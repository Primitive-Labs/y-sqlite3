# y-better-sqlite3

SQLite persistence provider for [Yjs](https://yjs.dev) using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

This package provides the same functionality as [y-indexeddb](https://github.com/yjs/y-indexeddb) but for Node.js environments, storing Yjs document updates in a local SQLite database.

## Features

- Persistent storage for Yjs documents in Node.js
- Multi-document support — store many Y.Doc instances in a single SQLite file
- Automatic compaction to prevent unbounded growth
- Custom key-value storage for metadata
- API compatible with y-indexeddb
- Includes fix for unbounded growth bug (see [yjs/y-indexeddb#31](https://github.com/yjs/y-indexeddb/issues/31))

## Installation

```bash
npm install y-better-sqlite3 yjs
```

## Usage

```typescript
import { SqlitePersistence } from 'y-better-sqlite3';
import * as Y from 'yjs';

const doc = new Y.Doc();
const persistence = new SqlitePersistence('my-document', doc);

// Wait for existing data to be loaded
persistence.on('synced', () => {
  console.log('Document loaded from SQLite');
});

// Or use the promise
await persistence.whenSynced;

// Now you can use the document
const ymap = doc.getMap('data');
ymap.set('key', 'value');

// Changes are automatically persisted to SQLite
```

### With js-bao

```typescript
import { initJsBao } from 'js-bao/node';
import { SqlitePersistence } from 'y-better-sqlite3';
import * as Y from 'yjs';

// Create document with SQLite persistence
const doc = new Y.Doc();
const persistence = new SqlitePersistence('my-document', doc, {
  dir: './data'  // Optional: specify database directory
});
await persistence.whenSynced;

// Initialize js-bao
const { connectDocument } = await initJsBao({
  databaseConfig: { type: 'node-sqlite' }
});

// Connect the persisted document
await connectDocument('my-document', doc, 'read-write');

// Now use js-bao models...
```

### Specifying Database Location

```typescript
const persistence = new SqlitePersistence('my-doc', doc, {
  dir: '/path/to/data'  // Database will be at /path/to/data/my-doc.sqlite
});
```

### Multi-Document (Shared Database)

Multiple documents can share a single SQLite file using the `dbPath` option. Each document's data is isolated by its name.

```typescript
import { SqlitePersistence, clearDocument } from 'y-better-sqlite3';
import * as Y from 'yjs';

const docA = new Y.Doc();
const docB = new Y.Doc();

// Both use the same SQLite file, isolated by doc name
const pA = new SqlitePersistence('doc-a', docA, {
  dbPath: './data/shared.sqlite'
});
const pB = new SqlitePersistence('doc-b', docB, {
  dbPath: './data/shared.sqlite'
});

await pA.whenSynced;
await pB.whenSynced;

// Data is fully isolated — changes to doc-a are invisible to doc-b
docA.getMap('data').set('key', 'value-a');
docB.getMap('data').set('key', 'value-b');
```

Clearing a single document from a shared database removes only that document's data:

```typescript
// Remove only doc-a's data; doc-b is untouched, file remains
clearDocument('doc-a', { dbPath: './data/shared.sqlite' });

// Or via the instance method (also only clears own data)
await pA.clearData();
```

> **Note:** `dir` and `dbPath` are mutually exclusive — providing both throws an error.

## API

### `new SqlitePersistence(name, doc, options?)`

Creates a new persistence provider.

- `name` - Document name (used as database filename, and as the isolation key in shared databases)
- `doc` - Y.Doc instance to persist
- `options.dir` - Optional directory for the database file (creates `{dir}/{name}.sqlite`)
- `options.dbPath` - Optional explicit path to a shared SQLite file (mutually exclusive with `dir`)

### Properties

- `synced: boolean` - Whether initial sync is complete
- `whenSynced: Promise<SqlitePersistence>` - Resolves when synced
- `db: Database | null` - The underlying better-sqlite3 instance

### Methods

- `destroy(): Promise<void>` - Close database connection
- `clearData(): Promise<void>` - Destroy and delete data (deletes the file for per-doc databases; deletes only this doc's rows for shared databases)
- `get(key): any` - Get custom metadata value
- `set(key, value): void` - Set custom metadata value
- `del(key): void` - Delete custom metadata value

### Events

- `synced` - Emitted when existing data is loaded

### Utilities

- `clearDocument(name, dir?)` - Delete a document's database file
- `clearDocument(name, { dbPath })` - Delete only the named document's rows from a shared database
- `fetchUpdates(persistence)` - Manually fetch and apply updates
- `storeState(persistence, force?)` - Manually store/compact state
- `PREFERRED_TRIM_SIZE` - Threshold for automatic compaction (default: 500)

## How It Works

1. On initialization, all stored updates are loaded and applied to the Y.Doc
2. An initial state snapshot is only written if the database is empty (fixes unbounded growth)
3. Document changes trigger immediate writes to SQLite
4. When updates exceed `PREFERRED_TRIM_SIZE`, the database is compacted

### Storage Schema

All data is keyed by `docName`, enabling multi-document support in a single file.

```sql
-- Yjs document updates (binary encoded)
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  docName TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX idx_updates_docName ON updates(docName);

-- Custom key-value metadata
CREATE TABLE custom (
  docName TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (docName, key)
);
```

## Differences from y-indexeddb

| Feature | y-indexeddb | y-better-sqlite3 |
|---------|-------------|------------------|
| Environment | Browser | Node.js |
| Storage | IndexedDB | SQLite |
| Async | Fully async | Sync with async wrapper |
| Growth fix | In fork only | Built-in |

## Testing

```bash
# Run unit tests (y-better-sqlite3 only)
npm test

# Run integration tests with js-bao (may have Yjs import issues)
npm run test:integration

# Run all tests
npm run test:all

# Watch mode
npm run test:watch
```

**Note**: Integration tests may fail with "Unexpected content type" due to Yjs version mismatch when multiple copies of Yjs are loaded. This is a [known Yjs issue](https://github.com/yjs/yjs/issues/438). The unit tests validate y-better-sqlite3 functionality independently.

## License

MIT
