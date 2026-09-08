import { esClient } from '../es/client';
import { PEOPLE_INDEX } from '../es/indices';
import { Actor, FilmographyEntry } from '../types/actor';
import { SearchResult } from './movies.service';

export interface SearchActorsParams {
  q?: string;
  movieId?: string;
  page: number;
  size: number;
}

export async function searchActors({ q, movieId, page, size }: SearchActorsParams): Promise<SearchResult<Actor>> {
  let query: Record<string, unknown>;

  if (movieId) {
    query = {
      nested: {
        path: 'filmography',
        query: { term: { 'filmography.titleId': movieId } },
      },
    };
  } else if (q && q.trim()) {
    query = {
      multi_match: {
        query: q.trim(),
        fields: ['name^3'],
        fuzziness: 'AUTO',
      },
    };
  } else {
    query = { match_all: {} };
  }

  const result = await esClient.search<Actor>({
    index: PEOPLE_INDEX,
    query,
    from: (page - 1) * size,
    size,
    sort: movieId || (q && q.trim()) ? ['_score'] : [{ 'name.keyword': 'asc' as const }],
  });

  const total = typeof result.hits.total === 'number'
    ? result.hits.total
    : result.hits.total?.value ?? 0;

  return {
    items: result.hits.hits.map((hit) => hit._source as Actor),
    total,
    page,
    size,
  };
}

export async function getActorById(id: string): Promise<Actor | null> {
  try {
    const result = await esClient.get<Actor>({ index: PEOPLE_INDEX, id });
    return result._source ?? null;
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return null;
    throw err;
  }
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `nm-${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

async function findActorByExactName(name: string): Promise<Actor | null> {
  const result = await esClient.search<Actor>({
    index: PEOPLE_INDEX,
    query: { term: { 'name.keyword': name } },
    size: 1,
  });
  const hit = result.hits.hits[0];
  return hit?._source ?? null;
}

/**
 * Finds a person by exact name or creates one, then ensures the given title reference
 * is present on their `filmography` list. Used when a movie is added via IMDb-URL scrape,
 * where we only have actor names (no stable IMDb nconst).
 */
export async function upsertActorForMovie(name: string, filmographyRef: FilmographyEntry): Promise<Actor> {
  const existing = await findActorByExactName(name);

  if (existing) {
    const alreadyLinked = existing.filmography.some((f) => f.titleId === filmographyRef.titleId);
    const filmography = alreadyLinked ? existing.filmography : [...existing.filmography, filmographyRef];
    if (!alreadyLinked) {
      await esClient.update({
        index: PEOPLE_INDEX,
        id: existing.id,
        doc: { filmography },
        refresh: 'wait_for',
      });
    }
    return { ...existing, filmography };
  }

  const actor: Actor = { id: slugifyName(name), name, filmography: [filmographyRef] };
  await esClient.index({
    index: PEOPLE_INDEX,
    id: actor.id,
    document: actor,
    refresh: 'wait_for',
  });
  return actor;
}
