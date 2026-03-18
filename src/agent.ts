import 'dotenv/config';
import { execSync } from 'child_process';

const SERVER_URL = process.env.SERVER_URL!;
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const POLL_INTERVAL_MS = 5_000;
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
  console.log(`[${new Date().toISOString()}] Processing task ${task.id}: ${task.instruction.slice(0, 80)}`);

  // ── ローカルpm2制御コマンド ──
  if (task.instruction === '__STOP_ALL__') {
    try {
      execSync('pm2 stop lancers-pipeline lancers-messenger', { encoding: 'utf8' });
      await reportResult(task, '✅ 停止完了:\n• lancers-pipeline\n• lancers-messenger\n\nline-agentは継続稼働中。再開: "START ALL"');
    } catch (e: unknown) {
      await reportResult(task, `⚠️ 停止エラー: ${(e as Error).message?.slice(0, 100)}`, true);
    }
    return;
  }

  if (task.instruction === '__START_ALL__') {
    try {
      execSync('pm2 start lancers-pipeline lancers-messenger', { encoding: 'utf8' });
      await reportResult(task, '▶️ 再開完了:\n• lancers-pipeline\n• lancers-messenger');
    } catch (e: unknown) {
      await reportResult(task, `⚠️ 再開エラー: ${(e as Error).message?.slice(0, 100)}`, true);
    }
    return;
  }

  // ── eBook生成 ──
  if (task.instruction.startsWith('__PRODUCT__:')) {
    const theme = task.instruction.slice('__PRODUCT__:'.length);
    try {
      const result = execSync(
        `node "C:/Users/merucari/.openclaw/workspace/ping-test/modules/generator.js" `,
        {
          input: theme,
          timeout: 600_000,
          encoding: 'utf8',
          cwd: 'C:/Users/merucari/.openclaw/workspace/ping-test',
          env: { ...process.env },
        }
      );
      await reportResult(task, result.trim() || `✅ "${theme}" のドラフト生成完了`);
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      await reportResult(task, err.stdout || err.stderr || err.message || '生成失敗', true);
    }
    return;
  }

  // ── フィードバック記録 ──
  if (task.instruction.startsWith('__PRODUCT_FEEDBACK__:')) {
    const [, draftId, ...rest] = task.instruction.split(':');
    const feedback = rest.join(':');
    try {
      execSync(
        `node -e "require('dotenv').config(); const f=require('./modules/feedback-log'); f.recordFeedback('${draftId}','${feedback.replace(/'/g, "\\'")}'); console.log('記録完了');"`,
        { encoding: 'utf8', cwd: 'C:/Users/merucari/.openclaw/workspace/ping-test', env: { ...process.env } }
      );
      await reportResult(task, `✅ フィードバック記録: [${draftId}] "${feedback}"`);
    } catch (e: unknown) {
      await reportResult(task, `記録失敗: ${(e as Error).message?.slice(0, 100)}`, true);
    }
    return;
  }

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
let lastWakeTime = 0;

async function poll(): Promise<void> {
  if (isProcessing) return;
  try {
    // wakeRender は最大1回/分（毎poll実行すると最大78秒ブロックする）
    const now = Date.now();
    if (now - lastWakeTime > 60_000) {
      await wakeRender();
      lastWakeTime = Date.now();
    }
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

/** poll前にRenderを起こす。スリープ中なら起動完了まで最大30秒待つ */
async function wakeRender(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return; // 起動済み
    } catch { /* 起動中 */ }
    await new Promise(r => setTimeout(r, 5000));
  }
}

/** 今日の nightly batch summary を読む */
function readNightlyBatchSummary(): { generated: number; errors: number; titles: string[] } | null {
  try {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
    const p = join('C:/Users/merucari/.claude/scripts/lancers-pipeline/drafts/nightly_batch', today, 'summary.json');
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return {
      generated: s.generated?.length ?? 0,
      errors:    s.errors?.length ?? 0,
      titles:    (s.generated ?? []).slice(0, 3).map((g: { title: string }) => g.title),
    };
  } catch { return null; }
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
    const nowStr = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

    // 夜間バッチの結果を確認して追記
    const batch = readNightlyBatchSummary();
    const batchLine = batch
      ? `\n\n📝 夜間バッチ完了: ${batch.generated}件生成（エラー${batch.errors}件）\n${batch.titles.map(t => `• ${t}`).join('\n')}\n→ drafts/nightly_batch/ を確認して手動投稿してください。`
      : '';

    const message = `☀️ ${nowStr} ジュニアだ。\n\n${briefing}${batchLine}`;

    const discordUrl = process.env.DISCORD_WEBHOOK_URL;
    if (discordUrl) {
      await fetch(discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message.slice(0, 2000) }),
      });
    } else {
      await fetch(`${SERVER_URL}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AGENT_API_KEY },
        body: JSON.stringify({ to: lineUserId, message }),
      });
    }
    console.log(`[${new Date().toISOString()}] Daily briefing sent (batch: ${batch?.generated ?? 'none'})`);
  } catch (err) {
    console.error('Briefing error:', err);
  }
}

console.log(`Agent started. Polling ${SERVER_URL} every ${POLL_INTERVAL_MS / 1000}s`);
setInterval(poll, POLL_INTERVAL_MS);
setInterval(keepAlive, 4 * 60 * 1000);
setInterval(checkDailyBriefing, 60 * 1000); // 1分ごとに時刻チェック
poll();
