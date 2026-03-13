export type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: 'awaiting_approval' | 'approved' | 'in_progress' | 'completed' | 'error';
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
      status: 'awaiting_approval',
      result: null,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };
    tasks.set(task.id, task);
    return task;
  },

  get(id: number): Task | undefined {
    return tasks.get(id);
  },

  getApproved(): Task[] {
    return [...tasks.values()].filter(t => t.status === 'approved');
  },

  approve(id: number): Task | null {
    const t = tasks.get(id);
    if (t && t.status === 'awaiting_approval') {
      t.status = 'approved';
      t.updated_at = Math.floor(Date.now() / 1000);
      return t;
    }
    return null;
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
