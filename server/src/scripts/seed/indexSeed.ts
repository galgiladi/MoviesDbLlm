import fs from 'fs';
import path from 'path';
import { esClient } from '../../es/client';
import { ensureIndices, TITLES_INDEX, PEOPLE_INDEX } from '../../es/indices';
import { Movie } from '../../types/movie';
import { Actor } from '../../types/actor';

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

async function bulkIndex<T extends { id: string }>(index: string, docs: T[]) {
  if (docs.length === 0) return;

  const result = await esClient.helpers.bulk({
    datasource: docs,
    onDocument: (doc: T) => [{ index: { _index: index, _id: doc.id } }, doc],
  });

  console.log(`Indexed into "${index}": ${result.successful} ok, ${result.failed} failed (of ${result.total}).`);
  if (result.failed > 0) {
    console.warn('Some documents failed to index — check Elasticsearch logs / mapping compatibility.');
  }
}

async function main() {
  const moviesPath = path.join(DATA_DIR, 'seed-movies.json');
  const actorsPath = path.join(DATA_DIR, 'seed-actors.json');

  if (!fs.existsSync(moviesPath) || !fs.existsSync(actorsPath)) {
    console.error('seed-movies.json / seed-actors.json not found. Run "npm run seed:build" first.');
    process.exit(1);
  }

  await ensureIndices();

  const movies: Omit<Movie, 'createdAt' | 'updatedAt'>[] = JSON.parse(fs.readFileSync(moviesPath, 'utf-8'));
  const actors: Actor[] = JSON.parse(fs.readFileSync(actorsPath, 'utf-8'));

  const now = new Date().toISOString();
  await bulkIndex<Movie>(
    TITLES_INDEX,
    movies.map((m) => ({ ...m, createdAt: now, updatedAt: now })),
  );
  await bulkIndex<Actor>(PEOPLE_INDEX, actors);

  await esClient.indices.refresh({ index: `${TITLES_INDEX},${PEOPLE_INDEX}` });
  console.log('Seeding complete.');
}

main().catch((err) => {
  console.error('Seed indexing failed:', err);
  process.exit(1);
});
