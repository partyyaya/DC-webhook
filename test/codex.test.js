import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { summarizeWithCodex } from '../src/shared/codex.js';

const OUTPUT_SCHEMA = {
  type: 'object', properties: { summary: { type: 'string' } },
  required: ['summary'], additionalProperties: false,
};

const FAKE_CODEX = {
  ok: `
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const outputFile = args[args.indexOf('--output-last-message') + 1];
  const schemaIndex = args.indexOf('--output-schema');
  const schema = schemaIndex >= 0 ? JSON.parse(fs.readFileSync(args[schemaIndex + 1], 'utf8')) : null;
  fs.writeFileSync(outputFile, JSON.stringify({ args, input, schema }));
});`,
  fail: `process.stderr.write('not logged in'); process.exit(2);`,
  hang: `setTimeout(() => {}, 60_000);`,
};

let dir;
const bins = {};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-codex-'));
  for (const [name, source] of Object.entries(FAKE_CODEX)) {
    bins[name] = path.join(dir, `codex-${name}`);
    await writeFile(bins[name], `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  }
});

after(() => rm(dir, { recursive: true, force: true }));

test('以 codex exec 非互動模式呼叫，提示詞從 stdin 傳入', async () => {
  const summary = await summarizeWithCodex('請摘要這篇公告', { bin: bins.ok, model: 'gpt-test', timeoutMs: 10_000 });
  const { args, input } = JSON.parse(summary);

  assert.equal(input, '請摘要這篇公告');
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '--output-last-message']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-test');
});

test('指定 JSON Schema 時以 --output-schema 傳給 Codex', async () => {
  const reply = await summarizeWithCodex('整理公告', { bin: bins.ok, timeoutMs: 10_000, schema: OUTPUT_SCHEMA });
  const { args, schema } = JSON.parse(reply);
  assert.ok(args.includes('--output-schema'));
  assert.deepEqual(schema, OUTPUT_SCHEMA);
  assert.equal(args.at(-1), '-');
});

test('找不到 Codex CLI 時立即回報安裝方式', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    summarizeWithCodex('x', { bin: path.join(dir, 'missing-codex'), timeoutMs: 60_000 }),
    /找不到 Codex CLI/,
  );
  assert.ok(Date.now() - startedAt < 5_000);
});

test('Codex CLI 失敗時帶出錯誤訊息', async () => {
  await assert.rejects(summarizeWithCodex('x', { bin: bins.fail, timeoutMs: 10_000 }), /結束碼 2[\s\S]*not logged in/);
});

test('Codex CLI 逾時會被終止', async () => {
  await assert.rejects(summarizeWithCodex('x', { bin: bins.hang, timeoutMs: 300 }), /逾時/);
});

