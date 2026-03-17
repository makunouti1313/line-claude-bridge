import { readFileSync, writeFileSync } from 'fs';

export type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: 'awaiting_approval' | 'approved' | 'in_progress' | 'completed' | 'error';
  result: string | null;
  created_at: number;
  updated_at: number;
};

const TASKS_FILE = '/tmp/tasks.json';

function loadTasks(): { tasks: Map<number, Task>; nextId: number } {
  try {
    const data = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
    const tasks = new Map<number, Task>(
      (data.tasks as Task[]).map(t => [t.id, t])
    );
    // 起動時に古い approved タスクだけ残す（completed/error は不要）
    const alive = new Map([...tasks].filter(([, t]) =>
      t.status === 'approved' || t.status === 'awaiting_approval'
    ));
    return { tasks: alive, nextId: data.nextId ?? 1 };
  } catch {
    return { tasks: new Map(), nextId: 1 };
  }
}

function saveTasks(): void {
  try {
    writeFileSync(TASKS_FILE, JSON.stringify({
      tasks: [...tasks.values()],
      nextId,
    }), 'utf8');
  } catch { /* ignore — /tmp write failure shouldn't crash server */ }
}

const { tasks, nextId: loadedId } = loadTasks();
let nextId = loadedId;

export const taskDb = {
  create(line_user_id: string, instruction: string): Task {
    const task: Task = {
      id: nextId++,
      line_user_id,
      instruction,
      status: 'awaiting_approval',
      result: null,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };
    tasks.set(task.id, task);
    saveTasks();
    return task;
  },

  get(id: number): Task | undefined {
    return tasks.get(id);
  },

  getAwaitingApproval(): Task[] {
    return [...tasks.values()].filter(t => t.status === 'awaiting_approval');
  },

  getApproved(): Task[] {
    return [...tasks.values()].filter(t => t.status === 'approved');
  },

  approve(id: number): Task | null {
    const t = tasks.get(id);
    if (t && t.status === 'awaiting_approval') {
      t.status = 'approved';
      t.updated_at = Math.floor(Date.now() / 1000);
      saveTasks();
      return t;
    }
    return null;
  },

  complete(id: number, result: string): void {
    const t = tasks.get(id);
    if (t) {
      t.status = 'completed';
      t.result = result;
      t.updated_at = Math.floor(Date.now() / 1000);
      saveTasks();
    }
  },

  setError(id: number, error: string): void {
    const t = tasks.get(id);
    if (t) {
      t.status = 'error';
      t.result = error;
      t.updated_at = Math.floor(Date.now() / 1000);
      saveTasks();
    }
  },
};
