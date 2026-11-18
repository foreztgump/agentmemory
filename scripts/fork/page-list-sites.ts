// Finds every `<expr>.list<T?>(<scope>)` call in src/ that reads a whole scope in one call, and
// rewrites the ones on a growing scope to `collectAll<T>(<expr>, <scope>)`, which pages through
// `kv.iterate`. The scope guard refuses an unpaged list of a `paged-only` or `point-read-only`
// scope (see SCOPE_CLASS), so this keeps callers working once the guard enforces that.
//
// Usage:
//   npx tsx scripts/fork/page-list-sites.ts            print every site, change nothing
//   npx tsx scripts/fork/page-list-sites.ts --write    rewrite the growing-scope sites in place
//
// A site is "growing" when its scope argument is rooted at `KV.<name>` (a property, or a call such
// as `KV.auditMonth(x)`), or is the string a static KV scope holds, and SCOPE_CLASS[name] is
// paged-only or point-read-only. A call whose scope is held in a variable, or is not a KV scope, is
// printed as unclassified and left for a person. A site that cannot be converted is listed in
// ALLOWED_SITES with its reason; the rewrite skips it and test/fork-paged-list-sites.test.ts
// accepts it. src/fork/ and src/state/kv.ts are skipped: they implement the paging.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { KV } from "../../src/state/schema.js";
import { SCOPE_CLASS, type ScopeClass } from "../../src/fork/kv/scope-classes.js";

export type SiteKind = ScopeClass | "unclassified";

export interface ListSite {
  file: string;
  line: number;
  kind: SiteKind;
  scopeName: string | null;
  receiver: string;
  scope: string;
  typeArgs: string;
  start: number;
  end: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KV_MODULE = join(repoRoot, "src/state/kv.js");

export const GROWING: ReadonlySet<SiteKind> = new Set<SiteKind>(["paged-only", "point-read-only"]);

export interface AllowedSite {
  file: string;
  scope: string;
  reason: string;
}

export const ALLOWED_SITES: readonly AllowedSite[] = [
  {
    file: "src/mcp/standalone.ts",
    scope: '"mem:memories"',
    reason: "InMemoryKV keeps every row in this process, so a list reads no engine state and has no iterate",
  },
  {
    file: "src/mcp/standalone.ts",
    scope: '"mem:sessions"',
    reason: "InMemoryKV keeps every row in this process, so a list reads no engine state and has no iterate",
  },
  {
    file: "src/state/index-persistence.ts",
    scope: "vectorBucketScope(bucket)",
    reason: "a vector bucket holds at most bucketSize rows, and the load runs once at start",
  },
];

export function allowedReason(site: Pick<ListSite, "file" | "scope">): string | null {
  const file = relative(repoRoot, site.file).split(sep).join("/");
  return ALLOWED_SITES.find((a) => a.file === file && a.scope === site.scope)?.reason ?? null;
}

const SCOPE_BY_VALUE = new Map<string, keyof typeof SCOPE_CLASS>(
  Object.entries(KV).flatMap(([name, value]) => (typeof value === "string" ? [[value, name as keyof typeof SCOPE_CLASS]] : [])),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

export function scannedFiles(root = repoRoot): string[] {
  const skipDir = join(root, "src/fork") + sep;
  const skipFile = join(root, "src/state/kv.ts");
  return sourceFiles(join(root, "src")).filter((f) => !f.startsWith(skipDir) && f !== skipFile);
}

function kvRoot(expr: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expr)) return SCOPE_BY_VALUE.get(expr.text) ?? null;
  let node: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "KV") {
    return node.name.text;
  }
  return null;
}

export function findListSites(files: string[] = scannedFiles()): ListSite[] {
  const sites: ListSite[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "list" &&
        node.arguments.length === 1
      ) {
        const [arg] = node.arguments as unknown as [ts.Expression];
        const name = kvRoot(arg);
        const known = name !== null && Object.hasOwn(SCOPE_CLASS, name);
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind: known ? SCOPE_CLASS[name as keyof typeof SCOPE_CLASS] : "unclassified",
          scopeName: known ? name : null,
          receiver: node.expression.expression.getText(sf),
          scope: arg.getText(sf),
          typeArgs: node.typeArguments ? `<${node.typeArguments.map((t) => t.getText(sf)).join(", ")}>` : "",
          start: node.getStart(sf),
          end: node.end,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

function importPath(from: string): string {
  const rel = relative(dirname(from), KV_MODULE).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function withCollectAllImport(file: string, text: string): string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const kvImports = imports.filter(
    (i) => ts.isStringLiteral(i.moduleSpecifier) && resolve(dirname(file), i.moduleSpecifier.text) === KV_MODULE,
  );
  const valueNames = kvImports.flatMap((i) => {
    const named = i.importClause?.namedBindings;
    if (i.importClause?.isTypeOnly || !named || !ts.isNamedImports(named)) return [];
    return named.elements.filter((e) => !e.isTypeOnly).map((e) => ({ name: e.name.text, last: named.elements.at(-1)! }));
  });
  if (valueNames.some((n) => n.name === "collectAll")) return text;
  const extend = valueNames[0]?.last;
  if (extend) return `${text.slice(0, extend.end)}, collectAll${text.slice(extend.end)}`;
  const sample = imports.find((i) => ts.isStringLiteral(i.moduleSpecifier));
  const quote = sample ? sample.moduleSpecifier.getText(sf)[0]! : '"';
  const semi = sample && sample.getText(sf).endsWith(";") ? ";" : "";
  const line = `import { collectAll } from ${quote}${importPath(file)}${quote}${semi}\n`;
  const at = imports.length ? imports[imports.length - 1]!.end : 0;
  return imports.length ? `${text.slice(0, at)}\n${line.trimEnd()}${text.slice(at)}` : line + text;
}

export function rewriteFile(file: string): number {
  let text = readFileSync(file, "utf-8");
  let changed = 0;
  for (;;) {
    const sites = findListSites([file]).filter((s) => GROWING.has(s.kind) && !allowedReason(s));
    const outermost = sites.filter((s) => !sites.some((o) => o !== s && o.start <= s.start && s.end <= o.end));
    if (outermost.length === 0) break;
    for (const s of outermost.sort((a, b) => b.start - a.start)) {
      text = `${text.slice(0, s.start)}collectAll${s.typeArgs}(${s.receiver}, ${s.scope})${text.slice(s.end)}`;
      changed++;
    }
    writeFileSync(file, text);
  }
  if (changed > 0) writeFileSync(file, withCollectAllImport(file, text));
  return changed;
}

function report(sites: ListSite[], title: string): void {
  const byFile = new Map<string, ListSite[]>();
  for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  console.log(`${title}: ${sites.length} sites in ${byFile.size} files`);
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    console.log(`  ${relative(repoRoot, file)}: ${list.length}`);
    for (const s of list) console.log(`    :${s.line}  ${s.receiver}.list${s.typeArgs}(${s.scope})  [${s.kind}]`);
  }
}

/** Every call that lists a growing or unknown scope in one read and is not in ALLOWED_SITES. */
export function unpagedSites(files?: string[]): ListSite[] {
  return findListSites(files).filter((s) => (GROWING.has(s.kind) || s.kind === "unclassified") && !allowedReason(s));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const sites = findListSites();
  const growing = sites.filter((s) => GROWING.has(s.kind) && !allowedReason(s));
  report(growing, write ? "rewriting" : "growing-scope sites");
  report(sites.filter((s) => allowedReason(s)), "allowed sites, left as they are");
  report(sites.filter((s) => s.kind === "bounded"), "bounded-scope sites, left as they are");
  report(sites.filter((s) => s.kind === "unclassified" && !allowedReason(s)), "unclassified sites, handle by hand");
  if (write) {
    const files = [...new Set(growing.map((s) => s.file))];
    const changed = files.reduce((n, f) => n + rewriteFile(f), 0);
    console.log(`rewrote ${changed} calls in ${files.length} files`);
  }
}
