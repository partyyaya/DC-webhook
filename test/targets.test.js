import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeTarget, parseWebhookTargets } from '../src/shared/targets.js';
import { integer, listText, loadTopicConfig, section, text } from '../src/shared/topic-config.js';

const hook = (id) => `https://discord.com/api/webhooks/${id}/token${id}`;

/** 建立暫存專案目錄；files 為相對路徑 → 內容。 */
async function setup(t, files = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-config-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(rootDir, file)), { recursive: true });
    await writeFile(path.join(rootDir, file), content);
  };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  return { rootDir, write, load: (source = 'crypto', env = {}) => loadTopicConfig(source, { rootDir, env }) };
}

test('主題設定檔可寫註解，以 export default 匯出設定物件；檔案不存在時為空設定', async (t) => {
  const { load, rootDir } = await setup(t, {
    'env/crypto.js': `// 註解
export default {
  /* 區塊註解 */
  news: { coinCount: 6 }, // 行尾註解
};`,
  });
  assert.deepEqual(await load(), { file: path.join(rootDir, 'env/crypto.js'), label: 'env/crypto.js', values: { news: { coinCount: 6 } } });
  assert.deepEqual(await load('artale'), { file: null, label: 'env/artale.js', values: {} });
});

test('可用 <主題>_CONFIG_FILE 改用其他設定檔；同一程序中檔案修改後會重新載入', async (t) => {
  const { load, write } = await setup(t);
  await write('config/crypto.js', 'export default { codexTimeoutMs: 1 };');
  assert.deepEqual((await load('crypto', { CRYPTO_CONFIG_FILE: 'config/crypto.js' })).values, { codexTimeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await write('config/crypto.js', 'export default { codexTimeoutMs: 2 };');
  assert.deepEqual((await load('crypto', { CRYPTO_CONFIG_FILE: 'config/crypto.js' })).values, { codexTimeoutMs: 2 });
});

test('舊版 env/.env.<主題> 仍存在時提醒搬移；設定檔格式錯誤時明確失敗', async (t) => {
  const { load, write } = await setup(t, { 'env/.env.artale': 'ARTALE_DISCORD_WEBHOOK_URL=x\n' });
  await assert.rejects(load('artale'), /env\/\.env\.artale 已停用：請把設定搬到 env\/artale\.js/);
  await write('env/crypto.js', 'export default [];');
  await assert.rejects(load(), /必須以 export default 匯出設定物件/);
  await write('env/crypto.js', 'export default {');
  await assert.rejects(load(), /無法載入 env\/crypto\.js/);
});

test('欄位檢查：不支援的欄位、型別錯誤會指出位置；未填寫時使用預設值', () => {
  assert.deepEqual(section(undefined, ['a'], 'x'), {});
  assert.throws(() => section({ a: 1, typo: 2 }, ['a'], 'env/crypto.js 的 news'), /env\/crypto\.js 的 news 有不支援的欄位：typo；可用欄位為 a/);
  assert.throws(() => section([], ['a'], 'x'), /x 必須是物件/);
  assert.equal(text(undefined, '08:00', 'x'), '08:00');
  assert.throws(() => text(8, '', 'schedule.time'), /schedule.time 必須是文字/);
  assert.equal(integer(undefined, 3, 'x'), 3);
  assert.throws(() => integer(11, 3, 'news.coinCount', { max: 10 }), /news.coinCount 必須是 1～10 的整數，目前為「11」/);
  assert.throws(() => integer('3', 3, 'intervalMinutes'), /intervalMinutes 必須是 1 以上的整數/);
  assert.equal(listText(['BTC', 'ETH'], '', 'x'), 'BTC,ETH');
  assert.equal(listText(2, '', 'x'), '2');
  assert.equal(listText('1-5', '', 'x'), '1-5');
  assert.throws(() => listText({}, '', 'news.priorityCoins'), /news.priorityCoins 必須是陣列或逗號分隔的文字/);
});

test('Webhook 清單：name 只是備註，以 Webhook ID 區分；每個 Webhook 各自的變更提醒設定，未填寫時為空', () => {
  const targets = parseWebhookTargets([
    { name: ' 自己 ', url: hook('111') },
    { url: `${hook('222')}?thread_id=333`, webhookProfile: { personaPrompt: '貓', nameMessage: '改名了' } },
  ], 'webhooks');
  const empty = { personaPrompt: '', avatarMessage: '', nameMessage: '' };
  assert.deepEqual(targets, [
    { name: '自己', url: hook('111'), webhookId: '111', webhookProfile: empty },
    { name: '', url: `${hook('222')}?thread_id=333`, webhookId: '222', webhookProfile: { ...empty, personaPrompt: '貓', nameMessage: '改名了' } },
  ]);
  assert.equal(describeTarget(targets[0]), '自己（111）');
  assert.equal(describeTarget(targets[1]), 'Webhook 222');
  assert.deepEqual(parseWebhookTargets(undefined, 'webhooks'), []);
});

test('Webhook 清單格式錯誤時指出是第幾個，且錯誤訊息不包含 token', () => {
  const where = 'env/crypto.js 的 webhooks';
  const cases = [
    [{ url: hook('111') }, /webhooks 必須是陣列/],
    [[{ name: '朋友', url: 'https://example.com/hook/secretToken' }], /webhooks 第 1 個（朋友） 的網址無效/],
    [[{ name: '朋友' }], /第 1 個（朋友） 的網址無效/],
    [[{ url: hook('111') }, { url: hook('222'), personaPrompt: '貓' }], /第 2 個 有不支援的欄位：personaPrompt；可用欄位為 name、url、webhookProfile/],
    [[{ url: hook('111'), webhookProfile: { persona: '貓' } }], /第 1 個 的 webhookProfile 有不支援的欄位：persona/],
    [[{ url: hook('111'), webhookProfile: { personaPrompt: 1 } }], /webhookProfile\.personaPrompt 必須是文字/],
    [[{ url: hook('111'), name: 1 }], /name 必須是文字/],
    [[{ url: hook('111') }, { url: `${hook('111')}?thread_id=1` }], /重複的 Webhook（ID 111）/],
  ];
  for (const [list, pattern] of cases) {
    assert.throws(() => parseWebhookTargets(list, where), (err) => {
      assert.match(err.message, pattern);
      assert.ok(!err.message.includes('secretToken') && !err.message.includes('token111'));
      return true;
    });
  }
});
