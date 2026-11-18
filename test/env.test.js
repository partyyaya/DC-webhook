import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../src/shared/env.js';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function setupEnvFiles(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-env-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'env'));
  const files = {
    shared: 'CODEX_BIN=shared-codex\nCODEX_MODEL=shared-model\nARTALE_DISCORD_WEBHOOK_URL=wrong-shared-hook\n',
    artale: 'ARTALE_DISCORD_WEBHOOK_URL=artale-hook\nARTALE_SCHEDULE_DAYS=2\nSTOCKS_DISCORD_WEBHOOK_URL=wrong-artale-file\nCODEX_MODEL=wrong-source-model\n',
    stocks: 'STOCKS_DISCORD_WEBHOOK_URL=stocks-hook\n',
    crypto: 'CRYPTO_DISCORD_WEBHOOK_URL=crypto-hook\n',
  };
  for (const [source, content] of Object.entries(files)) await writeFile(path.join(rootDir, 'env', `.env.${source}`), content);
  await writeFile(path.join(rootDir, '.env'), 'CODEX_BIN=wrong-legacy-codex\nCRYPTO_DISCORD_WEBHOOK_URL=wrong-legacy-hook\n');
  return rootDir;
}

test('只載入共用與指定來源的環境檔，各來源設定互不混用', async (t) => {
  const rootDir = await setupEnvFiles(t);
  for (const source of ['artale', 'stocks', 'crypto']) {
    const env = loadProjectEnv(source, { rootDir, env: {} });
    assert.equal(env.CODEX_BIN, 'shared-codex');
    assert.equal(env.CODEX_MODEL, 'shared-model');
    assert.equal(env[`${source.toUpperCase()}_DISCORD_WEBHOOK_URL`], `${source}-hook`);
    for (const other of ['artale', 'stocks', 'crypto'].filter(name => name !== source)) {
      assert.equal(env[`${other.toUpperCase()}_DISCORD_WEBHOOK_URL`], undefined);
    }
  }
  assert.deepEqual(loadProjectEnv(undefined, { rootDir, env: {} }), { CODEX_BIN: 'shared-codex', CODEX_MODEL: 'shared-model' });
});

test('系統環境變數含空值時仍優先；缺少環境檔不讀根目錄舊檔', async (t) => {
  const rootDir = await setupEnvFiles(t);
  const env = { CODEX_BIN: 'system-codex', ARTALE_DISCORD_WEBHOOK_URL: '' };
  assert.equal(loadProjectEnv('artale', { rootDir, env }), env);
  assert.equal(env.CODEX_BIN, 'system-codex');
  assert.equal(env.ARTALE_DISCORD_WEBHOOK_URL, '');
  await rm(path.join(rootDir, 'env'), { recursive: true });
  assert.deepEqual(loadProjectEnv('crypto', { rootDir, env: {} }), {});
});

test('無效來源及無法讀取的正式環境檔會明確失敗', async (t) => {
  const rootDir = await setupEnvFiles(t);
  assert.throws(() => loadProjectEnv('../outside', { rootDir, env: {} }), /不支援的環境設定來源/);
  await rm(path.join(rootDir, 'env/.env.artale'));
  await mkdir(path.join(rootDir, 'env/.env.artale'));
  assert.throws(() => loadProjectEnv('artale', { rootDir, env: {} }), /無法讀取環境設定 env\/\.env\.artale/);
});

async function readArtaleConfig(overrides = {}) {
  const script = `
try {
  const { config } = await import(${JSON.stringify(new URL('../src/artale/config.js', import.meta.url).href)});
  console.log(JSON.stringify({ webhook: config.discordWebhookUrl, state: config.stateFile, posts: config.discordMessagesFile,
    days: [...config.schedule.days], start: config.schedule.start, end: config.schedule.end,
    interval: config.schedule.intervalMinutes, timeZone: config.schedule.timeZone }));
} catch (err) { console.error(err.message); process.exitCode = 1; }
`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ARTALE_DISCORD_WEBHOOK_URL: '', ARTALE_STATE_FILE: '', ARTALE_DISCORD_MESSAGES_FILE: '',
      ARTALE_NEWS_CATEGORIES: 'maintenance,update,bm', ARTALE_SCHEDULE_DAYS: '', ARTALE_SCHEDULE_START: '',
      ARTALE_SCHEDULE_END: '', ARTALE_SCHEDULE_TIMEZONE: '', ARTALE_CHECK_INTERVAL_MINUTES: '',
      CODEX_TIMEOUT_MS: '300000', ...overrides },
  });
  return JSON.parse(stdout);
}

test('從其他目錄啟動仍使用專案根目錄下的 Artale 紀錄路徑', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const script = `
import { ROOT_DIR } from ${JSON.stringify(new URL('../src/shared/env.js', import.meta.url).href)};
import { config } from ${JSON.stringify(new URL('../src/artale/config.js', import.meta.url).href)};
console.log(JSON.stringify({ root: ROOT_DIR, state: config.stateFile, posts: config.discordMessagesFile }));
`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: os.tmpdir(),
    env: { ...process.env, ARTALE_STATE_FILE: 'data/artale/state.json', ARTALE_DISCORD_MESSAGES_FILE: 'data/artale/discord-messages.jsonl',
      ARTALE_NEWS_CATEGORIES: 'maintenance,update,bm', ARTALE_SCHEDULE_DAYS: '2', ARTALE_SCHEDULE_START: '08:20',
      ARTALE_SCHEDULE_END: '17:20', ARTALE_SCHEDULE_TIMEZONE: 'Asia/Taipei', ARTALE_CHECK_INTERVAL_MINUTES: '60', CODEX_TIMEOUT_MS: '300000' },
  });
  assert.deepEqual(JSON.parse(stdout), {
    root: path.resolve(root), state: path.join(root, 'data/artale/state.json'), posts: path.join(root, 'data/artale/discord-messages.jsonl'),
  });
});

test('Artale 使用專屬 Webhook、排程與紀錄設定，不受其他來源或舊設定影響', async () => {
  const config = await readArtaleConfig({
    ARTALE_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/111/artaleToken',
    ARTALE_SCHEDULE_DAYS: '2,4', ARTALE_SCHEDULE_START: '10:00', ARTALE_SCHEDULE_END: '18:00',
    ARTALE_CHECK_INTERVAL_MINUTES: '30', ARTALE_SCHEDULE_TIMEZONE: 'UTC',
    ARTALE_STATE_FILE: 'data/artale/custom-state.json', ARTALE_DISCORD_MESSAGES_FILE: 'data/artale/custom-posts.jsonl',
    DISCORD_WEBHOOK_URL: 'wrong', SCHEDULE_DAYS: 'invalid', SCHEDULE_START: 'invalid',
    SCHEDULE_END: 'invalid', CHECK_INTERVAL_MINUTES: 'invalid', SCHEDULE_TIMEZONE: 'invalid',
    STOCKS_DISCORD_WEBHOOK_URL: 'wrong', CRYPTO_DISCORD_WEBHOOK_URL: 'wrong',
    STOCKS_SCHEDULE_DAYS: 'invalid', CRYPTO_SCHEDULE_START: 'invalid',
  });
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(config, { webhook: 'https://discord.com/api/webhooks/111/artaleToken',
    state: path.join(root, 'data/artale/custom-state.json'), posts: path.join(root, 'data/artale/custom-posts.jsonl'),
    days: [2, 4], start: 600, end: 1080, interval: 30, timeZone: 'UTC' });
});

test('Artale 專屬設定留空時使用預設，不回退到舊的全域 Webhook 與排程', async () => {
  const config = await readArtaleConfig({ DISCORD_WEBHOOK_URL: 'wrong', SCHEDULE_DAYS: 'invalid',
    SCHEDULE_START: 'invalid', SCHEDULE_END: 'invalid', CHECK_INTERVAL_MINUTES: 'invalid', SCHEDULE_TIMEZONE: 'invalid',
    STATE_FILE: 'wrong.json', DISCORD_MESSAGES_FILE: 'wrong.jsonl' });
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(config, { webhook: '', state: path.join(root, 'data/artale/state.json'), posts: path.join(root, 'data/artale/discord-messages.jsonl'),
    days: [2], start: 500, end: 1040, interval: 60, timeZone: 'Asia/Taipei' });
});

test('Artale 排程錯誤明確指出專屬設定名稱', async () => {
  for (const name of ['ARTALE_SCHEDULE_DAYS', 'ARTALE_SCHEDULE_START', 'ARTALE_SCHEDULE_END',
    'ARTALE_CHECK_INTERVAL_MINUTES', 'ARTALE_SCHEDULE_TIMEZONE']) {
    await assert.rejects(readArtaleConfig({ [name]: 'invalid' }), err => err.stderr.includes(name));
  }
});
