// Exit 0 when the agentmemory at argv[2] serves REST and has finished its keyword
// index rebuild over a non-empty store; exit 1 otherwise. --print writes the
// status report's index section to stdout.
const [base, secret, flag] = process.argv.slice(2);
let index;
try {
  const res = await fetch(`${base}/agentmemory/status`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) process.exit(1);
  ({ index } = await res.json());
} catch {
  process.exit(1);
}
if (flag === "--print") console.log(JSON.stringify(index));
const ready = index && !index.keywordRebuildRunning && !index.bm25Incomplete && index.bm25Documents > 0;
process.exit(ready ? 0 : 1);
