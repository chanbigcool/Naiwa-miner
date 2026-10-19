/* 云端榜前端接线验收（假云端）
 * ---------------------------------------------------------------------------
 * 真实后端只能在发布域名上跑（Origin 精确匹配），本地 127.0.0.1 必然被拒。
 * 所以这里不动网络：在页面脚本执行**之前**塞一个 window.MinerCloud 替身，
 * 专门验证 game.js 那一侧的接线是否真的通了：
 *   1. 打开排行榜 → 展示的是云端那份，不是本机的
 *   2. 子标题 / 开始页摘要跟着切成"全服"
 *   3. 改名字 → 触发补传（flush）
 *   4. 结算 → 提交这一局，名次来自云端
 *
 * 用法：node _qa/cloudui.mjs http://127.0.0.1:8141/miner/ _qa/shots-cloudui
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9381;
const TARGET = process.argv[2] || 'http://127.0.0.1:8141/miner/';
const OUTDIR = process.argv[3] || '_qa/shots-cloudui';
fs.mkdirSync(OUTDIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-cloudui-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--mute-audio', '--window-size=420,880', 'about:blank',
], { stdio: 'ignore' });

const STUB = `(() => {
  window.__stub = { submitted: [], flushed: [], loads: 0 };
  const C = window.MinerCloud;
  C.available = function () { return true; };
  C.clientId = function () { return 'cid-test'; };
  C.pending = function () { return 0; };
  C.load = function () {
    window.__stub.loads++;
    function mk(id, name, score, level, combo, cid) {
      return { id: 'c' + id, runId: 'run' + id, clientId: cid || 'other',
               name: name, avatar: 'blob', score: score, level: level, comboBest: combo,
               ts: Date.now(), named: true, preset: 'standard', outcome: 'fail' };
    }
    var rows = [mk(1, '云玩家A', 15000, 9, 12, 'cid-test'),
                mk(2, '云玩家B', 12000, 8, 7),
                mk(3, '云玩家C', 9000, 6, 5)];
    var sub = window.__stub.submitted[0];
    if (sub) {
      var me = { id: 'c0', runId: sub.id, clientId: 'cid-test', name: sub.name || '我',
                 avatar: 'blob', score: sub.score, level: 3, comboBest: 2, ts: Date.now(),
                 named: true, preset: 'standard', outcome: 'fail' };
      rows.unshift(me);
    }
    return Promise.resolve({ count: 42, rows: { score: rows, level: rows, combo: rows } });
  };
  C.submit = function (rec, name) {
    window.__stub.submitted.push({ id: rec.id, name: name, score: rec.score });
    return Promise.resolve({ ok: true });
  };
  C.flush = function (name) {
    window.__stub.flushed.push(name);
    return Promise.resolve(1);
  };
})();`;

const report = { target: TARGET };
const need = (cond, msg) => { if (!cond) { report.problem = msg; throw new Error(msg); } };

async function main() {
  let tabs = null;
  for (let i = 0; i < 60; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (tabs.length) { break; }
    } catch (e) { /* ignore */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.text); }
    return r.result.value;
  };
  const click = async (sel) => {
    const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) { throw new Error('找不到元素 ' + sel); }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: TARGET });

  for (let i = 0; i < 80; i++) {
    const ok = await evaluate(`!!(window.__miner && window.__miner.game && document.getElementById('btnStart'))`).catch(() => false);
    if (ok) { break; }
    await sleep(150);
  }
  await sleep(500);

  /* 把真实的 cloud.js 模块"换成"假后端：game.js 持有的是同一个对象，
   * 所以换方法就够了，不用在文档级抢注（cloud.js 会把自己的实现挂上去）。 */
  await evaluate(STUB);
  await evaluate('window.__miner.refreshCloud()');
  await sleep(500);

  /* 1. 开始页摘要已经切成"全服" */
  report.debug = await evaluate(`(() => ({
    hasStub: typeof window.MinerCloud,
    loads: window.__stub.loads,
    cloud: window.__miner.cloud,
  }))()`);
  report.startMeta = await evaluate(`document.getElementById('lbMeta').textContent`);
  need(/全服/.test(report.startMeta), '开始页摘要没切成全服：' + report.startMeta);

  /* 2. 排行榜展示的是云端那份 */
  await click('#btnOpenBoard');
  await sleep(400);
  report.board = await evaluate(`(() => ({
    sub: document.getElementById('boardSub').textContent,
    rows: [...document.querySelectorAll('#boardList li')].map(li => ({
      name: li.querySelector('b').textContent,
      me: li.classList.contains('me'),
    })),
  }))()`);
  need(/全服榜/.test(report.board.sub), '子标题没写全服榜：' + report.board.sub);
  need(report.board.rows[0] && report.board.rows[0].name === '云玩家A',
    '第一名不是云端数据：' + JSON.stringify(report.board.rows[0]));
  need(report.board.rows[0].me === true, '自己那条（设备指纹相同）应该高亮');
  await shot('01-board-cloud.png');

  /* 2.5 云榜**为空**时，不许拿本机记录凑数。
   * 这是线上真实抓到过的 bug：标题"全服榜 · 共 0 条"，下面却列着本机成绩。 */
  await evaluate(`(() => {
    window.__miner.board.push({ id: 'local-x', name: '本机玩家甲', avatar: 'blob',
      score: 99999, level: 9, comboBest: 9, ts: Date.now(), preset: 'standard',
      outcome: 'fail', named: true });
    const C = window.MinerCloud;
    window.__realLoad = C.load;
    C.load = function () {
      return Promise.resolve({ count: 0, rows: { score: [], level: [], combo: [] } });
    };
  })()`);
  await evaluate('window.__miner.refreshCloud()');
  await sleep(400);
  report.emptyCloud = await evaluate(`(() => ({
    sub: document.getElementById('boardSub').textContent,
    rows: document.querySelectorAll('#boardList li').length,
    empty: !document.getElementById('boardEmpty').hidden,
    meta: document.getElementById('lbMeta').textContent,
  }))()`);
  need(/共 0 条/.test(report.emptyCloud.sub), '云榜为空时子标题该写 0 条：' + report.emptyCloud.sub);
  need(report.emptyCloud.rows === 0,
    '云榜为空时不能渲染本机记录，实际渲染了 ' + report.emptyCloud.rows + ' 行');
  need(report.emptyCloud.empty, '云榜为空时应该显示空榜提示');
  need(/全服/.test(report.emptyCloud.meta), '开始页摘要也该如实说全服为空：' + report.emptyCloud.meta);
  await shot('01b-board-cloud-empty.png');

  /* 把假后端恢复成有数据的版本，继续后面的用例 */
  await evaluate('window.MinerCloud.load = window.__realLoad');
  await evaluate('window.__miner.refreshCloud()');
  await sleep(400);

  /* 3. 起名触发补传 */
  await evaluate(`(() => { const i = document.getElementById('boardNameInput');
    i.focus(); i.value = ''; })()`);
  await evaluate(`(() => { const i = document.getElementById('boardNameInput');
    i.value = '阿包'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.blur(); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(400);
  report.flush = await evaluate(`window.__stub.flushed.slice()`);
  need(report.flush.indexOf('阿包') >= 0, '起名后应该补传队列：' + JSON.stringify(report.flush));

  /* 4. 结算提交 + 名次来自云端 */
  await click('#btnBoardClose');
  await sleep(200);
  await click('#btnStart');
  await sleep(900);
  await evaluate(`(() => { const g = window.__miner.game;
    g.score = 15000; g.target = 20000; g.level = 9; g.comboBest = 12; g.timeLeft = 0.04; })()`);
  await sleep(1200);
  report.settle = await evaluate(`(() => ({
    over: document.getElementById('ovOver').classList.contains('show'),
    rank: document.getElementById('overRankTxt').textContent,
    badge: document.getElementById('overRankBadge').textContent,
    submitted: window.__stub.submitted.slice(),
  }))()`);
  need(report.settle.over, '结算面板没弹出来');
  need(report.settle.submitted.length === 1, '应该提交一条：' + JSON.stringify(report.settle.submitted));
  need(report.settle.submitted[0].name === '阿包', '提交的名字不对：' + report.settle.submitted[0].name);
  /* 局内 15000、标准 ×2 → 全服榜上必须是 30000。
   * 云端只存"结算分"，倍率在写记录那一刻就算完了，读的人不用再乘。 */
  need(report.settle.submitted[0].score === 30000,
    '提交的应该是结算分（15000 × 2 = 30000）：' + report.settle.submitted[0].score);
  need(/全服/.test(report.settle.rank), '结算卡名次没走云端：' + report.settle.rank);
  await shot('02-over-cloud.png');

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUTDIR, 'cloudui-report.json'), JSON.stringify(report, null, 2));
  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  console.error(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUTDIR, 'cloudui-report.json'), JSON.stringify(report, null, 2));
  try { chrome.kill(); } catch (x) { /* ignore */ }
  process.exit(1);
});
