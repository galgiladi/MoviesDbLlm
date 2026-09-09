import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * Local (CPU, no API key, no rate limits) text embeddings via a small sentence-transformers
 * model, run in-process via ONNX Runtime. Used both for the one-time plot-embedding backfill
 * and for embedding a user's live question in semantic_search_plots - a rate-limited external
 * embedding API would be a real risk on that live path, not just the bulk pass.
 *
 * Model produces 384-dim, L2-normalized vectors - keep EMBEDDING_DIMS below in sync with the
 * `plotEmbedding` mapping in es/indices.ts if this model ever changes.
 */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_NAME);
  }
  return extractorPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}
