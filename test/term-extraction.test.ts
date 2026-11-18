import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { extractTerms, tokenize } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";

const TEXTS = [
  "The quick brown fox jumps over the lazy dog",
  "Running runs ran runner easily fairly happiness",
  "connection connected connecting connections",
  "getUserById returns a Promise<User | undefined>",
  "src/functions/search.ts:93 getSearchIndex()",
  "C:\\Users\\dev\\project\\index.ts",
  "snake_case_identifier and kebab-case-name and dotted.module.path",
  "fix(search): handle CJK tokens in BM25 [TEE-1157]",
  "npm run build && npm test -- --run test/search-index.test.ts",
  "Error: ENOENT: no such file or directory, open '/tmp/x.json'",
  "TypeError: Cannot read properties of undefined (reading 'map')",
  "auth authentication login signin token jwt oauth",
  "db database sql postgres query migration schema",
  "k8s kubernetes deploy deployment docker container image",
  "config configuration settings env environment variable",
  "perf performance latency slow fast optimize optimization",
  "test tests testing spec unit integration e2e",
  "bug fix issue error crash exception failure",
  "async await promise callback event loop",
  "UI frontend component react render state hook",
  "API endpoint route handler request response REST",
  "日本語のテキストを検索します",
  "中文分词测试：搜索引擎索引",
  "한국어 형태소 분석 테스트",
  "mixed 日本語 and English テキスト with code getFoo()",
  "数据库连接失败 database connection failed",
  "emoji 🚀 rocket ✅ check — dash “quotes” ‘single’",
  "numbers 42 3.14 1e10 0xff v0.9.33 2026-11-17T12:00:00Z",
  "a b c d e x y z",
  "   leading and trailing whitespace   ",
  "",
  "!!!???...---",
  "UPPER lower MiXeD CamelCase PascalCase",
  "https://github.com/foreztgump/agentmemory/pull/12?tab=files#diff",
  "user@example.com sent mail to admin@test.org",
  "$HOME/.config/agentmemory/.env AGENTMEMORY_URL=http://localhost:3111",
  "Ünïcödé àccents café naïve résumé Straße",
  "Привет мир поиск индекс",
  "مرحبا بالعالم",
  "tab\tseparated\tvalues\nnew\nlines",
  "kv.list(KV.memories) returns Memory[]",
  "registerFunction('mem::search', async (data) => {})",
  "vectorIndexAddGuarded(id, sessionId, text, ctx)",
  "SELECT * FROM observations WHERE session_id = $1 LIMIT 50;",
  "git rebase --onto disk v0.9.33 feature/TEE-1157-search-ports",
  "docker compose -f deploy/coolify/docker-compose.yml up -d",
  "The user prefers concise responses without trailing summaries",
  "Decided to use Qdrant sparse vectors with the idf modifier",
  "Edited src/state/search-index.ts to extract term extraction",
  "Read package.json and tsconfig.json to find the build scripts",
  "repos repository repositories refactor refactoring refactored",
  "généralisation internationalization i18n l10n localization",
];

function obs(id: string, overrides: Partial<CompressedObservation>): CompressedObservation {
  return {
    id,
    sessionId: "ses_fixture",
    timestamp: "2026-11-17T00:00:00.000Z",
    type: "file_edit",
    title: "",
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
    ...overrides,
  };
}

const LONG = "token ".repeat(1500) + "tail-marker";

const OBSERVATIONS: CompressedObservation[] = [
  obs("obs_1", {
    type: "file_edit",
    title: "Edited search-index.ts",
    subtitle: "Moved tokenize into a shared module",
    narrative: "Extracted the tokenizer, stemmer and CJK segmentation from SearchIndex.",
    facts: ["tokenize is pure", "extractTerms reads title, narrative, facts"],
    concepts: ["bm25", "refactoring", "search"],
    files: ["src/state/search-index.ts", "src/state/term-extraction.ts"],
  }),
  obs("obs_2", {
    type: "command_run",
    title: "Ran npm test",
    narrative: "4,700 tests passed in 92s; vitest reported 0 failures.",
    facts: ["npm test exit 0"],
    concepts: ["testing"],
    files: [],
  }),
  obs("obs_3", {
    type: "conversation",
    title: "User asked about database migrations",
    narrative: "Discussed moving records from Valkey to Kvrocks.",
    facts: [],
    concepts: ["db", "migration"],
    files: [],
    source: {
      toolName: "conversation",
      userPrompt: "How do we migrate the db without downtime?",
      assistantResponse: "Use the offline migrator and keep vectors.",
      toolOutput: "conversation transcript: migrate kvrocks qdrant",
    } as CompressedObservation["source"],
  }),
  obs("obs_4", {
    type: "file_read",
    title: "読み込み: 設定ファイル",
    narrative: "設定ファイルを読み込んで環境変数を確認した",
    facts: ["中文事实"],
    concepts: ["config"],
    files: ["config/日本語.json"],
  }),
  obs("obs_5", {
    type: "error",
    title: "TypeError in hybrid search",
    subtitle: "Cannot read properties of undefined",
    narrative: "HybridSearch.search threw when vector index was null.",
    facts: ["vector index null", "embedding provider missing"],
    concepts: ["bug", "search", "embedding"],
    files: ["src/state/hybrid-search.ts"],
  }),
  obs("obs_6", {
    type: "web_fetch",
    title: "Fetched Qdrant docs",
    narrative: "Sparse vectors support the idf modifier with BM25 weights.",
    facts: ["idf = ln((N-n+0.5)/(n+0.5)+1)"],
    concepts: ["qdrant", "bm25"],
    files: [],
    source: {
      toolName: "WebFetch",
      userPrompt: LONG,
      assistantResponse: LONG,
      toolOutput: "not indexed because toolName is not conversation",
    } as CompressedObservation["source"],
  }),
  obs("obs_7", {
    type: "conversation",
    title: "Long conversation",
    narrative: "Capped source fields",
    source: {
      toolName: "conversation",
      userPrompt: LONG,
      assistantResponse: LONG,
      toolOutput: LONG,
    } as CompressedObservation["source"],
  }),
  obs("mem_8", {
    type: "decision",
    title: "Prefer Kvrocks for records",
    narrative: "Decided to keep records in Kvrocks through the redis adapter.",
    concepts: ["architecture", "decision"],
    files: ["deploy/coolify/docker-compose.yml"],
  }),
];

const QUERIES = [
  "search index",
  "auth login",
  "db migration",
  "perf",
  "tokenize",
  "設定",
  "中文",
  "TypeError undefined",
  "kvrocks records",
  "qdrant idf",
  "refactor",
  "tail-marker",
  "conversation transcript",
  "src/state/hybrid-search.ts",
  "",
];

describe("term extraction (byte-identical snapshot)", () => {
  it("tokenizes a fixed corpus of mixed text", () => {
    expect(TEXTS.map((text) => [text, tokenize(text.toLowerCase())])).toMatchSnapshot();
  });

  it("tokenizes without lowercasing first", () => {
    expect(TEXTS.slice(0, 12).map((text) => tokenize(text))).toMatchSnapshot();
  });

  it("extracts document terms from observations", () => {
    expect(OBSERVATIONS.map((o) => [o.id, extractTerms(o)])).toMatchSnapshot();
  });

  it("ranks the same documents with the same scores, synonyms included", () => {
    const index = new SearchIndex();
    OBSERVATIONS.forEach((o) => index.add(o, o.id.startsWith("mem_") ? "memory" : "observation"));
    TEXTS.forEach((text, i) => index.add(obs(`obs_text_${i}`, { title: text, narrative: text })));
    expect(QUERIES.map((q) => [q, index.search(q, 10)])).toMatchSnapshot();
  });
});
