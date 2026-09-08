import { esClient } from '../es/client';
import { TITLES_INDEX } from '../es/indices';
import { Movie, MovieInput } from '../types/movie';

export interface SearchMoviesParams {
  q?: string;
  page: number;
  size: number;
}

export interface SearchResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export async function searchMovies({ q, page, size }: SearchMoviesParams): Promise<SearchResult<Movie>> {
  // Text match only decides *which* movies match; ranking is always by popularity (numVotes),
  // same as the no-query listing, so well-known movies surface first everywhere in the app —
  // a pure relevance (_score) sort could otherwise put an obscure exact title match above a far
  // more famous partial match (e.g. "Batman" outranking "Batman Begins").
  const query = q && q.trim()
    ? {
        multi_match: {
          query: q.trim(),
          fields: ['title^3', 'description', 'genres'],
          fuzziness: 'AUTO',
        },
      }
    : { match_all: {} };

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query,
    from: (page - 1) * size,
    size,
    sort: [{ numVotes: 'desc' as const }, { score: 'desc' as const }],
  });

  const total = typeof result.hits.total === 'number'
    ? result.hits.total
    : result.hits.total?.value ?? 0;

  return {
    items: result.hits.hits.map((hit) => hit._source as Movie),
    total,
    page,
    size,
  };
}

export async function getMovieById(id: string): Promise<Movie | null> {
  try {
    const result = await esClient.get<Movie>({ index: TITLES_INDEX, id });
    return result._source ?? null;
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return null;
    throw err;
  }
}

export async function createMovie(movie: MovieInput): Promise<Movie> {
  const now = new Date().toISOString();
  const doc: Movie = { ...movie, createdAt: now, updatedAt: now };
  await esClient.index({
    index: TITLES_INDEX,
    id: doc.id,
    document: doc,
    refresh: 'wait_for',
  });
  return doc;
}

export async function patchMovie(id: string, partial: Partial<Movie>): Promise<Movie | null> {
  const existing = await getMovieById(id);
  if (!existing) return null;

  const update: Partial<Movie> = { ...partial, updatedAt: new Date().toISOString() };
  await esClient.update({
    index: TITLES_INDEX,
    id,
    doc: update,
    refresh: 'wait_for',
  });

  return { ...existing, ...update };
}
