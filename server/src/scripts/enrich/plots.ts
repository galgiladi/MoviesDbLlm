import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { esClient } from '../../es/client';
import { TITLES_INDEX } from '../../es/indices';
import { env } from '../../config/env';

/**
 * One-time (resumable) enrichment pass: fills in real plot summaries from TMDb for every movie
 * already indexed in `titles`, replacing the templated "X (Year) is a Genre film." description.
 * Run after the main seed pipeline - this updates the already-indexed documents directly rather
 * than regenerating seed-movies.json, so it doesn't need to redo cast/credit assignment.
 *
 * Safe to interrupt and re-run: progress (which tconsts have been attempted) is persisted to
 * PROGRESS_FILE, so a re-run only processes movies it hasn't seen yet.
 */

const PROGRESS_FILE = path.join(__dirname, '..', '..', '..', 'data', '.cache', 'tmdb-plot-progress.json');
const PAGE_SIZE = 250;
const CONCURRENCY = 8; // stays safely under TMDb's ~40-50 req/sec cap
const MAX_RETRIES = 3;

interface Progress {
  // tconst -> true once attempted (whether or not TMDb had a plot for it) - never retried on a
  // plain re-run; delete this file (or specific keys) to force re-attempting specific titles.
  attempted: Record<string, true>;
}

function loadProgress(): Progress {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return { attempted: {} };
  }
}

function saveProgress(progress: Progress): void {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TmdbMatch {
  overview?: string;
  posterUrl?: string;
}

async function fetchTmdbMatch(tconst: string): Promise<TmdbMatch | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/find/${tconst}`, {
        params: { external_source: 'imdb_id', api_key: env.tmdbApiKey },
        timeout: 10_000,
      });
      const movie = response.data?.movie_results?.[0];
      if (!movie) return null;
      return {
        overview: typeof movie.overview === 'string' && movie.overview.trim() ? movie.overview.trim() : undefined,
        posterUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : undefined,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return null;
      if (status === 429 || status >= 500) {
        // TMDb sends Retry-After on 429; otherwise back off a little more each attempt.
        const retryAfter = Number(err?.response?.headers?.['retry-after']);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  console.warn(`  giving up on ${tconst} after ${MAX_RETRIES} retries`);
  return null;
}

async function processBatch(
  ids: string[],
  progress: Progress,
): Promise<{ enriched: number; attempted: number }> {
  let enriched = 0;
  let attempted = 0;

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY).filter((id) => !progress.attempted[id]);
    if (chunk.length === 0) continue;

    await Promise.all(
      chunk.map(async (id) => {
        const match = await fetchTmdbMatch(id);
        progress.attempted[id] = true;
        attempted++;

        if (match?.overview) {
          await esClient.update({
            index: TITLES_INDEX,
            id,
            doc: {
              description: match.overview,
              ...(match.posterUrl ? { posterUrl: match.posterUrl } : {}),
            },
          });
          enriched++;
        }
      }),
    );
  }

  return { enriched, attempted };
}

async function main() {
  if (!env.tmdbApiKey) {
    console.error(
      'TMDB_API_KEY is not set in server/.env. Get a free key at https://www.themoviedb.org/settings/api ' +
        '(Settings -> API -> Request an API key -> Developer) and add it, then re-run this script.',
    );
    process.exit(1);
  }

  const progress = loadProgress();
  let totalProcessed = 0;
  let totalEnriched = 0;
  let searchAfter: unknown[] | undefined;

  console.log('Starting TMDb plot enrichment (resumable - safe to Ctrl+C and re-run later)...');

  for (;;) {
    const result = await esClient.search<{ id: string }>({
      index: TITLES_INDEX,
      size: PAGE_SIZE,
      sort: [{ id: 'asc' as const }],
      _source: ['id'],
      ...(searchAfter ? { search_after: searchAfter } : {}),
    });

    const hits = result.hits.hits;
    if (hits.length === 0) break;

    const ids = hits.map((hit) => hit._source!.id);
    const { enriched, attempted } = await processBatch(ids, progress);
    totalProcessed += attempted;
    totalEnriched += enriched;

    saveProgress(progress);
    if (totalProcessed > 0) {
      console.log(`Processed ${totalProcessed.toLocaleString()} (enriched ${totalEnriched.toLocaleString()}) so far...`);
    }

    searchAfter = hits[hits.length - 1].sort as unknown[];
  }

  console.log(`Done. Attempted ${totalProcessed.toLocaleString()} movies, enriched ${totalEnriched.toLocaleString()} with a real plot summary.`);
}

main().catch((err) => {
  console.error('Plot enrichment failed:', err);
  process.exit(1);
});
