import * as vscode from "vscode";
import { DatabaseManager } from "./manager";
import { SqliteDatabase, ColumnFilter, SortSpec } from "./database";

const PAGE_SIZE = 200;

/** データベース 1 つにつき 1 つの Webview パネル */
export class DatabasePanel {
  private static panels = new Map<string, DatabasePanel>();

  /** 現在のデータビューに適用中のフィルタ・並べ替え（行の追加/削除後の再読込でも維持） */
  private filters: ColumnFilter[] = [];
  private sort: SortSpec | null = null;

  static show(
    context: vscode.ExtensionContext,
    manager: DatabaseManager,
    uri: vscode.Uri,
    initialTable?: string,
    runSql?: string
  ): void {
    const key = uri.toString();
    const existing = DatabasePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (initialTable) {
        existing.post({ type: "openTable", table: initialTable });
      }
      if (runSql != null) {
        existing.post({ type: "runExternalSql", sql: runSql });
      }
      return;
    }
    const db = manager.get(uri);
    if (!db) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "superSqlite.panel",
      db.fileName,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
      }
    );
    DatabasePanel.panels.set(
      key,
      new DatabasePanel(context, manager, db, panel, initialTable, runSql)
    );
  }

  private constructor(
    context: vscode.ExtensionContext,
    private manager: DatabaseManager,
    private db: SqliteDatabase,
    private panel: vscode.WebviewPanel,
    private initialTable?: string,
    private pendingSql?: string
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(context, panel.webview);

    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      DatabasePanel.panels.delete(this.db.uri.toString());
    });
  }

  private post(msg: any): void {
    this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          this.post({
            type: "init",
            dbName: this.db.fileName,
            tables: this.db.listTables(),
            schema: this.buildSchema(),
            initialTable: this.initialTable
          });
          if (this.pendingSql != null) {
            this.post({ type: "runExternalSql", sql: this.pendingSql });
            this.pendingSql = undefined;
          }
          break;

        case "loadTable":
          this.filters = Array.isArray(msg.filters) ? msg.filters : [];
          this.sort = msg.sort ?? null;
          this.sendTable(msg.table, msg.page ?? 0);
          break;

        case "runQuery":
          this.runQuery(msg.sql);
          break;

        case "updateCell":
          this.updateCell(msg);
          break;

        case "insertRow":
          await this.mutate(() => this.db.insertRow(msg.table, msg.values ?? {}));
          this.sendTable(msg.table, msg.page ?? 0);
          break;

        case "deleteRow":
          this.deleteRow(msg);
          break;

        case "refresh":
          await this.manager.reload(this.db.uri);
          this.db = this.manager.get(this.db.uri)!;
          this.post({
            type: "init",
            dbName: this.db.fileName,
            tables: this.db.listTables(),
            schema: this.buildSchema()
          });
          break;
      }
    } catch (e: any) {
      this.post({ type: "error", message: String(e?.message ?? e) });
      vscode.window.showErrorMessage(`Super SQLite: ${e?.message ?? e}`);
    }
  }

  /** 変更を加えてファイルへ保存 */
  private async mutate(fn: () => number): Promise<number> {
    const affected = fn();
    await this.db.save();
    this.manager.refresh();
    return affected;
  }

  /** 自動補完用に「テーブル名 -> 列名一覧」のスキーマを作る */
  private buildSchema(): Record<string, string[]> {
    const schema: Record<string, string[]> = {};
    for (const t of this.db.listTables()) {
      try {
        schema[t.name] = this.db.columns(t.name).map((c) => c.name);
      } catch {
        schema[t.name] = [];
      }
    }
    return schema;
  }

  private sendTable(table: string, page: number): void {
    const total = this.db.rowCount(table, this.filters);
    const offset = page * PAGE_SIZE;
    const data = this.db.selectTable(table, PAGE_SIZE, offset, this.filters, this.sort);
    const cols = this.db.columns(table);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    this.post({
      type: "tableData",
      table,
      columns: data.columns,
      rows: data.rows,
      rowIds: data.rowIds,
      hasRowId: data.hasRowId,
      pkColumns: pkCols,
      columnMeta: cols,
      page,
      pageSize: PAGE_SIZE,
      total,
      filters: this.filters,
      sort: this.sort
    });
  }

  private runQuery(sql: string): void {
    const trimmed = (sql ?? "").trim();
    if (!trimmed) {
      return;
    }
    const before = Date.now();
    const res = this.db.exec(trimmed);
    const elapsed = Date.now() - before;
    // 変更系なら保存してツリーも更新
    const lower = trimmed.toLowerCase();
    const isMutation = /\b(insert|update|delete|create|drop|alter|replace|vacuum|reindex)\b/.test(
      lower
    );
    if (isMutation) {
      this.db
        .save()
        .then(() => this.manager.refresh())
        .catch(() => undefined);
    }
    this.post({
      type: "queryResult",
      columns: res.columns,
      rows: res.rows,
      hasResultSet: res.hasResultSet,
      rowsModified: res.rowsModified,
      elapsed,
      isMutation
    });
  }

  private async updateCell(msg: any): Promise<void> {
    const value = normalize(msg.value, msg.isNull);
    if (msg.hasRowId && typeof msg.rowid === "number") {
      await this.mutate(() => this.db.updateCell(msg.table, msg.rowid, msg.column, value));
    } else if (Array.isArray(msg.keys) && msg.keys.length > 0) {
      await this.mutate(() => this.db.updateCellByKeys(msg.table, msg.keys, msg.column, value));
    } else {
      throw new Error("この行は主キー / rowid が無いため編集できません。");
    }
    this.post({ type: "cellSaved", reqId: msg.reqId });
  }

  private async deleteRow(msg: any): Promise<void> {
    if (msg.hasRowId && typeof msg.rowid === "number") {
      await this.mutate(() => this.db.deleteByRowId(msg.table, msg.rowid));
    } else if (Array.isArray(msg.keys) && msg.keys.length > 0) {
      await this.mutate(() => this.db.deleteByKeys(msg.table, msg.keys));
    } else {
      throw new Error("この行は主キー / rowid が無いため削除できません。");
    }
    this.sendTable(msg.table, msg.page ?? 0);
  }

  private html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const nonce = getNonce();
    const asset = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", f));
    const csp =
      `default-src 'none'; img-src ${webview.cspSource}; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${asset("main.css")}" />
  <title>Super SQLite</title>
</head>
<body>
  <div id="toolbar">
    <select id="tableSelect" title="テーブル / ビュー"></select>
    <div class="tabs">
      <button class="tab active" data-tab="data">データ</button>
      <button class="tab" data-tab="query">SQL</button>
    </div>
    <span class="spacer"></span>
    <button id="addRowBtn" title="行を追加">＋ 行</button>
    <button id="refreshBtn" title="再読込">↻</button>
    <span id="status"></span>
  </div>

  <div id="dataView" class="view">
    <div id="grid"></div>
    <div id="pager">
      <button id="prevPage">‹ 前</button>
      <span id="pageInfo"></span>
      <button id="nextPage">次 ›</button>
    </div>
  </div>

  <div id="queryView" class="view hidden">
    <div class="editor-wrap">
      <textarea id="sqlEditor" spellcheck="false" placeholder="SELECT * FROM ...   (Ctrl+Enter で実行)"></textarea>
      <div class="editor-actions">
        <button id="runBtn">▶ 実行 (Ctrl+Enter)</button>
        <span id="queryStatus"></span>
      </div>
    </div>
    <div id="queryResult"></div>
  </div>

  <script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
  }
}

function normalize(value: any, isNull: boolean): any {
  if (isNull) {
    return null;
  }
  return value;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
