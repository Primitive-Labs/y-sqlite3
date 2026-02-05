/**
 * Integration tests for js-bao with y-better-sqlite3 persistence.
 *
 * These tests verify that js-bao works correctly when Y.Doc
 * is backed by SqlitePersistence for Node.js environments.
 *
 * Run these tests separately: npm run test:integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as fs from "fs";
import { SqlitePersistence } from "../src/y-better-sqlite3";

// Import js-bao (Node.js build)
import {
  initJsBao,
  resetJsBao,
  BaseModel,
  defineModelSchema,
  attachAndRegisterModel,
} from "js-bao/node";

const TEST_DIR = "./test-dbs";

// Define test models using js-bao's schema API
const taskSchema = defineModelSchema({
  name: "tasks",
  fields: {
    id: { type: "id", autoAssign: true, indexed: true },
    title: { type: "string", indexed: true, default: "" },
    completed: { type: "boolean", indexed: true, default: false },
    priority: { type: "number", indexed: true, default: 0 },
  },
});

interface Task extends BaseModel {
  id: string;
  title: string;
  completed: boolean;
  priority: number;
}
class Task extends BaseModel {}
attachAndRegisterModel(Task, taskSchema);

let testCounter = 0;
const getTestName = () => `jsbao-integration-${Date.now()}-${testCounter++}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("js-bao with SqlitePersistence", () => {
  beforeEach(async () => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    await resetJsBao();
  });

  afterEach(async () => {
    await resetJsBao();
    // Clean up test databases
    if (fs.existsSync(TEST_DIR)) {
      const files = fs.readdirSync(TEST_DIR);
      for (const file of files) {
        if (file.endsWith(".sqlite")) {
          try {
            fs.unlinkSync(`${TEST_DIR}/${file}`);
          } catch {}
        }
      }
    }
  });

  it("should initialize js-bao with a persisted Y.Doc", async () => {
    const docName = getTestName();

    // Create Y.Doc with SQLite persistence
    const doc = new Y.Doc();
    const persistence = new SqlitePersistence(docName, doc, { dir: TEST_DIR });
    await persistence.whenSynced;

    // Initialize js-bao
    const { connectDocument } = await initJsBao({
      databaseConfig: { type: "node-sqlite" },
      models: [Task],
    });

    // Connect the persisted document
    await connectDocument(docName, doc, "read-write");

    // Create and save a task
    const task = new Task({
      title: "Test Task",
      completed: false,
      priority: 1,
    });
    await task.save({ targetDocument: docName });

    expect(task.title).toBe("Test Task");
    expect(task.id).toBeDefined();

    // Verify task can be found
    const found = await Task.find(task.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Test Task");

    await persistence.destroy();
  });

  it("should persist js-bao data across sessions", async () => {
    const docName = getTestName();
    let taskId: string;

    // Session 1: Create data
    {
      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(docName, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      const { connectDocument } = await initJsBao({
        databaseConfig: { type: "node-sqlite" },
        models: [Task],
      });
      await connectDocument(docName, doc, "read-write");

      const task = new Task({
        title: "Persisted Task",
        completed: false,
        priority: 5,
      });
      await task.save({ targetDocument: docName });
      taskId = task.id;

      // Wait for persistence to write
      await wait(100);
      await persistence.destroy();
      await resetJsBao();
    }

    // Session 2: Verify data persisted
    {
      const doc = new Y.Doc();
      const persistence = new SqlitePersistence(docName, doc, { dir: TEST_DIR });
      await persistence.whenSynced;

      const { connectDocument } = await initJsBao({
        databaseConfig: { type: "node-sqlite" },
        models: [Task],
      });
      await connectDocument(docName, doc, "read-write");

      // Find the task by ID
      const found = await Task.find(taskId);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Persisted Task");
      expect(found!.priority).toBe(5);

      await persistence.destroy();
    }
  });

  it("should handle CRUD operations with persistence", async () => {
    const docName = getTestName();

    const doc = new Y.Doc();
    const persistence = new SqlitePersistence(docName, doc, { dir: TEST_DIR });
    await persistence.whenSynced;

    const { connectDocument } = await initJsBao({
      databaseConfig: { type: "node-sqlite" },
      models: [Task],
    });
    await connectDocument(docName, doc, "read-write");

    // Create
    const task = new Task({
      title: "CRUD Test",
      completed: false,
      priority: 1,
    });
    await task.save({ targetDocument: docName });
    const taskId = task.id;

    // Read
    const found = await Task.find(taskId);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("CRUD Test");

    // Update
    task.completed = true;
    task.priority = 10;
    await task.save({ targetDocument: docName });

    const updated = await Task.find(taskId);
    expect(updated!.completed).toBe(true);
    expect(updated!.priority).toBe(10);

    // Delete
    await task.delete();
    const deleted = await Task.find(taskId);
    expect(deleted).toBeNull();

    await persistence.destroy();
  });

  it("should work with findAll", async () => {
    const docName = getTestName();
    const uniquePrefix = `findAll-${Date.now()}`;

    const doc = new Y.Doc();
    const persistence = new SqlitePersistence(docName, doc, { dir: TEST_DIR });
    await persistence.whenSynced;

    const { connectDocument } = await initJsBao({
      databaseConfig: { type: "node-sqlite" },
      models: [Task],
    });
    await connectDocument(docName, doc, "read-write");

    // Create multiple tasks with unique prefix to identify them
    const task1 = new Task({ title: `${uniquePrefix}-Task 1`, completed: false, priority: 1 });
    await task1.save({ targetDocument: docName });

    const task2 = new Task({ title: `${uniquePrefix}-Task 2`, completed: true, priority: 2 });
    await task2.save({ targetDocument: docName });

    const task3 = new Task({ title: `${uniquePrefix}-Task 3`, completed: false, priority: 3 });
    await task3.save({ targetDocument: docName });

    // Find all and filter to our specific tasks
    const allTasks = await Task.findAll();
    const ourTasks = allTasks.filter((t) => t.title.startsWith(uniquePrefix));
    expect(ourTasks.length).toBe(3);

    const titles = ourTasks.map((t) => t.title).sort();
    expect(titles).toEqual([
      `${uniquePrefix}-Task 1`,
      `${uniquePrefix}-Task 2`,
      `${uniquePrefix}-Task 3`,
    ]);

    await persistence.destroy();
  });
});
