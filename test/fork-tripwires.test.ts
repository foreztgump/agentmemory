import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../tsconfig.fork.json", import.meta.url));

describe("fork tripwires", () => {
  it("type-checks the search ports and scope classes against upstream code", () => {
    const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    });
    if (!config) throw new Error(`cannot read ${configPath}`);
    const program = ts.createProgram(config.fileNames, config.options);
    const errors = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file && d.start !== undefined
        ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
        : "";
      return where + ts.flattenDiagnosticMessageText(d.messageText, "\n");
    });
    expect(errors).toEqual([]);
  }, 60_000);
});
