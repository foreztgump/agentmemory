import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEPLOY_ENV: Record<string, string> = {
  AGENTMEMORY_LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test-proxy-key",
  ANTHROPIC_BASE_URL: "http://cliproxy.invalid:8317",
  ANTHROPIC_MODEL: "claude-haiku-5-5",
  EMBEDDING_PROVIDER: "voyage",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_MODEL: "voyage-code-4",
  VOYAGE_OUTPUT_DIMENSION: "1024",
};

const CLEARED_KEYS = [
  ...Object.keys(DEPLOY_ENV),
  "CONSOLIDATION_ENABLED",
  "AGENTMEMORY_PROVIDER",
  "AGENTMEMORY_ALLOW_AGENT_SDK",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MINIMAX_API_KEY",
  "COHERE_API_KEY",
  "HOME",
  "USERPROFILE",
];

const original: Record<string, string | undefined> = {};
let sandboxHome: string;

async function freshModules() {
  vi.resetModules();
  const config = await import("../src/config.js");
  const embedding = await import("../src/providers/embedding/index.js");
  return { config, embedding };
}

describe("fork deploy configuration (NR1 stacks)", () => {
  beforeEach(() => {
    for (const k of CLEARED_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-fork-deploy-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
  });

  afterEach(() => {
    for (const k of CLEARED_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("runs summaries and consolidation on the Anthropic-compatible endpoint", async () => {
    Object.assign(process.env, DEPLOY_ENV);
    const { config } = await freshModules();
    expect(config.loadConfig().provider).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      baseURL: "http://cliproxy.invalid:8317",
    });
    expect(config.isConsolidationEnabled()).toBe(true);
  });

  it("falls back to zero-LLM when AGENTMEMORY_LLM_PROVIDER is missing", async () => {
    Object.assign(process.env, DEPLOY_ENV);
    delete process.env["AGENTMEMORY_LLM_PROVIDER"];
    const { config } = await freshModules();
    expect(config.loadConfig().provider.provider).toBe("noop");
    expect(config.isConsolidationEnabled()).toBe(false);
  });

  it("embeds with voyage-code-4 at 1024 dimensions", async () => {
    Object.assign(process.env, DEPLOY_ENV);
    const { embedding } = await freshModules();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] }), { status: 200 }),
    );
    try {
      const provider = embedding.createEmbeddingProvider();
      expect(provider?.name).toBe("voyage");
      expect(provider?.dimensions).toBe(1024);
      await provider!.embed("capture");
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toMatchObject({ model: "voyage-code-4", output_dimension: 1024 });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
