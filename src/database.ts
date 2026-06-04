import * as path from "path";
import * as vscode from "vscode";
// sql.js は CommonJS。型は any で扱う（@types は無いため）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require("sql.js");

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowsModified: number;
  /** SELECT 系で結果セットが返ったか */
  hasResultSet: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: number;
  defaultValue: any;
}

export interface TableInfo {
  name: string;
  type: "table" | "view";
}

/** 列フィルタ条件（演算子はホワイトリスト管理） */
export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value?: any;
}

export type FilterOp =
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "equals"
  | "notEquals"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "empty"
  | "notEmpty";

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

let SQL: any | undefined;

/** sql.js (wasm) を初期化。wasm ファイルは node_modules/sql.js/dist に同梱。 */
async function getSqlJs(): Promise<any> {
  if (SQL) {
    return SQL;
  }
  const sqlJsDir = path.dirname(require.resolve("sql.js"));
  SQL = await initSqlJs({
    locateFile: (file: string) => path.join(sqlJsDir, file)
  });
  return SQL;
}

/**
 * 1 つの SQLite ファイルを表す。sql.js はメモリ上で動作するため、
 * 変更後は export() してファイルへ書き戻す。
 */
export class SqliteDatabase {
  private db: any;
  private constructor(public readonly uri: vscode.Uri, db: any) {
    this.db = db;
  }

  static async open(uri: vscode.Uri): Promise<SqliteDatabase> {
    const sql = await getSqlJs();
    const bytes = await vscode.workspace.fs.readFile(uri);
    const db = new sql.Database(bytes);
    return new SqliteDatabase(uri, db);
  }

  get fileName(): string {
    return path.basename(this.uri.fsPath);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /** 変更をファイルへ書き戻す */
  async save(): Promise<void> {
    const data: Uint8Array = this.db.export();
    await vscode.workspace.fs.writeFile(this.uri, data);
  }

  /** テーブル / ビューの一覧 */
  listTables(): TableInfo[] {
    const res = this.exec(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    );
    return res.rows.map((r) => ({ name: String(r[0]), type: r[1] as any }));
  }

  /** テーブルの列情報 */
  columns(table: string): ColumnInfo[] {
    const res = this.exec(`PRAGMA table_info(${quoteId(table)})`);
    return res.rows.map((r) => ({
      name: String(r[1]),
      type: String(r[2] ?? ""),
      notNull: !!r[3],
      defaultValue: r[4],
      pk: Number(r[5] ?? 0)
    }));
  }

  /** このテーブルが rowid を持つか（編集時の行特定に使用） */
  hasRowId(table: string): boolean {
    try {
      this.db.exec(`SELECT rowid FROM ${quoteId(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  rowCount(table: string, filters: ColumnFilter[] = []): number {
    const where = buildWhere(filters);
    const res = this.selectRows(
      `SELECT COUNT(*) FROM ${quoteId(table)}${where.clause}`,
      where.params
    );
    return Number(res.rows[0]?.[0] ?? 0);
  }

  /**
   * テーブルデータをページングして取得。フィルタ・並べ替えを適用可能。
   * rowid テーブルなら __rowid として rowid を付与し、編集の行特定に使う。
   */
  selectTable(
    table: string,
    limit: number,
    offset: number,
    filters: ColumnFilter[] = [],
    sort: SortSpec | null = null
  ): { columns: string[]; rows: any[][]; rowIds: (number | null)[]; hasRowId: boolean } {
    const hasRowId = this.hasRowId(table);
    const where = buildWhere(filters);
    const order = buildOrder(sort);
    const select = hasRowId ? "rowid AS __rowid__, *" : "*";
    const sql =
      `SELECT ${select} FROM ${quoteId(table)}${where.clause}${order} LIMIT ? OFFSET ?`;
    const res = this.selectRows(sql, [...where.params, limit, offset]);
    if (!hasRowId) {
      return { columns: res.columns, rows: res.rows, rowIds: res.rows.map(() => null), hasRowId };
    }
    const rowIds = res.rows.map((r) => Number(r[0]));
    const columns = res.columns.slice(1);
    const rows = res.rows.map((r) => r.slice(1));
    return { columns, rows, rowIds, hasRowId };
  }

  /** バインド付きの SELECT を実行し、列名と行を返す */
  private selectRows(sql: string, params: any[] = []): { columns: string[]; rows: any[][] } {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const columns: string[] = stmt.getColumnNames();
      const rows: any[][] = [];
      while (stmt.step()) {
        rows.push(stmt.get());
      }
      return { columns, rows };
    } finally {
      stmt.free();
    }
  }

  /** 任意 SQL を実行（複数ステートメント可）。最後の結果セットを返す。 */
  exec(sql: string): QueryResult {
    const results = this.db.exec(sql); // [{columns, values}, ...]
    const rowsModified = this.db.getRowsModified();
    if (!results || results.length === 0) {
      return { columns: [], rows: [], rowsModified, hasResultSet: false };
    }
    const last = results[results.length - 1];
    return {
      columns: last.columns as string[],
      rows: last.values as any[][],
      rowsModified,
      hasResultSet: true
    };
  }

  /** プリペアドステートメントで安全に実行（バインド付き） */
  run(sql: string, params: any[] = []): number {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    return this.db.getRowsModified();
  }

  // ---- CRUD --------------------------------------------------------------

  updateCell(table: string, rowid: number, column: string, value: any): number {
    const sql = `UPDATE ${quoteId(table)} SET ${quoteId(column)} = ? WHERE rowid = ?`;
    return this.run(sql, [value, rowid]);
  }

  /** PK / UNIQUE 列の組で行を特定して更新（rowid が無いテーブル用） */
  updateCellByKeys(
    table: string,
    keys: { column: string; value: any }[],
    column: string,
    value: any
  ): number {
    const where = keys.map((k) => `${quoteId(k.column)} = ?`).join(" AND ");
    const sql = `UPDATE ${quoteId(table)} SET ${quoteId(column)} = ? WHERE ${where}`;
    return this.run(sql, [value, ...keys.map((k) => k.value)]);
  }

  insertRow(table: string, values: Record<string, any>): number {
    const cols = Object.keys(values);
    if (cols.length === 0) {
      // 全列デフォルトで 1 行追加
      return this.run(`INSERT INTO ${quoteId(table)} DEFAULT VALUES`);
    }
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quoteId(table)} (${cols
      .map(quoteId)
      .join(", ")}) VALUES (${placeholders})`;
    return this.run(sql, cols.map((c) => values[c]));
  }

  deleteByRowId(table: string, rowid: number): number {
    return this.run(`DELETE FROM ${quoteId(table)} WHERE rowid = ?`, [rowid]);
  }

  deleteByKeys(table: string, keys: { column: string; value: any }[]): number {
    const where = keys.map((k) => `${quoteId(k.column)} = ?`).join(" AND ");
    return this.run(`DELETE FROM ${quoteId(table)} WHERE ${where}`, keys.map((k) => k.value));
  }
}

/** SQLite 識別子を安全にクォート */
export function quoteId(id: string): string {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

/** LIKE 用に特殊文字（% _ \）をエスケープ */
function likeEscape(v: any): string {
  return String(v ?? "").replace(/[\\%_]/g, (c) => "\\" + c);
}

/** フィルタ配列から WHERE 句とバインド値を生成（値はすべてパラメータ化） */
function buildWhere(filters: ColumnFilter[]): { clause: string; params: any[] } {
  if (!filters || filters.length === 0) {
    return { clause: "", params: [] };
  }
  const parts: string[] = [];
  const params: any[] = [];
  for (const f of filters) {
    if (!f || !f.column) {
      continue;
    }
    const col = quoteId(f.column);
    switch (f.op) {
      case "contains":
        parts.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`%${likeEscape(f.value)}%`);
        break;
      case "notContains":
        parts.push(`(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`);
        params.push(`%${likeEscape(f.value)}%`);
        break;
      case "startsWith":
        parts.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`${likeEscape(f.value)}%`);
        break;
      case "endsWith":
        parts.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`%${likeEscape(f.value)}`);
        break;
      case "equals":
        parts.push(`${col} = ?`);
        params.push(f.value);
        break;
      case "notEquals":
        parts.push(`(${col} IS NULL OR ${col} <> ?)`);
        params.push(f.value);
        break;
      case "gt":
        parts.push(`${col} > ?`);
        params.push(f.value);
        break;
      case "ge":
        parts.push(`${col} >= ?`);
        params.push(f.value);
        break;
      case "lt":
        parts.push(`${col} < ?`);
        params.push(f.value);
        break;
      case "le":
        parts.push(`${col} <= ?`);
        params.push(f.value);
        break;
      case "empty":
        parts.push(`(${col} IS NULL OR ${col} = '')`);
        break;
      case "notEmpty":
        parts.push(`(${col} IS NOT NULL AND ${col} <> '')`);
        break;
      default:
        break;
    }
  }
  if (parts.length === 0) {
    return { clause: "", params: [] };
  }
  return { clause: " WHERE " + parts.join(" AND "), params };
}

/** 並べ替え指定から ORDER BY 句を生成 */
function buildOrder(sort: SortSpec | null): string {
  if (!sort || !sort.column) {
    return "";
  }
  const dir = sort.dir === "desc" ? "DESC" : "ASC";
  return ` ORDER BY ${quoteId(sort.column)} ${dir}`;
}
