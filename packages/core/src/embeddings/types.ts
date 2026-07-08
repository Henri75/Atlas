export interface EmbeddingProvider {
  /** Provider key used in the Qdrant collection name. */
  readonly name: string;
  readonly model: string;
  /** Vector dimension — resolved during init(). */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
