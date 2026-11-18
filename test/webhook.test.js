import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { deleteDiscordMessage, editDiscordMessage, sendToDiscord } from '../src/shared/discord.js';
import { listPosts } from '../src/shared/posts.js';
import { runWebhookCommand } from '../src/webhook.js';

const HOOK = 'https://discord.com/api/webhooks/111111111111111111/testSecretToken';
const MESSAGE_ID = '222222222222222222';
const execute = promisify(execFile);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function setup(t, handler) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-posts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const historyFile = path.join(dir, 'data', 'messages.jsonl');
  const calls = [];
  const output = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = { url: new URL(url), ...options, payload: options.body ? JSON.parse(options.body) : undefined };
    calls.push(request);
    if (handler) return handler(request, calls.length);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return json({ id: MESSAGE_ID, channel_id: '333333333333333333', ...request.payload });
  });
  const options = {
    source: 'artale',
    env: { ARTALE_DISCORD_WEBHOOK_URL: HOOK, ARTALE_DISCORD_MESSAGES_FILE: historyFile },
    output: (text) => output.push(text),
  };
  return { dir, historyFile, calls, output, options, run: (args) => runWebhookCommand(args, options) };
}

async function seedHistory(file, count) {
  await mkdir(path.dirname(file), { recursive: true });
  const events = Array.from({ length: count }, (_, index) => ({
    action: 'create', webhookId: index % 2 ? '111111111111111111' : '444444444444444444',
    messageId: String(index + 1), title: `舊公告${index + 1}`, at: '2026-11-17T00:00:00.000Z',
  }));
  await writeFile(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

const readEvents = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('新增、修改、刪除使用正確 HTTP 路徑，並保存 ID 及最後狀態，不保存 token', async (t) => {
  const fixture = await setup(t);
  const { run, calls, historyFile } = fixture;
  const [created] = await run(['create', '--content', '測試公告']);
  assert.equal(created.messageId, MESSAGE_ID);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.searchParams.get('wait'), 'true');
  assert.deepEqual(calls[0].payload, { content: '測試公告', allowed_mentions: { parse: [] } });

  await run(['edit', '--message-id', MESSAGE_ID, '--content', '修正版']);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url.pathname, `/api/webhooks/111111111111111111/testSecretToken/messages/${MESSAGE_ID}`);
  assert.equal(calls[1].url.searchParams.has('wait'), false);
  assert.equal(calls[1].payload.content, '修正版');
  assert.ok(!Object.hasOwn(calls[1].payload, 'embeds'), '修改文字不應清空既有卡片');

  await run(['delete', '--message-id', MESSAGE_ID]);
  assert.equal(calls[2].method, 'DELETE');
  assert.equal(calls[2].url.pathname, calls[1].url.pathname);
  assert.equal(calls[2].body, undefined);
  const records = await run(['list']);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'deleted');
  assert.equal(records[0].title, '修正版');
  assert.ok(records[0].createdAt);
  const log = await readFile(historyFile, 'utf8');
  assert.equal(log.trim().split('\n').length, 3);
  assert.ok(!log.includes('testSecretToken'));
  assert.ok(!fixture.output.join('\n').includes('testSecretToken'));
});

test('JSON 支援多則新增與完整卡片修改，可明確清除舊卡片且停用提及', async (t) => {
  const { run, calls, dir } = await setup(t);
  const file = path.join(dir, 'payload.json');
  await writeFile(file, JSON.stringify([{ embeds: [{ title: '版本更新', description: '摘要' }] }, { content: '商城' }]));
  await run(['create', '--file', file]);
  assert.equal(calls.length, 2);
  await writeFile(file, JSON.stringify({ content: '新文字', embeds: [], allowed_mentions: { parse: ['everyone'] } }));
  await run(['edit', '--message-id', MESSAGE_ID, '--file', file]);
  assert.deepEqual(calls[2].payload, { content: '新文字', embeds: [], allowed_mentions: { parse: [] } });
});

test('create、edit、delete 的 dry-run 不連線也不建立發文紀錄', async (t) => {
  const { run, calls, historyFile, output } = await setup(t);
  await run(['create', '--content', '預覽', '--dry-run']);
  await run(['edit', '--message-id', MESSAGE_ID, '--content', '修改預覽', '--dry-run']);
  await run(['delete', '--message-id', MESSAGE_ID, '--dry-run']);
  assert.equal(calls.length, 0);
  await assert.rejects(access(historyFile), { code: 'ENOENT' });
  assert.ok(!output.join('\n').includes('testSecretToken'));
  assert.equal(JSON.parse(output[2]).action, 'delete');
});

test('參數或任一筆 JSON 不符時，不發出任何操作', async (t) => {
  const { run, calls, dir } = await setup(t);
  const file = path.join(dir, 'invalid.json');
  await writeFile(file, JSON.stringify([{ content: '合法' }, { content: '字'.repeat(2001) }]));
  await assert.rejects(run(['create', '--file', file]), /2000/);
  for (const args of [
    ['delete'], ['delete', '--message-id', '../'], ['create', '--content', 'x', '--file', file],
    ['edit', '--message-id', MESSAGE_ID], ['delete', '--message-id', MESSAGE_ID, '--content', 'x'],
    ['create', '--content', ''], ['create', '--message-id', MESSAGE_ID, '--content', 'x'],
  ]) await assert.rejects(run(args));
  await writeFile(file, JSON.stringify([{ content: '修改' }]));
  await assert.rejects(run(['edit', '--message-id', MESSAGE_ID, '--file', file]), /不能使用陣列/);
  await writeFile(file, '{}');
  await assert.rejects(run(['create', '--file', file]), /至少需要/);
  assert.equal(calls.length, 0);
});

test('多則新增中途失敗仍保留已成功訊息 ID，失敗訊息不記錄', async (t) => {
  const { run, dir, historyFile, output } = await setup(t, (_, count) => count === 1
    ? json({ id: MESSAGE_ID, channel_id: '333' }) : json({ code: 50035 }, 400));
  const file = path.join(dir, 'batch.json');
  await writeFile(file, JSON.stringify([{ content: '第一則' }, { content: '第二則' }]));
  await assert.rejects(run(['create', '--file', file]), /HTTP 400/);
  const records = await listPosts(historyFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, MESSAGE_ID);
  assert.equal(output.length, 1);
});

test('切換 Webhook 後只列出該 Webhook 的紀錄，討論串 ID 會傳入修改及刪除', async (t) => {
  const { run, historyFile, calls } = await setup(t);
  await run(['create', '--content', '第一群']);
  const secondHook = 'https://discord.com/api/v10/webhooks/444444444444444444/anotherToken/?wait=false';
  await run(['create', '--webhook', secondHook, '--content', '第二群']);
  assert.equal((await run(['list'])).length, 1);
  assert.equal((await run(['list', '--webhook', secondHook]))[0].webhookId, '444444444444444444');
  assert.equal((await listPosts(historyFile)).length, 2);
  for (const action of ['edit', 'delete']) {
    await run([action, '--message-id', MESSAGE_ID, '--thread-id', '555555555555555555',
      ...(action === 'edit' ? ['--content', '討論串修正'] : [])]);
    assert.equal(calls.at(-1).url.searchParams.get('thread_id'), '555555555555555555');
  }
});

test('紀錄寫入失敗會明確回報已成功與訊息 ID', async (t) => {
  const { run, options, dir, calls } = await setup(t);
  options.env.ARTALE_DISCORD_MESSAGES_FILE = dir; // 目錄可存在，但不能作為紀錄檔 append
  await assert.rejects(run(['create', '--content', '公告']), (err) => {
    assert.match(err.message, /已成功/);
    assert.ok(err.message.includes(MESSAGE_ID));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('Discord 拒絕刪除時不標示為已刪除，錯誤與網路失敗均不洩漏 Webhook token', async (t) => {
  const { run, historyFile } = await setup(t, ({ method }) => method === 'POST'
    ? json({ id: MESSAGE_ID }) : json({ code: 10008, message: HOOK }, 404));
  await run(['create', '--content', '公告']);
  await assert.rejects(run(['delete', '--message-id', MESSAGE_ID]), (err) => {
    assert.match(err.message, /HTTP 404/);
    assert.ok(!err.message.includes('testSecretToken'));
    return true;
  });
  assert.equal((await listPosts(historyFile))[0].status, 'active');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(HOOK); });
  await assert.rejects(editDiscordMessage(HOOK, MESSAGE_ID, { content: '修改' }), (err) => !err.message.includes('testSecretToken'));
});

test('API 操作遇到 429 依回應重試；刪除成功 204 不解析 JSON', async (t) => {
  const { calls } = await setup(t, (_, count) => count === 1 ? json({ retry_after: 0 }, 429) : new Response(null, { status: 204 }));
  assert.equal(await deleteDiscordMessage(HOOK, MESSAGE_ID), null);
  assert.equal(calls.length, 2);
});

test('Webhook 及訊息 ID 驗證會在請求前完成，避免刪掉 Webhook 本身', async (t) => {
  const { calls } = await setup(t);
  await assert.rejects(deleteDiscordMessage(HOOK, undefined), /訊息 ID/);
  await assert.rejects(deleteDiscordMessage(HOOK, '../'), /訊息 ID/);
  await assert.rejects(sendToDiscord('https://discord.com/api/webhooks/111/testSecretToken/messages/222', { content: 'x' }), /有效/);
  await assert.rejects(sendToDiscord('http://discord.com/api/webhooks/111/testSecretToken', { content: 'x' }), /有效/);
  await assert.rejects(sendToDiscord('https://example.com/api/webhooks/111/testSecretToken', { content: 'x' }), /有效/);
  assert.equal(calls.length, 0);
});

test('Node 入口可單獨使用，不依賴有效排程或 Codex 設定', async (t) => {
  const { historyFile } = await setup(t);
  const { stdout } = await execute(process.execPath, ['src/artale/webhook.js', 'create', '--content', '預覽', '--dry-run'], {
    env: { ...process.env, ARTALE_DISCORD_WEBHOOK_URL: HOOK, ARTALE_DISCORD_MESSAGES_FILE: historyFile,
      ARTALE_SCHEDULE_DAYS: 'invalid', ARTALE_NEWS_CATEGORIES: 'invalid', CODEX_BIN: '/missing-codex' },
  });
  assert.equal(JSON.parse(stdout).action, 'create');
  assert.ok(!stdout.includes('testSecretToken'));
});

test('共用指令依來源選擇獨立 Webhook 與紀錄，忽略舊的全域設定', async (t) => {
  const { options, dir, calls } = await setup(t);
  const env = { ...options.env, DISCORD_WEBHOOK_URL: 'invalid', DISCORD_MESSAGES_FILE: 'invalid',
    CRYPTO_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/555555555555555555/cryptoToken',
    CRYPTO_DISCORD_MESSAGES_FILE: path.join(dir, 'crypto.jsonl') };
  const run = args => runWebhookCommand(args, { ...options, source: undefined, env });
  for (const [source, id] of [['artale', '111111111111111111'], ['crypto', '555555555555555555']]) {
    await run(['create', '--source', source, '--content', '公告']);
    assert.match(calls.at(-1).url.pathname, new RegExp(`/webhooks/${id}/`));
    const records = await run(['list', '--source', source]);
    assert.equal(records.length, 1);
    assert.equal(records[0].webhookId, id);
  }
  await assert.rejects(run(['create', '--content', '沒有指定來源']), /--source/);
  env.CRYPTO_DISCORD_WEBHOOK_URL = '';
  await assert.rejects(run(['create', '--source', 'crypto', '--content', '缺少網址']), /CRYPTO_DISCORD_WEBHOOK_URL/);
  await assert.rejects(run(['create', '--source', 'unknown', '--content', '無效來源']), /--source/);
  await assert.rejects(run(['create', '--source', 'stocks', '--content', '已移除的來源']), /--source/);
  assert.equal(calls.length, 2);
});

test('Artale 發文指令不允許切換來源，仍支援明確指定其他 Webhook', async (t) => {
  const { run, calls } = await setup(t);
  await assert.rejects(run(['delete', '--source', 'crypto', '--message-id', MESSAGE_ID]), /固定使用 artale/);
  assert.equal(calls.length, 0);
  await run(['create', '--webhook', 'https://discord.com/api/webhooks/444444444444444444/anotherToken', '--content', '測試']);
  assert.match(calls[0].url.pathname, /webhooks\/444444444444444444\//);
});

test('所有 Webhook 合計最多保留 100 筆操作，新增、修改、刪除皆移除最舊紀錄', async (t) => {
  const { run, historyFile } = await setup(t);
  await seedHistory(historyFile, 99);
  await run(['create', '--content', '新公告']);
  let events = await readEvents(historyFile);
  assert.equal(events.length, 100);
  assert.equal(events[0].messageId, '1');
  assert.equal(events.at(-1).messageId, MESSAGE_ID);

  await run(['edit', '--message-id', MESSAGE_ID, '--content', '修正版']);
  events = await readEvents(historyFile);
  assert.equal(events.length, 100);
  assert.equal(events[0].messageId, '2');
  assert.equal(events.at(-1).action, 'edit');

  await run(['delete', '--message-id', MESSAGE_ID]);
  events = await readEvents(historyFile);
  assert.equal(events.length, 100);
  assert.equal(events[0].messageId, '3');
  assert.deepEqual(events.slice(-3).map(event => event.action), ['create', 'edit', 'delete']);
  assert.equal((await run(['list']))[0].status, 'deleted');
});

test('舊檔案超過 100 筆時，下次寫入保留最後 99 筆舊紀錄加上新操作', async (t) => {
  const { run, historyFile } = await setup(t);
  await seedHistory(historyFile, 110);
  const before = await readFile(historyFile, 'utf8');
  await run(['list']);
  await run(['create', '--content', '預覽', '--dry-run']);
  assert.equal(await readFile(historyFile, 'utf8'), before, '查詢及預覽不應清理紀錄');
  await run(['create', '--content', '新公告']);
  const events = await readEvents(historyFile);
  assert.equal(events.length, 100);
  assert.equal(events[0].messageId, '12');
  assert.equal(events.at(-1).messageId, MESSAGE_ID);
});

test('不同 Node 程序同時寫入，仍保留所有新操作且合計不超過 100 筆', async (t) => {
  const { historyFile } = await setup(t);
  await seedHistory(historyFile, 98);
  const source = `
import { managePost } from ${JSON.stringify(new URL('../src/shared/posts.js', import.meta.url).href)};
const [historyFile, messageId] = process.argv.slice(1);
globalThis.fetch = async () => new Response(JSON.stringify({ id: messageId }));
await managePost('create', ${JSON.stringify(HOOK)}, { payload: { content: '並行發文' }, historyFile });
`;
  const ids = ['900000000000000001', '900000000000000002', '900000000000000003', '900000000000000004'];
  await Promise.all(ids.map(id => execute(process.execPath, ['--input-type=module', '-e', source, historyFile, id])));
  const events = await readEvents(historyFile);
  assert.equal(events.length, 100);
  assert.equal(events[0].messageId, '3');
  for (const id of ids) assert.ok(events.some(event => event.messageId === id));
  await assert.rejects(access(`${historyFile}.lock`), { code: 'ENOENT' });
});

test('發文紀錄格式錯誤時不覆寫原檔，並釋放寫入鎖', async (t) => {
  const { run, historyFile } = await setup(t);
  await mkdir(path.dirname(historyFile), { recursive: true });
  await writeFile(historyFile, '{broken}\n');
  await assert.rejects(run(['create', '--content', '新公告']), /已成功.*紀錄寫入失敗/);
  assert.equal(await readFile(historyFile, 'utf8'), '{broken}\n');
  await assert.rejects(access(`${historyFile}.lock`), { code: 'ENOENT' });
});
