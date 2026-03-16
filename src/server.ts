import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi, webhook } from '@line/bot-sdk';
import Groq from 'groq-sdk';
import { taskDb } from './db';

const app = express();
const PORT = process.env.PORT || 3002;

// Lancers ジョブストア（メモリ）
type LancersJob = { id: string; title: string; url: string; proposal: string; budgetText: string; score: number; scoreLabel: string };
const lancersJobs = new Map<string, LancersJob>();
let lancersJobCounter = 0;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  const lineUserId = process.env.LINE_USER_ID || 'U5ff819a7a20ddd21ecc14ff2a4ed4813';
  if (lineUserId) {
    const card = [
      `📋 案件承認カード [ID: ${id}]`,
      `${job.scoreLabel} (${job.score}点)`,
      ``,
      `【案件名】${job.title}`,
      `【予算】${job.budgetText || '不明'}`,
      `【URL】${job.url}`,
      ``,
      `✅ 応募 → "GO ${id}" と返信`,
      `❌ スキップ → 無視でOK`,
    ].join('\n');
    await lineClient.pushMessage({ to: lineUserId, messages: [{ type: 'text', text: card }] }).catch(console.error);
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
      // ジュニアへの指示を作成して即承認 → agent.tsが10秒以内に実行
      const instruction = `以下のLancers案件の準備をしてください:\n\n1. この応募文をクリップボードにコピーする（Bashで: echo "${lancersJob.proposal.replace(/"/g, '\\"').replace(/\n/g, ' ')}" | clip）\n2. Windowsのブラウザでこのページを開く（Bashで: start "${lancersJob.url}"）\n3. "準備完了 [${lancersId}] ${lancersJob.title}" とだけ返答する\n\n応募文:\n${lancersJob.proposal}`;
      const task = taskDb.create(userId, instruction);
      taskDb.approve(task.id); // 二度確認なしで即承認
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `⚙️ [${lancersId}] ジュニアに指示中...\n応募ページが開いたら貼り付けて送信してください。` }] });
      continue;
    }

    // 承認待ちタスクがある場合、自然言語で承認判定
    const waitingTasks = taskDb.getAwaitingApproval();
    if (waitingTasks.length > 0) {
      const intentRes = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `ユーザーのメッセージが「タスクの承認」を意図しているかを判定してください。
承認の例: 「承認」「やって」「OK」「いいよ」「お願い」「進めて」「実行して」「やろう」「GO」「はい」「頼む」など。
返答はJSONのみ: {"approved": true, "taskId": null} または {"approved": false}
taskIdはメッセージ中に数字があればその数値、なければnull。`,
          },
          { role: 'user', content: userText },
        ],
        max_tokens: 50,
      });

      let intent: { approved: boolean; taskId: number | null } = { approved: false, taskId: null };
      try {
        const raw = intentRes.choices[0].message.content ?? '{}';
        intent = JSON.parse(raw.match(/\{.*\}/s)?.[0] ?? '{}');
      } catch { /* パース失敗は承認なしとみなす */ }

      if (intent.approved) {
        // IDが指定されていればそのタスク、なければ最新の承認待ちタスク
        const targetId = intent.taskId ?? waitingTasks[waitingTasks.length - 1].id;
        const task = taskDb.approve(targetId);
        const reply = task
          ? `✅ タスク ${targetId} を承認しました。実行します。`
          : `⚠️ 承認待ちのタスクが見つかりませんでした。`;
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: reply }] });
        continue;
      }
    }

    // 通常メッセージ → Groqで指示変換 → 承認カード送信
    const groqRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `あなたはLINEメッセージをClaude Codeへの指示に変換するアシスタントです。
ユーザーのメッセージを、Claude Codeが実行できる明確な技術指示に変換してください。
プロジェクトのパス: C:/Users/merucari/OneDrive/デスクトップ/samantha-final/
返答は指示文のみ。説明不要。`,
        },
        { role: 'user', content: userText },
      ],
      max_tokens: 500,
    });

    const instruction = groqRes.choices[0].message.content ?? userText;
    const task = taskDb.create(userId, instruction);

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

    lineClient.pushMessage({
      to: line_user_id,
      messages: [{ type: 'text', text: message }],
    }).catch(console.error);
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
