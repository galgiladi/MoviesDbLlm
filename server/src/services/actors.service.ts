import { esClient } from '../es/client';
import { ACTORS_INDEX } from '../es/indices';
import { Actor, ActorMovie } from '../types/actor';
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
        path: 'movies',
        query: { term: { 'movies.movieId': movieId } },
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
    index: ACTORS_INDEX,
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
    const result = await esClient.get<Actor>({ index: ACTORS_INDEX, id });
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
    index: ACTORS_INDEX,
    query: { term: { 'name.keyword': name } },
    size: 1,
  });
  const hit = result.hits.hits[0];
  return hit?._source ?? null;
}

/**
 * Finds an actor by exact name or creates one, then ensures the given movie
 * reference is present on their `movies` list. Used when a movie is added
 * via IMDb-URL scrape, where we only have actor names (no stable nconst).
 */
export async function upsertActorForMovie(name: string, movieRef: ActorMovie): Promise<Actor> {
  const existing = await findActorByExactName(name);

  if (existing) {
    const alreadyLinked = existing.movies.some((m) => m.movieId === movieRef.movieId);
    const movies = alreadyLinked ? existing.movies : [...existing.movies, movieRef];
    if (!alreadyLinked) {
      await esClient.update({
        index: ACTORS_INDEX,
        id: existing.id,
        doc: { movies },
        refresh: 'wait_for',
      });
    }
    return { ...existing, movies };
  }

  const actor: Actor = { id: slugifyName(name), name, movies: [movieRef] };
  await esClient.index({
    index: ACTORS_INDEX,
    id: actor.id,
    document: actor,
    refresh: 'wait_for',
  });
  return actor;
}
