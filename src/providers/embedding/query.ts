import type { EmbeddingProvider } from "../../types.js";

export function embedQuery(provider: EmbeddingProvider, text: string): Promise<Float32Array> {
  return provider.embedQuery ? provider.embedQuery(text) : provider.embed(text);
}
