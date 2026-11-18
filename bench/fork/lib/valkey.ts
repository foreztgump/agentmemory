import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ALL_OBSERVATIONS = 'valkey-cli --scan --pattern "state:mem:obs:*" | while read -r k; do valkey-cli --raw hvals "$k"; done';

// Streams the JSON values a shell script prints inside a Valkey container, one per
// line, as raw text. Throws when the script fails, so a wrong container or a
// broken scan cannot pass as an empty store.
export async function* valueLines(container: string, script: string): AsyncIterable<string> {
  const child = spawn("docker", ["exec", container, "sh", "-c", script], { stdio: ["ignore", "pipe", "inherit"] });
  let spawnError = "";
  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      spawnError = `: ${error.message}`;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
  let drained = false;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (line.startsWith("{")) yield line;
    }
    drained = true;
  } finally {
    if (!drained) child.kill();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`docker exec ${container} failed with exit code ${code}${spawnError}`);
}

// The error names the container but never the line: values hold private memory.
export async function* jsonValues(container: string, script: string): AsyncIterable<Record<string, unknown>> {
  let n = 0;
  for await (const line of valueLines(container, script)) {
    n++;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`value ${n} from ${container} is not JSON: ${(error as Error).message.slice(0, 80)}`);
    }
    yield value;
  }
}
