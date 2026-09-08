import { esClient } from './client';

export const TITLES_INDEX = 'titles';
export const PEOPLE_INDEX = 'people';

const textWithKeyword = {
  type: 'text',
  fields: { keyword: { type: 'keyword', ignore_above: 512 } },
} as const;

const titlesMapping = {
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
    credits: {
      type: 'nested',
      properties: {
        personId: { type: 'keyword' },
        name: textWithKeyword,
        category: { type: 'keyword' },
        character: { type: 'text' },
      },
    },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
} as const;

const peopleMapping = {
  properties: {
    id: { type: 'keyword' },
    name: textWithKeyword,
    birthYear: { type: 'integer' },
    filmography: {
      type: 'nested',
      properties: {
        titleId: { type: 'keyword' },
        title: textWithKeyword,
        category: { type: 'keyword' },
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
  await ensureIndex(TITLES_INDEX, titlesMapping);
  await ensureIndex(PEOPLE_INDEX, peopleMapping);
}
