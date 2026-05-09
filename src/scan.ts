import fg from "fast-glob";
import { EXT_TO_LANG, type LangId } from "./queries.js";
import { resolve as resolvePath } from "node:path";

export const LANG_TO_EXTS: Partial<Record<LangId, string[]>> = (() => {
  const m: Partial<Record<LangId, string[]>> = {};
  for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
    (m[lang] ??= []).push(ext);
  }
  return m;
})();

export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/target/**",
  "**/venv/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/out/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];

export function buildPatterns(p: {
  language?: LangId;
  patterns?: string[];
}): string[] {
  if (p.patterns && p.patterns.length) return p.patterns;
  if (p.language) {
    const exts = LANG_TO_EXTS[p.language];
    if (!exts) throw new Error(`no extensions registered for language ${p.language}`);
    // B12: fast-glob's brace expansion {ext} for a single ext expands to a
    // literal "{ext}" segment on some setups — sidestep it entirely.
    return exts.length === 1 ? [`**/*.${exts[0]}`] : [`**/*.{${exts.join(",")}}`];
  }
  const allExts = Object.keys(EXT_TO_LANG);
  return allExts.length === 1 ? [`**/*.${allExts[0]}`] : [`**/*.{${allExts.join(",")}}`];
}

// S1: validate glob patterns/excludes to prevent path traversal or negation
// tricks that could escape the sandbox or confuse fast-glob behaviour.
function assertSafeGlobs(globs: string[], kind: "pattern" | "exclude"): void {
  for (const g of globs) {
    if (kind === "exclude" && g.startsWith("!")) {
      throw new Error(`negated ${kind} pattern not allowed: ${g}`);
    }
    if (g.includes("..")) {
      throw new Error(`${kind} pattern must not contain "..": ${g}`);
    }
    if (kind === "pattern" && (g.startsWith("/") || g.startsWith("\\"))) {
      throw new Error(`${kind} pattern must not start with an absolute path separator: ${g}`);
    }
  }
}

export async function findFiles(opts: {
  root: string;
  patterns: string[];
  exclude?: string[];
  max_files?: number;
}): Promise<string[]> {
  const root = resolvePath(opts.root);
  assertSafeGlobs(opts.patterns, "pattern");
  const userExcludes = opts.exclude ?? [];
  assertSafeGlobs(userExcludes, "exclude");
  const ignore = [...DEFAULT_EXCLUDES, ...userExcludes];
  const files = await fg(opts.patterns, {
    cwd: root,
    absolute: true,
    ignore,
    dot: false,
    onlyFiles: true,
    // Hardcoded false for security — never follow symlinks during scan.
    followSymbolicLinks: false,
  });
  const max = opts.max_files ?? 500;
  return files.slice(0, max);
}
