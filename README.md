# Super SQLite

> SQLite データベースを VSCode から **閲覧・編集・SQL 実行** できる拡張機能

SQLite データベースを VSCode の中だけで完結して扱えます。ネイティブモジュールのビルドが不要な [sql.js](https://github.com/sql-js/sql.js)（WebAssembly 版 SQLite）を使うため、**Windows / macOS / Linux すべてでそのまま動作**します。

![VSCode](https://img.shields.io/badge/VSCode-%5E1.90.0-007ACC?logo=visualstudiocode)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

<!--
  スクリーンショットの追加方法:
  1. docs/images/ に画像（例: screenshot.png）を置く
  2. ここに Markdown の画像記法で screenshot.png を貼る
-->


## ✨ 機能

- 📂 `.db` / `.sqlite` / `.sqlite3` / `.db3` ファイルを開く
- 🌳 アクティビティバーにテーブル / ビュー / 列をツリー表示
- 📊 テーブルデータをページング表示（1 ページ 200 行）
- ✏️ **セルのインライン編集**（ダブルクリック → 入力 → Enter で保存）
- ➕ 行の追加 / ✕ 行の削除（CRUD）
- ⚡ 任意の SQL を実行（`Ctrl+Enter`）。選択範囲だけの実行にも対応
- 💡 `.sql` / `.spl` ファイルで、開いている DB のテーブル名・列名を SQL 補完
- 💾 変更は即座に元の SQLite ファイルへ書き戻し

---

## 📦 インストール（配布された `.vsix` を受け取った方へ）

GitHub やマーケットプレイスを使わなくても、`.vsix` ファイル 1 つで導入できます。

1. 受け取った `super-sqlite-x.x.x.vsix` を分かりやすい場所に保存する
2. VSCode を開く
3. 左の **拡張機能**アイコン（四角が 4 つ）をクリック
4. 拡張機能パネル右上の **「…」** メニュー → **「VSIX からのインストール…」**
5. 保存した `.vsix` ファイルを選ぶ
6. 完了。左のアクティビティバーに **Super SQLite** のアイコンが追加されます

> コマンドからでも導入できます:
> ```bash
> code --install-extension super-sqlite-x.x.x.vsix
> ```

## 🚀 使い方

1. アクティビティバーの DB アイコン → **「データベースを開く」**
   （またはエクスプローラーで `.db` などのファイルを右クリック → 「データベースを開く」）
2. ツリーのテーブルをクリックするとデータパネルが開きます
3. セルをダブルクリックすると編集、`＋` / `✕` で行の追加・削除
4. **「SQL」タブ**で自由にクエリを実行（`Ctrl+Enter`）

---

## 🛠 開発・ビルド（配布する方／コードを見る方へ）

```bash
npm install
npm run build        # dist/extension.js を生成
```

VSCode でこのフォルダを開き、`F5`（「拡張機能を実行」）を押すと拡張機能開発ホストが起動し、その場で動作確認できます。

### 配布用の `.vsix` を作る

```bash
npm run package      # → super-sqlite-0.1.0.vsix が生成される
```

生成された `.vsix` をクラウドストレージなどで共有すれば、受け取った人は上の「インストール」手順で導入できます。

## 📁 プロジェクト構成

```
super_sqlite/
├── src/                  # TypeScript ソース
│   ├── extension.ts      #   エントリポイント・コマンド登録
│   ├── manager.ts        #   開いている DB の一元管理
│   ├── database.ts       #   sql.js ラッパ（CRUD・クエリ実行）
│   ├── treeProvider.ts   #   サイドバーのツリー表示
│   ├── panel.ts          #   データ表示／SQL 実行の Webview
│   └── completion.ts     #   SQL の入力補完
├── media/                # Webview のフロントエンド（HTML/CSS/JS・アイコン）
├── docs/images/          # README 用スクリーンショット
├── esbuild.js            # バンドル設定
└── package.json          # 拡張機能マニフェスト
```

## 💡 仕組み・注意点

- sql.js は DB ファイル全体をメモリに読み込みます。中〜小規模の DB に最適です。
- 編集は `rowid` を使って行を特定します。`WITHOUT ROWID` テーブルは主キー列で特定します。
  主キーも rowid も無いテーブルのセルは編集できません（SQL タブから操作してください）。
- セルを空欄にして確定すると、元が NULL だった場合のみ NULL を維持します。

## 📄 ライセンス

本拡張機能は **MIT License** の下で公開されています。

```
MIT License © 2026 tono
```

ソフトウェアの利用・複製・改変・再配布・販売を自由に行えます。上記の著作権表示と `LICENSE` 本文を同梱することだけが条件です。詳細は同梱の `LICENSE` ファイルを参照してください。
