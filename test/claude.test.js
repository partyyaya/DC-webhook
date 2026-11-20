import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { summarizeWithAi } from '../src/shared/ai.js';
import { summarizeWithClaude } from '../src/shared/claude.js';

const OUTPUT_SCHEMA = {
  type: 'object', properties: { summary: { type: 'string' } },
  required: ['summary'], additionalProperties: false,
};

// 假的 Claude Code CLI：ok 把收到的參數與 stdin 放進結果（有 --json-schema 時放進 structured_output）；
// stream-json 模式一行一個事件，最後一行才是結果。
const FAKE_CLAUDE = {
  ok: `
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const echo = { args, input, cwd: process.cwd() };
  const result = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(echo) };
  const schemaIndex = args.indexOf('--json-schema');
  if (schemaIndex >= 0) result.structured_output = { ...echo, schema: JSON.parse(args[schemaIndex + 1]) };
  if (args.includes('stream-json')) {
    for (const event of [{ type: 'system', subtype: 'init' }, { type: 'assistant' }, result]) process.stdout.write(JSON.stringify(event) + '\\n');
  } else {
    process.stdout.write(JSON.stringify(result));
  }
});`,
  modelError: `
process.stderr.write('[claude-code:unrecognized_model] {"model":"x"}');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (x)." }));
process.exit(1);`,
  retries: `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: ['schema mismatch'] }));`,
  noStructured: `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'plain text' }));`,
  empty: `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '  ' }));`,
  hang: `setTimeout(() => {}, 60_000);`,
};

let dir;
const bins = {};
const images = {};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-claude-test-'));
  for (const [name, source] of Object.entries(FAKE_CLAUDE)) {
    bins[name] = path.join(dir, `claude-${name}`);
    await writeFile(bins[name], `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  }
  for (const [name, bytes] of Object.entries({ 'a.png': '89504e47', 'b.JPG': 'ffd8ffe0', 'c.bmp': '424d' })) {
    images[name] = path.join(dir, name);
    await writeFile(images[name], Buffer.from(bytes, 'hex'));
  }
});

after(() => rm(dir, { recursive: true, force: true }));

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

test('以 claude -p 非互動模式呼叫，提示詞從 stdin 傳入；預設不提供任何工具、不保存對話、不讀取個人設定', async () => {
  const { args, input, cwd } = JSON.parse(await summarizeWithClaude('請摘要這篇公告', { bin: bins.ok, model: 'sonnet', timeoutMs: 10_000 }));

  assert.equal(input, '請摘要這篇公告');
  assert.equal(args[0], '-p');
  assert.equal(valueOf(args, '--output-format'), 'json');
  assert.equal(valueOf(args, '--tools'), '');
  assert.equal(valueOf(args, '--setting-sources'), '');
  assert.equal(valueOf(args, '--model'), 'sonnet');
  for (const flag of ['--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag));
  for (const flag of ['--allowedTools', '--json-schema', '--input-format', '--verbose']) assert.ok(!args.includes(flag), flag);
  // 在空的暫存資料夾執行，看不到專案檔案
  assert.ok(path.basename(cwd).startsWith('dcwebhook-claude-'));

  const plain = JSON.parse(await summarizeWithClaude('x', { bin: bins.ok, model: '', timeoutMs: 10_000 }));
  assert.ok(!plain.args.includes('--model'));
});

test('指定 JSON Schema 時以 --json-schema 傳入，回傳 structured_output 的 JSON 字串', async () => {
  const reply = await summarizeWithClaude('整理公告', { bin: bins.ok, timeoutMs: 10_000, schema: OUTPUT_SCHEMA });
  const { args, schema } = JSON.parse(reply);
  assert.deepEqual(JSON.parse(valueOf(args, '--json-schema')), OUTPUT_SCHEMA);
  assert.deepEqual(schema, OUTPUT_SCHEMA);
});

test('需要網路搜尋時只提供 WebSearch、WebFetch 並免確認', async () => {
  const { args } = JSON.parse(await summarizeWithClaude('搜尋新聞', { bin: bins.ok, timeoutMs: 10_000, webSearch: true }));
  assert.equal(valueOf(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(valueOf(args, '--allowedTools'), 'WebSearch,WebFetch');
});

test('附加圖片時改用 stream-json，把圖片（base64）與提示詞放在同一則訊息，並從最後的結果事件取得回覆', async () => {
  const reply = await summarizeWithClaude('看圖', {
    bin: bins.ok, timeoutMs: 10_000, schema: OUTPUT_SCHEMA, images: [images['a.png'], images['b.JPG']],
  });
  const { args, input } = JSON.parse(reply);
  assert.equal(valueOf(args, '--input-format'), 'stream-json');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.ok(input.endsWith('\n'));
  assert.deepEqual(JSON.parse(input), {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('89504e47', 'hex').toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('ffd8ffe0', 'hex').toString('base64') } },
        { type: 'text', text: '看圖' },
      ],
    },
  });
});

test('不支援的圖片格式不執行 CLI，直接說明支援的格式', async () => {
  await assert.rejects(
    summarizeWithClaude('看圖', { bin: path.join(dir, 'missing-claude'), timeoutMs: 10_000, images: [images['c.bmp']] }),
    /不支援此圖片格式[\s\S]*\.png/,
  );
});

test('CLI 失敗時帶出結束碼、stderr 與結果中的錯誤原因', async () => {
  await assert.rejects(
    summarizeWithClaude('x', { bin: bins.modelError, timeoutMs: 10_000 }),
    /Claude Code CLI 執行失敗：結束碼 1[\s\S]*unrecognized_model[\s\S]*There's an issue with the selected model/,
  );
});

test('結果標示為錯誤、沒有符合 Schema 的回覆或沒有內容時拋錯', async () => {
  await assert.rejects(
    summarizeWithClaude('x', { bin: bins.retries, timeoutMs: 10_000, schema: OUTPUT_SCHEMA }),
    /error_max_structured_output_retries[\s\S]*schema mismatch/,
  );
  await assert.rejects(
    summarizeWithClaude('x', { bin: bins.noStructured, timeoutMs: 10_000, schema: OUTPUT_SCHEMA }),
    /沒有輸出符合 JSON Schema 的回覆/,
  );
  await assert.rejects(summarizeWithClaude('x', { bin: bins.empty, timeoutMs: 10_000 }), /沒有輸出任何摘要內容/);
});

test('找不到 Claude Code CLI 時立即回報安裝方式', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    summarizeWithClaude('x', { bin: path.join(dir, 'missing-claude'), timeoutMs: 60_000 }),
    /找不到 Claude Code CLI[\s\S]*@anthropic-ai\/claude-code[\s\S]*CLAUDE_BIN/,
  );
  assert.ok(Date.now() - startedAt < 5_000);
});

test('Claude Code CLI 逾時會被終止', async () => {
  await assert.rejects(summarizeWithClaude('x', { bin: bins.hang, timeoutMs: 300 }), /Claude Code CLI 執行失敗：超過 300ms 逾時/);
});

test('summarizeWithAi 依 provider 選擇 Claude 或 Codex（預設 Codex），名稱錯誤時拋錯', async () => {
  const { args } = JSON.parse(await summarizeWithAi('x', { provider: 'claude', bin: bins.ok, timeoutMs: 10_000 }));
  assert.equal(args[0], '-p');
  const missing = path.join(dir, 'missing-cli');
  await assert.rejects(summarizeWithAi('x', { provider: 'codex', bin: missing, timeoutMs: 10_000 }), /找不到 Codex CLI/);
  await assert.rejects(summarizeWithAi('x', { bin: missing, timeoutMs: 10_000 }), /找不到 Codex CLI/);
  await assert.rejects(summarizeWithAi('x', { provider: 'gemini', bin: missing, timeoutMs: 10_000 }), /AI_PROVIDER 只能是 codex 或 claude/);
});
