/* 横屏快照：确认开始页入口、排行榜、结算卡在宽屏上不变形
 * 用法：node _qa/landscape.mjs http://127.0.0.1:8137/miner/ _qa/shots-land
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const TARGET = process.argv[2] || 'http://127.0.0.1:8137/miner/';
const OUTDIR = process.argv[3] || '.';
fs.mkdirSync(OUTDIR, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-land-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--mute-audio', '--window-size=980,640', 'about:blank',
], { stdio: 'ignore' });

function done(code) {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(code);
}

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) { /* wait */ }
    await sleep(250);
  }
  throw new Error('DevTools 没起来');
}

const ws = new WebSocket(await wsUrl());
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
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
}
const need = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); };
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    if (await ev('!!(window.__miner && window.__miner.game && window.__miner.game.phase !== "ready")')) return;
    await sleep(200);
  }
  throw new Error('就绪超时');
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 980, height: 640, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: TARGET });
  await waitReady();

  const now = Date.now();
  const seed = [];
  const names = ['老王', '小美', '奶蛙', '阿强', '花花', '老王', '小美', '奶蛙'];
  for (let i = 0; i < 8; i++) {
    seed.push({ id: 'x' + i, name: names[i], score: 9800 - i * 730, level: 8 - (i % 4),
      comboBest: 12 - i, ts: now - i * 60000, preset: 'standard', named: true });
  }
  await ev(`localStorage.setItem('naiwa_miner_board_v1', ${JSON.stringify(JSON.stringify(seed))});
            localStorage.setItem('naiwa_miner_name', '老王'); location.reload();`);
  await waitReady();
  await sleep(500);
  await shot('01-playing-landscape.png');

  const layout = await ev('window.__miner.layout');
  const stage = await ev(`(() => { const r = document.getElementById('stage').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  await ev('document.getElementById("btnOpenBoard").click()');
  await sleep(400);
  await shot('02-board-landscape.png');
  const overflow = await ev(`(() => {
    const c = document.querySelector('#ovBoard .ov-card');
    const list = document.getElementById('boardScroll');
    const closeBtn = document.getElementById('btnBoardClose').getBoundingClientRect();
    return {
      cardFits: c.getBoundingClientRect().bottom <= innerHeight + 1,
      closeVisible: closeBtn.bottom <= innerHeight + 1 && closeBtn.top >= 0,
      listScrollable: list.scrollHeight >= list.clientHeight,
      rows: document.querySelectorAll('#boardList .bl-row').length,
    };
  })()`);
  need(overflow.cardFits && overflow.closeVisible, '横屏榜单卡超出画面：' + JSON.stringify(overflow));

  await ev('document.getElementById("btnBoardClose").click()');
  await sleep(400);
  await ev(`(() => { const g = window.__miner.game; g.score = 8800; g.target = 20000; g.level = 5; g.timeLeft = 0.04; })()`);
  await sleep(800);
  await shot('03-over-landscape.png');

  console.log(JSON.stringify({ layout, stage, overflow, problems }, null, 2));
  done(problems.length ? 2 : 0);
} catch (err) {
  console.error('中断:', err.message);
  try { await shot('99-fail.png'); } catch (e) { /* ignore */ }
  done(3);
}
