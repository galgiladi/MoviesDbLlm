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
    // Embedding of `description` (only when it's a real TMDb plot, not the templated fallback) -
    // powers semantic_search_plots. 384 dims to match the Xenova/all-MiniLM-L6-v2 model in
    // services/embeddings.ts; `index: true` + cosine similarity enables approximate kNN search.
    plotEmbedding: { type: 'dense_vector', dims: 384, index: true, similarity: 'cosine' },
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
  if (!exists) {
    await esClient.indices.create({ index, mappings });
    // eslint-disable-next-line no-console
    console.log(`Created index "${index}"`);
    return;
  }
  // Index already exists (e.g. from before plotEmbedding was added) - ES allows adding new
  // fields to an existing mapping (though not changing existing ones), so patch it in rather
  // than requiring a full reindex.
  const { properties } = mappings as { properties: Record<string, unknown> };
  await esClient.indices.putMapping({ index, properties: properties as any });
}

export async function ensureIndices() {
  await ensureIndex(TITLES_INDEX, titlesMapping);
  await ensureIndex(PEOPLE_INDEX, peopleMapping);
}
