<div align="center">

# tree-sitter-mcp

### tree-sitter で構文レベルのコード解析を LLM から叩く MCP サーバー

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](src/index.ts)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](package.json)
[![tree-sitter](https://img.shields.io/badge/tree--sitter-WASM-5C5EF9?style=flat)](https://tree-sitter.github.io/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF?style=flat)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

**grep より構文精度、`ast-grep` より軽量。プロジェクト全体の「全関数」「全クラス」「importグラフ」が一瞬。**

---

</div>

## 概要

grep ベースの検索は「`def foo` 含む行」しか分からない。tree-sitter は**字句レベルではなく AST レベル**で、「関数定義の名前ノード」「呼び出し式の被呼び出し名」等を正確に抜き出せる。

WASM 版 (`web-tree-sitter`) + prebuilt grammar (`tree-sitter-wasms`) で動くので native ビルド不要。Windows/macOS/Linux 同じ体験。

## 特徴

| アクション | 用途 |
|---|---|
| `list_languages` | サポート言語一覧 + 各言語でどのクエリ（definitions / calls / imports）が定義済みか |
| `parse` | AST を JSON または S 式で返す。`max_depth` / `with_text` 制御、構文エラー位置も |
| `find_definitions` | 関数 / メソッド / クラス / 構造体 / トレイト / インターフェース / 型エイリアス 等を全列挙（`{kind, name, start_line, end_line, signature}`） |
| `find_calls` | 呼び出し式を全列挙 + `top_callees` ランキング |
| `find_imports` | import 文を全抽出（Python / JS / TS / Go / Rust） |
| `outline` | 人間可読なアウトライン文字列 |
| `query` | 任意の S 式クエリ実行（フル tree-sitter クエリ言語） |
| `scan` | ディレクトリ再帰スキャン (`fast-glob`)。全ファイルで `find_definitions` を走らせて言語別 / kind 別集計 + 各ファイルの定義一覧を返す。デフォルト除外: `node_modules` / `dist` / `build` / `.git` / `target` / `venv` / `.venv` / `__pycache__` / `coverage` / `.next` / `out` / `*.min.js` / `*.min.css` / `*.map` |

`find_definitions` オプション (v0.2 追加):
- `with_body: true` — `start..end` のコード本文を `body` に含める
- `context_before: N` / `context_after: N` — 定義前後 N 行のコンテキストを `context` に含める

## 対応言語

Python / JavaScript / TypeScript / TSX / Go / Rust / C / C++ / Java / Ruby / Bash / JSON / YAML / HTML / CSS / PHP

（`tree-sitter-wasms` に含まれる全 prebuilt grammar。definition クエリは主要言語のみ実装済み）

## インストール

```bash
git clone https://github.com/cUDGk/tree-sitter-mcp.git
cd tree-sitter-mcp && npm install && npm run build
```

## 使い方

```bash
claude mcp add tree-sitter -- node C:/Users/user/Desktop/tree-sitter-mcp/dist/index.js
```

### 呼び出し例

プロジェクト全 Python 関数一覧（LLM は find_definitions を各ファイルで叩く）:
```json
{"action": "find_definitions", "path": "C:/proj/app.py"}
```

応答:
```json
{
  "language": "python",
  "total": 12,
  "by_kind": {"function": 10, "class": 2},
  "definitions": [
    {"kind": "function", "name": "main", "start_line": 42, "end_line": 67,
     "signature": "def main(argv: list[str]) -> int:"},
    {"kind": "class", "name": "Config", "start_line": 10, "end_line": 41,
     "signature": "class Config:"}
  ]
}
```

インライン文字列でも OK（パスを渡さず `code` を直接）:
```json
{"action": "outline", "language": "typescript",
 "code": "export class Foo { bar() {} baz() {} }"}
```

任意の S 式クエリ:
```json
{"action": "query", "language": "python",
 "code": "x = 1\ny = x + 2",
 "query": "(binary_operator) @bin"}
```

プロジェクト全体スキャン（Python のみ、tests/ を除外）:
```json
{"action": "scan", "root": "C:/proj",
 "language": "python",
 "exclude": ["**/tests/**"],
 "max_files": 500}
```

応答 (集計例):
```json
{
  "files_matched": 27,
  "total_definitions": 143,
  "by_language": {"python": 143},
  "by_kind": {"function": 98, "class": 45},
  "files": [
    {"path": "C:/proj/src/app.py", "language": "python", "total": 8,
     "definitions": [
       {"kind": "class", "name": "Config", "line": 5, "signature": "class Config:"},
       {"kind": "function", "name": "main", "line": 42, "signature": "def main(argv: list[str]) -> int:"}
     ]}
  ]
}
```

定義の本体を丸ごと取る（LLM に関数全体を見せる用途）:
```json
{"action": "find_definitions", "path": "src/app.py", "with_body": true}
```

## 設計メモ

- **native ビルド不要**: `web-tree-sitter` (WASM) + prebuilt `tree-sitter-wasms` で、node-gyp の痛みを回避
- **言語自動検出**: `path` を渡せば拡張子から判定、`language` で明示上書き可
- **max_depth でトークン節約**: AST 丸ごと渡すと LLM のコンテキストが焼けるので `parse` は深さ上限あり
- **`query` はエスケープハッチ**: find_definitions / find_calls / find_imports でカバーできない抽出は S 式で書ける

## Attribution

- [tree-sitter](https://tree-sitter.github.io/) / [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter)
- [tree-sitter-wasms](https://www.npmjs.com/package/tree-sitter-wasms) — prebuilt grammar バンドル
- [Model Context Protocol](https://modelcontextprotocol.io/)

## ライセンス

MIT License © 2026 cUDGk — 詳細は [LICENSE](LICENSE) を参照。
