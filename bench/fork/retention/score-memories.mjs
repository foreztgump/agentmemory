// Computes the upstream retention scores (mem::retention-score), which nothing on a stack runs on a schedule and which stage C
// of the sweep needs (a memory with no score is never cold). Runs INSIDE the agentmemory container, as the app does:
//   docker exec <project>-agentmemory-1 node /tmp/score-memories.mjs   (copy the file in with docker cp)
// It joins the engine as a short-lived worker and triggers the function; it prints the tier counts. S12_LAMBDA sets the decay rate
// (upstream's default 0.01 a day leaves one buddy memory below the 0.15 cold score; staging uses a faster decay to get stage C candidates).
import { registerWorker } from "iii-sdk";

const sdk = registerWorker(process.env.III_ENGINE_URL ?? "ws://127.0.0.1:49134", { workerName: "s12-score", namespace: "agentmemory", invocationTimeoutMs: 600_000 });
const result = await sdk.trigger({ function_id: "mem::retention-score", payload: { config: process.env.S12_LAMBDA ? { lambda: Number(process.env.S12_LAMBDA) } : undefined }, timeoutMs: 600_000 });
console.log(JSON.stringify({ total: result.total, tiers: result.tiers, success: result.success }));
process.exit(0);
