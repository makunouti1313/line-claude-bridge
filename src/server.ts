import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi, webhook } from '@line/bot-sdk';
import Groq from 'groq-sdk';
import { taskDb } from './db';

const app = express();
const PORT = process.env.PORT || 3002;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// LINE webhook
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events as webhook.Event[];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source?.userId ?? 'unknown';
    const userText = event.message.text;

    // Groqで指示を整理
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

    const replyToken = (event as webhook.MessageEvent).replyToken ?? '';
    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `タスクを受け付けました（ID: ${task.id}）\n\n「${instruction}」\n\n完了したら結果を送ります。`,
        },
      ],
    });
  }
});

// エージェント用API（ローカルPCがポーリング）
app.use(express.json());

app.get('/tasks/pending', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(taskDb.getPending());
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

  // LINEに結果を送信
  if (line_user_id) {
    const message = error
      ? `タスク ${id} でエラーが発生しました。\n${error}`
      : `タスク ${id} が完了しました。\n\n${result}`;

    lineClient.pushMessage({
      to: line_user_id,
      messages: [{ type: 'text', text: message }],
    }).catch(console.error);
  }

  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
