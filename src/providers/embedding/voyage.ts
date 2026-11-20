import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { fetchWithTimeout } from "../_fetch.js";

const API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-code-3";
const DEFAULT_DIMENSIONS = 1024;
const OUTPUT_DIMENSIONS = [256, 512, 1024, 2048];

function parseOutputDimension(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!OUTPUT_DIMENSIONS.includes(value)) {
    throw new Error(
      `VOYAGE_OUTPUT_DIMENSION must be one of ${OUTPUT_DIMENSIONS.join(", ")}, got: ${raw}`,
    );
  }
  return value;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private outputDimension: number | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("VOYAGE_API_KEY") || "";
    if (!this.apiKey) throw new Error("VOYAGE_API_KEY is required");
    this.model = getEnvVar("VOYAGE_MODEL") || DEFAULT_MODEL;
    this.outputDimension = parseOutputDimension(getEnvVar("VOYAGE_OUTPUT_DIMENSION"));
    this.dimensions = this.outputDimension ?? DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.embedWithInputType(texts, "document");
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.embedWithInputType([text], "query");
    return result;
  }

  private async embedWithInputType(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<Float32Array[]> {
    const response = await fetchWithTimeout(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
        ...(this.outputDimension !== undefined && { output_dimension: this.outputDimension }),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Voyage embedding failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => new Float32Array(d.embedding));
  }
}
