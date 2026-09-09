import fs from 'fs';
import path from 'path';
import { esClient } from '../../es/client';
import { TITLES_INDEX } from '../../es/indices';
import { embedText } from '../../services/embeddings';

/**
 * One-time (resumable) pass: computes a local embedding of each movie's real plot summary
 * (skips movies still on the templated "X (Year) is a Genre film." description - nothing
 * meaningful to embed there) and writes it to the `plotEmbedding` field, powering
 * semantic_search_plots. Run after `enrich:plots` has backfilled real plots from TMDb.
 *
 * Fully local (no external API, no rate limits) via services/embeddings.ts - safe to interrupt
 * and re-run; progress is persisted to PROGRESS_FILE.
 */

const PROGRESS_FILE = path.join(__dirname, '..', '..', '..', 'data', '.cache', 'plot-embedding-progress.json');
const PAGE_SIZE = 200;
const SAVE_EVERY = 500;

interface Progress {
  done: Record<string, true>;
}

function loadProgress(): Progress {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return { done: {} };
  }
}

function saveProgress(progress: Progress): void {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
}

function templateDescription(title: string, year: number | undefined, genres: string[]): string {
  const genreText = genres.length ? genres.join(', ') : 'Drama';
  const yearText = year ? ` (${year})` : '';
  return `${title}${yearText} is a ${genreText} film.`;
}

interface TitleDoc {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  description: string;
}

async function bulkUpdateEmbeddings(updates: { id: string; vector: number[] }[]): Promise<void> {
  if (updates.length === 0) return;
  const result = await esClient.helpers.bulk({
    datasource: updates,
    onDocument: (u: { id: string; vector: number[] }) => [
      { update: { _index: TITLES_INDEX, _id: u.id } },
      { doc: { plotEmbedding: u.vector } },
    ],
  });
  if (result.failed > 0) {
    console.warn(`  ${result.failed} embedding updates failed (of ${result.total}) - check ES logs.`);
  }
}

async function main() {
  const progress = loadProgress();
  let totalScanned = 0;
  let totalEmbedded = 0;
  let totalSkippedTemplated = 0;
  let searchAfter: unknown[] | undefined;
  let pendingUpdates: { id: string; vector: number[] }[] = [];

  console.log('Starting plot embedding pass (resumable - safe to Ctrl+C and re-run later)...');

  for (;;) {
    const result = await esClient.search<TitleDoc>({
      index: TITLES_INDEX,
      size: PAGE_SIZE,
      sort: [{ id: 'asc' as const }],
      _source: ['id', 'title', 'year', 'genres', 'description'],
      ...(searchAfter ? { search_after: searchAfter } : {}),
    });

    const hits = result.hits.hits;
    if (hits.length === 0) break;

    for (const hit of hits) {
      const doc = hit._source!;
      totalScanned++;

      if (progress.done[doc.id]) continue;

      const isTemplated = doc.description === templateDescription(doc.title, doc.year, doc.genres ?? []);
      if (isTemplated || !doc.description?.trim()) {
        progress.done[doc.id] = true;
        totalSkippedTemplated++;
        continue;
      }

      const vector = await embedText(doc.description);
      pendingUpdates.push({ id: doc.id, vector });
      progress.done[doc.id] = true;
      totalEmbedded++;

      if (pendingUpdates.length >= SAVE_EVERY) {
        await bulkUpdateEmbeddings(pendingUpdates);
        pendingUpdates = [];
        saveProgress(progress);
        console.log(
          `Scanned ${totalScanned.toLocaleString()}, embedded ${totalEmbedded.toLocaleString()}, ` +
            `skipped (templated) ${totalSkippedTemplated.toLocaleString()}...`,
        );
      }
    }

    searchAfter = hits[hits.length - 1].sort as unknown[];
  }

  await bulkUpdateEmbeddings(pendingUpdates);
  saveProgress(progress);

  console.log(
    `Done. Scanned ${totalScanned.toLocaleString()}, embedded ${totalEmbedded.toLocaleString()}, ` +
      `skipped (still templated) ${totalSkippedTemplated.toLocaleString()}.`,
  );
}

main().catch((err) => {
  console.error('Plot embedding failed:', err);
  process.exit(1);
});
