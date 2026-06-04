import * as vscode from "vscode";
import { DatabaseManager } from "./manager";
import { SqliteTreeProvider } from "./treeProvider";
import { DatabasePanel } from "./panel";
import { SqlCompletionProvider } from "./completion";

export function activate(context: vscode.ExtensionContext): void {
  const manager = new DatabaseManager();
  const tree = new SqliteTreeProvider(manager);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("superSqlite.explorer", tree)
  );
  context.subscriptions.push({ dispose: () => manager.dispose() });

  const openDatabase = async (resource?: vscode.Uri) => {
    let uri = resource;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "開く",
        filters: { SQLite: ["db", "sqlite", "sqlite3", "db3"], すべて: ["*"] }
      });
      uri = picked?.[0];
    }
    if (!uri) {
      return;
    }
    try {
      await manager.open(uri);
      DatabasePanel.show(context, manager, uri);
    } catch (e: any) {
      vscode.window.showErrorMessage(`データベースを開けませんでした: ${e?.message ?? e}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("superSqlite.openDatabase", openDatabase),

    vscode.commands.registerCommand("superSqlite.refresh", () => manager.refresh()),

    vscode.commands.registerCommand("superSqlite.closeDatabase", (node?: any) => {
      const uri: vscode.Uri | undefined = node?.uri;
      if (uri) {
        manager.close(uri);
      }
    }),

    vscode.commands.registerCommand(
      "superSqlite.openTable",
      (uri: vscode.Uri, table: string) => {
        DatabasePanel.show(context, manager, uri, table);
      }
    ),

    vscode.commands.registerCommand("superSqlite.runQuery", (node?: any) => {
      const uri: vscode.Uri | undefined = node?.uri ?? manager.list()[0]?.uri;
      if (uri) {
        DatabasePanel.show(context, manager, uri);
      } else {
        openDatabase();
      }
    }),

    vscode.commands.registerCommand("superSqlite.runActiveFile", (resource?: vscode.Uri) =>
      runActiveFile(context, manager, resource)
    )
  );

  // .sql / .spl ファイルの SQL 補完（開いている DB のテーブル名・列名・キーワード）
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: "sql" }, { scheme: "file", pattern: "**/*.spl" }],
      new SqlCompletionProvider(manager),
      "."
    )
  );
}

/** アクティブな（または指定された）SQL ファイルの内容を、開いている DB に対して実行する */
async function runActiveFile(
  context: vscode.ExtensionContext,
  manager: DatabaseManager,
  resource?: vscode.Uri
): Promise<void> {
  // 実行する SQL を取得（エクスプローラから渡された場合はそのファイルを読む）
  let sql: string | undefined;
  const editor = vscode.window.activeTextEditor;
  if (resource && (!editor || editor.document.uri.toString() !== resource.toString())) {
    sql = Buffer.from(await vscode.workspace.fs.readFile(resource)).toString("utf8");
  } else if (editor) {
    const sel = editor.selection;
    sql = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  }
  if (!sql || !sql.trim()) {
    vscode.window.showWarningMessage("実行する SQL がありません。");
    return;
  }

  // 実行先 DB を決定（1 つだけ開いていればそれ、複数なら選択、無ければダイアログ）
  let uri: vscode.Uri | undefined;
  const open = manager.list();
  if (open.length === 1) {
    uri = open[0].uri;
  } else if (open.length > 1) {
    const pick = await vscode.window.showQuickPick(
      open.map((d) => ({ label: d.fileName, description: d.uri.fsPath, uri: d.uri })),
      { placeHolder: "SQL を実行するデータベースを選択" }
    );
    uri = pick?.uri;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "このDBに対して実行",
      filters: { SQLite: ["db", "sqlite", "sqlite3", "db3"], すべて: ["*"] }
    });
    uri = picked?.[0];
  }
  if (!uri) {
    return;
  }

  try {
    await manager.open(uri); // 既に開いていれば既存インスタンスを返す
  } catch (e: any) {
    vscode.window.showErrorMessage(`データベースを開けませんでした: ${e?.message ?? e}`);
    return;
  }
  DatabasePanel.show(context, manager, uri, undefined, sql);
}

export function deactivate(): void {
  /* DatabaseManager は subscriptions 経由で dispose される */
}
