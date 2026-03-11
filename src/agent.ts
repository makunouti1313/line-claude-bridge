import 'dotenv/config';
import { execSync } from 'child_process';

const SERVER_URL = process.env.SERVER_URL!;
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const POLL_INTERVAL_MS = 10_000;

type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: string;
};

async function fetchPendingTasks(): Promise<Task[]> {
  const res = await fetch(`${SERVER_URL}/tasks/pending`, {
    headers: { 'x-api-key': AGENT_API_KEY },
  });
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return res.json() as Promise<Task[]>;
}

async function reportResult(task: Task, result: string, isError = false): Promise<void> {
  await fetch(`${SERVER_URL}/tasks/${task.id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AGENT_API_KEY,
    },
    body: JSON.stringify({
      line_user_id: task.line_user_id,
      ...(isError ? { error: result } : { result }),
    }),
  });
}

function runClaude(instruction: string): string {
  try {
    const output = execSync(
      `claude --print "${instruction.replace(/"/g, '\\"')}"`,
      {
        timeout: 300_000, // 5分
        encoding: 'utf8',
        cwd: 'C:/Users/merucari/OneDrive/デスクトップ/samantha-final',
      }
    );
    return output.trim();
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return error.stdout || error.stderr || error.message || 'Unknown error';
  }
}

async function processTask(task: Task): Promise<void> {
  console.log(`[${new Date().toISOString()}] Processing task ${task.id}: ${task.instruction}`);

  try {
    const result = runClaude(task.instruction);
    await reportResult(task, result);
    console.log(`[${new Date().toISOString()}] Task ${task.id} completed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportResult(task, msg, true);
    console.error(`[${new Date().toISOString()}] Task ${task.id} error:`, msg);
  }
}

let isProcessing = false;

async function poll(): Promise<void> {
  if (isProcessing) return;

  try {
    const tasks = await fetchPendingTasks();
    if (tasks.length === 0) return;

    isProcessing = true;
    // 1タスクずつ直列処理
    for (const task of tasks) {
      await processTask(task);
    }
  } catch (err) {
    console.error('Poll error:', err);
  } finally {
    isProcessing = false;
  }
}

console.log(`Agent started. Polling ${SERVER_URL} every ${POLL_INTERVAL_MS / 1000}s`);
setInterval(poll, POLL_INTERVAL_MS);
poll(); // 起動時に即実行
