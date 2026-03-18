import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi, webhook } from '@line/bot-sdk';
import Groq from 'groq-sdk';
import { Client, GatewayIntentBits, Events } from 'discord.js';
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

// ─── Discord 送信キュー（レート制限対応・500+件バースト対応） ─────────────
// Discord webhook: 安全レートは 2req/秒（超えると429、30分BANのリスクあり）
const discordQueue: string[] = [];
let discordQueueRunning = false;

function enqueueDiscord(content: string): void {
  discordQueue.push(content.slice(0, 2000));
  if (!discordQueueRunning) processDiscordQueue();
}

async function processDiscordQueue(): Promise<void> {
  discordQueueRunning = true;
  while (discordQueue.length > 0) {
    const content = discordQueue.shift()!;
    await sendDiscord(content);
    if (discordQueue.length > 0) await new Promise(r => setTimeout(r, 500)); // 2req/秒
  }
  discordQueueRunning = false;
}

/** Discord webhook に直接送信（失敗時は3回リトライ・指数バックオフ） */
async function sendDiscord(content: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || res.status === 204) return;
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || '2') * 1000;
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }
      throw new Error(`Discord HTTP ${res.status}`);
    } catch (e) {
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      else console.error('Discord送信失敗:', (e as Error).message);
    }
  }
}

/** ドラフト生成指示（auto-apply.js は使わない・提出は人間が手動） */
function buildDraftInstruction(id: string, job: LancersJob): string {
  return `以下のLancers案件の応募文ドラフトを生成してローカルに保存してください。

案件ID: ${id}
タイトル: ${job.title}
URL: ${job.url}
予算: ${job.budgetText || '不明'}
スコア: ${job.score}点
${job.reason ? `選定理由: ${job.reason}` : ''}

既存の提案文（ベースとして使用）:
${job.proposal || '（未生成）'}

手順:
1. node -e "require('fs').mkdirSync('C:/Users/merucari/.claude/scripts/lancers-pipeline/drafts',{recursive:true});" を実行
2. 上記案件に合わせた高品質な応募文ドラフトを作成する（800〜1200文字、具体的・読み手が一目で採用したくなる内容）
3. ドラフトをMarkdown形式で C:/Users/merucari/.claude/scripts/lancers-pipeline/drafts/${id}.md に保存する
4. "ドラフト完了 [${id}] ${job.title}" とだけ返答する

絶対禁止: auto-apply.js の実行・ブラウザ操作・応募ボタンのクリック。提出は人間が手動で行う。`;
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

  // 全案件: 承認カード送信（auto-submitは禁止。提出は人間が手動で行う）
  const card = [
    `📋 案件カード [ID: ${id}]`,
    `${job.scoreLabel} (${job.score}点)`,
    job.reason ? `理由: ${job.reason}` : '',
    ``,
    `【案件名】${job.title}`,
    `【予算】${job.budgetText || '不明'}`,
    `【URL】${job.url}`,
    ``,
    `✅ ドラフト生成 → "GO ${id}"`,
    `❌ スキップ → 無視でOK`,
  ].filter(Boolean).join('\n');
  enqueueDiscord(card);

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
      const task = taskDb.create(userId, buildDraftInstruction(lancersId, lancersJob));
      taskDb.approve(task.id);
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `📝 [${lancersId}] ドラフト生成中...完了したらDiscordに通知します。` }] });
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
    enqueueDiscord(message);
  }

  res.json({ ok: true });
});

// エージェントからのプッシュ通知代理送信（Discord優先、フォールバックなし）
app.post('/notify', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { message } = req.body as { to?: string; message: string };
  enqueueDiscord(message);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ── Discord Bot（メッセージ受信） ──
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? '';

if (process.env.DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID) {
  const discordBot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordBot.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (msg.channelId !== DISCORD_CHANNEL_ID) return;

    const userText = msg.content.trim();
    const userId = process.env.LINE_USER_ID ?? '';

    const reply = async (text: string) => {
      await msg.reply(text.slice(0, 2000)).catch(console.error);
    };

    // GO [ID] — ドラフト生成（提出は人間が手動）
    const goMatch = userText.match(/^GO\s+(\d+)$/i);
    if (goMatch) {
      const lancersId = goMatch[1].padStart(3, '0');
      const lancersJob = lancersJobs.get(lancersId);
      if (!lancersJob) {
        await reply(`❌ ID: ${lancersId} の案件が見つかりません。`);
        return;
      }
      const task = taskDb.create(userId, buildDraftInstruction(lancersId, lancersJob));
      taskDb.approve(task.id);
      await reply(`📝 [${lancersId}] ドラフト生成中...\n完了したらDiscordに通知します。`);
      return;
    }

    // RESUME COST — コスト一時停止を解除
    if (/^RESUME\s*COST$/i.test(userText)) {
      const instruction = '__RESUME_COST__';
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id);
      await reply('▶️ コスト制限解除を指示しました。');
      return;
    }

    // COST — 現在のコスト状況を確認
    if (/^COST$/i.test(userText)) {
      const instruction = '__COST_STATUS__';
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id);
      await reply('💰 コスト状況を確認中...');
      return;
    }

    // STOP ALL
    if (/^STOP\s*ALL$/i.test(userText)) {
      const task = taskDb.create(userId, '__STOP_ALL__');
      taskDb.approve(task.id);
      await reply('🛑 STOP ALL 指示送信。10秒以内に停止します。');
      return;
    }

    // START ALL
    if (/^START\s*ALL$/i.test(userText)) {
      const task = taskDb.create(userId, '__START_ALL__');
      taskDb.approve(task.id);
      await reply('▶️ START ALL 指示送信。10秒以内に再開します。');
      return;
    }

    // DELIVER {id}
    const deliverMatch = userText.match(/^DELIVER\s+(\d+)$/i);
    if (deliverMatch) {
      const appId = deliverMatch[1].padStart(3, '0');
      const task = taskDb.create(userId, `node "C:/Users/merucari/.claude/scripts/lancers-pipeline/delivery.js" "${appId}" を実行して、結果を報告してください。`);
      taskDb.approve(task.id);
      await reply(`📝 [${appId}] 納品コンテンツ生成中...`);
      return;
    }

    // SHOW_DELIVERY {id}
    const showDeliveryMatch = userText.match(/^SHOW_DELIVERY\s+(\d+)$/i);
    if (showDeliveryMatch) {
      const appId = showDeliveryMatch[1].padStart(3, '0');
      const task = taskDb.create(userId, `node -e "const l=require('C:/Users/merucari/.claude/scripts/lancers-pipeline/logger.js'); const d=l.getDelivery('${appId}'); if(d){console.log('【納品物全文】\\n'+d.content);}else{console.log('納品物が見つかりません: ${appId}');}" を実行して結果を報告してください。`);
      taskDb.approve(task.id);
      await reply(`📄 [${appId}] 全文取得中...`);
      return;
    }

    // START [テーマ] — eBook生成
    const startMatch = userText.match(/^START\s+(.+)$/i);
    if (startMatch) {
      const theme = startMatch[1].trim();
      const instruction = `__PRODUCT__:${theme}`;
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id);
      await reply(`📚 **"${theme}"** の生成を開始します。\n5〜10分後にドラフトをお届けします。`);
      return;
    }

    // OK [draftId] — ドラフト承認（feedback-logに記録）
    const okMatch = userText.match(/^OK\s+(\d+)$/i);
    if (okMatch) {
      const instruction = `__PRODUCT_FEEDBACK__:${okMatch[1]}:OK`;
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id);
      await reply(`✅ ドラフト [${okMatch[1]}] を承認しました。記録します。`);
      return;
    }

    // NG [draftId] [理由] — ドラフト非承認
    const ngMatch = userText.match(/^NG\s+(\d+)\s+(.+)$/i);
    if (ngMatch) {
      const instruction = `__PRODUCT_FEEDBACK__:${ngMatch[1]}:${ngMatch[2]}`;
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id);
      await reply(`📝 フィードバック記録: "${ngMatch[2]}"\n次回の生成に反映します。`);
      return;
    }

    // 通常メッセージ → 即実行
    const task = taskDb.create(userId, userText);
    taskDb.approve(task.id);
    await reply(`⚡ 受信。ジュニアが実行中...\n「${userText.slice(0, 40)}${userText.length > 40 ? '…' : ''}」`);
  });

  discordBot.once(Events.ClientReady, (c) => {
    console.log(`Discord Bot ready: ${c.user.tag}`);
  });

  discordBot.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
}
