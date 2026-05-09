#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
// NodeJS.ErrnoException-shaped check without depending on @types
function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}
import { createRequire } from "node:module";
import { dirname, extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import Parser from "web-tree-sitter";
type SyntaxNode = Parser.SyntaxNode;
type Tree = Parser.Tree;
type Language = Parser.Language;
type Query = Parser.Query;
type QueryCapture = Parser.QueryCapture;

import {
  DEFINITION_QUERIES,
  CALL_QUERIES,
  IMPORT_QUERIES,
  EXT_TO_LANG,
  type LangId,
} from "./queries.js";
import { buildPatterns, findFiles } from "./scan.js";

const require = createRequire(import.meta.url);

// ─── version (B14) ───────────────────────────────────────────────────────────
const PKG = (() => {
  try {
    const pkgPath = require.resolve("../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
  } catch {
    return { name: "tree-sitter", version: "0.0.0" };
  }
})();

// ─── env / sandbox config (S1, S4, S5, S6) ───────────────────────────────────
const ALLOW_ANY_PATH = process.env.TREE_SITTER_ALLOW_ANY_PATH === "1";
const ALLOW_REGEX_PREDICATES = process.env.TREE_SITTER_ALLOW_REGEX_PREDICATES === "1";
const MCP_ROOT = (() => {
  const raw = process.env.TREE_SITTER_MCP_ROOT ?? process.cwd();
  try {
    return realpathSync(resolvePath(raw));
  } catch {
    return resolvePath(raw);
  }
})();
const MAX_FILES_HARD_CAP = (() => {
  const raw = process.env.TREE_SITTER_MAX_FILES;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();
const MAX_DEPTH_HARD_CAP = 64;
const MAX_QUERY_LEN = 4096;
const MAX_QUERY_RESULTS = 10000; // S4
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB (S3)
const MAX_CONTEXT_LINES = 200; // S7
const MAX_BODY_LINES = 5000; // S7
const PER_FILE_TIMEOUT_MS = 5000; // S10
const NUL_PROBE_BYTES = 8192; // S3

// ─── safety helpers ──────────────────────────────────────────────────────────
function isUncPath(p: string): boolean {
  return /^\\\\/.test(p) || /^\/\//.test(p);
}

function assertSafePath(p: string, kind: "file" | "dir"): string {
  if (ALLOW_ANY_PATH) {
    // S2: still try to resolve through symlinks so we report a stable real path,
    // but fall back to a plain resolve for write targets / non-existent paths.
    try {
      return realpathSync(resolvePath(p));
    } catch {
      return resolvePath(p);
    }
  }
  if (isUncPath(p)) {
    throw new Error(`UNC paths not allowed: ${p}`);
  }
  const abs = resolvePath(p);
  // S4: re-check after resolving — a relative path like "\\server\share" could
  // survive the pre-resolve check but resolve to a UNC path on Windows.
  if (isUncPath(abs)) {
    throw new Error(`UNC paths not allowed: ${abs}`);
  }
  // S1: TOCTOU-safe — call realpathSync directly. Distinguish "not found"
  // from other errors by ENOENT instead of pre-checking with existsSync.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e: unknown) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      throw new Error(`${kind} not found: ${abs}`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot resolve real path for ${abs}: ${msg}`);
  }
  // realpathSync(MCP_ROOT) was already taken at startup
  const rootWithSep = MCP_ROOT.endsWith(pathSep) ? MCP_ROOT : MCP_ROOT + pathSep;
  if (real !== MCP_ROOT && !real.startsWith(rootWithSep)) {
    throw new Error(
      `path "${real}" is outside sandbox root "${MCP_ROOT}". Set TREE_SITTER_MCP_ROOT or TREE_SITTER_ALLOW_ANY_PATH=1 to override.`,
    );
  }
  return real;
}

function assertSafeRoot(p: string): string {
  return assertSafePath(p, "dir");
}

function assertSafeFile(p: string): string {
  const abs = assertSafePath(p, "file");
  let st;
  try {
    st = statSync(abs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`stat failed for ${abs}: ${msg}`);
  }
  if (st.isDirectory()) {
    throw new Error(`expected a file, got a directory: ${abs}`); // U7
  }
  if (!st.isFile()) {
    throw new Error(`not a regular file: ${abs}`);
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large (${st.size} > ${MAX_FILE_BYTES} bytes): ${abs}`);
  }
  // Binary detection — NUL byte in first 8 KiB.
  const buf = Buffer.alloc(Math.min(NUL_PROBE_BYTES, st.size));
  if (buf.length > 0) {
    const fd = openSync(abs, "r");
    try {
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    if (buf.includes(0)) {
      throw new Error(`binary file rejected (NUL byte found in first ${buf.length} bytes): ${abs}`);
    }
  }
  return abs;
}

function assertQueryString(q: string): string {
  if (q.trim().length === 0) {
    throw new Error("query must not be empty");
  }
  // S3: reject control characters in the original (pre-strip) query to block
  // covert payloads / terminal control sequences, but exclude common whitespace
  // (tab \x09, newline \x0a, carriage return \x0d).
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(q)) {
    throw new Error("query contains disallowed control characters");
  }
  // S3: strip `;[^\n]*` line comments before length-checking so attackers
  // cannot pad past MAX_QUERY_LEN with comment bytes.
  // S5: require start-of-token (whitespace/paren boundary) to avoid stripping
  // semicolons inside string literals that appear mid-token.
  const stripped = q.replace(/(^|[\s()])\s*;[^\n]*/g, "$1");
  // S2: measure UTF-8 byte length (not char length) to prevent bypass with
  // multi-byte characters that inflate byte size past MAX_QUERY_LEN.
  const byteLen = Buffer.byteLength(stripped, "utf8");
  if (byteLen > MAX_QUERY_LEN) {
    throw new Error(`query too long (${byteLen} bytes > ${MAX_QUERY_LEN} after stripping comments)`);
  }
  if (!ALLOW_REGEX_PREDICATES) {
    if (/#match\?/i.test(q) || /#not-match\?/i.test(q)) {
      throw new Error(
        `#match? / #not-match? predicates rejected by default. Set TREE_SITTER_ALLOW_REGEX_PREDICATES=1 to enable.`,
      );
    }
  }
  return q;
}

function clampDepth(n: number | undefined, def: number): number {
  const v = n ?? def;
  return Math.min(Math.max(1, v), MAX_DEPTH_HARD_CAP);
}

function clampContext(n: number | undefined): number {
  const v = n ?? 0;
  return Math.min(Math.max(0, v), MAX_CONTEXT_LINES);
}

// ─── coerce helper (S8) ──────────────────────────────────────────────────────
// Claude Code の LLM ツール呼び出しパスで array/object 引数が
// JSON 文字列化された状態で届く事があるので、両対応にする。
function coerceStringArray(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    for (const e of v) if (typeof e !== "string") throw new Error("expected array of strings");
    return v;
  }
  if (typeof v !== "string") throw new Error("expected array or JSON-encoded array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error(`expected JSON array, got unparseable string: ${v.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`expected JSON array, got ${typeof parsed}`);
  }
  for (const e of parsed) {
    if (typeof e !== "string") throw new Error("array elements must be strings");
  }
  return parsed as string[];
}

// ─── parser/grammar caches (B13, B15) ────────────────────────────────────────
const langCache = new Map<LangId, Language>();
const parserCache = new Map<LangId, Parser>();

function wasmPath(lang: LangId): string {
  const pkgPath = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgPath), "out", `tree-sitter-${lang}.wasm`);
}

let listLanguagesCache: ReturnType<typeof buildListLanguages> | null = null;

async function initParser(): Promise<void> {
  await Parser.init();
}

async function getLanguage(lang: LangId): Promise<Language> {
  const cached = langCache.get(lang);
  if (cached) return cached;
  const path = wasmPath(lang);
  if (!existsSync(path)) {
    // U6
    throw new Error(
      `grammar not bundled for "${lang}" (looked at ${path}). Run action "list_languages" to see which languages are available.`,
    );
  }
  const LanguageCtor = (Parser as unknown as { Language: { load(p: string): Promise<Language> } }).Language;
  const l = await LanguageCtor.load(path);
  langCache.set(lang, l);
  return l;
}

async function getParser(lang: LangId): Promise<Parser> {
  const cached = parserCache.get(lang);
  // B1: parser.reset() only matters mid-parse; calling it between parses is a no-op.
  if (cached) return cached;
  const language = await getLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

// Note: parsers are cached per language and reused. Trees are explicitly
// .delete()'d in finally blocks (B8).

function detectLang(p: { language?: string; path?: string; code?: string }): LangId {
  if (p.language) {
    const l = p.language.toLowerCase();
    if (l in EXT_TO_LANG) return EXT_TO_LANG[l]!;
    if (Object.values(EXT_TO_LANG).includes(l as LangId)) return l as LangId;
    throw new Error(`unknown language: "${p.language}"`);
  }
  if (p.path) {
    const ext = extname(p.path).slice(1).toLowerCase(); // B10
    if (ext in EXT_TO_LANG) return EXT_TO_LANG[ext]!;
    throw new Error(`cannot detect language from extension "${ext}"`);
  }
  throw new Error("must specify language or path (for ext detection)");
}

async function loadSource(p: { code?: string; path?: string }): Promise<{ code: string; path?: string }> {
  if (p.code !== undefined) return { code: p.code };
  if (p.path) {
    const abs = assertSafeFile(p.path);
    // B2: read as Buffer then decode with fatal:false so non-UTF-8 bytes are
    // replaced with U+FFFD instead of throwing — consistent with other MCPs.
    const buf = readFileSync(abs);
    const code = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { code, path: abs };
  }
  throw new Error("must provide 'code' or 'path'");
}

// ─── line cache for one call (B7) ────────────────────────────────────────────
class LineIndex {
  private lines: string[];
  constructor(code: string) {
    this.lines = code.split(/\r?\n/);
  }
  line(row0: number): string {
    return this.lines[row0] ?? "";
  }
  slice(start1: number, end1: number, hardCap: number): { text: string; truncated: boolean } {
    const s = Math.max(0, start1 - 1);
    const e = Math.min(this.lines.length, end1);
    const want = Math.max(0, e - s);
    const cap = Math.min(want, hardCap);
    const truncated = want > cap;
    return { text: this.lines.slice(s, s + cap).join("\n"), truncated };
  }
}

// ─── nodeToJson (B5) ─────────────────────────────────────────────────────────
function nodeToJson(
  node: SyntaxNode,
  code: string,
  depth: number,
  maxDepth: number,
  withText: boolean,
  maxTextLen: number,
): unknown {
  const o: Record<string, unknown> = {
    type: node.type,
    start: { row: node.startPosition.row, col: node.startPosition.column },
    end: { row: node.endPosition.row, col: node.endPosition.column },
  };
  if (node.isError || node.isMissing) {
    o.error = node.isError ? "syntax_error" : "missing";
  }
  let hasNamed = false;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.isNamed) {
      hasNamed = true;
      break;
    }
  }
  if (!hasNamed) {
    if (withText) {
      // B5: avoid node.text whole-leaf allocation
      const leafLen = node.endIndex - node.startIndex;
      o.text = code.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + maxTextLen));
      // B10: surface that we truncated the leaf so callers don't think the
      // sliced bytes are the full leaf.
      if (leafLen > maxTextLen) o.text_truncated = true;
    }
    return o;
  }
  if (depth >= maxDepth) {
    o.truncated = true;
    o.child_count = node.namedChildCount;
    return o;
  }
  const children: unknown[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.isNamed) children.push(nodeToJson(c, code, depth + 1, maxDepth, withText, maxTextLen));
  }
  o.children = children;
  return o;
}

// Drains an action (parses + uses tree, then deletes tree). Parser is cached.
// B3: fn only receives tree — callers should not hold a reference to the parser
// since the parser is reused and must not be called again until fn resolves.
async function withTree<T>(lang: LangId, code: string, fn: (tree: Tree) => Promise<T> | T): Promise<T> {
  const parser = await getParser(lang);
  const maybeTree = parser.parse(code);
  if (!maybeTree) throw new Error(`parser returned null tree for language "${lang}"`); // B9
  const tree: Tree = maybeTree;
  try {
    return await fn(tree);
  } finally {
    try {
      tree.delete();
    } catch {
      /* ignore */
    }
  }
}

async function withQuery<T>(language: Language, source: string, fn: (q: Query) => Promise<T> | T): Promise<T> {
  assertQueryString(source);
  const q = language.query(source);
  try {
    return await fn(q);
  } finally {
    try {
      q.delete();
    } catch {
      /* ignore */
    }
  }
}

// ─── parse ───────────────────────────────────────────────────────────────────
async function parseAction(p: {
  code?: string;
  path?: string;
  language?: string;
  format?: "json" | "sexp";
  max_depth?: number;
  with_text?: boolean;
}): Promise<unknown> {
  const lang = detectLang(p);
  const src = await loadSource(p);
  return withTree(lang, src.code, (tree) => {
    const format = p.format ?? "json";
    const errors: unknown[] = [];
    (function walk(n: SyntaxNode) {
      if (n.isError || n.isMissing) {
        errors.push({
          type: n.type,
          kind: n.isError ? "error" : "missing",
          start: { row: n.startPosition.row, col: n.startPosition.column },
          end: { row: n.endPosition.row, col: n.endPosition.column },
        });
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) walk(c);
      }
    })(tree.rootNode);
    const base = {
      language: lang,
      path: src.path,
      has_errors: errors.length > 0,
      error_count: errors.length,
      errors: errors.slice(0, 20),
      errors_truncated: errors.length > 20, // U5
    };
    if (format === "sexp") {
      return { ...base, sexp: tree.rootNode.toString() };
    }
    return {
      ...base,
      tree: nodeToJson(tree.rootNode, src.code, 0, clampDepth(p.max_depth, 8), p.with_text ?? false, 80),
    };
  });
}

// ─── query (B6) ──────────────────────────────────────────────────────────────
async function queryAction(p: {
  code?: string;
  path?: string;
  language?: string;
  query: string;
  limit?: number;
}): Promise<unknown> {
  const lang = detectLang(p);
  const src = await loadSource(p);
  const language = await getLanguage(lang);
  return withTree(lang, src.code, async (tree) =>
    withQuery(language, p.query, (query) => {
      const matches = query.matches(tree.rootNode);
      const limit = Math.min(p.limit ?? 500, MAX_QUERY_RESULTS); // S4
      // B1: fetch limit+1 to distinguish "exactly limit" from "more than limit",
      // avoiding a false positive when result count equals the cap.
      const lim = limit + 1;
      const results: unknown[] = [];
      for (const m of matches) {
        if (results.length >= lim) break;
        const captures = m.captures.map((c: QueryCapture) => ({
          name: c.name,
          type: c.node.type,
          start: { row: c.node.startPosition.row, col: c.node.startPosition.column },
          end: { row: c.node.endPosition.row, col: c.node.endPosition.column },
          // B6
          text: src.code.slice(c.node.startIndex, Math.min(c.node.endIndex, c.node.startIndex + 200)),
        }));
        results.push({ pattern_index: m.pattern, captures });
      }
      const wasTruncated = results.length > limit;
      results.length = Math.min(results.length, limit);
      return {
        language: lang,
        path: src.path,
        match_count: results.length,
        truncated: wasTruncated,
        matches: results,
      };
    }),
  );
}

// ─── findDefs / find_definitions (B2, B3, B11) ───────────────────────────────
const DEF_KINDS = new Set([
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "struct",
  "trait",
  "impl",
  "module",
  "constructor",
  "export",
]);

interface DefEntry {
  kind: string;
  name: string;
  start_line: number;
  end_line: number;
  signature: string;
  body?: string;
  body_truncated?: boolean;
  context?: string;
}

async function findDefsForLang(
  code: string,
  lang: LangId,
  opts: { with_body?: boolean; context_before?: number; context_after?: number },
): Promise<{ defs: DefEntry[]; byKind: Record<string, number> }> {
  const q = DEFINITION_QUERIES[lang];
  if (!q) throw new Error(`no definition query defined for "${lang}"`);
  const language = await getLanguage(lang);
  const lineIdx = new LineIndex(code);
  const before = clampContext(opts.context_before);
  const after = clampContext(opts.context_after);

  return withTree(lang, code, async (tree) =>
    withQuery(language, q, (query) => {
      const matches = query.matches(tree.rootNode);
      const defs: DefEntry[] = [];
      for (const m of matches) {
        if (m.captures.length === 0) continue; // B3
        // B2: explicit allowlist of kind names
        let kindCapture: QueryCapture | undefined;
        let nameCapture: QueryCapture | undefined;
        for (const c of m.captures) {
          if (c.name === "name") {
            nameCapture = c;
          } else if (DEF_KINDS.has(c.name) && !kindCapture) {
            kindCapture = c;
          }
        }
        if (!kindCapture || !nameCapture) continue;
        const startLine = kindCapture.node.startPosition.row + 1;
        const endLine = kindCapture.node.endPosition.row + 1;
        // B2: For decorators / annotations the kindCapture spans from the
        // decorator line, but the actual `def`/`class`/`function` keyword sits
        // on the name line. Anchor the signature to the name node's line so
        // we capture e.g. `def foo(...)` instead of `@decorator`.
        const sigRow = nameCapture.node.startPosition.row;
        const entry: DefEntry = {
          kind: kindCapture.name,
          name: nameCapture.node.text,
          start_line: startLine,
          end_line: endLine,
          signature: lineIdx.line(sigRow).trim().slice(0, 200),
        };
        if (opts.with_body) {
          const sliced = lineIdx.slice(Math.max(1, startLine - before), endLine + after, MAX_BODY_LINES);
          entry.body = sliced.text;
          if (sliced.truncated) entry.body_truncated = true; // U5
        } else if (before > 0 || after > 0) {
          // context_after is relative to the end of the definition body, not its start line.
          const sliced = lineIdx.slice(Math.max(1, startLine - before), endLine + after, MAX_BODY_LINES);
          entry.context = sliced.text;
        }
        defs.push(entry);
      }
      defs.sort((a, b) => a.start_line - b.start_line);
      // B7: when several patterns match the same definition (e.g. Go's
      // generic @type plus the more specific @struct/@interface), keep the
      // more specific kind. Dedupe by (start_line, name).
      const KIND_RANK: Record<string, number> = {
        struct: 3,
        interface: 3,
        class: 3,
        enum: 3,
        trait: 3,
        type: 1,
      };
      const seen = new Map<string, DefEntry>();
      for (const d of defs) {
        const key = `${d.start_line}:${d.name}`;
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, d);
          continue;
        }
        const prevRank = KIND_RANK[prev.kind] ?? 2;
        const curRank = KIND_RANK[d.kind] ?? 2;
        if (curRank > prevRank) seen.set(key, d);
      }
      const dedupedDefs = [...seen.values()].sort((a, b) => a.start_line - b.start_line);
      const byKind: Record<string, number> = {};
      for (const d of dedupedDefs) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      return { defs: dedupedDefs, byKind };
    }),
  );
}

async function findDefs(p: {
  code?: string;
  path?: string;
  language?: string;
  with_body?: boolean;
  context_before?: number;
  context_after?: number;
}): Promise<unknown> {
  const lang = detectLang(p);
  const src = await loadSource(p);
  const { defs, byKind } = await findDefsForLang(src.code, lang, p);
  return { language: lang, path: src.path, total: defs.length, by_kind: byKind, definitions: defs };
}

// ─── scan (S2, S4, S9, S10, B11, B12, B18) ───────────────────────────────────
async function scanProject(p: {
  root: string;
  patterns?: string[];
  language?: string;
  exclude?: string[];
  max_files?: number;
  max_files_reported?: number;
  include_signatures?: boolean;
  limit_per_file?: number;
}): Promise<unknown> {
  const safeRoot = assertSafeRoot(p.root); // S9
  let langFilter: LangId | undefined;
  if (p.language) {
    const l = p.language.toLowerCase();
    if (l in EXT_TO_LANG) langFilter = EXT_TO_LANG[l]!;
    else if ((Object.values(EXT_TO_LANG) as string[]).includes(l)) langFilter = l as LangId;
    else throw new Error(`unknown language: "${p.language}"`);
  }
  const patterns = buildPatterns({ language: langFilter, patterns: p.patterns });
  const requestedMax = p.max_files ?? 500;
  const cappedMax = Math.min(requestedMax, MAX_FILES_HARD_CAP); // S4
  const files = await findFiles({
    root: safeRoot,
    patterns,
    exclude: p.exclude,
    max_files: cappedMax,
  });

  const byLanguage: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const fileReports: unknown[] = [];
  // B4: dropped misleading `fatal` flag — we never actually break on it.
  const errors: { path: string; error: string }[] = [];
  let totalDefs = 0;
  let scannedCount = 0; // B12
  const includeSigs = p.include_signatures !== false;
  const limitPerFile = p.limit_per_file ?? 200;
  const maxReported = p.max_files_reported ?? 200;

  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase(); // B10
    if (!(ext in EXT_TO_LANG)) continue;
    const lang = EXT_TO_LANG[ext]!;
    if (langFilter && lang !== langFilter) continue;
    if (!DEFINITION_QUERIES[lang]) continue;

    let safeAbs: string;
    try {
      safeAbs = assertSafeFile(file); // S1, S3
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ path: file, error: msg }); // recoverable (B18)
      continue;
    }

    let code: string;
    try {
      // B2: Buffer + fatal:false TextDecoder for consistent non-UTF-8 handling.
      const buf = readFileSync(safeAbs);
      code = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ path: safeAbs, error: `read failed: ${msg}` });
      continue;
    }

    // S10: per-file wall-clock timeout via Promise.race.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`scan timeout after ${PER_FILE_TIMEOUT_MS}ms`)),
        PER_FILE_TIMEOUT_MS,
      );
    });

    // C1: keep defsP in scope so the timeout catch can await it to settle.
    // The cached Parser is not re-entrant; we must not start the next file's
    // parse until the current one finishes (even if we already timed out).
    const defsP = findDefsForLang(code, lang, {});
    // Attach early catch so a timeout-abandoned promise never becomes an
    // unhandled rejection.
    defsP.catch(() => undefined);
    try {
      const r = await Promise.race([defsP, timeoutP]);
      scannedCount++;
      totalDefs += r.defs.length;
      byLanguage[lang] = (byLanguage[lang] ?? 0) + r.defs.length;
      for (const [k, v] of Object.entries(r.byKind)) {
        byKind[k] = (byKind[k] ?? 0) + v;
      }
      if (fileReports.length < maxReported) {
        fileReports.push({
          path: safeAbs,
          language: lang,
          total: r.defs.length,
          definitions: r.defs.slice(0, limitPerFile).map((d) => {
            const o: Record<string, unknown> = { kind: d.kind, name: d.name, line: d.start_line };
            if (includeSigs) o.signature = d.signature;
            return o;
          }),
        });
      }
    } catch (e: unknown) {
      // B4: no `fatal` flag — every per-file error is recoverable here.
      const errObj = e instanceof Error ? e : new Error(String(e));
      errors.push({ path: safeAbs, error: `${errObj.name}: ${errObj.message}` });
      // C1: if we timed out, defsP may still be using the cached parser.
      // Wait up to 1 s for it to settle before moving to the next file so we
      // don't start a concurrent parse on the same Parser instance.
      if (errObj.message.startsWith("scan timeout")) {
        const graceP = new Promise<void>((res) => setTimeout(res, 1000));
        await Promise.race([defsP.then(() => undefined, () => undefined), graceP]);
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
  const errorsCap = 200;
  const errorsOut = errors.slice(0, errorsCap);
  return {
    root: safeRoot,
    patterns,
    files_matched: files.length,
    files_scanned: scannedCount, // B12
    // B5: only mark truncated when the number of scanned files exceeds the
    // per-file report cap. Comparing fileReports.length >= maxReported was
    // off-by-one and false-positives at exact boundary.
    files_truncated: scannedCount > maxReported,
    total_definitions: totalDefs,
    by_language: byLanguage,
    by_kind: byKind,
    errors: errorsOut,
    errors_truncated: errors.length > errorsCap, // U5
    files: fileReports,
    sandbox_root: MCP_ROOT,
    max_files_cap: MAX_FILES_HARD_CAP,
  };
}

// ─── findCalls (B3) ──────────────────────────────────────────────────────────
async function findCalls(p: { code?: string; path?: string; language?: string }): Promise<unknown> {
  const lang = detectLang(p);
  const q = CALL_QUERIES[lang];
  if (!q) throw new Error(`no call query defined for "${lang}"`);
  const src = await loadSource(p);
  const language = await getLanguage(lang);
  return withTree(lang, src.code, async (tree) =>
    withQuery(language, q, (query) => {
      const matches = query.matches(tree.rootNode);
      const calls: { name: string; line: number }[] = [];
      const counts = new Map<string, number>();
      for (const m of matches) {
        if (m.captures.length === 0) continue; // B3
        let name = "";
        let nameCap: QueryCapture | undefined;
        for (const c of m.captures) {
          if (c.name === "name") {
            name = c.node.text;
            nameCap = c;
            break;
          }
        }
        if (!name || !nameCap) continue;
        // U12: PHP qualified names look like `Foo\Bar\baz` — normalize to the
        // last segment so the top_callees ranking groups by the actual called
        // function name rather than its namespace path.
        if (lang === "php" && name.includes("\\")) {
          name = name.split("\\").pop() ?? name;
        }
        calls.push({ name, line: nameCap.node.startPosition.row + 1 });
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([name, count]) => ({ name, count }));
      return { language: lang, path: src.path, total: calls.length, top_callees: top, calls: calls.slice(0, 500) };
    }),
  );
}

// ─── findImports (B4) ────────────────────────────────────────────────────────
async function findImports(p: { code?: string; path?: string; language?: string }): Promise<unknown> {
  const lang = detectLang(p);
  const q = IMPORT_QUERIES[lang];
  if (!q) throw new Error(`no import query defined for "${lang}"`);
  const src = await loadSource(p);
  const language = await getLanguage(lang);
  return withTree(lang, src.code, async (tree) =>
    withQuery(language, q, (query) => {
      const matches = query.matches(tree.rootNode);
      const imports: { module: string | undefined; line: number; raw: string }[] = [];
      for (const m of matches) {
        if (m.captures.length === 0) continue; // B4
        const moduleCap = m.captures.find((c: QueryCapture) => c.name === "module");
        const importCap = m.captures.find((c: QueryCapture) => c.name === "import");
        const anchor = importCap ?? m.captures[0];
        if (!anchor) continue; // B4
        const moduleText = moduleCap?.node.text.replace(/^["']|["']$/g, "");
        imports.push({
          module: moduleText,
          line: anchor.node.startPosition.row + 1,
          raw: src.code.slice(anchor.node.startIndex, Math.min(anchor.node.endIndex, anchor.node.startIndex + 200)),
        });
      }
      return { language: lang, path: src.path, total: imports.length, imports };
    }),
  );
}

// ─── outline ─────────────────────────────────────────────────────────────────
async function outline(p: { code?: string; path?: string; language?: string }): Promise<unknown> {
  const defs = (await findDefs(p)) as {
    language: LangId;
    path?: string;
    total: number;
    definitions: DefEntry[];
  };
  const outlineLines: string[] = [];
  outlineLines.push(`# ${defs.path ?? "<inline>"} [${defs.language}]`);
  outlineLines.push(`# ${defs.total} definitions`);
  // C3: compute nesting with a sort+stack (O(N log N)) instead of O(N²) nested
  // loop. Sort by start_line, maintain a stack of enclosing definitions, pop
  // entries whose end_line is before the current definition's start_line.
  const sorted = [...defs.definitions].sort((a, b) => a.start_line - b.start_line);
  const stack: DefEntry[] = [];
  const levelMap = new Map<DefEntry, number>();
  for (const d of sorted) {
    while (stack.length && (stack[stack.length - 1] as DefEntry).end_line < d.start_line) stack.pop();
    levelMap.set(d, stack.length);
    stack.push(d);
  }
  for (const d of defs.definitions) {
    const level = levelMap.get(d) ?? 0;
    const indent = "  ".repeat(level);
    outlineLines.push(`${indent}L${d.start_line}: ${d.kind} ${d.name}`);
  }
  return {
    language: defs.language,
    path: defs.path,
    total: defs.total,
    outline: outlineLines.join("\n"),
    definitions: defs.definitions,
  };
}

// ─── find_references (U13) ───────────────────────────────────────────────────
async function findReferences(p: {
  code?: string;
  path?: string;
  language?: string;
  name: string;
  limit?: number;
}): Promise<unknown> {
  if (!p.name) throw new Error("find_references requires 'name'");
  const lang = detectLang(p);
  const src = await loadSource(p);
  const limit = Math.min(p.limit ?? 1000, MAX_QUERY_RESULTS); // S4
  const targetName = p.name.normalize("NFC"); // B9
  const results: { line: number; col: number; context: string }[] = [];
  const lineIdx = new LineIndex(src.code);
  return withTree(lang, src.code, (tree) => {
    // Walk all nodes; collect identifier-like leaves whose text == name.
    // Imperfect (no scoping) but matches U13 spec.
    const targetTypes = new Set([
      "identifier",
      "type_identifier",
      "property_identifier",
      "field_identifier",
      "shorthand_property_identifier",
      "name",
      "constant",
      "word",
      "command_name",
    ]);
    // C2: node types whose subtrees we must not walk. Covers all string/comment
    // variants across grammars so template_substitution (and similar) nodes
    // inside template literals are never mistaken for real references.
    const SKIP_TYPES = new Set([
      "comment",
      "string",
      "template_string",
      "string_fragment",
      "interpreted_string_literal",
      "raw_string_literal",
    ]);
    let truncated = false;
    (function walk(n: SyntaxNode): boolean {
      if (results.length >= limit) {
        truncated = true;
        return true;
      }
      // Do not recurse into comments or string literals — identifier-shaped
      // tokens inside them are not real references.
      if (SKIP_TYPES.has(n.type)) {
        return false;
      }
      if (targetTypes.has(n.type)) {
        const text = src.code.slice(n.startIndex, n.endIndex).normalize("NFC"); // B9
        if (text === targetName) {
          results.push({
            line: n.startPosition.row + 1,
            col: n.startPosition.column + 1,
            context: lineIdx.line(n.startPosition.row).trim().slice(0, 200),
          });
        }
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c) continue;
        if (walk(c)) return true;
      }
      return false;
    })(tree.rootNode);
    return {
      language: lang,
      path: src.path,
      name: p.name,
      total: results.length,
      truncated,
      references: results,
      note: "lexical match only — does not respect scoping or shadowing",
    };
  });
}

// ─── node_at (U14) ───────────────────────────────────────────────────────────
async function nodeAt(p: {
  code?: string;
  path?: string;
  language?: string;
  row: number;
  col: number;
  named?: boolean;
}): Promise<unknown> {
  if (typeof p.row !== "number" || typeof p.col !== "number") {
    throw new Error("node_at requires numeric 'row' (0-indexed) and 'col' (0-indexed)");
  }
  // S5: defensively clamp row/col to non-negative finite ints in case a caller
  // bypasses the zod schema (e.g. direct invocation, future schema relaxation).
  if (!Number.isFinite(p.row) || !Number.isFinite(p.col)) {
    throw new Error("node_at requires finite numeric 'row' and 'col'");
  }
  // U8: clamp row/col as defense-in-depth; Zod already enforces nonnegative int,
  // but direct/internal callers may bypass the schema.
  const safeRow = Math.max(0, Math.floor(p.row));
  const safeCol = Math.max(0, Math.floor(p.col));
  const lang = detectLang(p);
  const src = await loadSource(p);
  return withTree(lang, src.code, (tree) => {
    const point = { row: safeRow, column: safeCol };
    const node = (p.named ?? true)
      ? tree.rootNode.namedDescendantForPosition(point)
      : tree.rootNode.descendantForPosition(point);
    if (!node) {
      return { language: lang, path: src.path, row: safeRow, col: safeCol, node: null };
    }
    const ancestors: { type: string; start_row: number; end_row: number }[] = [];
    let cur: SyntaxNode | null = node.parent;
    while (cur) {
      ancestors.push({ type: cur.type, start_row: cur.startPosition.row, end_row: cur.endPosition.row });
      cur = cur.parent;
      if (ancestors.length > 32) break;
    }
    return {
      language: lang,
      path: src.path,
      row: safeRow,
      col: safeCol,
      node: {
        type: node.type,
        start: { row: node.startPosition.row, col: node.startPosition.column },
        end: { row: node.endPosition.row, col: node.endPosition.column },
        text: src.code.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 200)),
        is_named: node.isNamed,
      },
      ancestors,
    };
  });
}

// ─── list_languages (B15) ────────────────────────────────────────────────────
function buildListLanguages() {
  const names = Object.values(EXT_TO_LANG);
  const unique = [...new Set(names)];
  return {
    count: unique.length,
    languages: unique.map((l) => ({
      id: l,
      has_definition_query: l in DEFINITION_QUERIES,
      has_call_query: l in CALL_QUERIES,
      has_import_query: l in IMPORT_QUERIES,
      wasm_bundled: existsSync(wasmPath(l)),
    })),
    extension_map: EXT_TO_LANG,
  };
}

function listLanguages() {
  if (!listLanguagesCache) listLanguagesCache = buildListLanguages();
  return listLanguagesCache;
}

// ─── MCP tool plumbing ───────────────────────────────────────────────────────
function textContent(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}
function errContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const server = new McpServer({ name: PKG.name ?? "tree-sitter", version: PKG.version ?? "0.0.0" }); // B14

server.tool(
  "tree_sitter",
  `Parse source code at the AST level via tree-sitter (WASM grammars).

Sources:
- code: inline string
- path: file path (language auto-detected from extension)
- language: explicit id (python / javascript / typescript / tsx / go / rust / c / cpp / java / ruby / bash / json / yaml / html / css / php)

Sandbox:
- All file paths must live under TREE_SITTER_MCP_ROOT (defaults to server CWD).
- Set TREE_SITTER_ALLOW_ANY_PATH=1 to disable the sandbox check.
- Files larger than 10 MiB or containing NUL bytes in the first 8 KiB are rejected.

Actions and required params:
- list_languages: (no params) inventory of supported languages + which queries (definitions / calls / imports) are pre-defined.
- parse: requires (code|path) + optional language. Returns AST as JSON (max_depth default 8) or S-expression (format='sexp').
- query: requires (code|path) + query (S-expression). Captures @name returned with {name, type, start, end, text}. #match? / #not-match? predicates blocked unless TREE_SITTER_ALLOW_REGEX_PREDICATES=1.
- find_definitions: requires (code|path). Lists every function / class / method / struct / trait / interface / etc.
- find_calls: requires (code|path). Lists call sites + top_callees ranking. Supported: Python/JS/TS/TSX/Go/Rust/C/C++/Java/Ruby/Bash/PHP. Not supported for JSON/YAML/HTML/CSS — those languages return an error.
- find_imports: requires (code|path). Lists import statements. Supported: Python/JS/TS/TSX/Go/Rust only — other languages return an error.
- outline: requires (code|path). find_definitions + human-readable outline text.
- find_references: requires (code|path) + name. Lexical identifier match — does not respect scope or shadowing. (limit default 1000)
- node_at: requires (code|path) + row + col (both 0-indexed). Optional: named (default true). Returns AST node at the given position with ancestors.
- scan: requires root. Walks a directory (fast-glob), runs find_definitions on every matching file, aggregates. Per-file timeout 5s. Symlinks never followed.

find_definitions options:
- with_body: include lines start..end as 'body' (capped at 5000 lines)
- context_before / context_after: include up to 200 lines of extra context

Example queries — see README.`,
  {
    action: z
      .enum([
        "list_languages",
        "parse",
        "query",
        "find_definitions",
        "find_calls",
        "find_imports",
        "outline",
        "scan",
        "find_references",
        "node_at",
      ])
      .describe(
        "Action: list_languages | parse | query | find_definitions | find_calls | find_imports | outline | scan | find_references | node_at",
      ),
    code: z.string().optional().describe("Inline source code (alternative to 'path')"),
    path: z.string().optional().describe("Source file path (must live under TREE_SITTER_MCP_ROOT). Lang auto-detected from ext."),
    language: z.string().optional().describe("Explicit language id. Full names: python|py / javascript|js / typescript|ts / tsx / go / rust|rs / c / cpp|cc / java / ruby|rb / bash|sh / json / yaml|yml / html|htm / css / php. find_imports supports python/js/ts/tsx/go/rust only."),
    query: z
      .string()
      .optional()
      .describe("Required when action=query. S-expression query (max 4096 bytes after stripping ; comments)."),
    format: z.enum(["json", "sexp"]).optional().describe("parse: output format (default json)"),
    max_depth: z.number().int().positive().optional().describe("parse: max tree depth (default 8, server cap 64)"),
    with_text: z.boolean().optional().describe("parse: include leaf node text"),
    // U2: explicit per-action defaults. U5 mirrors find_references default.
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max results. Defaults: query=500, find_references=1000. Hard cap 10000 across both actions.",
      ),
    with_body: z.boolean().optional().describe("find_definitions: include lines start..end as 'body' (max 5000 lines)"),
    context_before: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("find_definitions: N lines before start (max 200)"),
    context_after: z
      .number()
      .int()
      .nonnegative()
      .optional()
      // U1: context_after is anchored to the definition END, not its start line.
      .describe("find_definitions: N lines after the definition end (max 200)"),
    name: z.string().optional().describe("Required when action=find_references. Identifier to search for."),
    // U7: row/col stay nominally optional in the union schema (because most
    // actions don't need them) but are validated as required at the action
    // dispatch site for node_at, with a clear error message.
    row: z.number().int().nonnegative().optional().describe("Required when action=node_at. 0-indexed row (non-negative integer)."),
    col: z.number().int().nonnegative().optional().describe("Required when action=node_at. 0-indexed column (non-negative integer)."),
    named: z
      .boolean()
      .optional()
      .describe("node_at: Optional: named (default true). If true, use namedDescendantForPosition; otherwise descendantForPosition."),
    // scan
    root: z
      .string()
      .optional()
      .describe("Required when action=scan. Directory to walk (must live under TREE_SITTER_MCP_ROOT). Files >10 MiB or containing a NUL byte in the first 8 KiB are skipped into errors[]."),
    patterns: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("scan: glob patterns (overrides language default)"),
    exclude: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("scan: extra exclude globs (added to defaults)"),
    max_files: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("scan: cap number of files to scan (default 500, hard cap TREE_SITTER_MAX_FILES=5000)"),
    max_files_reported: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("scan: cap number of per-file results in output (default 200)"),
    include_signatures: z.boolean().optional().describe("scan: include signature text per definition (default true)"),
    limit_per_file: z.number().int().positive().optional().describe("scan: cap definitions per file (default 200)"),
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
          return textContent(
            await scanProject({
              root: p.root,
              patterns: coerceStringArray(p.patterns),
              language: p.language,
              exclude: coerceStringArray(p.exclude),
              max_files: p.max_files,
              max_files_reported: p.max_files_reported,
              include_signatures: p.include_signatures,
              limit_per_file: p.limit_per_file,
            }),
          );
        }
        case "find_calls":
          return textContent(await findCalls(p));
        case "find_imports":
          return textContent(await findImports(p));
        case "outline":
          return textContent(await outline(p));
        case "find_references": {
          if (!p.name) return errContent("find_references requires 'name'");
          return textContent(await findReferences({ ...p, name: p.name }));
        }
        case "node_at": {
          // U7: node_at requires row & col — enforce here since the union
          // schema cannot make them required only for one action variant.
          if (typeof p.row !== "number" || typeof p.col !== "number") {
            return errContent(
              "node_at requires both 'row' and 'col' (non-negative 0-indexed integers).",
            );
          }
          return textContent(await nodeAt({ ...p, row: p.row, col: p.col }));
        }
        default: {
          // U12: exhaustiveness check
          const _exh: never = p.action;
          return errContent(`unknown action: ${String(_exh)}`);
        }
      }
    } catch (err: unknown) {
      // B19, B20
      const errObj = err instanceof Error ? err : null;
      const cls = errObj?.name ?? "Error";
      const msg = errObj?.message ?? String(err);
      console.error(`[tree-sitter-mcp] ${cls}: ${msg}`);
      if (errObj?.stack) console.error(errObj.stack);
      return errContent(`${cls}: ${msg}`);
    }
  },
);

async function main() {
  await initParser();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
