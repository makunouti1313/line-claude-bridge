import 'dotenv/config';
import { execSync } from 'child_process';

const SERVER_URL = process.env.SERVER_URL!;
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const POLL_INTERVAL_MS = 10_000;
const MAX_RETRIES = 3;

type Task = {
  id: number;
  line_user_id: string;
  instruction: string;
  status: string;
};

async function fetchApprovedTasks(): Promise<Task[]> {
  const res = await fetch(`${SERVER_URL}/tasks/approved`, {
    headers: { 'x-api-key': AGENT_API_KEY },
  });
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return res.json() as Promise<Task[]>;
}

async function reportResult(task: Task, result: string, isError = false): Promise<void> {
  await fetch(`${SERVER_URL}/tasks/${task.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': AGENT_API_KEY },
    body: JSON.stringify({
      line_user_id: task.line_user_id,
      ...(isError ? { error: result } : { result }),
    }),
  });
}

function runClaude(instruction: string): string {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // stdinで渡す（シェル引数だと改行・特殊文字が壊れるため）
  // CWDはDesktop（どのプロジェクトへも相対パスで移動できる）
  const output = execSync(
    `claude --print --dangerously-skip-permissions`,
    {
      input: instruction,
      timeout: 600_000, // 10分（重い作業対応）
      encoding: 'utf8',
      cwd: 'C:/Users/merucari/OneDrive/デスクトップ',
      env,
    }
  );
  return output.trim();
}

async function processTask(task: Task): Promise<void> {
  console.log(`[${new Date().toISOString()}] Processing task ${task.id}: ${task.instruction}`);

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = runClaude(task.instruction);
      await reportResult(task, result);
      console.log(`[${new Date().toISOString()}] Task ${task.id} completed`);
      return;
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      lastError = error.stdout || error.stderr || error.message || 'Unknown error';
      console.error(`[Attempt ${attempt}/${MAX_RETRIES}] Task ${task.id} error:`, lastError.slice(0, 200));
      if (attempt < MAX_RETRIES) console.log('Retrying...');
    }
  }

  // 3回失敗したら報告
  await reportResult(task, lastError, true);
}

let isProcessing = false;

async function poll(): Promise<void> {
  if (isProcessing) return;
  try {
    const tasks = await fetchApprovedTasks();
    if (tasks.length === 0) return;
    isProcessing = true;
    for (const task of tasks) {
      await processTask(task);
    }
  } catch (err) {
    console.error('Poll error:', err);
  } finally {
    isProcessing = false;
  }
}

async function keepAlive(): Promise<void> {
  try { await fetch(`${SERVER_URL}/health`); } catch { /* ignore */ }
}

// 毎日8:00 JST (23:00 UTC) にブリーフィング
let lastBriefingDate = '';
async function checkDailyBriefing(): Promise<void> {
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  const today = now.toISOString().slice(0, 10);
  if (jstHour === 8 && lastBriefingDate !== today) {
    lastBriefingDate = today;
    await sendDailyBriefing();
  }
}

async function sendDailyBriefing(): Promise<void> {
  const lineUserId = process.env.LINE_USER_ID;
  if (!lineUserId) return;

  try {
    const { default: Groq } = await import('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // Lancers案件パイプラインを実行して今日の状況を把握
    let lancersContext = '';
    try {
      const pipelineResult = runClaude(
        'C:/Users/merucari/.openclaw/workspace/ping-test/jobs.json を読んで、今日の日付（created_at）のpending案件数と最高スコア案件のタイトル・スコアを1行で要約してください。ファイルがなければ「案件データなし」と返してください。'
      );
      lancersContext = pipelineResult;
    } catch {
      lancersContext = '案件データ未取得';
    }

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `あなたはジュニア。ゆうすけ（28歳、雀荘スタッフ週3、月収10万、副業でランサーズ月20万目標）の相棒AI。
毎朝自主的に状況報告と提案を送る。タメ口。お世辞なし。具体的に。150字以内。`,
        },
        {
          role: 'user',
          content: `今日の朝のメッセージを作って。Lancers状況: ${lancersContext}。今日やるべき最重要アクション1つを明確に。`,
        },
      ],
      max_tokens: 200,
    });

    const briefing = res.choices[0].message.content ?? '';
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
    const message = `☀️ ${now} ジュニアだ。\n\n${briefing}`;

    await fetch(`${SERVER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AGENT_API_KEY },
      body: JSON.stringify({ to: lineUserId, message }),
    });
    console.log(`[${new Date().toISOString()}] Daily briefing sent`);
  } catch (err) {
    console.error('Briefing error:', err);
  }
}

console.log(`Agent started. Polling ${SERVER_URL} every ${POLL_INTERVAL_MS / 1000}s`);
setInterval(poll, POLL_INTERVAL_MS);
setInterval(keepAlive, 4 * 60 * 1000);
setInterval(checkDailyBriefing, 60 * 1000); // 1分ごとに時刻チェック
poll();
