import { createServer, type IncomingMessage } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { Agent, type Providers } from './agent';
import { Briefings } from './briefings';
import { Channels, Secretary } from './channel';
import { config } from './config';
import { Google } from './google';
import { anthropicCreate, ClaudeProvider } from './llm/claude';
import { GeminiProvider, type GenerateContent } from './llm/gemini';
import { Line, verifyLineSignature } from './line';
import { hasFfmpeg } from './audio';
import { FileHost } from './files';
import { JapaneseDaily } from './japanese';
import { Maps } from './maps';
import { modelInfo } from './models';
import { Scheduler } from './scheduler';
import { Store } from './store';
import { Telegram } from './telegram';

const store = new Store(config.dataDir);

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
const japanese = new JapaneseDaily(config, store, agent);

/** /status: what is configured and whether it works. */
async function status(): Promise<string> {
  const lines = [`🩺 ${agent.botName} status (version ${config.version})`];
  const model = modelInfo(agent.model);
  lines.push(`AI model: ${model.label} (${model.id})${agent.hasProvider(model.provider) ? '' : ' ⚠️ its API key is missing'}`);
  lines.push(`Gemini key: ${config.geminiKey ? '✅' : '❌ not set (needed for Gemini models and voice notes)'}`);
  lines.push(`Claude key: ${providers.claude ? '✅' : '— not set (optional)'}`);
  if (gemini && model.provider === 'gemini') {
    try {
      await gemini.models.get({ model: model.id });
      lines.push(`Gemini model ${model.id}: ✅ available`);
    } catch (e) {
      lines.push(`Gemini model ${model.id}: ❌ ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (google) {
    try {
      await google.check();
      const missing = google.missing();
      lines.push(
        missing.length
          ? `Google: ✅ signed in, but without ${missing.join(', ')}. Run \`npm run google-auth\` again to add them.`
          : 'Google (Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts): ✅ signed in',
      );
    } catch (e) {
      lines.push(`Google: ❌ ${(e as Error).message}`);
    }
  } else lines.push('Google: — not connected (run `npm run google-auth`)');
  lines.push(`Telegram: ${config.telegram.token ? `✅ ${config.telegram.mode}` : '— off'}  LINE: ${config.line.accessToken ? '✅' : '— off'}`);
  const s = store.settings();
  lines.push(`Personality: ${s.personaKey ?? 'default'}${s.ttsVoice ? `, voice ${s.ttsVoice}` : ''}`);
  lines.push(`Google Maps: ${maps ? '✅' : '— off (GOOGLE_MAPS_API_KEY)'}  WaniKani: ${config.wanikaniToken ? '✅' : '— off'}`);
  const voiceMode = store.settings().voiceReplies ?? config.defaultVoiceReplies;
  lines.push(
    `Spoken replies: ${voiceMode}${voiceMode === 'off' ? '' : !config.geminiKey ? ' ⚠️ needs GEMINI_API_KEY' : !hasFfmpeg() ? ' ⚠️ needs ffmpeg' : ` ✅ (${config.ttsModel}, voice ${config.ttsVoice})`}`,
    `Public address: ${config.publicUrl || '— not set (LINE needs PUBLIC_URL for its webhook, voice replies and file links)'}`,
  );
  lines.push(
    `Scheduled messages go to: ${config.notifyChats.join(', ') || '⚠️ nobody (set BOT_NOTIFY_CHATS to your chat from /id)'}`,
    `Kanji & word of the day ${config.schedule.japanese || 'off'}, weather ${config.schedule.weather || 'off'}, briefing ${config.schedule.briefing || 'off'}, weekend planner ${config.schedule.weekendDay} ${config.schedule.weekend || 'off'}, cleanup ${config.schedule.cleanup || 'off'} (${config.timezone})`,
  );
  const b = config.billing;
  lines.push(`Spending today: $${agent.spentToday().toFixed(4)}${b.warnUsd !== null ? `, warn at $${b.warnUsd}` : ''}${b.capUsd !== null ? `, cap $${b.capUsd}` : ''}`);
  return lines.join('\n');
}

const secretary = new Secretary(config, store, agent, briefings, geminiGenerate, status, japanese);
const channels = new Channels();
const telegram = config.telegram.token ? new Telegram(config.telegram, secretary) : null;
const files = new FileHost(config.publicUrl);
const line = config.line.channelSecret && config.line.accessToken ? new Line(config.line, secretary, files) : null;
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
      void channels.send(chat, `✅ ${agent.botName} updated and running (version ${config.version}).`).catch(() => undefined);
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
