export type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  result: string | null;
  created_at: number;
  updated_at: number;
};

let nextId = 1;
const tasks = new Map<number, Task>();

export const taskDb = {
  create(line_user_id: string, instruction: string): Task {
    const task: Task = {
      id: nextId++,
      line_user_id,
      instruction,
      status: 'pending',
      result: null,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };
    tasks.set(task.id, task);
    return task;
  },

  getPending(): Task[] {
    return [...tasks.values()].filter(t => t.status === 'pending');
  },

  setInProgress(id: number): void {
    const t = tasks.get(id);
    if (t) { t.status = 'in_progress'; t.updated_at = Math.floor(Date.now() / 1000); }
  },

  complete(id: number, result: string): void {
    const t = tasks.get(id);
    if (t) { t.status = 'completed'; t.result = result; t.updated_at = Math.floor(Date.now() / 1000); }
  },

  setError(id: number, error: string): void {
    const t = tasks.get(id);
    if (t) { t.status = 'error'; t.result = error; t.updated_at = Math.floor(Date.now() / 1000); }
  },
};
