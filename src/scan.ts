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
    return [`**/*.{${exts.join(",")}}`];
  }
  const allExts = Object.keys(EXT_TO_LANG);
  return [`**/*.{${allExts.join(",")}}`];
}

export async function findFiles(opts: {
  root: string;
  patterns: string[];
  exclude?: string[];
  max_files?: number;
  follow_symlinks?: boolean;
}): Promise<string[]> {
  const root = resolvePath(opts.root);
  const ignore = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])];
  const files = await fg(opts.patterns, {
    cwd: root,
    absolute: true,
    ignore,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: opts.follow_symlinks === true,
  });
  const max = opts.max_files ?? 500;
  return files.slice(0, max);
}
