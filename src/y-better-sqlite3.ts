import * as Y from "yjs";
import Database from "better-sqlite3";
import { Observable } from "lib0/observable";
import * as promise from "lib0/promise";
import * as fs from "fs";
import * as path from "path";

export const PREFERRED_TRIM_SIZE = 500;

export interface SqlitePersistenceOptions {
  /**
   * Directory where the database file will be stored.
   * Defaults to current working directory.
   */
  dir?: string;
}

interface UpdateRow {
  id: number;
  data: Buffer;
}

interface CountRow {
  count: number;
}

/**
 * Fetch updates from the database and apply them to the document.
 * @param persistence - The SqlitePersistence instance
 * @param beforeApplyUpdatesCallback - Called before applying updates (only if store is empty)
 * @param afterApplyUpdatesCallback - Called after applying updates
 */
export const fetchUpdates = (
  persistence: SqlitePersistence,
  beforeApplyUpdatesCallback: () => void = () => {},
  afterApplyUpdatesCallback: () => void = () => {}
): void => {
  if (persistence._destroyed || !persistence.db) return;

  const db = persistence.db;

  // Get count first to check if store is empty
  const countResult = db
    .prepare("SELECT COUNT(*) as count FROM updates")
    .get() as CountRow;
  const count = countResult.count;

  // Get all updates after our current reference
  const rows = db
    .prepare("SELECT id, data FROM updates WHERE id > ? ORDER BY id")
    .all(persistence._dbref) as UpdateRow[];

  // Only write initial snapshot if store is empty (fixes unbounded growth bug)
  if (count === 0) {
    beforeApplyUpdatesCallback();
  }

  // Apply all updates in a transaction
  Y.transact(
    persistence.doc,
    () => {
      for (const row of rows) {
        Y.applyUpdate(persistence.doc, new Uint8Array(row.data));
      }
    },
    persistence,
    false
  );

  afterApplyUpdatesCallback();

  // Update reference to last key
  if (rows.length > 0) {
    persistence._dbref = rows[rows.length - 1].id;
  }

  // Update size count
  const newCount = db
    .prepare("SELECT COUNT(*) as count FROM updates")
    .get() as CountRow;
  persistence._dbsize = newCount.count;
};

/**
 * Store the current document state, optionally compacting old updates.
 * @param persistence - The SqlitePersistence instance
 * @param forceStore - If true, always store. If false, only store if over PREFERRED_TRIM_SIZE.
 */
export const storeState = (
  persistence: SqlitePersistence,
  forceStore: boolean = true
): void => {
  fetchUpdates(persistence);

  if (!persistence.db || persistence._destroyed) return;

  if (forceStore || persistence._dbsize >= PREFERRED_TRIM_SIZE) {
    const db = persistence.db;
    const fullState = Y.encodeStateAsUpdate(persistence.doc);

    // Use a transaction for atomic update
    const compact = db.transaction(() => {
      // Add the full state as a new entry
      const result = db
        .prepare("INSERT INTO updates (data) VALUES (?)")
        .run(Buffer.from(fullState));
      const newId = result.lastInsertRowid as number;

      // Delete all entries up to (but not including) the new entry
      db.prepare("DELETE FROM updates WHERE id < ?").run(newId);
    });

    compact();

    // Update the count
    const countResult = db
      .prepare("SELECT COUNT(*) as count FROM updates")
      .get() as CountRow;
    persistence._dbsize = countResult.count;
  }
};

/**
 * Clear/delete a document's database file.
 * @param name - The document name
 * @param dir - Optional directory path
 */
export const clearDocument = (name: string, dir?: string): void => {
  const dbPath = dir ? path.join(dir, `${name}.sqlite`) : `${name}.sqlite`;
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
};

/**
 * SQLite persistence provider for Yjs documents.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 *
 * @example
 * ```typescript
 * import { SqlitePersistence } from 'y-better-sqlite3';
 * import * as Y from 'yjs';
 *
 * const doc = new Y.Doc();
 * const persistence = new SqlitePersistence('my-doc', doc);
 *
 * persistence.on('synced', () => {
 *   console.log('Document loaded from SQLite');
 * });
 *
 * // Or use the promise
 * await persistence.whenSynced;
 * ```
 */
export class SqlitePersistence extends Observable<string> {
  public doc: Y.Doc;
  public name: string;
  public synced: boolean = false;
  public db: Database.Database | null = null;
  public whenSynced: Promise<SqlitePersistence>;

  /** @internal */
  _dbref: number = 0;
  /** @internal */
  _dbsize: number = 0;
  /** @internal */
  _destroyed: boolean = false;
  /** @internal */
  _storeTimeout: number = 1000;
  /** @internal */
  _storeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private _dbPath: string;
  private _storeUpdate: (update: Uint8Array, origin: any) => void;

  constructor(name: string, doc: Y.Doc, options?: SqlitePersistenceOptions) {
    super();
    this.doc = doc;
    this.name = name;

    // Determine database path
    this._dbPath = options?.dir
      ? path.join(options.dir, `${name}.sqlite`)
      : `${name}.sqlite`;

    // Ensure directory exists
    const dir = path.dirname(this._dbPath);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open/create database
    this.db = new Database(this._dbPath);

    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Set up whenSynced promise
    this.whenSynced = promise.create((resolve) =>
      this.on("synced", () => resolve(this))
    );

    // Set up update handler
    this._storeUpdate = (update: Uint8Array, origin: any) => {
      if (this.db && origin !== this && !this._destroyed) {
        // Store the update
        this.db
          .prepare("INSERT INTO updates (data) VALUES (?)")
          .run(Buffer.from(update));
        this._dbsize++;

        // Check if we need to compact
        if (this._dbsize >= PREFERRED_TRIM_SIZE) {
          // Debounce the compaction
          if (this._storeTimeoutId !== null) {
            clearTimeout(this._storeTimeoutId);
          }
          this._storeTimeoutId = setTimeout(() => {
            storeState(this, false);
            this._storeTimeoutId = null;
          }, this._storeTimeout);
        }
      }
    };

    // Listen for document updates
    doc.on("update", this._storeUpdate);

    // Clean up when document is destroyed
    doc.on("destroy", this.destroy.bind(this));

    // Defer initialization to allow event listeners to be registered
    // This matches y-indexeddb behavior where DB open is async
    queueMicrotask(() => {
      this._initialize();
    });
  }

  private _initialize(): void {
    if (!this.db || this._destroyed) return;

    const beforeApplyUpdatesCallback = () => {
      // Only called when store is empty - write initial snapshot
      if (this.db && !this._destroyed) {
        const initialState = Y.encodeStateAsUpdate(this.doc);
        this.db
          .prepare("INSERT INTO updates (data) VALUES (?)")
          .run(Buffer.from(initialState));
      }
    };

    const afterApplyUpdatesCallback = () => {
      if (this._destroyed) return;
      this.synced = true;
      this.emit("synced", [this]);
    };

    fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback);
  }

  /**
   * Close the database connection and stop listening for updates.
   */
  destroy(): Promise<void> {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId);
    }

    this.doc.off("update", this._storeUpdate);
    this._destroyed = true;

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    return Promise.resolve();
  }

  /**
   * Destroy this instance and delete all data from the database file.
   */
  async clearData(): Promise<void> {
    await this.destroy();
    if (fs.existsSync(this._dbPath)) {
      fs.unlinkSync(this._dbPath);
    }
  }

  /**
   * Get a custom value from the database.
   * @param key - The key to retrieve
   */
  get(key: string | number): any {
    if (!this.db || this._destroyed) return undefined;

    const row = this.db
      .prepare("SELECT value FROM custom WHERE key = ?")
      .get(String(key)) as { value: string } | undefined;

    if (!row) return undefined;

    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /**
   * Set a custom value in the database.
   * @param key - The key to set
   * @param value - The value to store (will be JSON serialized)
   */
  set(key: string | number, value: any): void {
    if (!this.db || this._destroyed) return;

    const serialized = JSON.stringify(value);
    this.db
      .prepare("INSERT OR REPLACE INTO custom (key, value) VALUES (?, ?)")
      .run(String(key), serialized);
  }

  /**
   * Delete a custom value from the database.
   * @param key - The key to delete
   */
  del(key: string | number): void {
    if (!this.db || this._destroyed) return;

    this.db.prepare("DELETE FROM custom WHERE key = ?").run(String(key));
  }
}

// Default export for convenience
export default SqlitePersistence;
