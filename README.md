# y-sqlite3

SQLite persistence provider for [Yjs](https://yjs.dev) using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

This package provides the same functionality as [y-indexeddb](https://github.com/yjs/y-indexeddb) but for Node.js environments, storing Yjs document updates in a local SQLite database.

## Features

- Persistent storage for Yjs documents in Node.js
- Automatic compaction to prevent unbounded growth
- Custom key-value storage for metadata
- API compatible with y-indexeddb
- Includes fix for unbounded growth bug (see [yjs/y-indexeddb#31](https://github.com/yjs/y-indexeddb/issues/31))

## Installation

```bash
npm install y-sqlite3 yjs
```

## Usage

```typescript
import { SqlitePersistence } from 'y-sqlite3';
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
import { SqlitePersistence } from 'y-sqlite3';
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

## API

### `new SqlitePersistence(name, doc, options?)`

Creates a new persistence provider.

- `name` - Document name (used as database filename)
- `doc` - Y.Doc instance to persist
- `options.dir` - Optional directory for the database file

### Properties

- `synced: boolean` - Whether initial sync is complete
- `whenSynced: Promise<SqlitePersistence>` - Resolves when synced
- `db: Database | null` - The underlying better-sqlite3 instance

### Methods

- `destroy(): Promise<void>` - Close database connection
- `clearData(): Promise<void>` - Destroy and delete database file
- `get(key): any` - Get custom metadata value
- `set(key, value): void` - Set custom metadata value
- `del(key): void` - Delete custom metadata value

### Events

- `synced` - Emitted when existing data is loaded

### Utilities

- `clearDocument(name, dir?)` - Delete a document's database file
- `fetchUpdates(persistence)` - Manually fetch and apply updates
- `storeState(persistence, force?)` - Manually store/compact state
- `PREFERRED_TRIM_SIZE` - Threshold for automatic compaction (default: 500)

## How It Works

1. On initialization, all stored updates are loaded and applied to the Y.Doc
2. An initial state snapshot is only written if the database is empty (fixes unbounded growth)
3. Document changes trigger immediate writes to SQLite
4. When updates exceed `PREFERRED_TRIM_SIZE`, the database is compacted

### Storage Schema

```sql
-- Yjs document updates (binary encoded)
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data BLOB NOT NULL
);

-- Custom key-value metadata
CREATE TABLE custom (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

## Differences from y-indexeddb

| Feature | y-indexeddb | y-sqlite3 |
|---------|-------------|-----------|
| Environment | Browser | Node.js |
| Storage | IndexedDB | SQLite |
| Async | Fully async | Sync with async wrapper |
| Growth fix | In fork only | Built-in |

## Testing

```bash
npm test

# Watch mode
npm run test:watch
```

## License

MIT
