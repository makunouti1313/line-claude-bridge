import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi, webhook } from '@line/bot-sdk';
import Groq from 'groq-sdk';
import { taskDb } from './db';
import { readFileSync, writeFileSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3002;

// Lancers ジョブストア（ファイル永続化）
type LancersJob = {
  id: string; title: string; url: string; proposal: string;
  budgetText: string; score: number; scoreLabel: string;
  reason?: string; platform?: string; autoApply?: boolean;
};
const JOBS_FILE = '/tmp/lancers_jobs.json';

function loadJobs(): { jobs: Map<string, LancersJob>; counter: number } {
  try {
    const data = JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
    return { jobs: new Map(Object.entries(data.jobs)), counter: data.counter ?? 0 };
  } catch {
    return { jobs: new Map(), counter: 0 };
  }
}

function saveJobs(): void {
  try {
    writeFileSync(JOBS_FILE, JSON.stringify({ jobs: Object.fromEntries(lancersJobs), counter: lancersJobCounter }), 'utf8');
  } catch { /* ignore */ }
}

const { jobs: lancersJobs, counter: lancersJobCounter0 } = loadJobs();
let lancersJobCounter = lancersJobCounter0;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/** Discord webhook に送信（失敗時は3回リトライ） */
async function sendDiscord(content: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 2000) }),
      });
      if (res.ok || res.status === 204) return;
      throw new Error(`Discord HTTP ${res.status}`);
    } catch (e) {
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      else console.error('Discord送信失敗:', (e as Error).message);
    }
  }
}

function buildApprovalCard(task: { id: number; instruction: string }): string {
  return [
    `🔐 承認カード`,
    `[ID]: ${task.id}`,
    `[Action]: ${task.instruction.slice(0, 80)}`,
    `[Rationale]: ユーザーの要求に基づき即時実行`,
    `[Risk]: コード変更あり / git revertで復元可能`,
    `[Cost/Reversibility]: 無償 / 可逆`,
    ``,
    `実行する場合は「承認」「やって」「OK」などと返信してください。`,
  ].join('\n');
}

// pipeline.js からLancers高スコア案件を受け取ってLINEに承認カードを送信
app.post('/lancers/job', express.json(), async (req, res) => {
  const secret = req.headers['x-lancers-secret'];
  if (process.env.LANCERS_API_SECRET && secret !== process.env.LANCERS_API_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const job = req.body as Omit<LancersJob, 'id'>;
  if (!job?.url || !job?.title) return res.status(400).json({ error: 'url and title required' });

  const id = String(++lancersJobCounter).padStart(3, '0');
  lancersJobs.set(id, { ...job, id });
  saveJobs();

  const lineUserId = process.env.LINE_USER_ID || 'U5ff819a7a20ddd21ecc14ff2a4ed4813';

  if (job.autoApply) {
    // スコア >= 70: 承認不要で即タスク作成 → agent.ts が自動実行
    // proposalをbase64でエンコードして渡す（Windows CLIの日本語文字化け対策）
    const proposalB64 = Buffer.from(job.proposal || '', 'utf8').toString('base64');
    const instruction = `以下のLancers案件にPlaywrightで自動応募してください。

手順:
1. Bashで以下を実行してproposalファイルを作成:
node -e "require('fs').mkdirSync('C:/Temp',{recursive:true}); require('fs').writeFileSync('C:/Temp/aether_${id}.txt', Buffer.from('${proposalB64}','base64').toString('utf8'), 'utf8'); console.log('written');"
2. Bashで以下を実行して応募:
node -e "require('dotenv').config({path:'C:/Users/merucari/.openclaw/workspace/ping-test/.env'}); const {applyToJob}=require('C:/Users/merucari/.openclaw/workspace/ping-test/auto-apply.js'); const p=require('fs').readFileSync('C:/Temp/aether_${id}.txt','utf8'); applyToJob('${job.url}',p).then(r=>{console.log('応募完了:',JSON.stringify(r)); process.exit(0);}).catch(e=>{console.error('応募失敗:',e.message); process.exit(1);});"
3. 成功なら "応募完了 [${id}] ${job.title}" とだけ返答する
4. 失敗なら エラー内容と "応募失敗 [${id}]" と返答する

※ auto-apply.js は .env の LANCERS_EMAIL と LANCERS_PASSWORD を使います`;

    const task = taskDb.create(lineUserId, instruction);
    taskDb.approve(task.id);

    const autoCard = [
      `🤖 自動応募開始 [ID: ${id}]`,
      `${job.scoreLabel} (${job.score}点)`,
      job.reason ? `理由: ${job.reason}` : '',
      ``,
      `【案件名】${job.title}`,
      `【予算】${job.budgetText || '不明'}`,
      `【URL】${job.url}`,
      ``,
      `（2〜5分後に応募します。完了したら通知します）`,
      `❌ キャンセル → LINEで "STOP ALL"`,
    ].filter(Boolean).join('\n');
    await sendDiscord(autoCard);
  } else {
    // 承認カード送信
    const card = [
      `📋 案件承認カード [ID: ${id}]`,
      `${job.scoreLabel} (${job.score}点)`,
      job.reason ? `理由: ${job.reason}` : '',
      ``,
      `【案件名】${job.title}`,
      `【予算】${job.budgetText || '不明'}`,
      `【URL】${job.url}`,
      ``,
      `✅ 応募 → LINEで "GO ${id}" と送信`,
      `❌ スキップ → 無視でOK`,
    ].filter(Boolean).join('\n');
    await sendDiscord(card);
  }

  res.json({ ok: true, id });
});

// LINE webhook
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events as webhook.Event[];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source?.userId ?? 'unknown';
    const userText = event.message.text.trim();
    const replyToken = (event as webhook.MessageEvent).replyToken ?? '';

    // ID確認コマンド
    if (userText.toUpperCase() === 'ID') {
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `あなたのUser ID:\n${userId}` }] });
      continue;
    }

    // "GO [ID]" — Lancers案件を即実行（承認カード不要）
    const goMatch = userText.match(/^GO\s+(\d+)$/i);
    if (goMatch) {
      const lancersId = goMatch[1].padStart(3, '0');
      const lancersJob = lancersJobs.get(lancersId);
      if (!lancersJob) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ ID: ${lancersId} の案件が見つかりません。\n案件は再起動でリセットされます。` }] });
        continue;
      }
      // ジュニアへの指示を作成して即承認 → agent.tsが5秒以内に実行
      // proposalをbase64でエンコードして渡す（Windows CLIの日本語文字化け対策）
      const proposalB64 = Buffer.from(lancersJob.proposal || '', 'utf8').toString('base64');
      const instruction = `以下のLancers案件にPlaywrightで自動応募してください。

手順:
1. Bashで以下を実行してproposalファイルを作成:
node -e "require('fs').mkdirSync('C:/Temp',{recursive:true}); require('fs').writeFileSync('C:/Temp/aether_${lancersId}.txt', Buffer.from('${proposalB64}','base64').toString('utf8'), 'utf8'); console.log('written');"
2. Bashで以下を実行して応募:
node -e "require('dotenv').config({path:'C:/Users/merucari/.openclaw/workspace/ping-test/.env'}); const {applyToJob}=require('C:/Users/merucari/.openclaw/workspace/ping-test/auto-apply.js'); const p=require('fs').readFileSync('C:/Temp/aether_${lancersId}.txt','utf8'); applyToJob('${lancersJob.url}',p).then(r=>{console.log('応募完了:',JSON.stringify(r)); process.exit(0);}).catch(e=>{console.error('応募失敗:',e.message); process.exit(1);});"
3. 成功なら "応募完了 [${lancersId}] ${lancersJob.title}" とだけ返答する
4. 失敗なら エラー内容と "応募失敗 [${lancersId}]" と返答する

※ auto-apply.jsは .env の LANCERS_EMAIL と LANCERS_PASSWORD を使ってログインして自動送信します`;
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id); // 二度確認なしで即承認
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `⚙️ [${lancersId}] ジュニアに指示中...\n応募ページが開いたら貼り付けて送信してください。` }] });
      continue;
    }

    // ゆうすけ本人のメッセージ
    const OWNER_ID = process.env.LINE_USER_ID || 'U5ff819a7a20ddd21ecc14ff2a4ed4813';
    if (userId === OWNER_ID) {

      // ── STOP ALL パニックボタン ──
      if (/^STOP\s*ALL$/i.test(userText)) {
        const task = taskDb.create(userId, '__STOP_ALL__');
        taskDb.approve(task.id);
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '🛑 STOP ALL 指示送信。10秒以内に停止します。' }] });
        continue;
      }

      // ── START ALL 再開コマンド ──
      if (/^START\s*ALL$/i.test(userText)) {
        const task = taskDb.create(userId, '__START_ALL__');
        taskDb.approve(task.id);
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '▶️ START ALL 指示送信。10秒以内に再開します。' }] });
        continue;
      }

      // ── DELIVER {id} — 納品コンテンツ生成 ──
      const deliverMatch = userText.match(/^DELIVER\s+(\d+)$/i);
      if (deliverMatch) {
        const appId = deliverMatch[1].padStart(3, '0');
        const instruction = `node "C:/Users/merucari/.claude/scripts/lancers-pipeline/delivery.js" "${appId}" を実行して、結果を報告してください。`;
        const task = taskDb.create(userId, instruction);
        taskDb.approve(task.id);
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `📝 [${appId}] 納品コンテンツ生成中...\n完了したらプレビューを送ります。` }] });
        continue;
      }

      // ── GO_DELIVER {id} — 承認済み納品物を提出 ──
      const goDeliverMatch = userText.match(/^GO_DELIVER\s+(\d+)$/i);
      if (goDeliverMatch) {
        const appId = goDeliverMatch[1].padStart(3, '0');
        const instruction = `以下を実行してください:
1. node -e "const l=require('C:/Users/merucari/.claude/scripts/lancers-pipeline/logger.js'); const d=l.getDelivery('${appId}'); console.log(JSON.stringify(d));" を実行してdelivery内容を取得
2. 取得したcontentをLancersの案件ページ（job_url）のメッセージ欄に送信
3. 成功したら l.updateDelivery('${appId}', {delivery_status:'delivered'}) を実行
4. 完了を報告`;
        const task = taskDb.create(userId, instruction);
        taskDb.approve(task.id);
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `📤 [${appId}] 納品物を送信中...` }] });
        continue;
      }

      // ── REPLY {id} — クライアントへ返信 ──
      const replyMatch = userText.match(/^REPLY\s+(\d+)\s+([\s\S]+)$/i);
      if (replyMatch) {
        const appId   = replyMatch[1].padStart(3, '0');
        const replyText = replyMatch[2].trim();
        // TODO: Playwright でLancersのメッセージ送信（将来実装）
        // 今は手動コピペ用にテキストを返す
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `📋 返信文 [${appId}]:\n\n${replyText}\n\n（Lancers画面に貼り付けてください）` }] });
        continue;
      }

      // ── SHOW_DELIVERY {id} — 納品物全文表示 ──
      const showDeliveryMatch = userText.match(/^SHOW_DELIVERY\s+(\d+)$/i);
      if (showDeliveryMatch) {
        const appId = showDeliveryMatch[1].padStart(3, '0');
        const instruction = `node -e "const l=require('C:/Users/merucari/.claude/scripts/lancers-pipeline/logger.js'); const d=l.getDelivery('${appId}'); if(d){console.log('【納品物全文】\\n'+d.content);}else{console.log('納品物が見つかりません: ${appId}');}" を実行して結果を報告してください。`;
        const task = taskDb.create(userId, instruction);
        taskDb.approve(task.id);
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `📄 [${appId}] 全文取得中...` }] });
        continue;
      }

      // 通常メッセージ → 即実行
      const task = taskDb.create(userId, userText);
      taskDb.approve(task.id);
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `⚡ 受信。ジュニアが実行中...\n「${userText.slice(0, 40)}${userText.length > 40 ? '…' : ''}」` }],
      });
      continue;
    }

    // 他のユーザー → 承認カードを送る（セキュリティ維持）
    const task = taskDb.create(userId, userText);
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: buildApprovalCard(task) }],
    });
  }
});

// エージェント用API
app.use(express.json());

app.get('/tasks/approved', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(taskDb.getApproved());
});

app.post('/tasks/:id/complete', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { result, error, line_user_id } = req.body as { result?: string; error?: string; line_user_id?: string };
  const id = Number(req.params.id);

  if (error) {
    taskDb.setError(id, error);
  } else {
    taskDb.complete(id, result ?? '');
  }

  if (line_user_id) {
    const message = error
      ? `❌ タスク ${id} でエラーが発生しました。\n${error}`
      : `✅ タスク ${id} が完了しました。\n\n${result}`;
    sendDiscord(message).catch(console.error);
  }

  res.json({ ok: true });
});

// エージェントからのプッシュ通知代理送信
app.post('/notify', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { to, message } = req.body as { to: string; message: string };
  await lineClient.pushMessage({ to, messages: [{ type: 'text', text: message }] });
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
