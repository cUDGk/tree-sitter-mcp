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
| `find_imports` | import 文を全抽出（Python / JS / TS / TSX / Go / Rust） |
| `outline` | 人間可読なアウトライン文字列 |
| `query` | 任意の S 式クエリ実行（フル tree-sitter クエリ言語） |
| `find_references` | 指定識別子と完全一致する識別子ノードを全列挙（**スコープを考慮しない単純な字句一致** — 同名シャドウは区別されない） |
| `node_at` | `(row, col)` (両方 0 始まり) 位置の AST ノードと祖先列を返す |
| `scan` | ディレクトリ再帰スキャン (`fast-glob`)。全ファイルで `find_definitions` を走らせて言語別 / kind 別集計 + 各ファイルの定義一覧を返す。デフォルト除外: `node_modules` / `dist` / `build` / `.git` / `target` / `venv` / `.venv` / `__pycache__` / `coverage` / `.next` / `.nuxt` / `out` / `*.min.js` / `*.min.css` / `*.map` |

`find_definitions` オプション (v0.3 追加):
- `with_body: true` — `start..end` のコード本文を `body` に含める
- `context_before: N` / `context_after: N` — 定義前後 N 行のコンテキストを `context` に含める

> **Note**: `find_calls` / `find_imports` はクエリ未定義の言語に対してエラーを返す（`find_definitions` / `scan` はクエリ未定義の言語を黙ってスキップするのに対して挙動が違う）。

## 対応言語

Python / JavaScript / TypeScript / TSX / Go / Rust / C / C++ / Java / Ruby / Bash / JSON / YAML / HTML / CSS / PHP

（`tree-sitter-wasms` に含まれる全 prebuilt grammar。definition クエリは主要言語のみ実装済み）

## インストール

```bash
git clone https://github.com/cUDGk/tree-sitter-mcp.git
cd tree-sitter-mcp && npm install && npm run build
```

## 使い方

`bin` で `tree-sitter-mcp` が登録されているので、`npx` 経由で叩くのが楽:

```bash
claude mcp add tree-sitter -- npx tree-sitter-mcp
```

あるいはフルパス指定:

```bash
claude mcp add tree-sitter -- node /absolute/path/to/tree-sitter-mcp/dist/index.js
```

### 環境変数

| 変数 | デフォルト | 用途 |
|---|---|---|
| `TREE_SITTER_MCP_ROOT` | サーバの CWD | サンドボックスのルート。全ての `path` / `root` 引数はこの配下にある実パスのみ許可される。シンボリックリンクは展開してチェック。 |
| `TREE_SITTER_ALLOW_ANY_PATH` | (未設定) | `1` をセットするとサンドボックスチェックを完全に無効化（テスト・デバッグ用途） |
| `TREE_SITTER_MAX_FILES` | `5000` | `scan` の `max_files` のハードキャップ |
| `TREE_SITTER_ALLOW_REGEX_PREDICATES` | (未設定) | `1` をセットすると `query` で `#match?` / `#not-match?` を許可（デフォルトは ReDoS 回避のため拒否） |

10 MiB を超えるファイル、最初の 8 KiB に NUL バイトが含まれるバイナリは自動で拒否される。`scan` は 1 ファイルあたり 5 秒のウォールクロックタイムアウトを持ち、超過したファイルは `errors` に積んでスキップする。シンボリックリンクは常にスキップ（`follow_symlinks` は廃止）。

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

## v0.3.0 変更点

セキュリティ・バグ・UX のまとめ修正:

- **サンドボックス**: `TREE_SITTER_MCP_ROOT` 配下に `path` / `root` を制限。`realpathSync` でシンボリックリンクを展開してから判定。UNC パス (`\\server\...`) を拒否。`TREE_SITTER_ALLOW_ANY_PATH=1` で無効化可。
- **DoS 対策**: 10 MiB 超のファイル / 先頭 8 KiB 内 NUL バイト混入バイナリ / 4 KiB 超のクエリ文字列を拒否。`scan` は 5 秒のウォールクロックタイムアウト、`max_files` 上限 5000 (`TREE_SITTER_MAX_FILES`)。`max_depth` は 64 でハードキャップ。`context_before` / `context_after` は 200 行、`with_body` は 5000 行で打ち切り。
- **predicates**: `#match?` / `#not-match?` 正規表現述語はデフォルト拒否（`TREE_SITTER_ALLOW_REGEX_PREDICATES=1` で許可）。
- **新アクション**: `find_references` (字句一致のみ・スコープ非考慮)、`node_at` (`(row, col)` 位置のノード + 祖先列)。
- **クエリ拡充**: TSX に `enum_declaration` / `type_alias_declaration` を追加。`c` / `cpp` / `java` / `ruby` / `bash` / `php` の CALL_QUERIES を追加。
- **バグ**: parser は言語別にキャッシュ + 毎リクエスト `tree.delete()` / `query.delete()`。`m.captures[0]` 等の undefined 安全化。`node.text` の leaf 全アロケート → `code.slice(startIndex, ...)` に変更。`split(/\r?\n/)` を 1 リクエスト 1 回に集約。`server.version` は `package.json` から読む。
- **API 廃止**: `follow_symlinks` パラメータは削除（常に false）。

## v0.2.1 修正

Claude Code の LLM ツール呼び出しパスで、object / array 型の引数が JSON 文字列化された状態で届く事があるバグに対応。文字列で受け取っても `coerceObject()` ヘルパで解釈し直すようにし、zod schema は `z.union([<本来>, z.string()])` に緩和した。正常な object / array 経路は従来通り動作する。
