import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../src/shared/env.js';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hook = (id) => `https://discord.com/api/webhooks/${id}/token${id}`;

// ---- 共用環境檔 env/.env.shared ----

async function setupSharedEnv(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-env-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'env'));
  await writeFile(path.join(rootDir, 'env', '.env.shared'),
    'CODEX_BIN=shared-codex\nCODEX_MODEL=shared-model\nARTALE_DISCORD_WEBHOOK_URL=wrong-shared-hook\nCRYPTO_SCHEDULE_TIME=09:00\n');
  await writeFile(path.join(rootDir, '.env'), 'CODEX_BIN=wrong-legacy-codex\n');
  return rootDir;
}

test('只載入 env/.env.shared 的共用設定，忽略主題前綴的變數與根目錄舊 .env', async (t) => {
  const rootDir = await setupSharedEnv(t);
  assert.deepEqual(loadProjectEnv({ rootDir, env: {} }), { CODEX_BIN: 'shared-codex', CODEX_MODEL: 'shared-model' });
});

test('系統環境變數含空值時仍優先；缺少共用環境檔時不變更環境變數', async (t) => {
  const rootDir = await setupSharedEnv(t);
  const env = { CODEX_BIN: 'system-codex', CODEX_MODEL: '' };
  assert.equal(loadProjectEnv({ rootDir, env }), env);
  assert.deepEqual(env, { CODEX_BIN: 'system-codex', CODEX_MODEL: '' });
  await rm(path.join(rootDir, 'env'), { recursive: true });
  assert.deepEqual(loadProjectEnv({ rootDir, env: {} }), {});
});

test('無法讀取共用環境檔時明確失敗', async (t) => {
  const rootDir = await setupSharedEnv(t);
  await rm(path.join(rootDir, 'env/.env.shared'));
  await mkdir(path.join(rootDir, 'env/.env.shared'));
  assert.throws(() => loadProjectEnv({ rootDir, env: {} }), /無法讀取環境設定 env\/\.env\.shared/);
});

// ---- 主題設定檔 env/<主題>.js ----

/**
 * 在子程序中以指定的設定檔內容載入主題設定，回傳摘要。
 * content 為設定物件（轉成 export default）或原始 JS 文字；null 代表設定檔不存在。
 */
async function readConfig(t, source, content, { cwd = ROOT, env = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-topic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${source}.js`);
  if (content !== null) await writeFile(file, typeof content === 'string' ? content : `export default ${JSON.stringify(content)};`);
  const script = `
try {
  const { config } = await import(${JSON.stringify(new URL(`../src/${source}/config.js`, import.meta.url).href)});
  console.log(JSON.stringify({
    targets: config.targets.map(({ name, webhookId, webhookProfile }) => ({ name, webhookId, webhookProfile })),
    state: config.stateFile, posts: config.discordMessagesFile,
    days: [...config.schedule.days].sort(), start: config.schedule.start, end: config.schedule.end,
    interval: config.schedule.intervalMinutes, timeZone: config.schedule.timeZone, timeout: config.codex.timeoutMs,
    ...(config.newsCategories ? { categories: config.newsCategories } : {}),
    ...(config.news ? { news: config.news, webSearch: config.codex.webSearch } : {}),
  }));
} catch (err) { console.error(err.message); process.exitCode = 1; }
`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...process.env, CODEX_TIMEOUT_MS: '', [`${source.toUpperCase()}_CONFIG_FILE`]: file, ...env },
  });
  return JSON.parse(stdout);
}

const profileFile = (source, id) => path.join(ROOT, `data/${source}/webhook-profiles/${id}.json`);
const emptyProfile = (source, id) => ({ profileFile: profileFile(source, id), personaPrompt: '', avatarMessage: '', nameMessage: '' });

test('Artale 設定檔不存在或為空時使用預設值，且不讀取舊的環境變數設定', async (t) => {
  const expected = { targets: [], state: path.join(ROOT, 'data/artale/state.json'), posts: path.join(ROOT, 'data/artale/discord-messages.jsonl'),
    days: [2], start: 500, end: 1040, interval: 60, timeZone: 'Asia/Taipei', timeout: 300000, categories: ['maintenance', 'update', 'bm'] };
  const legacyEnv = { ARTALE_DISCORD_WEBHOOK_URL: hook('999'), ARTALE_SCHEDULE_DAYS: 'invalid', ARTALE_NEWS_CATEGORIES: 'invalid' };
  assert.deepEqual(await readConfig(t, 'artale', null, { env: legacyEnv }), expected);
  assert.deepEqual(await readConfig(t, 'artale', {}), expected);
});

test('Artale 設定檔的 Webhook、分類、排程、提醒與紀錄設定；從其他目錄啟動時相對路徑仍以專案根目錄為準', async (t) => {
  const config = await readConfig(t, 'artale', {
    webhooks: [
      { name: '自己', url: hook('111'), webhookProfile: { avatarMessage: '換頭像', nameMessage: '改名' } },
      { url: hook('222'), webhookProfile: { personaPrompt: '貓' } },
    ],
    newsCategories: ['update', 'bm'],
    schedule: { days: '2,4', start: '10:00', end: '18:00', intervalMinutes: 30, timeZone: 'UTC' },
    files: { state: 'data/artale/custom-state.json', discordMessages: 'data/artale/custom-posts.jsonl' },
  }, { cwd: os.tmpdir() });
  assert.deepEqual(config, {
    targets: [
      { name: '自己', webhookId: '111', webhookProfile: { ...emptyProfile('artale', '111'), avatarMessage: '換頭像', nameMessage: '改名' } },
      { name: '', webhookId: '222', webhookProfile: { ...emptyProfile('artale', '222'), personaPrompt: '貓' } },
    ],
    state: path.join(ROOT, 'data/artale/custom-state.json'), posts: path.join(ROOT, 'data/artale/custom-posts.jsonl'),
    days: [2, 4], start: 600, end: 1080, interval: 30, timeZone: 'UTC', timeout: 300000, categories: ['update', 'bm'],
  });
  assert.deepEqual((await readConfig(t, 'artale', { schedule: { days: [1, 3] }, newsCategories: 'maintenance' })).days, [1, 3]);
});

test('Artale 設定錯誤明確指出設定檔與欄位名稱', async (t) => {
  const cases = [
    [{ schedule: { days: 'x' } }, 'schedule.days'],
    [{ schedule: { start: '25:00' } }, 'schedule.start'],
    [{ schedule: { end: 'x' } }, 'schedule.end'],
    [{ schedule: { timeZone: 'Mars/Base' } }, 'schedule.timeZone'],
    [{ schedule: { intervalMinutes: 0 } }, 'schedule.intervalMinutes'],
    [{ schedule: { start: '18:00', end: '08:00' } }, 'schedule.start'],
    [{ newsCategories: ['shop'] }, 'newsCategories'],
    [{ webhook: [] }, '不支援的欄位：webhook'],
    [{ webhookProfile: {} }, '不支援的欄位：webhookProfile'],
    [{ schedule: { interval: 30 } }, 'schedule 有不支援的欄位：interval'],
    [{ webhooks: [{ url: 'https://example.com/x' }] }, 'webhooks 第 1 個'],
  ];
  for (const [content, name] of cases) {
    await assert.rejects(readConfig(t, 'artale', content), (err) => {
      assert.ok(err.stderr.includes('artale.js 的') || err.stderr.includes('artale.js 有'), err.stderr);
      assert.ok(err.stderr.includes(name), `${name}：${err.stderr}`);
      return true;
    });
  }
});

test('Crypto 設定檔為空時使用預設值：每天 08:00、台灣時間、各 3 則、BTC → ADA → ETH、開放網路搜尋', async (t) => {
  assert.deepEqual(await readConfig(t, 'crypto', {}, { env: { CRYPTO_DISCORD_WEBHOOK_URL: hook('999') } }), {
    targets: [], state: path.join(ROOT, 'data/crypto/state.json'), posts: path.join(ROOT, 'data/crypto/discord-messages.jsonl'),
    days: [0, 1, 2, 3, 4, 5, 6], start: 480, end: 480, interval: 1440, timeZone: 'Asia/Taipei', timeout: 600000,
    news: { economyCount: 3, coinCount: 3, priorityCoins: ['BTC', 'ADA', 'ETH'] }, webSearch: true,
  });
});

test('Crypto 設定檔的 Webhook、排程、新聞、提醒、逾時與紀錄設定', async (t) => {
  const config = await readConfig(t, 'crypto', `
// 可以寫註解
export default {
  webhooks: [
    { name: '自己', url: '${hook('555')}', webhookProfile: { personaPrompt: '貓' } },
    { url: '${hook('666')}', webhookProfile: { nameMessage: '朋友改名' } }, // 每個機器人各自設定
  ],
  schedule: { days: '1-5', time: '21:30', timeZone: 'UTC' },
  news: { priorityCoins: ['eth', ' sol', 'Cardano'], economyCount: 1, coinCount: 10 },
  codexTimeoutMs: 120000,
  files: { state: 'data/crypto/custom-state.json', discordMessages: 'data/crypto/custom-posts.jsonl' },
};`);
  assert.deepEqual(config, {
    targets: [
      { name: '自己', webhookId: '555', webhookProfile: { ...emptyProfile('crypto', '555'), personaPrompt: '貓' } },
      { name: '', webhookId: '666', webhookProfile: { ...emptyProfile('crypto', '666'), nameMessage: '朋友改名' } },
    ],
    state: path.join(ROOT, 'data/crypto/custom-state.json'), posts: path.join(ROOT, 'data/crypto/custom-posts.jsonl'),
    days: [1, 2, 3, 4, 5], start: 1290, end: 1290, interval: 1440, timeZone: 'UTC', timeout: 120000,
    news: { economyCount: 1, coinCount: 10, priorityCoins: ['ETH', 'SOL', 'ADA'] }, webSearch: true,
  });
  assert.deepEqual((await readConfig(t, 'crypto', { news: { priorityCoins: 'BTC,ETH' } })).news.priorityCoins, ['BTC', 'ETH']);
});

test('Crypto 設定錯誤明確指出設定檔與欄位名稱', async (t) => {
  const cases = [
    [{ schedule: { days: 'x' } }, 'schedule.days'],
    [{ schedule: { time: '8點' } }, 'schedule.time'],
    [{ schedule: { timeZone: 'Mars/Base' } }, 'schedule.timeZone'],
    [{ codexTimeoutMs: 'x' }, 'codexTimeoutMs'],
    [{ news: { economyCount: 0 } }, 'news.economyCount'],
    [{ news: { coinCount: 11 } }, 'news.coinCount'],
    [{ news: { priorityCoins: ['B$C'] } }, 'news.priorityCoins'],
    [{ news: { coins: ['BTC'] } }, 'news 有不支援的欄位：coins'],
    [{ webhooks: [{ url: hook('1'), webhookProfile: { persona: '貓' } }] }, 'webhookProfile 有不支援的欄位：persona'],
    [{ webhooks: [{ url: hook('1') }, { url: hook('1') }] }, '重複的 Webhook'],
  ];
  for (const [content, name] of cases) {
    await assert.rejects(readConfig(t, 'crypto', content), (err) => {
      assert.ok(err.stderr.includes('crypto.js'), err.stderr);
      assert.ok(err.stderr.includes(name), `${name}：${err.stderr}`);
      return true;
    });
  }
});
