import { createServer, type IncomingMessage } from 'node:http';
import { langFromPreferences, t, useLanguage } from './i18n';
import { GoogleGenAI } from '@google/genai';
import { Agent, type Providers } from './agent';
import { Briefings } from './briefings';
import { Channels, Secretary } from './channel';
import { config } from './config';
import { Google } from './google';
import { anthropicCreate, ClaudeProvider } from './llm/claude';
import { GeminiProvider, type GenerateContent, geminiVoiceGenerate } from './llm/gemini';
import { Line, verifyLineSignature } from './line';
import { hasFfmpeg } from './audio';
import { FileHost } from './files';
import { JapaneseDaily } from './japanese';
import { Reviews } from './review';
import { Maps } from './maps';
import { modelInfo } from './models';
import { Scheduler } from './scheduler';
import { Store } from './store';
import { Telegram } from './telegram';

const store = new Store(config.dataDir);
// Fixed messages (command replies, alerts, the Telegram menu) follow a standing preference for Thai.
useLanguage(() => langFromPreferences(store.settings().preferences));

const gemini = config.geminiKey ? new GoogleGenAI({ apiKey: config.geminiKey }) : null;
const geminiGenerate: GenerateContent | null = gemini ? (p) => gemini.models.generateContent(p) : null;
const providers: Providers = {
  ...(geminiGenerate ? { gemini: new GeminiProvider(geminiGenerate) } : {}),
  ...(config.anthropicKey || process.env.ANTHROPIC_AUTH_TOKEN ? { claude: new ClaudeProvider(anthropicCreate()) } : {}),
};
if (!Object.keys(providers).length) console.warn('No AI key set: add GEMINI_API_KEY and/or ANTHROPIC_API_KEY (run `npm run setup`).');

let google: Google | null = null;
try {
  google = Google.load(config.dataDir);
} catch (e) {
  console.warn('Google not loaded:', (e as Error).message);
}

const maps = config.mapsKey ? new Maps(config.mapsKey) : null;
const agent = new Agent(config, store, providers, google, () => new Date(), maps);
const briefings = new Briefings(config, store, agent);
const reviews = new Reviews(config, store);
const japanese = new JapaneseDaily(config, store, agent, undefined, undefined, reviews);

/** /status: what is configured and whether it works. */
async function status(): Promise<string> {
  const off = t('off', 'ปิด');
  const lines = [t(`🩺 ${agent.botName} status (version ${config.version})`, `🩺 สถานะ ${agent.botName} (เวอร์ชัน ${config.version})`)];
  const model = modelInfo(agent.model);
  const keyMissing = agent.hasProvider(model.provider) ? '' : t(' ⚠️ its API key is missing', ' ⚠️ ยังไม่มีคีย์ API ของโมเดลนี้');
  lines.push(t(`AI model: ${model.label} (${model.id})${keyMissing}`, `โมเดล AI: ${model.label} (${model.id})${keyMissing}`));
  lines.push(
    t(
      `Gemini key: ${config.geminiKey ? '✅' : '❌ not set (needed for Gemini models and voice notes)'}`,
      `คีย์ Gemini: ${config.geminiKey ? '✅' : '❌ ยังไม่ได้ตั้ง (ต้องใช้กับโมเดล Gemini และข้อความเสียง)'}`,
    ),
  );
  lines.push(t(`Claude key: ${providers.claude ? '✅' : '— not set (optional)'}`, `คีย์ Claude: ${providers.claude ? '✅' : '— ยังไม่ได้ตั้ง (ไม่บังคับ)'}`));
  if (gemini && model.provider === 'gemini') {
    try {
      await gemini.models.get({ model: model.id });
      lines.push(t(`Gemini model ${model.id}: ✅ available`, `โมเดล Gemini ${model.id}: ✅ ใช้งานได้`));
    } catch (e) {
      lines.push(t(`Gemini model ${model.id}: ❌ ${(e as Error).message.slice(0, 120)}`, `โมเดล Gemini ${model.id}: ❌ ${(e as Error).message.slice(0, 120)}`));
    }
  }
  if (google) {
    try {
      await google.check();
      const missing = google.missing();
      lines.push(
        missing.length
          ? t(
              `Google: ✅ signed in, but without ${missing.join(', ')}. Run \`npm run google-auth\` again to add them.`,
              `Google: ✅ เชื่อมต่อแล้ว แต่ยังไม่มีสิทธิ์ ${missing.join(', ')} รัน \`npm run google-auth\` อีกครั้งเพื่อเพิ่ม`,
            )
          : t('Google (Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts): ✅ signed in', 'Google (Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts): ✅ เชื่อมต่อแล้ว'),
      );
    } catch (e) {
      lines.push(`Google: ❌ ${(e as Error).message}`);
    }
  } else lines.push(t('Google: — not connected (run `npm run google-auth`)', 'Google: — ยังไม่ได้เชื่อมต่อ (รัน `npm run google-auth`)'));
  lines.push(`Telegram: ${config.telegram.token ? `✅ ${config.telegram.mode}` : `— ${off}`}  LINE: ${config.line.accessToken ? '✅' : `— ${off}`}`);
  const s = store.settings();
  const persona = s.personaKey ?? t('default', 'ค่าเริ่มต้น');
  lines.push(
    t(`Personality: ${persona}${s.ttsVoice ? `, voice ${s.ttsVoice}` : ''}`, `บุคลิก: ${persona}${s.ttsVoice ? `, เสียง ${s.ttsVoice}` : ''}`),
  );
  lines.push(`Google Maps: ${maps ? '✅' : `— ${off} (GOOGLE_MAPS_API_KEY)`}  WaniKani: ${config.wanikaniToken ? '✅' : `— ${off}`}`);
  const voiceMode = store.settings().voiceReplies ?? config.defaultVoiceReplies;
  const voiceState =
    voiceMode === 'off'
      ? ''
      : !config.geminiKey
        ? t(' ⚠️ needs GEMINI_API_KEY', ' ⚠️ ต้องมี GEMINI_API_KEY')
        : !hasFfmpeg()
          ? t(' ⚠️ needs ffmpeg', ' ⚠️ ต้องมี ffmpeg')
          : t(
              ` ✅ (${secretary.ttsModel ?? (config.ttsModel || 'model picked on first use')}, voice ${store.settings().ttsVoice ?? config.ttsVoice})`,
              ` ✅ (${secretary.ttsModel ?? (config.ttsModel || 'เลือกโมเดลเมื่อใช้ครั้งแรก')}, เสียง ${store.settings().ttsVoice ?? config.ttsVoice})`,
            );
  lines.push(
    t(`Spoken replies: ${voiceMode}${voiceState}`, `การตอบเป็นเสียง: ${voiceMode}${voiceState}`),
    t(
      `Public address: ${config.publicUrl || '— not set (LINE needs PUBLIC_URL for its webhook, voice replies and file links)'}`,
      `ที่อยู่สาธารณะ: ${config.publicUrl || '— ยังไม่ได้ตั้ง (LINE ต้องใช้ PUBLIC_URL สำหรับ webhook การตอบเป็นเสียง และลิงก์ไฟล์)'}`,
    ),
  );
  const sc = config.schedule;
  lines.push(
    t(
      `Scheduled messages go to: ${config.notifyChats.join(', ') || '⚠️ nobody (set BOT_NOTIFY_CHATS to your chat from /id)'}`,
      `ข้อความตามเวลาส่งไปที่: ${config.notifyChats.join(', ') || '⚠️ ยังไม่มีใคร (ตั้ง BOT_NOTIFY_CHATS เป็นแชตของคุณจาก /id)'}`,
    ),
    t(
      `Kanji & word of the day ${sc.japanese || 'off'}, weather ${sc.weather || 'off'}, briefing ${sc.briefing || 'off'}, weekend planner ${sc.weekendDay} ${sc.weekend || 'off'}, cleanup ${sc.cleanup || 'off'} (${config.timezone})`,
      `คันจิและคำศัพท์ประจำวัน ${sc.japanese || off}, อากาศ ${sc.weather || off}, สรุปตอนเช้า ${sc.briefing || off}, วางแผนวันหยุด ${sc.weekendDay} ${sc.weekend || off}, เก็บกวาด ${sc.cleanup || off} (${config.timezone})`,
    ),
  );
  const b = agent.limits();
  const limits = (l: { warnUsd: number | null; capUsd: number | null }) =>
    `${l.warnUsd !== null ? t(`, warn at $${l.warnUsd}`, `, แจ้งเตือนที่ $${l.warnUsd}`) : ''}${l.capUsd !== null ? t(`, cap $${l.capUsd}`, `, วงเงิน $${l.capUsd}`) : ''}`;
  lines.push(
    t(`Spending today: $${agent.spentToday().toFixed(4)}${limits(b.all)} (change with /limit)`, `ค่าใช้จ่ายวันนี้: $${agent.spentToday().toFixed(4)}${limits(b.all)} (เปลี่ยนได้ด้วย /limit)`),
    `  Gemini $${agent.spentToday('gemini').toFixed(4)}${limits(b.gemini)}`,
    `  Claude $${agent.spentToday('claude').toFixed(4)}${limits(b.claude)}`,
  );
  return lines.join('\n');
}

// Voice (speech and voice-note transcription) uses the v1beta API, which has the speech settings.
const voiceGenerate = config.geminiKey ? geminiVoiceGenerate(config.geminiKey) : null;
const secretary = new Secretary(config, store, agent, briefings, voiceGenerate, status, japanese, reviews);
const channels = new Channels();
const telegram = config.telegram.token ? new Telegram(config.telegram, secretary) : null;
const files = new FileHost(config.publicUrl);
const line = config.line.channelSecret && config.line.accessToken ? new Line(config.line, secretary, files) : null;
secretary.setNotifier((chatKey, text) => channels.send(chatKey, text));
if (telegram) channels.add(telegram);
if (line) channels.add(line);
if (!telegram && !line) console.warn('Neither Telegram nor LINE is configured. See README.md.');

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method === 'GET' && path.startsWith('/files/')) {
      const f = files.get(path);
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.data.length, 'Content-Disposition': `inline; filename="${f.name}"` }).end(f.data);
      return;
    }
    if (req.method === 'POST' && path === '/telegram' && telegram && config.telegram.mode === 'webhook') {
      if (!telegram.verifyWebhook(req.headers['x-telegram-bot-api-secret-token'] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      const update = JSON.parse(await readBody(req));
      res.writeHead(200).end(); // answer now; the agent may take a while
      void telegram.handleUpdate(update);
      return;
    }
    if (req.method === 'POST' && path === '/line' && line) {
      const raw = await readBody(req);
      if (!verifyLineSignature(config.line.channelSecret, raw, req.headers['x-line-signature'] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end();
      void line.handleWebhook(JSON.parse(raw));
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error('HTTP handler error:', e);
    if (!res.headersSent) res.writeHead(400).end();
  }
});

server.listen(config.port, () => {
  const m = modelInfo(agent.model);
  console.log(`${config.botName} ${config.version} listening on :${config.port} (model ${m.id}, effort ${agent.effort}, Google ${google ? 'on' : 'off'})`);
  if (line) console.log('LINE webhook path: POST /line');
  if (line && config.publicUrl) void line.setWebhook(config.publicUrl).catch((e) => console.error((e as Error).message));
  if (!hasFfmpeg()) console.warn('ffmpeg not found: spoken replies and LINE voice messages need it (it is included in the Docker image).');
});

if (telegram) {
  if (config.telegram.mode === 'polling') void telegram.poll();
  else {
    const url = process.env.TELEGRAM_WEBHOOK_URL ?? (config.publicUrl ? `${config.publicUrl}/telegram` : '');
    if (url) void telegram.setWebhook(url).catch((e) => console.error(e));
  }
}

const scheduler = new Scheduler(config, store, channels, briefings, console.log, japanese, agent.health);
scheduler.start();

// Tell the owner a new version is running (e.g. after Watchtower updated the container).
if (config.announceStartup && config.version !== 'dev') {
  const lastVersion = store.ranOn('startup-version');
  if (lastVersion !== config.version) {
    store.markRan('startup-version', config.version);
    for (const chat of config.notifyChats) {
      void channels
        .send(chat, t(`✅ ${agent.botName} updated and running (version ${config.version}).`, `✅ ${agent.botName} อัปเดตแล้วและกำลังทำงาน (เวอร์ชัน ${config.version})`))
        .catch(() => undefined);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    telegram?.stop();
    scheduler.stop();
    server.close();
    process.exit(0);
  });
}
