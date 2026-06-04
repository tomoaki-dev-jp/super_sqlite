import * as vscode from "vscode";
import { SqliteDatabase } from "./database";

/** 開いているデータベースを一元管理するシングルトン */
export class DatabaseManager {
  private dbs = new Map<string, SqliteDatabase>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private key(uri: vscode.Uri): string {
    return uri.toString();
  }

  list(): SqliteDatabase[] {
    return [...this.dbs.values()];
  }

  get(uri: vscode.Uri): SqliteDatabase | undefined {
    return this.dbs.get(this.key(uri));
  }

  async open(uri: vscode.Uri): Promise<SqliteDatabase> {
    const existing = this.dbs.get(this.key(uri));
    if (existing) {
      return existing;
    }
    const db = await SqliteDatabase.open(uri);
    this.dbs.set(this.key(uri), db);
    this._onDidChange.fire();
    return db;
  }

  close(uri: vscode.Uri): void {
    const db = this.dbs.get(this.key(uri));
    if (db) {
      db.close();
      this.dbs.delete(this.key(uri));
      this._onDidChange.fire();
    }
  }

  /** ディスクから読み直す（外部変更の取り込み） */
  async reload(uri: vscode.Uri): Promise<SqliteDatabase | undefined> {
    if (!this.dbs.has(this.key(uri))) {
      return undefined;
    }
    this.dbs.get(this.key(uri))?.close();
    const db = await SqliteDatabase.open(uri);
    this.dbs.set(this.key(uri), db);
    this._onDidChange.fire();
    return db;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}
