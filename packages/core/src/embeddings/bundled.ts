import type { EmbeddingProvider } from './types.js';

/**
 * Zero-dependency-on-services fallback: ONNX MiniLM on CPU via
 * @huggingface/transformers. Lazily imported so services that never embed
 * don't pay the onnxruntime startup cost.
 */
const BUNDLED_MODEL = 'Xenova/all-MiniLM-L6-v2';

export async function createBundledProvider(): Promise<EmbeddingProvider> {
  const { pipeline } = await import('@huggingface/transformers');
  const extractor: any = await pipeline('feature-extraction', BUNDLED_MODEL, {
    dtype: 'q8',
  });
  const embed = async (texts: string[]): Promise<number[][]> => {
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist() as number[][];
  };
  const probe = await embed(['dimension probe']);
  return { name: 'bundled', model: BUNDLED_MODEL, dim: probe[0]!.length, embed };
}
