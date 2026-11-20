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
// 子程序載入設定時清空 AI 相關的環境變數，避免本機 env/.env.shared 的設定影響預設值（已設定的空值優先於共用檔）
const NEUTRAL_AI_ENV = {
  AI_PROVIDER: '', AI_TIMEOUT_MS: '', CODEX_TIMEOUT_MS: '', CODEX_BIN: '', CODEX_MODEL: '', CLAUDE_BIN: '', CLAUDE_MODEL: '',
};

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
 * aiOnly 為 true 時只回傳 AI 設定（provider、bin、model、timeoutMs）。
 */
async function readConfig(t, source, content, { cwd = ROOT, env = {}, aiOnly = false } = {}) {
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
    interval: config.schedule.intervalMinutes, timeZone: config.schedule.timeZone, timeout: config.ai.timeoutMs,
    ...(config.newsCategories ? { categories: config.newsCategories } : {}),
    ...(config.news ? { news: config.news, webSearch: config.ai.webSearch } : {}),
    ...(config.markets ? { markets: config.markets, webSearch: config.ai.webSearch } : {}),
    ai: { provider: config.ai.provider, bin: config.ai.bin, model: config.ai.model, timeoutMs: config.ai.timeoutMs },
  }));
} catch (err) { console.error(err.message); process.exitCode = 1; }
`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...process.env, ...NEUTRAL_AI_ENV, [`${source.toUpperCase()}_CONFIG_FILE`]: file, ...env },
  });
  const { ai, ...summary } = JSON.parse(stdout);
  return aiOnly ? ai : summary;
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
  aiTimeoutMs: 120000,
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
    [{ aiTimeoutMs: 'x' }, 'aiTimeoutMs'],
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

test('股票設定檔為空時使用預設值：每天 08:00、台灣時間、台股與美股各 3 則、開放網路搜尋', async (t) => {
  assert.deepEqual(await readConfig(t, 'stock', {}), {
    targets: [], state: path.join(ROOT, 'data/stock/state.json'), posts: path.join(ROOT, 'data/stock/discord-messages.jsonl'),
    days: [0, 1, 2, 3, 4, 5, 6], start: 480, end: 480, interval: 1440, timeZone: 'Asia/Taipei', timeout: 600000,
    news: { twStocks: ['2330', '2317', '2454'], usStocks: ['NVDA', 'AAPL', 'MSFT'], twCount: 3, usCount: 3 }, webSearch: true,
  });
});

test('股票設定檔的 Webhook、排程、股票清單、篇數與逾時設定；清單可寫數字、逗號分隔文字或留空', async (t) => {
  const config = await readConfig(t, 'stock', `
export default {
  webhooks: [{ name: '股票', url: '${hook('888')}', webhookProfile: { personaPrompt: '分析師' } }],
  schedule: { days: '1-5', time: '07:30', timeZone: 'UTC' },
  news: { twStocks: [2330, '0050', '6488.TWO'], usStocks: 'aapl, brk-b', twCount: 5, usCount: 0 },
  aiTimeoutMs: 120000,
  files: { state: 'data/stock/custom-state.json', discordMessages: 'data/stock/custom-posts.jsonl' },
};`);
  assert.deepEqual(config, {
    targets: [{ name: '股票', webhookId: '888', webhookProfile: { ...emptyProfile('stock', '888'), personaPrompt: '分析師' } }],
    state: path.join(ROOT, 'data/stock/custom-state.json'), posts: path.join(ROOT, 'data/stock/custom-posts.jsonl'),
    days: [1, 2, 3, 4, 5], start: 450, end: 450, interval: 1440, timeZone: 'UTC', timeout: 120000,
    news: { twStocks: ['2330', '0050', '6488'], usStocks: ['AAPL', 'BRK.B'], twCount: 5, usCount: 0 }, webSearch: true,
  });
  assert.deepEqual((await readConfig(t, 'stock', { news: { twStocks: [], usStocks: '' } })).news,
    { twStocks: [], usStocks: [], twCount: 3, usCount: 3 });
});

test('股票設定錯誤明確指出設定檔與欄位名稱', async (t) => {
  const cases = [
    [{ news: { twCount: 0, usCount: 0 } }, 'twCount 與 usCount 不能都是 0'],
    [{ news: { twCount: 11 } }, 'news.twCount 必須是 0～10'],
    [{ news: { usCount: -1 } }, 'news.usCount 必須是 0～10'],
    [{ news: { twStocks: ['TSMC'] } }, 'news.twStocks 格式錯誤'],
    [{ news: { twStocks: [50] } }, '0 開頭的代號（例如 0050）請加引號'],
    [{ news: { usStocks: ['蘋果'] } }, 'news.usStocks 格式錯誤'],
    [{ news: { stocks: ['2330'] } }, 'news 有不支援的欄位：stocks'],
    [{ codexTimeoutMs: 1000 }, '不支援的欄位：codexTimeoutMs'],
    [{ schedule: { time: '8點' } }, 'schedule.time'],
  ];
  for (const [content, name] of cases) {
    await assert.rejects(readConfig(t, 'stock', content), (err) => {
      assert.ok(err.stderr.includes('stock.js'), err.stderr);
      assert.ok(err.stderr.includes(name), `${name}：${err.stderr}`);
      return true;
    });
  }
});

test('技術指標設定檔為空時使用預設值：每天 09:10～22:40 每 60 分鐘、台灣時間、三個市場各 2 個代號的日線、不使用網路搜尋', async (t) => {
  const daily = (symbols) => ({ auto: false, symbols, interval: '1d' });
  assert.deepEqual(await readConfig(t, 'signal', {}), {
    targets: [], state: path.join(ROOT, 'data/signal/state.json'), posts: path.join(ROOT, 'data/signal/discord-messages.jsonl'),
    days: [0, 1, 2, 3, 4, 5, 6], start: 550, end: 1360, interval: 60, timeZone: 'Asia/Taipei', timeout: 600000,
    markets: { crypto: daily(['BTC', 'ETH']), tw: daily(['2330', '2345']), us: daily(['NVDA', 'AAPL']) }, webSearch: false,
  });
});

test('技術指標設定檔的 Webhook、排程（開始、結束時間與執行頻率）、市場與逾時設定；代號可寫 AUTO、逗號分隔文字或留空（不分析）', async (t) => {
  const config = await readConfig(t, 'signal', `
export default {
  webhooks: [{ name: '交易', url: '${hook('999')}' }],
  schedule: { days: '1-5', start: '09:00', end: '21:00', intervalMinutes: 60, timeZone: 'UTC' },
  markets: {
    crypto: { symbols: 'btc, ETHUSDT' },
    tw: { symbols: 'auto' },
    us: { symbols: [] },
  },
  aiTimeoutMs: 120000,
  files: { state: 'data/signal/custom-state.json', discordMessages: 'data/signal/custom-posts.jsonl' },
};`);
  assert.deepEqual(config, {
    targets: [{ name: '交易', webhookId: '999', webhookProfile: emptyProfile('signal', '999') }],
    state: path.join(ROOT, 'data/signal/custom-state.json'), posts: path.join(ROOT, 'data/signal/custom-posts.jsonl'),
    days: [1, 2, 3, 4, 5], start: 540, end: 1260, interval: 60, timeZone: 'UTC', timeout: 120000,
    markets: {
      crypto: { auto: false, symbols: ['BTC', 'ETH'], interval: '1d' },
      tw: { auto: true, symbols: [], interval: '1d' },
      us: { auto: false, symbols: [], interval: '1d' },
    },
    webSearch: false,
  });
});

test('技術指標設定錯誤明確指出設定檔與欄位名稱', async (t) => {
  const none = { symbols: [] };
  const cases = [
    [{ markets: { crypto: none, tw: none, us: none } }, 'markets 至少要有一個市場的 symbols 填寫代號或 AUTO'],
    [{ markets: { crypto: { symbols: ['BTC', 'AUTO'] } } }, 'markets.crypto.symbols 填 AUTO 時不能再加其他代號'],
    [{ markets: { tw: { symbols: [50] } } }, '0 開頭的代號（例如 0050）請加引號'],
    [{ markets: { us: { symbols: ['蘋果'] } } }, 'markets.us.symbols 格式錯誤'],
    [{ markets: { us: { symbols: ['NVDA'], interval: '4h' } } }, 'markets.us 有不支援的欄位：interval'],
    [{ markets: { crypto: 'AUTO' } }, 'markets.crypto 必須是物件'],
    [{ markets: { gold: none } }, 'markets 有不支援的欄位：gold'],
    [{ markets: { crypto: { symbol: ['BTC'] } } }, 'markets.crypto 有不支援的欄位：symbol'],
    [{ schedule: { time: '08:05' } }, 'schedule 有不支援的欄位：time'],
    [{ schedule: { start: '8點' } }, 'schedule.start'],
    [{ schedule: { start: '21:00', end: '09:00' } }, '目前不支援跨越午夜的時段'],
    [{ schedule: { intervalMinutes: 0 } }, 'schedule.intervalMinutes 必須是 1 以上的整數'],
  ];
  for (const [content, name] of cases) {
    await assert.rejects(readConfig(t, 'signal', content), (err) => {
      assert.ok(err.stderr.includes('signal.js'), err.stderr);
      assert.ok(err.stderr.includes(name), `${name}：${err.stderr}`);
      return true;
    });
  }
});

// ---- AI 設定（env/.env.shared 的 AI_PROVIDER 等共用設定）----

test('預設使用 Codex；AI_PROVIDER=claude 時改用 CLAUDE_BIN、CLAUDE_MODEL，AI_TIMEOUT_MS 優先於舊的 CODEX_TIMEOUT_MS', async (t) => {
  assert.deepEqual(await readConfig(t, 'artale', {}, { aiOnly: true }), { provider: 'codex', bin: 'codex', model: '', timeoutMs: 300000 });
  const both = { CODEX_BIN: 'my-codex', CODEX_MODEL: 'gpt-test', CLAUDE_BIN: '/opt/claude', CLAUDE_MODEL: 'sonnet', CODEX_TIMEOUT_MS: '2000' };
  assert.deepEqual(await readConfig(t, 'artale', {}, { aiOnly: true, env: both }),
    { provider: 'codex', bin: 'my-codex', model: 'gpt-test', timeoutMs: 2000 });
  assert.deepEqual(await readConfig(t, 'artale', {}, { aiOnly: true, env: { ...both, AI_PROVIDER: ' Claude ', AI_TIMEOUT_MS: '1000' } }),
    { provider: 'claude', bin: '/opt/claude', model: 'sonnet', timeoutMs: 1000 });
  assert.deepEqual(await readConfig(t, 'crypto', {}, { aiOnly: true, env: { AI_PROVIDER: 'claude' } }),
    { provider: 'claude', bin: 'claude', model: '', timeoutMs: 600000 });
});

test('AI_PROVIDER 名稱錯誤時明確失敗', async (t) => {
  for (const source of ['artale', 'crypto']) {
    await assert.rejects(readConfig(t, source, {}, { env: { AI_PROVIDER: 'gemini' } }), (err) => {
      assert.ok(err.stderr.includes('AI_PROVIDER 只能是 codex 或 claude，目前為「gemini」'), err.stderr);
      return true;
    });
  }
});

test('Crypto 逾時時間使用 aiTimeoutMs，舊欄位 codexTimeoutMs 仍可使用', async (t) => {
  assert.equal((await readConfig(t, 'crypto', { codexTimeoutMs: 1000 })).timeout, 1000);
  assert.equal((await readConfig(t, 'crypto', { aiTimeoutMs: 2000, codexTimeoutMs: 1000 })).timeout, 2000);
});
