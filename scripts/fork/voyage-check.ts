// Which output sizes and types a Voyage model accepts: one embedding request
// per output_dimension x output_dtype on a one-word input.
// Usage: VOYAGE_API_KEY=... npx tsx scripts/fork/voyage-check.ts [model]
// VOYAGE_BASE_URL overrides https://api.voyageai.com/v1 (for a local stub).

const model = process.argv[2] ?? "voyage-code-4";
const key = process.env.VOYAGE_API_KEY;
const base = (process.env.VOYAGE_BASE_URL ?? "https://api.voyageai.com/v1").replace(/\/$/, "");
const dimensions = [256, 512, 1024, 2048];
const dtypes = ["float", "int8", "binary"] as const;

if (!key) {
  console.error("VOYAGE_API_KEY is not set");
  process.exit(2);
}

function describe(vector: unknown[]): string {
  const numbers = vector.filter((v): v is number => typeof v === "number");
  if (numbers.length !== vector.length) return "non-numeric";
  const integers = numbers.every(Number.isInteger);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return `${integers ? "int" : "float"} range=[${min}, ${max}]`;
}

let failures = 0;
console.log(`model=${model}`);
for (const dimension of dimensions) {
  for (const dtype of dtypes) {
    const response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ input: ["hello"], model, input_type: "document", output_dimension: dimension, output_dtype: dtype }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      failures++;
      console.log(`dim=${dimension} dtype=${dtype} status=${response.status} error=${text.slice(0, 200).replace(/\s+/g, " ")}`);
      continue;
    }
    const body = JSON.parse(text) as { data?: Array<{ embedding?: unknown[] }>; model?: string; usage?: { total_tokens?: number } };
    const vector = body.data?.[0]?.embedding ?? [];
    const expected = dtype === "binary" ? dimension / 8 : dimension;
    console.log(
      `dim=${dimension} dtype=${dtype} status=200 length=${vector.length} expected=${expected} ` +
        `${describe(vector)} model=${body.model ?? "?"} tokens=${body.usage?.total_tokens ?? "?"}`,
    );
  }
}
process.exit(failures ? 1 : 0);
