/* 跨设备可见性诊断（CDP 驱动无头 Chrome）
 * ---------------------------------------------------------------------------
 * 目的：回答一个问题 —— A 玩家的成绩，B 玩家能不能看到？
 *
 * 做法：起两个**互相隔离的浏览器配置目录**（等价于两台设备 / 两个浏览器），
 *   1. A 写下 3 条成绩，确认 A 自己看得到
 *   2. B 打开同一个网址，看榜单是空的还是别人的 3 条
 *   3. 记录一次完整开局期间的所有网络请求 —— 判断有没有把成绩发出去
 *
 * 用法：node _qa/crossdevice.mjs http://127.0.0.1:8141/miner/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = process.argv[2] || 'http://127.0.0.1:8141/miner/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 9361;
const report = { target: TARGET };

async function withBrowser(label, fn) {
  const port = nextPort++;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-x-' + label + '-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=420,880',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let ver = null;
    for (let i = 0; i < 60; i++) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        if (ver.length) { break; }
      } catch (e) { /* 还没起来 */ }
      await sleep(150);
    }
    if (!ver || !ver.length) { throw new Error(label + ': Chrome 没起来'); }
    const page = ver.find((t) => t.type === 'page') || ver[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const requests = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent') {
        requests.push(msg.params.request.url);
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) { throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 80)); }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: TARGET });
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(`!!(window.__miner && window.__miner.game && window.__miner.game.phase !== 'ready')`).catch(() => false);
      if (ready) { break; }
      await sleep(150);
    }
    await sleep(500);

    const out = await fn({ evaluate, requests, sleep });
    report[label] = out;
    return out;
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

const readBoard = `(() => {
  const raw = JSON.parse(localStorage.getItem('naiwa_miner_board_v1') || '[]');
  return { stored: raw.length, names: raw.map(r => r.name), ids: raw.map(r => r.id) };
})()`;

/* ---------- 玩家 A：写下三条成绩 ---------- */
await withBrowser('A', async ({ evaluate, requests }) => {
  const before = await evaluate(readBoard);
  await evaluate(`(() => {
    const now = Date.now();
    const seed = [
      { id: 'A1', name: '玩家A', score: 8800, level: 6, comboBest: 7, ts: now - 3000, preset: 'standard', named: true, avatar: 'god' },
      { id: 'A2', name: '玩家A', score: 4300, level: 3, comboBest: 4, ts: now - 2000, preset: 'standard', named: true, avatar: 'god' },
      { id: 'A3', name: '玩家A', score: 9900, level: 8, comboBest: 9, ts: now - 1000, preset: 'standard', named: true, avatar: 'god' },
    ];
    localStorage.setItem('naiwa_miner_board_v1', JSON.stringify(seed));
    localStorage.setItem('naiwa_miner_name', '玩家A');
    localStorage.setItem('naiwa_miner_avatar', 'god');
    location.reload();
  })()`);
  for (let i = 0; i < 80; i++) {
    const ok = await evaluate(`!!(window.__miner && window.__miner.game && window.__miner.game.phase !== 'ready')`).catch(() => false);
    if (ok) { break; }
    await sleep(150);
  }
  await sleep(500);
  const after = await evaluate(readBoard);
  /* 打开排行榜，看界面上的第一名 */
  await evaluate(`document.getElementById('btnOpenBoard').click()`);
  await sleep(350);
  const shown = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#boardList li')];
    return { visible: document.querySelectorAll('#ovBoard.show').length > 0,
             rows: rows.length,
             top: rows[0] ? rows[0].querySelector('b').textContent : null };
  })()`);
  return { before, after, shown, requests: [...new Set(requests)] };
});

/* ---------- 玩家 B：同一网址，独立配置 ---------- */
await withBrowser('B', async ({ evaluate, requests }) => {
  const board = await evaluate(readBoard);
  /* 开始页没了：入口摘要变成右上角按钮上的条数徽章 */
  const startText = await evaluate(`(() => {
    const n = document.getElementById('lbMeta');
    return n ? n.textContent : null;
  })()`);
  await evaluate(`document.getElementById('btnOpenBoard').click()`);
  await sleep(350);
  const shown = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#boardList li')];
    return { visible: document.querySelectorAll('#ovBoard.show').length > 0,
             rows: rows.length,
             empty: document.getElementById('boardEmpty') ? document.getElementById('boardEmpty').textContent.trim() : null };
  })()`);
  return { board, startText, shown, requests: [...new Set(requests)] };
});

/* ---------- 汇总 ---------- */
const a = report.A;
const b = report.B;
const sameIds = b.board.ids.some((id) => a.after.ids.includes(id));

report.verdict = {
  aStored: a.after.stored,
  aTop: a.shown.top,
  bStored: b.board.stored,
  bRows: b.shown.rows,
  leaked: sameIds,
  nonStaticRequests: [...new Set([...(a.requests || []), ...(b.requests || [])])]
    .filter((u) => !/\.(html|css|js|webp|png|ico|svg|woff2?)(\?|$)/i.test(u))
    .filter((u) => !u.startsWith('data:') && !u.startsWith('blob:')),
};

console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join('_qa', 'crossdevice-report.json'), JSON.stringify(report, null, 2));

if (report.verdict.leaked) {
  console.error('!! B 看到了 A 的记录 —— 跨设备是通的');
  process.exit(1);
}
if (b.board.stored !== 0) {
  console.error('!! B 的榜不是空的：' + b.board.stored);
  process.exit(1);
}
console.log('\n结论：B 看不到 A 的成绩（B 榜 =', b.board.stored, '条，A 榜 =', a.after.stored, '条）');
