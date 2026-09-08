import { esClient } from '../es/client';
import { TITLES_INDEX } from '../es/indices';
import { Movie } from '../types/movie';

const CACHE_TTL_MS = 5 * 60 * 1000;
// TODO: revert to a much higher cap - temporarily capped low to cheaply smoke-test the Anthropic key/billing
// with fewer input tokens. Now that the titles index can hold up to 100,000 movies, this needs a real
// retrieval redesign (not just raising the number) before Ask AI can reason over the whole catalog.
const MAX_MOVIES = 20;

interface ChatContextMovie {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  description: string;
  score?: number;
  numVotes?: number;
  credits: { personId: string; name: string; category: string }[];
}

let cachedBlock: string | null = null;
let cachedAt = 0;

export async function getMoviesContextBlock(): Promise<string> {
  const now = Date.now();
  if (cachedBlock && now - cachedAt < CACHE_TTL_MS) {
    return cachedBlock;
  }

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
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
      credits: movie.credits.map((c) => ({ personId: c.personId, name: c.name, category: c.category })),
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
