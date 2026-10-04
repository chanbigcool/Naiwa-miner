/* 通用探针：打开一个页面，跑一段表达式，把结果打出来，顺便截一张图。
 *
 * 用途：当"截图看着像有 bug，但又说不清"的时候，别靠肉眼猜 —— 直接问浏览器要计算后的样式。
 * 这个脚本就是为了终结一次"图例底板到底还在不在"的争论才写的。
 *
 * 用法：
 *   node _qa/probe.mjs <url> <js表达式> [截图输出路径] [视口 WxH]
 *
 * 例：
 *   node _qa/probe.mjs http://127.0.0.1:8137/miner/ \
 *     "getComputedStyle(document.querySelector('.legend .thumb')).backgroundColor"
 *   node _qa/probe.mjs http://127.0.0.1:8137/miner/ "window.__miner.layout" _qa/x.png 1440x820
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const URL_ARG = process.argv[2];
const EXPR = process.argv[3] || 'document.title';
const SHOT = process.argv[4] || '';
const SIZE = process.argv[5] || '420x880';

const m = /^(\d+)[x×](\d+)$/.exec(SIZE);
const VW = m ? parseInt(m[1], 10) : 420;
const VH = m ? parseInt(m[2], 10) : 880;
const MOBILE = VW < VH;

if (!URL_ARG) {
  console.error('用法: node _qa/probe.mjs <url> "<js表达式>" [截图路径]');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-probe-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  // 探针要的就是"磁盘上现在的内容"，禁用缓存免得被上一版骗了
  '--disable-http-cache', '--disk-cache-size=1',
  `--window-size=${VW},${VH}`,
  'about:blank',
], { stdio: 'ignore' });

function cleanup(code) {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(code);
}

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { return page.webSocketDebuggerUrl; }
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools 端口一直没起来');
}

const wsUrl = await waitDevtools();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const problems = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems.push('未捕获异常: ' + (d.exception?.description || d.text));
  }
};

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('页面里求值失败: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride',
    { width: VW, height: VH, deviceScaleFactor: 2, mobile: MOBILE });

  await send('Page.navigate', { url: URL_ARG });
  await sleep(3500);

  const out = await evaluate(EXPR);
  console.log('=== 表达式 ===');
  console.log(EXPR);
  console.log('=== 结果 ===');
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));

  if (SHOT) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
    console.log('=== 截图 ===');
    console.log(SHOT);
  }

  if (problems.length) {
    console.log('=== 页面报错 ===');
    problems.forEach((p) => console.log(p));
  } else {
    console.log('=== 页面报错 ===');
    console.log('无 ✓');
  }
  cleanup(0);
} catch (e) {
  console.error('探针失败:', e.message);
  cleanup(1);
}
