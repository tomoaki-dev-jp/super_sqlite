import * as vscode from "vscode";
import { DatabaseManager } from "./manager";

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN", "INDEX",
  "VIEW", "TRIGGER", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS",
  "ON", "USING", "AS", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "DISTINCT", "ALL", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "GLOB",
  "BETWEEN", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END", "UNION",
  "INTERSECT", "EXCEPT", "ASC", "DESC", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "UNIQUE", "CHECK", "DEFAULT", "AUTOINCREMENT", "INTEGER",
  "TEXT", "REAL", "BLOB", "NUMERIC", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "TOTAL", "ABS", "ROUND", "LENGTH", "LOWER", "UPPER", "SUBSTR", "REPLACE",
  "COALESCE", "IFNULL", "DATE", "TIME", "DATETIME", "STRFTIME", "PRAGMA",
  "VACUUM", "REINDEX", "EXPLAIN", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION"
];

/**
 * .sql / .spl ファイル向けの SQL 補完。
 * 開いているデータベースのテーブル名・列名と SQL キーワードを補完する。
 * `テーブル名.` と入力した場合はそのテーブルの列のみを返す。
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private manager: DatabaseManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);

    // テーブル名. の直後なら、その列だけ返す
    const dotted = /([A-Za-z_]\w*)\.\w*$/.exec(linePrefix);
    if (dotted) {
      return this.columnItems(dotted[1]);
    }

    const items: vscode.CompletionItem[] = [];

    // 開いている DB のテーブル / 列
    const seenCols = new Set<string>();
    for (const db of this.manager.list()) {
      for (const t of this.safeTables(db)) {
        const item = new vscode.CompletionItem(
          t.name,
          t.type === "view"
            ? vscode.CompletionItemKind.Interface
            : vscode.CompletionItemKind.Struct
        );
        item.detail = `${db.fileName} の${t.type === "view" ? "ビュー" : "テーブル"}`;
        item.sortText = "0_" + t.name;
        items.push(item);

        for (const c of this.safeColumns(db, t.name)) {
          const lc = c.toLowerCase();
          if (seenCols.has(lc)) {
            continue;
          }
          seenCols.add(lc);
          const col = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
          col.detail = "列";
          col.sortText = "1_" + c;
          items.push(col);
        }
      }
    }

    // SQL キーワード
    for (const k of SQL_KEYWORDS) {
      const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
      item.sortText = "2_" + k;
      items.push(item);
    }

    return items;
  }

  private columnItems(tableName: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    for (const db of this.manager.list()) {
      const match = this.safeTables(db).find(
        (t) => t.name.toLowerCase() === tableName.toLowerCase()
      );
      if (!match) {
        continue;
      }
      for (const c of this.safeColumns(db, match.name)) {
        const lc = c.toLowerCase();
        if (seen.has(lc)) {
          continue;
        }
        seen.add(lc);
        const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
        item.detail = `${match.name} の列`;
        items.push(item);
      }
    }
    return items;
  }

  private safeTables(db: { listTables: () => { name: string; type: string }[] }) {
    try {
      return db.listTables();
    } catch {
      return [];
    }
  }

  private safeColumns(db: { columns: (t: string) => { name: string }[] }, table: string): string[] {
    try {
      return db.columns(table).map((c) => c.name);
    } catch {
      return [];
    }
  }
}
