#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import Parser from "web-tree-sitter";
type Node = any;
type Tree = any;
type Language = any;
import {
  DEFINITION_QUERIES,
  CALL_QUERIES,
  IMPORT_QUERIES,
  EXT_TO_LANG,
  type LangId,
} from "./queries.js";
import { buildPatterns, findFiles, DEFAULT_EXCLUDES } from "./scan.js";

const require = createRequire(import.meta.url);

// Claude Code の LLM ツール呼び出しパスで array/object 引数が
// JSON 文字列化された状態で届く事があるので、両対応にする。
function coerceObject<T>(v: T | string | undefined): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new Error(`expected object/array, got unparseable string: ${v.slice(0, 80)}`);
  }
}

function wasmPath(lang: LangId): string {
  const pkgPath = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgPath), "out", `tree-sitter-${lang}.wasm`);
}

async function initParser(): Promise<void> {
  await Parser.init();
}

const langCache = new Map<LangId, Language>();

async function getLanguage(lang: LangId): Promise<Language> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  const path = wasmPath(lang);
  if (!existsSync(path)) throw new Error(`grammar not bundled for "${lang}" (looked at ${path})`);
  const LanguageCtor = (Parser as any).Language;
  const l = await LanguageCtor.load(path);
  langCache.set(lang, l);
  return l;
}

async function getParser(lang: LangId): Promise<Parser> {
  const language = await getLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

function detectLang(p: { language?: string; path?: string; code?: string }): LangId {
  if (p.language) {
    const l = p.language.toLowerCase();
    if (l in EXT_TO_LANG) return EXT_TO_LANG[l];
    // accept direct lang id
    if (Object.values(EXT_TO_LANG).includes(l as LangId)) return l as LangId;
    throw new Error(`unknown language: "${p.language}"`);
  }
  if (p.path) {
    const ext = extname(p.path).slice(1).toLowerCase();
    if (ext in EXT_TO_LANG) return EXT_TO_LANG[ext];
    throw new Error(`cannot detect language from extension "${ext}"`);
  }
  throw new Error("must specify language or path (for ext detection)");
}

async function loadSource(p: { code?: string; path?: string }): Promise<{ code: string; path?: string }> {
  if (p.code !== undefined) return { code: p.code };
  if (p.path) {
    const abs = resolvePath(p.path);
    if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
    return { code: readFileSync(abs, "utf8"), path: abs };
  }
  throw new Error("must provide 'code' or 'path'");
}

function nodeToJson(node: Node, depth: number, maxDepth: number, withText: boolean, maxTextLen: number): any {
  const o: any = {
    type: node.type,
    start: { row: node.startPosition.row, col: node.startPosition.column },
    end: { row: node.endPosition.row, col: node.endPosition.column },
  };
  if (node.isError || node.isMissing) {
    o.error = node.isError ? "syntax_error" : "missing";
  }
  const hasNamed = (() => {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.isNamed) return true;
    }
    return false;
  })();
  if (!hasNamed) {
    if (withText) o.text = node.text.slice(0, maxTextLen);
    return o;
  }
  if (depth >= maxDepth) {
    o.truncated = true;
    o.child_count = node.namedChildCount;
    return o;
  }
  o.children = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.isNamed) o.children.push(nodeToJson(c, depth + 1, maxDepth, withText, maxTextLen));
  }
  return o;
}

function nodeLine(code: string, startRow: number): string {
  const lines = code.split(/\r?\n/);
  return lines[startRow] ?? "";
}

async function parseAction(p: {
  code?: string; path?: string; language?: string;
  format?: "json" | "sexp";
  max_depth?: number;
  with_text?: boolean;
}): Promise<any> {
  const lang = detectLang(p);
  const parser = await getParser(lang);
  const src = await loadSource(p);
  const tree: Tree = parser.parse(src.code)!;
  const format = p.format ?? "json";
  const errors: any[] = [];
  (function walk(n: Node) {
    if (n.isError || n.isMissing) {
      errors.push({
        type: n.type,
        kind: n.isError ? "error" : "missing",
        start: { row: n.startPosition.row, col: n.startPosition.column },
        end: { row: n.endPosition.row, col: n.endPosition.column },
      });
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
  })(tree.rootNode);
  const base = { language: lang, path: src.path, has_errors: errors.length > 0, error_count: errors.length, errors: errors.slice(0, 20) };
  if (format === "sexp") {
    return { ...base, sexp: tree.rootNode.toString() };
  }
  return {
    ...base,
    tree: nodeToJson(tree.rootNode, 0, p.max_depth ?? 8, p.with_text ?? false, 80),
  };
}

async function queryAction(p: {
  code?: string; path?: string; language?: string; query: string;
  limit?: number;
}): Promise<any> {
  const lang = detectLang(p);
  const parser = await getParser(lang);
  const src = await loadSource(p);
  const tree = parser.parse(src.code)!;
  const language = await getLanguage(lang);
  const query = language.query(p.query);
  const matches = query.matches(tree.rootNode);
  const limit = p.limit ?? 500;
  const results = [] as any[];
  for (const m of matches) {
    if (results.length >= limit) break;
    const captures = m.captures.map((c: any) => ({
      name: c.name,
      type: c.node.type,
      start: { row: c.node.startPosition.row, col: c.node.startPosition.column },
      end: { row: c.node.endPosition.row, col: c.node.endPosition.column },
      text: c.node.text.slice(0, 200),
    }));
    results.push({ pattern_index: m.patternIndex, captures });
  }
  return { language: lang, path: src.path, match_count: results.length, truncated: results.length === limit, matches: results };
}

function sliceLines(code: string, startLine1: number, endLine1: number): string {
  const lines = code.split(/\r?\n/);
  const s = Math.max(0, startLine1 - 1);
  const e = Math.min(lines.length, endLine1);
  return lines.slice(s, e).join("\n");
}

async function findDefs(p: {
  code?: string; path?: string; language?: string;
  with_body?: boolean;
  context_before?: number;
  context_after?: number;
}): Promise<any> {
  const lang = detectLang(p);
  const q = DEFINITION_QUERIES[lang];
  if (!q) throw new Error(`no definition query defined for "${lang}"`);
  const parser = await getParser(lang);
  const src = await loadSource(p);
  const tree = parser.parse(src.code)!;
  const language = await getLanguage(lang);
  const query = language.query(q);
  const matches = query.matches(tree.rootNode);
  const defs: any[] = [];
  const before = p.context_before ?? 0;
  const after = p.context_after ?? 0;
  for (const m of matches) {
    let kindCapture: any, nameCapture: any;
    for (const c of m.captures) {
      if (c.name === "name") nameCapture = c;
      else kindCapture = c;
    }
    if (!kindCapture || !nameCapture) continue;
    const startLine = kindCapture.node.startPosition.row + 1;
    const endLine = kindCapture.node.endPosition.row + 1;
    const entry: any = {
      kind: kindCapture.name,
      name: nameCapture.node.text,
      start_line: startLine,
      end_line: endLine,
      signature: nodeLine(src.code, kindCapture.node.startPosition.row).trim().slice(0, 200),
    };
    if (p.with_body) {
      entry.body = sliceLines(src.code, Math.max(1, startLine - before), endLine + after);
    } else if (before > 0 || after > 0) {
      entry.context = sliceLines(src.code, Math.max(1, startLine - before), startLine + after);
    }
    defs.push(entry);
  }
  defs.sort((a, b) => a.start_line - b.start_line);
  const byKind: Record<string, number> = {};
  for (const d of defs) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return { language: lang, path: src.path, total: defs.length, by_kind: byKind, definitions: defs };
}

async function scanProject(p: {
  root: string;
  patterns?: string[];
  language?: string;
  exclude?: string[];
  max_files?: number;
  max_files_reported?: number;
  include_signatures?: boolean;
  limit_per_file?: number;
  follow_symlinks?: boolean;
}): Promise<any> {
  let langFilter: LangId | undefined;
  if (p.language) {
    const l = p.language.toLowerCase();
    if (l in EXT_TO_LANG) langFilter = EXT_TO_LANG[l];
    else if ((Object.values(EXT_TO_LANG) as string[]).includes(l)) langFilter = l as LangId;
    else throw new Error(`unknown language: "${p.language}"`);
  }
  const patterns = buildPatterns({ language: langFilter, patterns: p.patterns });
  const files = await findFiles({
    root: p.root,
    patterns,
    exclude: p.exclude,
    max_files: p.max_files,
    follow_symlinks: p.follow_symlinks,
  });
  const byLanguage: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const fileReports: any[] = [];
  const errors: any[] = [];
  let totalDefs = 0;
  const includeSigs = p.include_signatures !== false;
  const limitPerFile = p.limit_per_file ?? 200;
  const maxReported = p.max_files_reported ?? 200;

  for (const file of files) {
    let ext = file.split(".").pop()?.toLowerCase() ?? "";
    if (!(ext in EXT_TO_LANG)) continue;
    const lang = EXT_TO_LANG[ext];
    if (langFilter && lang !== langFilter) continue;
    if (!DEFINITION_QUERIES[lang]) continue;
    try {
      const r = await findDefs({ path: file });
      totalDefs += r.total;
      byLanguage[lang] = (byLanguage[lang] ?? 0) + r.total;
      for (const [k, v] of Object.entries(r.by_kind as Record<string, number>)) {
        byKind[k] = (byKind[k] ?? 0) + v;
      }
      if (fileReports.length < maxReported) {
        fileReports.push({
          path: file,
          language: lang,
          total: r.total,
          definitions: r.definitions.slice(0, limitPerFile).map((d: any) => {
            const o: any = { kind: d.kind, name: d.name, line: d.start_line };
            if (includeSigs) o.signature = d.signature;
            return o;
          }),
        });
      }
    } catch (e: any) {
      errors.push({ path: file, error: e.message });
    }
  }
  return {
    root: p.root,
    patterns,
    files_matched: files.length,
    files_scanned: fileReports.length + errors.length,
    files_truncated: fileReports.length >= maxReported,
    total_definitions: totalDefs,
    by_language: byLanguage,
    by_kind: byKind,
    errors,
    files: fileReports,
  };
}

async function findCalls(p: { code?: string; path?: string; language?: string }): Promise<any> {
  const lang = detectLang(p);
  const q = CALL_QUERIES[lang];
  if (!q) throw new Error(`no call query defined for "${lang}"`);
  const parser = await getParser(lang);
  const src = await loadSource(p);
  const tree = parser.parse(src.code)!;
  const language = await getLanguage(lang);
  const query = language.query(q);
  const matches = query.matches(tree.rootNode);
  const calls: any[] = [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    let name = "";
    for (const c of m.captures) if (c.name === "name") name = c.node.text;
    if (!name) continue;
    calls.push({
      name,
      line: m.captures[0].node.startPosition.row + 1,
    });
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count }));
  return { language: lang, path: src.path, total: calls.length, top_callees: top, calls: calls.slice(0, 500) };
}

async function findImports(p: { code?: string; path?: string; language?: string }): Promise<any> {
  const lang = detectLang(p);
  const q = IMPORT_QUERIES[lang];
  if (!q) throw new Error(`no import query defined for "${lang}"`);
  const parser = await getParser(lang);
  const src = await loadSource(p);
  const tree = parser.parse(src.code)!;
  const language = await getLanguage(lang);
  const query = language.query(q);
  const matches = query.matches(tree.rootNode);
  const imports: any[] = [];
  for (const m of matches) {
    const moduleCap = m.captures.find((c: any) => c.name === "module");
    const importCap = m.captures.find((c: any) => c.name === "import");
    const any = importCap ?? m.captures[0];
    imports.push({
      module: moduleCap?.node.text.replace(/^["']|["']$/g, ""),
      line: any.node.startPosition.row + 1,
      raw: any.node.text.slice(0, 200),
    });
  }
  return { language: lang, path: src.path, total: imports.length, imports };
}

async function outline(p: { code?: string; path?: string; language?: string }): Promise<any> {
  const defs = await findDefs(p);
  const outlineLines: string[] = [];
  outlineLines.push(`# ${defs.path ?? "<inline>"} [${defs.language}]`);
  outlineLines.push(`# ${defs.total} definitions`);
  for (const d of defs.definitions) {
    const indent = d.kind === "method" ? "  " : "";
    outlineLines.push(`${indent}L${d.start_line}: ${d.kind} ${d.name}`);
  }
  return { language: defs.language, path: defs.path, total: defs.total, outline: outlineLines.join("\n"), definitions: defs.definitions };
}

function listLanguages() {
  const names = Object.values(EXT_TO_LANG);
  const unique = [...new Set(names)];
  return {
    count: unique.length,
    languages: unique.map((l) => ({
      id: l,
      has_definition_query: l in DEFINITION_QUERIES,
      has_call_query: l in CALL_QUERIES,
      has_import_query: l in IMPORT_QUERIES,
      wasm_bundled: existsSync(wasmPath(l as LangId)),
    })),
    extension_map: EXT_TO_LANG,
  };
}

function textContent(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}
function errContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const server = new McpServer({ name: "tree-sitter", version: "0.1.0" });

server.tool(
  "tree_sitter",
  `Parse source code at the AST level via tree-sitter (WASM grammars).

Sources:
- code: inline string
- path: file path (language auto-detected from extension)
- language: explicit id (python / javascript / typescript / tsx / go / rust / c / cpp / java / ruby / bash / json / yaml / html / css / php)

Actions:
- list_languages: inventory of supported languages + which queries (definitions / calls / imports) are pre-defined.
- parse: parse source and return the AST as JSON (max_depth default 8, with_text optional for leaves) or S-expression (format='sexp'). Includes syntax error locations.
- find_definitions: list every function / class / method / struct / trait / interface / etc. Returns {kind, name, start_line, end_line, signature}.
- find_calls: list call sites (and top_callees counts).
- find_imports: list import statements.
- outline: find_definitions + human-readable outline text.
- query: run an arbitrary tree-sitter S-expression query against the source. Captures named @name are returned with {name, type, start, end, text}.
- scan: walk a directory (fast-glob), run find_definitions on every matching file, aggregate. Use 'language' to filter, 'patterns' to override the glob, 'exclude' to add ignore patterns. Defaults exclude node_modules/dist/build/.git/target/venv/.venv/__pycache__/coverage/.next/out, *.min.js, *.min.css, *.map.

find_definitions options:
- with_body: include lines start..end as 'body'
- context_before / context_after: include N lines of extra context

Example queries — see README.`,
  {
    action: z.enum(["list_languages", "parse", "query", "find_definitions", "find_calls", "find_imports", "outline", "scan"]).describe("Action"),
    code: z.string().optional().describe("Inline source code"),
    path: z.string().optional().describe("Source file path (lang auto-detected from ext)"),
    language: z.string().optional().describe("Explicit language id (py/js/ts/... or full name)"),
    query: z.string().optional().describe("query action: S-expression query"),
    format: z.enum(["json", "sexp"]).optional().describe("parse: output format (default json)"),
    max_depth: z.number().int().positive().optional().describe("parse: max tree depth (default 8)"),
    with_text: z.boolean().optional().describe("parse: include leaf node text"),
    limit: z.number().int().positive().optional().describe("query: max matches (default 500)"),
    with_body: z.boolean().optional().describe("find_definitions: include lines start..end as 'body'"),
    context_before: z.number().int().nonnegative().optional().describe("find_definitions: N lines before start"),
    context_after: z.number().int().nonnegative().optional().describe("find_definitions: N lines after start (or after end with with_body)"),
    // scan
    root: z.string().optional().describe("scan: directory to walk"),
    patterns: z.union([z.array(z.string()), z.string()]).optional().describe("scan: glob patterns (overrides language default)"),
    exclude: z.union([z.array(z.string()), z.string()]).optional().describe("scan: extra exclude globs (added to defaults)"),
    max_files: z.number().int().positive().optional().describe("scan: cap number of files to scan (default 500)"),
    max_files_reported: z.number().int().positive().optional().describe("scan: cap number of per-file results in output (default 200)"),
    include_signatures: z.boolean().optional().describe("scan: include signature text per definition (default true)"),
    limit_per_file: z.number().int().positive().optional().describe("scan: cap definitions per file (default 200)"),
    follow_symlinks: z.boolean().optional(),
  },
  async (p) => {
    try {
      switch (p.action) {
        case "list_languages":
          return textContent(listLanguages());
        case "parse":
          return textContent(await parseAction(p));
        case "query": {
          if (!p.query) return errContent("query requires 'query'");
          return textContent(await queryAction({ ...p, query: p.query }));
        }
        case "find_definitions":
          return textContent(await findDefs(p));
        case "scan": {
          if (!p.root) return errContent("scan requires 'root'");
          return textContent(await scanProject({
            root: p.root,
            patterns: coerceObject<string[]>(p.patterns),
            language: p.language,
            exclude: coerceObject<string[]>(p.exclude),
            max_files: p.max_files,
            max_files_reported: p.max_files_reported,
            include_signatures: p.include_signatures,
            limit_per_file: p.limit_per_file,
            follow_symlinks: p.follow_symlinks,
          }));
        }
        case "find_calls":
          return textContent(await findCalls(p));
        case "find_imports":
          return textContent(await findImports(p));
        case "outline":
          return textContent(await outline(p));
      }
    } catch (err: any) {
      return errContent(`${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
    }
    return errContent("unreachable");
  },
);

async function main() {
  await initParser();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
