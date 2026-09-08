import { esClient } from './client';

export const MOVIES_INDEX = 'movies';
export const ACTORS_INDEX = 'actors';

const textWithKeyword = {
  type: 'text',
  fields: { keyword: { type: 'keyword', ignore_above: 512 } },
} as const;

const moviesMapping = {
  properties: {
    id: { type: 'keyword' },
    title: textWithKeyword,
    year: { type: 'integer' },
    genres: { type: 'keyword' },
    runtimeMinutes: { type: 'integer' },
    score: { type: 'float' },
    numVotes: { type: 'integer' },
    description: { type: 'text' },
    imdbUrl: { type: 'keyword' },
    posterUrl: { type: 'keyword' },
    cast: {
      type: 'nested',
      properties: {
        actorId: { type: 'keyword' },
        name: textWithKeyword,
        character: { type: 'text' },
      },
    },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
} as const;

const actorsMapping = {
  properties: {
    id: { type: 'keyword' },
    name: textWithKeyword,
    birthYear: { type: 'integer' },
    movies: {
      type: 'nested',
      properties: {
        movieId: { type: 'keyword' },
        title: textWithKeyword,
        character: { type: 'text' },
      },
    },
  },
} as const;

async function ensureIndex(index: string, mappings: Record<string, unknown>) {
  const exists = await esClient.indices.exists({ index });
  if (exists) return;
  await esClient.indices.create({ index, mappings });
  // eslint-disable-next-line no-console
  console.log(`Created index "${index}"`);
}

export async function ensureIndices() {
  await ensureIndex(MOVIES_INDEX, moviesMapping);
  await ensureIndex(ACTORS_INDEX, actorsMapping);
}
