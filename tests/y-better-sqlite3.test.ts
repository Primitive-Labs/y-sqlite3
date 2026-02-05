import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import Database from "better-sqlite3";
import * as fs from "fs";
import {
  SqlitePersistence,
  clearDocument,
  PREFERRED_TRIM_SIZE,
  fetchUpdates,
  storeState,
} from "../src/y-better-sqlite3";

const TEST_DIR = "./test-dbs";

// Helper to get a unique test name
let testCounter = 0;
const getTestName = () => `test-doc-${Date.now()}-${testCounter++}`;

// Helper to count entries in the updates table
const getUpdateCount = (name: string): number => {
  const dbPath = `${TEST_DIR}/${name}.sqlite`;
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath);
  const result = db.prepare("SELECT COUNT(*) as count FROM updates").get() as {
    count: number;
  };
  db.close();
  return result.count;
};

// Helper to wait for async operations
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SqlitePersistence", () => {
  beforeEach(() => {
    // Ensure test directory exists
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test databases
    if (fs.existsSync(TEST_DIR)) {
      const files = fs.readdirSync(TEST_DIR);
      for (const file of files) {
        if (file.endsWith(".sqlite")) {
          fs.unlinkSync(`${TEST_DIR}/${file}`);
        }
      }
    }
  });

  describe("Basic functionality", () => {
    it("should create a new database and emit synced event", async () => {
      const name = getTestName();
      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });

      let syncedEmitted = false;
      persistence.on("synced", () => {
        syncedEmitted = true;
      });

      await persistence.whenSynced;

      expect(persistence.synced).toBe(true);
      expect(syncedEmitted).toBe(true);
      expect(fs.existsSync(`${TEST_DIR}/${name}.sqlite`)).toBe(true);

      await persistence.destroy();
    });

    it("should persist and restore document state", async () => {
      const name = getTestName();

      // Session 1: Create document and add data
      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;

      const map1 = doc1.getMap("test");
      map1.set("key", "value");
      map1.set("number", 42);

      // Wait for update to be written
      await wait(50);
      await p1.destroy();
      doc1.destroy();

      // Session 2: Reopen and verify data persisted
      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;

      const map2 = doc2.getMap("test");
      expect(map2.get("key")).toBe("value");
      expect(map2.get("number")).toBe(42);

      await p2.destroy();
      doc2.destroy();
    });

    it("should handle arrays correctly", async () => {
      const name = getTestName();

      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;

      const arr1 = doc1.getArray("list");
      arr1.push(["a", "b", "c"]);

      await wait(50);
      await p1.destroy();
      doc1.destroy();

      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;

      const arr2 = doc2.getArray("list");
      expect(arr2.toArray()).toEqual(["a", "b", "c"]);

      await p2.destroy();
      doc2.destroy();
    });
  });

  describe("Unbounded growth fix", () => {
    it("should not grow on reopen without changes", async () => {
      const name = getTestName();

      // First open
      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;
      const count1 = getUpdateCount(name);
      expect(count1).toBe(1); // Initial snapshot
      await p1.destroy();
      doc1.destroy();

      // Second open without changes
      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;
      const count2 = getUpdateCount(name);
      expect(count2).toBe(1); // Should still be 1
      await p2.destroy();
      doc2.destroy();

      // Third open without changes
      const doc3 = new Y.Doc();
      const p3 = new SqlitePersistence(name, doc3, { dir: TEST_DIR });
      await p3.whenSynced;
      const count3 = getUpdateCount(name);
      expect(count3).toBe(1); // Should still be 1
      await p3.destroy();
      doc3.destroy();
    });

    it("should not grow on reopen with existing updates", async () => {
      const name = getTestName();

      // Open and make a change
      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;
      doc1.getArray("a").insert(0, [0]);

      // Wait for update to flush then close (avoid concurrent DB access)
      await wait(100);
      await p1.destroy();
      doc1.destroy();

      const afterFirstSession = getUpdateCount(name);
      expect(afterFirstSession).toBe(2); // 1 initial + 1 update

      // Reopen without changes
      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;
      await p2.destroy();
      doc2.destroy();

      const afterReopen = getUpdateCount(name);
      expect(afterReopen).toBe(2); // Should remain 2
    });

    it("should persist edits and keep stable count on reopen", async () => {
      const name = getTestName();

      // Session 1: make multiple edits
      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;

      const arr = doc1.getArray("persist");
      arr.insert(0, ["a"]);
      arr.insert(1, ["b"]);
      arr.insert(2, ["c"]);

      // Wait for update to flush then close (avoid concurrent DB access)
      await wait(100);
      await p1.destroy();
      doc1.destroy();

      const afterEdits = getUpdateCount(name);
      expect(afterEdits).toBe(4); // 1 initial + 3 updates

      // Session 2: verify content and stable count
      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;

      const arr2 = doc2.getArray("persist");
      expect(arr2.toArray()).toEqual(["a", "b", "c"]);

      await p2.destroy();
      doc2.destroy();

      const afterReopen = getUpdateCount(name);
      expect(afterReopen).toBe(4); // Should remain 4
    });
  });

  describe("Compaction", () => {
    it("should compact after PREFERRED_TRIM_SIZE updates", async () => {
      const name = getTestName();

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      persistence._storeTimeout = 0; // Immediate compaction
      await persistence.whenSynced;

      const arr = doc.getArray("test");

      // Generate many updates
      for (let i = 0; i < PREFERRED_TRIM_SIZE + 10; i++) {
        arr.insert(i, [i]);
      }

      // Wait for compaction
      await wait(200);

      const count = getUpdateCount(name);
      expect(count).toBeLessThan(PREFERRED_TRIM_SIZE);

      // Verify data integrity
      expect(arr.length).toBe(PREFERRED_TRIM_SIZE + 10);

      await persistence.destroy();
      doc.destroy();
    });

    it("should preserve data after compaction", async () => {
      const name = getTestName();

      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      p1._storeTimeout = 0;
      await p1.whenSynced;

      const arr1 = doc1.getArray("test");
      for (let i = 0; i < PREFERRED_TRIM_SIZE + 10; i++) {
        arr1.insert(i, [i]);
      }

      await wait(200);
      await p1.destroy();
      doc1.destroy();

      // Reopen and verify
      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;

      const arr2 = doc2.getArray("test");
      expect(arr2.length).toBe(PREFERRED_TRIM_SIZE + 10);
      expect(arr2.get(0)).toBe(0);
      expect(arr2.get(PREFERRED_TRIM_SIZE)).toBe(PREFERRED_TRIM_SIZE);

      await p2.destroy();
      doc2.destroy();
    });
  });

  describe("Custom storage", () => {
    it("should store and retrieve custom values", async () => {
      const name = getTestName();

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      persistence.set("string", "hello");
      persistence.set("number", 42);
      persistence.set("object", { a: 1, b: 2 });
      persistence.set("array", [1, 2, 3]);

      expect(persistence.get("string")).toBe("hello");
      expect(persistence.get("number")).toBe(42);
      expect(persistence.get("object")).toEqual({ a: 1, b: 2 });
      expect(persistence.get("array")).toEqual([1, 2, 3]);

      await persistence.destroy();
    });

    it("should persist custom values across sessions", async () => {
      const name = getTestName();

      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      await p1.whenSynced;

      p1.set("meta", { version: 1, author: "test" });
      await p1.destroy();
      doc1.destroy();

      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      await p2.whenSynced;

      expect(p2.get("meta")).toEqual({ version: 1, author: "test" });

      await p2.destroy();
      doc2.destroy();
    });

    it("should delete custom values", async () => {
      const name = getTestName();

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      persistence.set("key", "value");
      expect(persistence.get("key")).toBe("value");

      persistence.del("key");
      expect(persistence.get("key")).toBeUndefined();

      await persistence.destroy();
    });
  });

  describe("Cleanup", () => {
    it("should destroy without error", async () => {
      const name = getTestName();

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      await persistence.destroy();
      expect(persistence._destroyed).toBe(true);
    });

    it("should clearData and remove database file", async () => {
      const name = getTestName();
      const dbPath = `${TEST_DIR}/${name}.sqlite`;

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      doc.getMap("test").set("key", "value");
      await wait(50);

      expect(fs.existsSync(dbPath)).toBe(true);

      await persistence.clearData();

      expect(fs.existsSync(dbPath)).toBe(false);
    });

    it("should handle early destroy before sync", async () => {
      const name = getTestName();

      let hasBeenSynced = false;
      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });

      persistence.on("synced", () => {
        hasBeenSynced = true;
      });

      // Destroy immediately
      persistence.destroy();

      await wait(100);

      expect(hasBeenSynced).toBe(false);
    });

    it("clearDocument should remove database file", () => {
      const name = getTestName();
      const dbPath = `${TEST_DIR}/${name}.sqlite`;

      // Create a database file
      const db = new Database(dbPath);
      db.exec("CREATE TABLE test (id INTEGER)");
      db.close();

      expect(fs.existsSync(dbPath)).toBe(true);

      clearDocument(name, TEST_DIR);

      expect(fs.existsSync(dbPath)).toBe(false);
    });
  });

  describe("Concurrent access", () => {
    it("should handle updates from multiple sources", async () => {
      const name = getTestName();

      const doc1 = new Y.Doc();
      const p1 = new SqlitePersistence(name, doc1, { dir: TEST_DIR });
      p1._storeTimeout = 0;
      await p1.whenSynced;

      const doc2 = new Y.Doc();
      const p2 = new SqlitePersistence(name, doc2, { dir: TEST_DIR });
      p2._storeTimeout = 0;
      await p2.whenSynced;

      // Make changes in both docs
      doc1.getArray("arr").insert(0, ["from-doc1"]);
      doc2.getArray("arr").insert(0, ["from-doc2"]);

      await wait(100);

      // Fetch updates to sync
      fetchUpdates(p1);
      fetchUpdates(p2);

      // Both should have both items (order may vary due to CRDT)
      const arr1 = doc1.getArray("arr").toArray();
      const arr2 = doc2.getArray("arr").toArray();

      expect(arr1.length).toBe(2);
      expect(arr2.length).toBe(2);
      expect(arr1).toEqual(arr2);

      await p1.destroy();
      await p2.destroy();
      doc1.destroy();
      doc2.destroy();
    });
  });

  describe("Origin tracking", () => {
    it("should not re-persist updates from self", async () => {
      const name = getTestName();

      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(name, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      // Initial count
      const initialCount = getUpdateCount(name);

      // Apply an update with persistence as origin (simulating internal update)
      const update = Y.encodeStateAsUpdate(doc);
      Y.applyUpdate(doc, update, persistence);

      await wait(50);

      // Count should not have changed
      expect(getUpdateCount(name)).toBe(initialCount);

      await persistence.destroy();
    });
  });
});
