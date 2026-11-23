/** 以分析當下的已收盤 K 線繪製圖表；保留完整歷史暖機，只顯示最近 120 根。 */
import { adx, atr, ema, macd, rsi } from './indicators.js';
import { marketOf } from './markets.js';
import { formatPrice } from './signals.js';
import { logError } from '../shared/log.js';

const WIDTH = 1600;
const HEIGHT = 2100;
const LEFT = 90;
const RIGHT = 1270;
const BARS = 120;
const C = {
  bg: '#101722', panel: '#172131', grid: '#2a3546', text: '#e4ecf7', muted: '#9aaec7',
  up: '#40cda4', down: '#f17783', ema20: '#ffd166', ema50: '#56b4ef', ema200: '#c49bff',
  entry: '#ffffff', tp: '#40cda4', sl: '#f17783', fib: '#95a3ba', atr: '#f4ab68',
};

const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const point = (n) => Number(n.toFixed(2));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const number = (n, digits = 2) => finite(n) ? n.toFixed(digits) : 'N/A';
const compact = (n) => !finite(n) ? 'N/A' : Math.abs(n) >= 1e9 ? `${number(n / 1e9)}B` : Math.abs(n) >= 1e6 ? `${number(n / 1e6)}M` : Math.abs(n) >= 1e3 ? `${number(n / 1e3)}K` : number(n);
const text = (x, y, value, color = C.text, size = 18, extra = '') => `<text x="${point(x)}" y="${point(y)}" fill="${color}" font-size="${size}" ${extra}>${escape(value)}</text>`;
const line = (x1, y1, x2, y2, color, dash = '', width = 1) => `<line x1="${point(x1)}" y1="${point(y1)}" x2="${point(x2)}" y2="${point(y2)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const rect = (x, y, w, h, color, opacity = 1) => `<rect x="${point(x)}" y="${point(y)}" width="${point(w)}" height="${point(h)}" fill="${color}" opacity="${opacity}"/>`;

function limits(values, { zero = false, fixed } = {}) {
  if (fixed) return fixed;
  const valid = values.filter(finite);
  if (zero) valid.push(0);
  const min = valid.length ? Math.min(...valid) : 0;
  const max = valid.length ? Math.max(...valid) : 1;
  const pad = (max - min || Math.abs(max) * 0.1 || 1) * 0.07;
  return [zero && min >= 0 ? 0 : min - pad, max + pad];
}

/** SVG 與 PNG 共用同一份圖表內容；匯出 SVG 方便檢查標示與數值。 */
export function buildChartSvg(signal, item, { market, now = new Date(), timeZone = 'Asia/Taipei' }) {
  const { candles, snapshot } = item;
  if (!candles?.length || !snapshot) throw new Error('缺少繪圖所需的 K 線或指標');
  const info = marketOf(market);
  const closes = candles.map((bar) => bar.close);
  const offset = Math.max(0, candles.length - BARS);
  const visible = candles.slice(offset);
  const view = (values) => values.slice(offset);
  const e20 = view(ema(closes, 20));
  const e50 = view(ema(closes, 50));
  const e200 = view(ema(closes, 200));
  const m = macd(closes);
  const d = adx(candles);
  const price = (n) => finite(n) ? formatPrice(n, signal.price) : 'N/A';
  const date = (timestamp) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
  const stamp = (timestamp) => new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(timestamp));
  const step = (RIGHT - LEFT) / (visible.length + 8);
  const x = (i) => LEFT + step * (i + 0.5);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<g font-family="PingFang TC,Noto Sans CJK TC,Microsoft JhengHei,Arial,sans-serif" font-weight="700">`, rect(0, 0, WIDTH, HEIGHT, C.bg)];
  const add = (...values) => parts.push(...values);

  add(text(40, 54, `${signal.symbol}${signal.name ? ` ${signal.name}` : ''}｜${info.name} 日線技術分析`, C.text, 32, 'font-weight="bold"'));
  add(text(40, 87, `${item.source} ${item.ticker}｜單位：${info.currency}｜${item.adjusted ? '還原權息・' : ''}指標僅使用已收盤 K 線`, C.muted));
  add(text(40, 123, `${signal.direction === 'short' ? '做空' : '做多'}｜${signal.entryType === 'limit' ? '限價・待觸發' : '現價進場'} ${price(signal.entry)}｜止盈 ${price(signal.takeProfit)}｜止損 ${price(signal.stopLoss)}｜成本後 R/R 1:${number(signal.riskReward, 1)}`, signal.direction === 'short' ? C.down : C.up, 23));
  add(text(40, 156, `分析 ${stamp(now)}（${timeZone}）｜現價時間 ${finite(item.priceTime) ? stamp(item.priceTime) : '未提供'}｜最後收盤 K 線 ${date(visible.at(-1).time)}`, C.muted, 16));

  // 所有副圖沿用同一個 x 座標；每張副圖各自使用數值刻度。
  function panel(id, top, height, title, values, options = {}) {
    const [min, max] = limits(values, options);
    const y = (n) => top + height - ((n - min) / (max - min)) * height;
    add(rect(LEFT, top, RIGHT - LEFT, height, C.panel), text(LEFT, top - 15, title, C.text, 19));
    add(`<defs><clipPath id="${id}"><rect x="${LEFT}" y="${top}" width="${RIGHT - LEFT}" height="${height}"/></clipPath></defs>`);
    for (let i = 0; i <= 4; i++) {
      const value = min + ((max - min) * i) / 4;
      add(line(LEFT, y(value), RIGHT, y(value), C.grid), text(LEFT - 12, y(value) + 5, options.price ? price(value) : compact(value), C.muted, 14, 'text-anchor="end"'));
    }
    for (let i = 0; i < visible.length; i += Math.max(1, Math.floor(visible.length / 6))) add(line(x(i), top, x(i), top + height, C.grid));
    function series(values, color, width = 2) {
      let path = '';
      let start = true;
      values.forEach((n, i) => {
        if (!finite(n)) { start = true; return; }
        path += `${start ? 'M' : 'L'}${point(x(i))},${point(y(n))}`;
        start = false;
      });
      add(`<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" clip-path="url(#${id})"/>`);
    }
    function reference(value, color, label, dash = '5 5') {
      if (!finite(value) || value < min || value > max) return;
      add(line(LEFT, y(value), RIGHT, y(value), color, dash), text(RIGHT + 14, y(value) + 5, label, color, 16));
    }
    function bars(values, colors) {
      values.forEach((n, i) => {
        if (!finite(n)) return;
        add(rect(x(i) - step * 0.32, Math.min(y(n), y(0)), step * 0.64, Math.max(1, Math.abs(y(n) - y(0))), colors[i], 0.8));
      });
    }
    return { y, series, reference, bars };
  }

  const fib = snapshot.fibonacci;
  const levels = [{ price: fib.high.price, label: '波段高' }, { price: fib.low.price, label: '波段低' },
    ...fib.retracements.map((level) => ({ ...level, label: `Fib ${number(level.ratio * 100, 1)}%` })),
    ...fib.extensions.map((level) => ({ ...level, label: `Fib ${number(level.ratio * 100, 1)}% 延伸` }))];
  const mainValues = [...visible.flatMap((b) => [b.high, b.low]), ...e20, ...e50, ...e200,
    signal.price, signal.entry, signal.stopLoss, signal.takeProfit, ...levels.map((level) => level.price)];
  const main = panel('price', 220, 610, '蠟燭圖｜上漲綠色、下跌紅色｜右側色塊為交易風險與獲利區域', mainValues, { price: true });
  // 附加資訊只佔主圖右側，讓歷史 K 線清楚可讀。
  const tradeX = x(visible.length) + step;
  add(rect(tradeX, Math.min(main.y(signal.entry), main.y(signal.takeProfit)), RIGHT - tradeX, Math.abs(main.y(signal.entry) - main.y(signal.takeProfit)), C.tp, 0.18));
  add(rect(tradeX, Math.min(main.y(signal.entry), main.y(signal.stopLoss)), RIGHT - tradeX, Math.abs(main.y(signal.entry) - main.y(signal.stopLoss)), C.sl, 0.2));
  for (const level of levels) add(line(LEFT, main.y(level.price), RIGHT, main.y(level.price), C.fib, '2 7'));
  for (const value of [snapshot.range20.high, snapshot.range20.low]) add(line(x(Math.max(0, visible.length - 20)), main.y(value), RIGHT, main.y(value), C.atr, '7 5'));
  const colors = visible.map((bar) => bar.close >= bar.open ? C.up : C.down);
  visible.forEach((bar, i) => {
    add(line(x(i), main.y(bar.high), x(i), main.y(bar.low), colors[i], '', 1.4));
    add(rect(x(i) - step * 0.32, Math.min(main.y(bar.open), main.y(bar.close)), step * 0.64, Math.max(1.5, Math.abs(main.y(bar.open) - main.y(bar.close))), colors[i]));
  });
  main.series(e20, C.ema20); main.series(e50, C.ema50); main.series(e200, C.ema200);
  // 將靠近的標籤錯開，以引線對準各自的真實價位。
  const tags = [
    ...levels.map((level) => ({ value: level.price, label: `${level.label} ${price(level.price)}`, color: C.fib })),
    { value: snapshot.range20.high, label: `近20根高 ${price(snapshot.range20.high)}`, color: C.atr },
    { value: snapshot.range20.low, label: `近20根低 ${price(snapshot.range20.low)}`, color: C.atr },
    { value: signal.price, label: `現價 ${price(signal.price)}`, color: C.ema50 },
    { value: signal.entry, label: `進場 ${price(signal.entry)}`, color: C.entry },
    { value: signal.takeProfit, label: `止盈 ${price(signal.takeProfit)}`, color: C.tp },
    { value: signal.stopLoss, label: `止損 ${price(signal.stopLoss)}`, color: C.sl },
  ].map((tag) => ({ ...tag, target: main.y(tag.value) })).sort((a, b) => a.target - b.target);
  let labelY = 220;
  for (const tag of tags) { tag.y = Math.max(tag.target, labelY); labelY = tag.y + 23; }
  let bottom = 826;
  for (let i = tags.length - 1; i >= 0; i--) { tags[i].y = Math.min(tags[i].y, bottom); bottom = tags[i].y - 23; }
  for (const tag of tags) {
    const pos = tag.y;
    add(line(RIGHT, tag.target, RIGHT + 10, pos, tag.color), text(RIGHT + 15, pos + 5, tag.label, tag.color, 15));
  }
  for (const [value, color] of [[signal.entry, C.entry], [signal.takeProfit, C.tp], [signal.stopLoss, C.sl], [signal.price, C.ema50]]) add(line(LEFT, main.y(value), RIGHT, main.y(value), color, '6 5', 1.3));
  add(text(LEFT, 188, `EMA20 ${price(snapshot.ema.ema20)}`, C.ema20), text(350, 188, `EMA50 ${price(snapshot.ema.ema50)}`, C.ema50), text(610, 188, `EMA200 ${price(snapshot.ema.ema200)}`, C.ema200));
  for (let i = 0; i < visible.length; i += Math.max(1, Math.floor(visible.length / 6))) add(text(x(i), 854, date(visible[i].time), C.muted, 14, 'text-anchor="middle"'));

  // 前 20 根平均量不含當根，與 analyzeCandles() 的定義一致。
  const volumeAvg = candles.map((_, i) => i < 20 ? null : candles.slice(i - 20, i).reduce((sum, b) => sum + b.volume, 0) / 20);
  const volume = panel('volume', 905, 115, `成交量｜當根 ${compact(snapshot.volume.last)}｜前20根均量 ${compact(snapshot.volume.average)}｜量比 ${number(snapshot.volume.ratio)}x`, [...visible.map((b) => b.volume), ...view(volumeAvg)], { zero: true });
  volume.bars(visible.map((b) => b.volume), colors); volume.series(view(volumeAvg), C.ema20);
  const macdPanel = panel('macd', 1070, 135, `MACD(12,26,9)｜DIF ${number(snapshot.macd.macd)}（藍）｜訊號 ${number(snapshot.macd.signal)}（黃）｜柱體 ${number(snapshot.macd.histogram)}`, [...view(m.macd), ...view(m.signal), ...view(m.histogram)], { zero: true });
  macdPanel.bars(view(m.histogram), view(m.histogram).map((n) => n >= 0 ? C.up : C.down));
  macdPanel.series(view(m.macd), C.ema50); macdPanel.series(view(m.signal), C.ema20); macdPanel.reference(0, C.muted, '0');
  const rsiPanel = panel('rsi', 1255, 115, `RSI(14) ${number(snapshot.rsi.value)}｜30／70 參考線`, [], { fixed: [0, 100] });
  rsiPanel.series(view(rsi(closes)), C.ema200); rsiPanel.reference(30, C.up, '30'); rsiPanel.reference(70, C.down, '70');
  const adxPanel = panel('adx', 1420, 115, `ADX(14) ${number(snapshot.adx.adx)}（紫）｜+DI ${number(snapshot.adx.plusDI)}（綠）｜−DI ${number(snapshot.adx.minusDI)}（紅）`, [...view(d.adx), ...view(d.plusDI), ...view(d.minusDI), 25], { zero: true });
  adxPanel.series(view(d.adx), C.ema200); adxPanel.series(view(d.plusDI), C.up); adxPanel.series(view(d.minusDI), C.down); adxPanel.reference(25, C.muted, '25');
  const atrPanel = panel('atr', 1585, 105, `ATR(14) ${price(snapshot.atr)}｜佔現價 ${number(snapshot.atr / signal.price * 100)}%`, view(atr(candles)), { zero: true });
  atrPanel.series(view(atr(candles)), C.atr);
  for (let i = 0; i < visible.length; i += Math.max(1, Math.floor(visible.length / 6))) add(text(x(i), 1714, date(visible[i].time), C.muted, 14, 'text-anchor="middle"'));

  add(text(40, 1762, `EMA50 近5根斜率 ${number(snapshot.ema.ema50Slope)}%｜近20根漲日均量 ${compact(snapshot.volume.upAverage)}／跌日均量 ${compact(snapshot.volume.downAverage)}`, C.muted));
  add(text(40, 1793, `成交額（收盤×成交量）：當根 ${compact(snapshot.turnover.last)}／前20根平均 ${compact(snapshot.turnover.average)} ${info.currency}`, C.muted));
  add(text(40, 1824, `費波那契波段 ${fib.trend === 'up' ? '向上' : '向下'}｜低 ${price(fib.low.price)}（${date(fib.low.time)}）／高 ${price(fib.high.price)}（${date(fib.high.time)}）`, C.muted));
  function paragraph(value, top, color = C.text) {
    const chars = [...value];
    let row = '';
    let units = 0;
    let y = top;
    for (const ch of chars) {
      const width = ch.charCodeAt(0) > 255 ? 2 : 1;
      if (units + width > 150) { add(text(40, y, row, color, 18)); y += 28; row = ''; units = 0; }
      row += ch; units += width;
    }
    if (row) add(text(40, y, row, color, 18));
    return y + 30;
  }
  const endReason = paragraph(`判斷原因：${signal.reason}`, 1864);
  if (signal.note) paragraph(`注意事項：${signal.note}`, endReason, C.atr);
  add(text(40, 2070, `顯示最近 ${visible.length} 根，指標以完整 ${candles.length} 根計算；N/A 表示歷史不足。此圖為分析計畫，未代表已成交。`, C.muted, 16));
  add('</g></svg>');
  return parts.join('\n');
}

/** 僅在有需要的做單訊號時載入 PNG 轉檔套件；多個 Webhook 共用同一份 Buffer。 */
export async function buildSignalCharts(results, plan, options) {
  const charts = new Map();
  let renderer;
  for (const market of results) {
    if (!market.includeChart) continue;
    const source = plan.find((entry) => entry.key === market.key);
    for (const signal of [...market.signals, ...market.autoSignals]) {
      if (signal.action !== 'trade') continue;
      try {
        const item = [...source.items, ...source.autoItems].find((entry) => entry.symbol === signal.symbol);
        const svg = buildChartSvg(signal, item, { ...options, market: market.key });
        renderer ??= await import('@resvg/resvg-js');
        const rendered = await renderer.renderAsync(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
        charts.set(`${market.key}:${signal.symbol}`, {
          name: `signal-${market.key}-${signal.symbol.replace(/[^A-Za-z0-9_-]/g, '_')}.png`,
          contentType: 'image/png', data: rendered.asPng(),
        });
      } catch (err) {
        logError(`[${marketOf(market.key).name} ${signal.symbol}] 圖片解說產生失敗，本次只發送文字：${err.message}`);
      }
    }
  }
  return charts;
}
