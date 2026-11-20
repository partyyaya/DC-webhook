import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getWebhookProfile } from '../src/shared/discord.js';
import { checkWebhookProfile } from '../src/shared/webhook-profile.js';

const HOOK = 'https://discord.com/api/webhooks/111111111111111111/secretToken?thread_id=555&wait=true';
const MESSAGES = { avatarMessage: '我換新頭像了！', nameMessage: '我從「{oldName}」改名為「{name}」了！' };

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * 假的 Discord：GET 回傳目前的 profile（可在測試中修改），CDN 回傳頭像圖片，POST 記錄發送內容。
 * 假的 Codex：回覆 reply.json 的內容（FAIL 時以結束碼 1 失敗），並把參數、提示詞與附圖是否存在記錄到 codex-log.json。
 */
async function setup(t, { failPost = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const profile = { name: 'Bot', avatar: 'avatar-1' };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ method: options.method, url, payload: options.body ? JSON.parse(options.body) : undefined });
    if (url.hostname === 'cdn.discordapp.com') return new Response(PNG);
    if (options.method === 'GET') {
      return new Response(JSON.stringify({ id: '111111111111111111', token: 'secretToken', type: 1, ...profile }));
    }
    if (failPost) return new Response('{"code":50035}', { status: 400 });
    return new Response(JSON.stringify({ id: '900', channel_id: '333' }));
  });
  const replyFile = path.join(dir, 'reply.json');
  const codexLog = path.join(dir, 'codex-log.json');
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const images = args.flatMap((arg, i) => (arg === '--image' ? [args[i + 1]] : []));
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  fs.writeFileSync(${JSON.stringify(codexLog)}, JSON.stringify({ args, input, images: images.map((file) => fs.readFileSync(file).toString('hex')) }));
  const reply = fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8');
  if (reply === 'FAIL') { process.stderr.write('codex down'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], reply);
});
`, { mode: 0o755 });
  await writeFile(replyFile, JSON.stringify({ avatar: '新頭像好可愛喵', name: '新名字還不錯喵' }));
  const options = {
    ...MESSAGES, historyFile: path.join(dir, 'posts.jsonl'), profileFile: path.join(dir, 'artale', 'webhook-profile.json'),
    ai: { provider: 'codex', bin, timeoutMs: 10_000, webSearch: true },
  };
  const posts = () => calls.filter((call) => call.method === 'POST');
  const sent = async () => (await readFile(options.historyFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return {
    profile, calls, posts, options, dir, sent, check: (overrides = {}) => checkWebhookProfile(HOOK, { ...options, ...overrides }),
    setReply: (text) => writeFile(replyFile, text),
    codexCall: async () => JSON.parse(await readFile(codexLog, 'utf8')),
    codexCalled: () => readFile(codexLog).then(() => true, () => false),
  };
}

test('查詢 Webhook 不帶 wait、thread_id 參數，只回傳 ID、名稱與頭像，不回傳 token', async (t) => {
  const { calls } = await setup(t);
  assert.deepEqual(await getWebhookProfile(HOOK), { id: '111111111111111111', name: 'Bot', avatar: 'avatar-1' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/api/webhooks/111111111111111111/secretToken');
  assert.equal(calls[0].url.search, '');
});

test('兩句提醒都未設定（預設）時不查詢也不發送', async (t) => {
  const { check, calls } = await setup(t);
  assert.deepEqual(await check({ avatarMessage: '', nameMessage: '' }), { status: 'disabled' });
  assert.equal(calls.length, 0);
});

test('第一次檢查只記錄目前狀態，不發送；記錄檔不包含 token', async (t) => {
  const { check, posts, options } = await setup(t);
  assert.equal((await check()).status, 'recorded');
  assert.equal(posts().length, 0);
  const saved = await readFile(options.profileFile, 'utf8');
  assert.deepEqual({ ...JSON.parse(saved), checkedAt: undefined },
    { webhookId: '111111111111111111', name: 'Bot', avatar: 'avatar-1', checkedAt: undefined });
  assert.ok(!saved.includes('secretToken'));
  assert.equal((await check()).status, 'unchanged');
  assert.equal(posts().length, 0);
});

test('只換頭像或只換名稱時，只發送對應的一行；同一次變更只提醒一次', async (t) => {
  const { check, profile, posts, sent } = await setup(t);
  await check();
  profile.avatar = 'avatar-2';
  assert.equal((await check()).content, '我換新頭像了！');
  profile.name = 'New Bot';
  assert.equal((await check()).content, '我從「Bot」改名為「New Bot」了！');
  assert.equal((await check()).status, 'unchanged');
  assert.equal(posts().length, 2);
  // 提醒發送到原本的討論串
  assert.equal(posts()[0].url.searchParams.get('thread_id'), '555');
  assert.deepEqual((await sent()).map((event) => event.title), ['Webhook 名稱／頭像變更提醒', 'Webhook 名稱／頭像變更提醒']);
});

test('同時換頭像與名稱時發送兩行：第一行頭像、第二行名稱', async (t) => {
  const { check, profile, calls } = await setup(t);
  await check();
  Object.assign(profile, { name: '新名字', avatar: null });
  const result = await check();
  assert.deepEqual({ avatarChanged: result.avatarChanged, nameChanged: result.nameChanged }, { avatarChanged: true, nameChanged: true });
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).payload.content, '我換新頭像了！\n我從「Bot」改名為「新名字」了！');
  assert.deepEqual(calls.at(-1).payload.allowed_mentions, { parse: [] });
});

test('只設定其中一句時，另一項變更不發送但仍更新記錄', async (t) => {
  const { check, profile, posts } = await setup(t);
  await check({ nameMessage: '' });
  Object.assign(profile, { name: '新名字', avatar: 'avatar-2' });
  assert.equal((await check({ nameMessage: '' })).content, '我換新頭像了！');
  profile.name = '再改名';
  assert.equal((await check({ nameMessage: '' })).content, '');
  assert.equal(posts().length, 1);
  assert.equal((await check({ nameMessage: '' })).status, 'unchanged');
});

test('提醒發送失敗時不更新記錄，下次檢查會再發送；錯誤不會往外拋', async (t) => {
  const { check, profile, posts, options } = await setup(t, { failPost: true });
  await check();
  profile.avatar = 'avatar-2';
  assert.equal((await check()).status, 'failed');
  assert.equal((await check()).status, 'failed');
  assert.equal(posts().length, 2);
  const saved = JSON.parse(await readFile(options.profileFile, 'utf8'));
  assert.equal(saved.avatar, 'avatar-1');
});

test('不同主題分開記錄：使用同一個 Webhook 時，各主題各自發送自己的提醒與紀錄', async (t) => {
  const { check, profile, posts, dir } = await setup(t);
  const artale = { historyFile: path.join(dir, 'artale', 'posts.jsonl'), profileFile: path.join(dir, 'artale', 'webhook-profile.json'),
    avatarMessage: 'Artale 換頭像' };
  const crypto = { historyFile: path.join(dir, 'crypto', 'posts.jsonl'), profileFile: path.join(dir, 'crypto', 'webhook-profile.json'),
    avatarMessage: 'Crypto 換頭像' };
  await check(artale);
  await check(crypto);
  profile.avatar = 'avatar-2';
  assert.equal((await check(crypto)).content, 'Crypto 換頭像');
  assert.equal((await check(artale)).content, 'Artale 換頭像');
  assert.deepEqual(posts().map((call) => call.payload.content), ['Crypto 換頭像', 'Artale 換頭像']);
  for (const topic of [artale, crypto]) {
    assert.equal((await readFile(topic.historyFile, 'utf8')).trim().split('\n').length, 1);
    assert.equal(JSON.parse(await readFile(topic.profileFile, 'utf8')).avatar, 'avatar-2');
  }
});

test('主題改用另一個 Webhook 時只重新記錄，不發送', async (t) => {
  const { check, posts, options } = await setup(t);
  await check();
  const saved = JSON.parse(await readFile(options.profileFile, 'utf8'));
  await writeFile(options.profileFile, JSON.stringify({ ...saved, webhookId: '999', name: '舊 Webhook', avatar: 'old' }));
  assert.equal((await check()).status, 'recorded');
  assert.equal(posts().length, 0);
  assert.equal(JSON.parse(await readFile(options.profileFile, 'utf8')).webhookId, '111111111111111111');
});

const PERSONA = { personaPrompt: '你是一隻傲嬌的貓，句尾會加「喵」', avatarMessage: '固定頭像文字', nameMessage: '固定名稱文字' };

test('只有角色設定提示詞也會啟用；頭像與名稱同時被更換時由 AI 寫感想取代固定文字，第一行頭像、第二行名稱', async (t) => {
  const { check, profile, posts, calls, codexCall } = await setup(t);
  assert.equal((await check({ ...PERSONA, avatarMessage: '', nameMessage: '' })).status, 'recorded');
  Object.assign(profile, { name: '新名字', avatar: 'a_0f1e' });
  const result = await check(PERSONA);
  assert.equal(result.content, '新頭像好可愛喵\n新名字還不錯喵');
  assert.equal(posts().at(-1).payload.content, '新頭像好可愛喵\n新名字還不錯喵');

  // 下載新頭像並以 --image 附給 Codex；不開放網路搜尋
  const cdn = calls.find((call) => call.url.hostname === 'cdn.discordapp.com');
  assert.equal(cdn.url.pathname, '/avatars/111111111111111111/a_0f1e.png');
  const { args, input, images } = await codexCall();
  assert.deepEqual(images, [PNG.toString('hex')]);
  assert.ok(!args.includes('-c'), 'AI 感想不需要網路搜尋');
  assert.ok(args.includes('--output-schema'));
  assert.match(input, /你是一隻傲嬌的貓/);
  assert.match(input, /新頭像就是附上的圖片/);
  assert.match(input, /從「Bot」改為「新名字」/);
});

test('只換名稱時不下載頭像也不附圖，只發送名稱感想', async (t) => {
  const { check, profile, calls, setReply, codexCall } = await setup(t);
  await check(PERSONA);
  profile.name = '新名字';
  await setReply(JSON.stringify({ avatar: '', name: '新名字還不錯喵' }));
  assert.equal((await check(PERSONA)).content, '新名字還不錯喵');
  assert.equal(calls.filter((call) => call.url.hostname === 'cdn.discordapp.com').length, 0);
  const { images, input } = await codexCall();
  assert.deepEqual(images, []);
  assert.match(input, /頭像：沒有被更換/);
});

test('自訂頭像被移除時不附圖，提示詞說明改回預設頭像', async (t) => {
  const { check, profile, calls, setReply, codexCall } = await setup(t);
  await check(PERSONA);
  profile.avatar = null;
  await setReply(JSON.stringify({ avatar: '頭像不見了喵', name: '' }));
  assert.equal((await check(PERSONA)).content, '頭像不見了喵');
  assert.equal(calls.filter((call) => call.url.hostname === 'cdn.discordapp.com').length, 0);
  assert.match((await codexCall()).input, /改回 Discord 的預設頭像/);
});

test('AI 失敗或沒有寫出被更換項目的感想時，不發送也不更新記錄，下次再試', async (t) => {
  const { check, profile, posts, setReply, options } = await setup(t);
  await check(PERSONA);
  profile.avatar = 'abc123';
  await setReply('FAIL');
  assert.equal((await check(PERSONA)).status, 'failed');
  await setReply(JSON.stringify({ avatar: '  ', name: '' }));
  assert.equal((await check(PERSONA)).status, 'failed');
  assert.equal(posts().length, 0);
  assert.equal(JSON.parse(await readFile(options.profileFile, 'utf8')).avatar, 'avatar-1');

  await setReply(JSON.stringify({ avatar: '終於好了喵', name: '' }));
  assert.equal((await check(PERSONA)).content, '終於好了喵');
  assert.equal(posts().length, 1);
});

test('沒有角色設定提示詞時不呼叫 AI，直接發送固定文字', async (t) => {
  const { check, profile, codexCalled } = await setup(t);
  await check();
  Object.assign(profile, { name: '新名字', avatar: 'abc123' });
  assert.equal((await check({ personaPrompt: '' })).content, '我換新頭像了！\n我從「Bot」改名為「新名字」了！');
  assert.equal(await codexCalled(), false);
});
