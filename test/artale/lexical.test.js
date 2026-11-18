import assert from 'node:assert/strict';
import test from 'node:test';
import { findMissingText, lexicalToMarkdown } from '../../src/artale/lexical.js';

const text = (value) => ({ type: 'text', text: value });
const paragraph = (...children) => ({ type: 'paragraph', children });
const listItem = (value, ...children) => ({ type: 'listitem', value, children });
const cell = (value) => ({ type: 'tablecell', children: [paragraph(text(value))] });
const doc = (...children) => ({ root: { type: 'root', children } });

test('轉換段落、標題、引用與分隔線，並略過空白段落', () => {
  const markdown = lexicalToMarkdown(
    doc(
      paragraph(text('各位 Artale 冒險家們，您好！')),
      paragraph(text(' ')),
      { type: 'heading', tag: 'h2', children: [text('[更新目錄]')] },
      {
        type: 'quote',
        children: [
          paragraph(text('💡 注意事項')),
          { type: 'list', listType: 'bullet', children: [listItem(1, text('不可交易'))] },
        ],
      },
      { type: 'horizontalrule' },
    ),
  );

  assert.equal(markdown, '各位 Artale 冒險家們，您好！\n\n## [更新目錄]\n\n> 💡 注意事項\n>\n> - 不可交易\n\n---');
});

test('轉換編號清單與巢狀清單', () => {
  const markdown = lexicalToMarkdown(
    doc({
      type: 'list',
      listType: 'number',
      start: 1,
      children: [
        listItem(1, text('Tespia 開放')),
        listItem(2, { type: 'list', listType: 'bullet', children: [listItem(1, text('皇家騎士團'))] }),
        listItem(2, text('多角色系統')),
      ],
    }),
  );

  assert.equal(markdown, '1. Tespia 開放\n  - 皇家騎士團\n2. 多角色系統');
});

test('轉換表格，儲存格內的直線會被跳脫', () => {
  const markdown = lexicalToMarkdown(
    doc({
      type: 'table',
      children: [
        { type: 'tablerow', children: [cell('類別'), cell('倍率')] },
        { type: 'tablerow', children: [cell('經驗值|掉寶'), cell('20倍')] },
      ],
    }),
  );

  assert.equal(markdown, '| 類別 | 倍率 |\n| --- | --- |\n| 經驗值\\|掉寶 | 20倍 |');
});

test('轉換完整時，完整性檢查不會誤判（引用、清單、含直線的表格、連結）', () => {
  const lexical = doc(
    { type: 'heading', tag: 'h2', children: [text('1. 多角色系統')] },
    {
      type: 'quote',
      children: [
        paragraph(text('💡 注意事項')),
        { type: 'list', listType: 'bullet', children: [listItem(1, text('「回歸歡迎硬幣」不可交易'))] },
      ],
    },
    {
      type: 'table',
      children: [{ type: 'tablerow', children: [cell('經驗值|掉寶'), cell('20倍')] }],
    },
    paragraph({ type: 'link', url: 'https://artale.live', children: [text('前往官網')] }),
  );
  assert.deepEqual(findMissingText(lexical, lexicalToMarkdown(lexical)), []);
});

test('轉換結果漏掉文字時，完整性檢查會列出遺漏的片段', () => {
  const lexical = doc(paragraph(text('第一段')), paragraph(text('第二段：活動時間 11/24')));
  assert.deepEqual(findMissingText(lexical, '第一段'), ['第二段：活動時間 11/24']);
});

test('轉換連結與圖片', () => {
  const markdown = lexicalToMarkdown(
    doc(
      paragraph(text('詳見'), { type: 'link', url: 'https://artale.live/tw/news', children: [text('公告頁')] }),
      { type: 'image', src: 'https://cdn.example/a.webp', alt: '活動圖' },
    ),
  );

  assert.equal(markdown, '詳見[公告頁](https://artale.live/tw/news)\n\n![活動圖](https://cdn.example/a.webp)');
});
