import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '..', 'tasks.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

export type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  result: string | null;
  created_at: number;
  updated_at: number;
};

export const taskDb = {
  create(line_user_id: string, instruction: string): Task {
    const stmt = db.prepare(
      'INSERT INTO tasks (line_user_id, instruction) VALUES (?, ?) RETURNING *'
    );
    return stmt.get(line_user_id, instruction) as Task;
  },

  getPending(): Task[] {
    return db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC").all() as Task[];
  },

  setInProgress(id: number): void {
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = unixepoch() WHERE id = ?").run(id);
  },

  complete(id: number, result: string): void {
    db.prepare("UPDATE tasks SET status = 'completed', result = ?, updated_at = unixepoch() WHERE id = ?").run(result, id);
  },

  setError(id: number, error: string): void {
    db.prepare("UPDATE tasks SET status = 'error', result = ?, updated_at = unixepoch() WHERE id = ?").run(error, id);
  },
};

export default db;
