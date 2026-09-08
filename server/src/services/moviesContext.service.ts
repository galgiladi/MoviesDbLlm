import { esClient } from '../es/client';
import { MOVIES_INDEX } from '../es/indices';
import { Movie } from '../types/movie';

const CACHE_TTL_MS = 5 * 60 * 1000;
// TODO: revert to 1000 - temporarily capped low to cheaply smoke-test the Anthropic key/billing with fewer input tokens
const MAX_MOVIES = 20;

interface ChatContextMovie {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  description: string;
  score?: number;
  numVotes?: number;
  cast: { actorId: string; name: string }[];
}

let cachedBlock: string | null = null;
let cachedAt = 0;

export async function getMoviesContextBlock(): Promise<string> {
  const now = Date.now();
  if (cachedBlock && now - cachedAt < CACHE_TTL_MS) {
    return cachedBlock;
  }

  const result = await esClient.search<Movie>({
    index: MOVIES_INDEX,
    query: { match_all: {} },
    size: MAX_MOVIES,
  });

  const trimmed: ChatContextMovie[] = result.hits.hits.map((hit) => {
    const movie = hit._source as Movie;
    return {
      id: movie.id,
      title: movie.title,
      year: movie.year,
      genres: movie.genres,
      description: movie.description,
      score: movie.score,
      numVotes: movie.numVotes,
      cast: movie.cast.map((c) => ({ actorId: c.actorId, name: c.name })),
    };
  });

  cachedBlock = JSON.stringify(trimmed);
  cachedAt = now;
  return cachedBlock;
}

export function invalidateMoviesContext(): void {
  cachedBlock = null;
  cachedAt = 0;
}
