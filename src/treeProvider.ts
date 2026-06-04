import * as vscode from "vscode";
import { DatabaseManager } from "./manager";

type Node = DbNode | TableNode | ColumnNode;

class DbNode {
  readonly kind = "db";
  constructor(public uri: vscode.Uri, public label: string) {}
}
class TableNode {
  readonly kind = "table";
  constructor(
    public uri: vscode.Uri,
    public name: string,
    public type: "table" | "view"
  ) {}
}
class ColumnNode {
  readonly kind = "column";
  constructor(public label: string, public description: string) {}
}

export class SqliteTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: DatabaseManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "db") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "database";
      item.iconPath = new vscode.ThemeIcon("database");
      item.tooltip = node.uri.fsPath;
      item.resourceUri = node.uri;
      return item;
    }
    if (node.kind === "table") {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = node.type;
      item.iconPath = new vscode.ThemeIcon(node.type === "view" ? "eye" : "table");
      item.command = {
        command: "superSqlite.openTable",
        title: "テーブルを開く",
        arguments: [node.uri, node.name]
      };
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon("symbol-field");
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.manager.list().map((db) => new DbNode(db.uri, db.fileName));
    }
    if (node.kind === "db") {
      const db = this.manager.get(node.uri);
      if (!db) {
        return [];
      }
      return db.listTables().map((t) => new TableNode(node.uri, t.name, t.type));
    }
    if (node.kind === "table") {
      const db = this.manager.get(node.uri);
      if (!db) {
        return [];
      }
      return db.columns(node.name).map((c) => {
        const flags = [c.type, c.pk ? "PK" : "", c.notNull ? "NOT NULL" : ""]
          .filter(Boolean)
          .join(" · ");
        return new ColumnNode(c.name, flags);
      });
    }
    return [];
  }
}
