import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ALL_OBSERVATIONS = 'valkey-cli --scan --pattern "state:mem:obs:*" | while read -r k; do valkey-cli --raw hvals "$k"; done';

// Streams the JSON values a shell script prints inside a Valkey container, one per
// line, as raw text. Throws when the script fails, so a wrong container or a
// broken scan cannot pass as an empty store.
export async function* valueLines(container: string, script: string): AsyncIterable<string> {
  const child = spawn("docker", ["exec", container, "sh", "-c", script], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.startsWith("{")) yield line;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`docker exec ${container} failed with exit code ${code}`);
}

export async function* jsonValues(container: string, script: string): AsyncIterable<Record<string, unknown>> {
  for await (const line of valueLines(container, script)) yield JSON.parse(line);
}
