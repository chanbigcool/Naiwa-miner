/* 本地 QA：排行榜（CDP 驱动无头 Chrome）
 * ---------------------------------------------------------------------------
 * 覆盖四条真实路径：
 *   1. 空榜 → 开始页入口的状态文案
 *   2. 有历史记录 → 三个榜的排序、名字归属（只认未署名的）
 *   3. 已署名玩家结算 → 直接报名次，不再弹起名框
 *   4. 新玩家结算 → 在结算卡上留名，名字落盘、记录跟着改名
 * 用法：node _qa/board.mjs http://127.0.0.1:8137/miner/ _qa/shots-board
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const TARGET = process.argv[2] || 'http://127.0.0.1:8137/miner/';
const OUTDIR = process.argv[3] || '.';
fs.mkdirSync(OUTDIR, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-board-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=420,880',
  'about:blank',
], { stdio: 'ignore' });

function cleanup(code) {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(code);
}

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
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

const ws = new WebSocket(await waitDevtools());
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
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
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

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, 'base64'));
}

async function boxOf(sel) {
  const b = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!b) throw new Error('找不到元素: ' + sel);
  return b;
}

async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function click(sel) {
  const b = await boxOf(sel);
  await clickAt(b.x, b.y);
  return b;
}

async function waitReady(maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ok = await evaluate(`(() => {
      const g = window.__miner && window.__miner.game;
      const b = document.getElementById('btnStart');
      return !!(g && b && document.readyState === 'complete');
    })()`);
    if (ok) return;
    await sleep(200);
  }
  throw new Error('等待游戏就绪超时');
}

function need(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }

const report = {};
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 420, height: 880, deviceScaleFactor: 2, mobile: true });

  await send('Page.navigate', { url: TARGET });
  await waitReady();

  /* ---------- 1. 空榜 ---------- */
  await evaluate('localStorage.clear(); location.reload();');
  await waitReady();
  report.emptyMeta = await evaluate('document.getElementById("lbMeta").textContent');
  need(report.emptyMeta === '还没有记录', '空榜文案不对：' + report.emptyMeta);
  await click('#btnOpenBoard');
  await sleep(350);
  report.emptyBoardShown = await evaluate('document.getElementById("ovBoard").classList.contains("show")');
  report.emptyRows = await evaluate('document.querySelectorAll("#boardList .bl-row").length');
  report.emptyHint = await evaluate('!document.getElementById("boardEmpty").hidden');
  need(report.emptyBoardShown && report.emptyRows === 0 && report.emptyHint, '空榜状态不对');
  await shot('01-board-empty.png');
  await click('#btnBoardClose');
  await sleep(300);
  report.backToStart = await evaluate('document.getElementById("ovStart").classList.contains("show")');
  need(report.backToStart, '关掉排行榜应该回到开始页');

  /* ---------- 2. 有历史：三个榜 + 名字归属 ---------- */
  const now = Date.now();
  const seed = [
    { id: 'a', name: '奶蛙', score: 5200, level: 4, comboBest: 6, ts: now - 500000, preset: 'standard', named: true, avatar: 'dog' },
    { id: 'b', name: '老王', score: 9100, level: 6, comboBest: 9, ts: now - 400000, preset: 'standard', named: true, avatar: 'god' },
    { id: 'c', name: '小美', score: 7400, level: 9, comboBest: 5, ts: now - 300000, preset: 'hard', named: true, avatar: 'laugh' },
    { id: 'd', name: '奶蛙矿工', score: 2600, level: 2, comboBest: 14, ts: now - 200000, preset: 'standard', named: false },
    { id: 'e', name: '奶蛙矿工', score: 1500, level: 3, comboBest: 3, ts: now - 100000, preset: 'relaxed', named: false },
    { id: 'f', name: '奶蛙矿工', score: 880, level: 1, comboBest: 2, ts: now - 50000, preset: 'standard', named: false },
  ];
  /* 模拟"新设备导入别人的存档"：头像键也清掉，否则第 1 步空榜时已经分好脸了 */
  await evaluate(`localStorage.setItem('naiwa_miner_board_v1', ${JSON.stringify(JSON.stringify(seed))});
    localStorage.removeItem('naiwa_miner_avatar'); location.reload();`);
  await waitReady();
  report.seededMeta = await evaluate('document.getElementById("lbMeta").textContent');
  need(report.seededMeta.indexOf('共 6 条') === 0, '入口文案没算对：' + report.seededMeta);
  need(report.seededMeta.indexOf('老王') > 0, '入口应该报第一名：' + report.seededMeta);

  await click('#btnOpenBoard');
  await sleep(350);
  const firstBy = async (key) => {
    await click(`#boardTabs button[data-board="${key}"]`);
    await sleep(200);
    return evaluate(`(() => {
      const r = document.querySelector('#boardList .bl-row');
      return { name: r.querySelector('.bl-who b').textContent, val: r.querySelector('.bl-val').textContent };
    })()`);
  };
  report.scoreTop = await firstBy('score');
  need(report.scoreTop.name === '老王' && report.scoreTop.val.indexOf('9,100') === 0, '总分榜第一不对');
  await shot('02-board-score.png');

  /* 头像：每行一张、真的加载出来、同名同脸 */
  report.avatars = await evaluate(`(() => {
    return [...document.querySelectorAll('#boardList .bl-row')].map(r => {
      const ava = r.querySelector('.bl-ava');
      const img = ava && ava.querySelector('img');
      return {
        name: r.querySelector('.bl-who b').textContent,
        has: !!img,
        loaded: !!(img && img.naturalWidth > 0),
        src: img ? img.getAttribute('src') : '',
        tint: ava ? getComputedStyle(ava).getPropertyValue('--ava-tint').trim() : '',
      };
    });
  })()`);
  need(report.avatars.length === 6, '六条记录都要有头像行');
  need(report.avatars.every((a) => a.has && a.loaded), '每行头像都得真的加载出来');
  need(report.avatars.every((a) => /^\.\.\/assets\/nai\/nai\d\d-[a-z]+\.webp$/.test(a.src)),
    '头像路径不对：' + JSON.stringify(report.avatars.map((a) => a.src)));
  need(report.avatars.every((a) => /^#/.test(a.tint)), '圆底 tint 丢了：' + JSON.stringify(report.avatars.map((a) => a.tint)));
  const miners = report.avatars.filter((a) => a.name === '奶蛙矿工');
  need(miners.length === 3 && miners.every((a) => a.src === miners[0].src), '同名必须同一张脸');
  const topAva = report.avatars.filter((a) => a.name === '老王')[0];
  need(topAva.src.indexOf('nai11-god') >= 0, '老王的头像应该照存档里的 god，实际 ' + topAva.src);

  report.levelTop = await firstBy('level');
  need(report.levelTop.name === '小美' && report.levelTop.val.indexOf('9') === 0, '关卡榜第一不对');
  await shot('03-board-level.png');

  report.comboTop = await firstBy('combo');
  need(report.comboTop.name === '奶蛙矿工' && report.comboTop.val.indexOf('14') === 0, '连击榜第一不对');

  // 起名：只认领未署名的三条，别人的名字不许动
  await click('#boardNameInput');
  await send('Input.insertText', { text: '奶蛙王' });
  await click('.ov-title.board');            // 点空白处失焦 → change 才会触发
  await sleep(300);
  report.afterName = await evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('naiwa_miner_board_v1'));
    const mine = raw.filter(r => r.name === '奶蛙王').length;
    return { name: localStorage.getItem('naiwa_miner_name'), mine,
             others: raw.filter(r => ['老王', '小美', '奶蛙'].indexOf(r.name) >= 0).length };
  })()`);
  need(report.afterName.name === '奶蛙王', '名字没落盘');
  need(report.afterName.mine === 3, '未署名的三条应该被认领，实际 ' + report.afterName.mine);
  need(report.afterName.others === 3, '别人的名字不该被改掉');

  /* 留名 = 认领，也是"把脸定下来"的时刻 */
  report.nameAvatar = await evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('naiwa_miner_board_v1'));
    const mine = raw.filter(r => r.name === '奶蛙王');
    const otherUsed = ['dog', 'god', 'laugh'];
    return {
      stored: localStorage.getItem('naiwa_miner_avatar'),
      mine: mine.map(r => r.avatar),
      otherUsed,
      live: window.__miner.avatar,
      onStartLine: (() => {
        const img = document.querySelector('#boardAva img');
        return img ? img.getAttribute('src') : '';
      })(),
    };
  })()`);
  need(!!report.nameAvatar.stored, '头像应该落盘到 localStorage');
  need(report.nameAvatar.live === report.nameAvatar.stored, '内存里的那一枚应该就是落盘的那一枚');
  need(report.nameAvatar.mine.every((k) => k === report.nameAvatar.stored),
    '认领之后同一人只能有一张脸：' + JSON.stringify(report.nameAvatar.mine));
  need(report.nameAvatar.otherUsed.indexOf(report.nameAvatar.stored) < 0,
    '随机分配应该避开榜上已经被别人用掉的脸，实际分到 ' + report.nameAvatar.stored);
  need(report.nameAvatar.onStartLine.indexOf('-' + report.nameAvatar.stored + '.webp') > 0,
    '名字行左边的头像跟实际分配不一致：' + report.nameAvatar.onStartLine);
  await shot('04-board-named.png');

  // 空名字要被挡住
  await click('#boardNameInput');
  await evaluate('document.getElementById("boardNameInput").select()');
  await send('Input.insertText', { text: '   ' });   // 全空格：清洗之后就是空名字
  await click('.ov-title.board');
  await sleep(300);
  report.blankRejected = {
    note: await evaluate('document.getElementById("boardNameNote").textContent'),
    stored: await evaluate('localStorage.getItem("naiwa_miner_name")'),
  };
  need(report.blankRejected.note === '名字不能空着', '空名字应该被拒绝提示');
  need(report.blankRejected.stored === '奶蛙王', '空名字不该覆盖掉已有名字');

  await click('#btnBoardClose');
  await sleep(300);

  /* ---------- 3. 已署名玩家结算 ---------- */
  await click('#btnStart');
  await sleep(900);
  report.afterStartClick = await evaluate(`(() => {
    const g = window.__miner.game;
    return { phase: g.phase, startShown: document.getElementById('ovStart').classList.contains('show'),
             timeLeft: +g.timeLeft.toFixed(1), btnText: document.getElementById('btnStart').textContent };
  })()`);
  await evaluate(`(() => { const g = window.__miner.game; g.score = 12000; g.target = 15000; g.level = 7; g.comboBest = 5; g.timeLeft = 0.04; })()`);
  await sleep(900);
  report.forcedProbe = await evaluate(`(() => {
    const g = window.__miner.game;
    const ovs = [...document.querySelectorAll('.overlay.show')].map(e => e.id);
    return { timeLeft: +g.timeLeft.toFixed(2), phase: g.phase, ovs, score: g.score,
             raf: typeof requestAnimationFrame };
  })()`);
  report.namedFail = await evaluate(`(() => ({
    over: document.getElementById('ovOver').classList.contains('show'),
    badge: document.getElementById('overRankBadge').textContent,
    rankTxt: document.getElementById('overRankTxt').innerText.replace(/\\s+/g, ' ').trim(),
    nameRowHidden: document.getElementById('overNameRow').hidden,
    hint: document.getElementById('overNameHint').innerText.trim(),
    podium: document.getElementById('overLb').classList.contains('podium'),
    rows: window.__miner.board.length,
  }))()`);
  need(report.namedFail.over, '应该进结算面板');
  need(report.namedFail.badge === '#1', '12000 分应该第一，实际 ' + report.namedFail.badge);
  need(report.namedFail.nameRowHidden, '已署名玩家不该再弹起名框');
  need(report.namedFail.hint.indexOf('奶蛙王') >= 0, '结算卡应该显示用哪个名字上榜');
  need(report.namedFail.podium, '第一名应该有种领奖台样式');
  await shot('05-over-named.png');

  await click('#btnOverBoard');
  await sleep(350);
  report.meRow = await evaluate(`(() => {
    const me = document.querySelector('#boardList .bl-row.me');
    return { shown: document.getElementById('ovBoard').classList.contains('show'),
             found: !!me, name: me ? me.querySelector('.bl-who b').textContent : '' };
  })()`);
  need(report.meRow.shown && report.meRow.found, '从结算卡打开的榜要能高亮刚打的那条');
  await shot('06-board-from-over.png');
  await click('#btnBoardClose');
  await sleep(300);
  report.backToOver = await evaluate('document.getElementById("ovOver").classList.contains("show")');
  need(report.backToOver, '从结算卡进榜，关掉要回结算卡，不能直接回开始页');

  /* ---------- 4. 新玩家：在结算卡上留名 ---------- */
  await evaluate('localStorage.clear(); location.reload();');
  await waitReady();
  await click('#btnStart');
  await sleep(900);
  await evaluate(`(() => { const g = window.__miner.game; g.score = 3000; g.target = 9999; g.level = 2; g.comboBest = 4; g.timeLeft = 0.04; })()`);
  await sleep(900);
  report.newPlayer = await evaluate(`(() => ({
    badge: document.getElementById('overRankBadge').textContent,
    nameRowHidden: document.getElementById('overNameRow').hidden,
    placeholder: document.getElementById('overNameInput').placeholder,
    hint: document.getElementById('overNameHint').innerText.trim(),
  }))()`);
  need(!report.newPlayer.nameRowHidden, '新玩家应该在结算卡上看到起名框');
  need(report.newPlayer.badge === '#1', '榜首应该是新玩家');

  report.newPlayerAva = await evaluate(`(() => {
    const img = document.querySelector('#overAva img');
    const slot = document.getElementById('overAva');
    return {
      src: img ? img.getAttribute('src') : '',
      loaded: !!(img && img.naturalWidth > 0),
      w: slot ? Math.round(slot.getBoundingClientRect().width) : 0,
      stored: localStorage.getItem('naiwa_miner_avatar'),
    };
  })()`);
  need(report.newPlayerAva.loaded, '结算卡上的头像没加载出来');
  need(report.newPlayerAva.w > 12, '结算卡头像被压没了，实际宽 ' + report.newPlayerAva.w + 'px');
  need(report.newPlayerAva.src.indexOf('-' + report.newPlayerAva.stored + '.webp') > 0,
    '结算卡上的脸和本机分配的不一致：' + report.newPlayerAva.src);
  await shot('07-over-newcomer.png');

  await click('#overNameInput');
  await send('Input.insertText', { text: '小王' });
  await click('#btnSaveName');
  await sleep(400);
  report.afterSubmit = await evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('naiwa_miner_board_v1'));
    return {
      nameRowHidden: document.getElementById('overNameRow').hidden,
      hint: document.getElementById('overNameHint').innerText.trim(),
      stored: localStorage.getItem('naiwa_miner_name'),
      recName: raw[0].name,
      named: raw[0].named,
    };
  })()`);
  need(report.afterSubmit.nameRowHidden, '留名之后起名框应该收起');
  need(report.afterSubmit.stored === '小王', '名字没落盘');
  need(report.afterSubmit.recName === '小王' && report.afterSubmit.named === true, '记录没跟着改名');
  await shot('08-over-signed.png');

  /* ---------- 5. 刷新之后还在 ---------- */
  await evaluate('location.reload();');
  await waitReady();
  report.afterReload = {
    meta: await evaluate('document.getElementById("lbMeta").textContent'),
    name: await evaluate('window.__miner.name'),
  };
  need(report.afterReload.name === '小王', '刷新后名字应该还在');
  need(report.afterReload.meta.indexOf('小王') > 0, '刷新后入口应该报小王');
  await click('#btnOpenBoard');
  await sleep(350);
  report.persistedRow = await evaluate(`(() => {
    const r = document.querySelector('#boardList .bl-row');
    return { name: r.querySelector('.bl-who b').textContent, val: r.querySelector('.bl-val').textContent };
  })()`);
  need(report.persistedRow.name === '小王' && report.persistedRow.val.indexOf('3,000') === 0, '刷新后榜单内容不对');

  /* 刷新一次就换脸的话，玩家会以为榜被别人顶了 */
  report.avaAfterReload = await evaluate(`(() => {
    const img = document.querySelector('#boardList .bl-ava img');
    return { src: img ? img.getAttribute('src') : '', stored: localStorage.getItem('naiwa_miner_avatar') };
  })()`);
  need(report.avaAfterReload.src.indexOf('-' + report.avaAfterReload.stored + '.webp') > 0,
    '刷新之后头像换了：' + JSON.stringify(report.avaAfterReload));
  await shot('09-board-persisted.png');

  // 改名要连带改掉"自己的"记录
  await click('#boardNameInput');
  await evaluate('document.getElementById("boardNameInput").select()');
  await send('Input.insertText', { text: '大王' });
  await click('.ov-title.board');
  await sleep(350);
  report.rename = await evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('naiwa_miner_board_v1'));
    return { stored: localStorage.getItem('naiwa_miner_name'), rec: raw[0].name,
             ava: raw[0].avatar, avaStored: localStorage.getItem('naiwa_miner_avatar') };
  })()`);
  need(report.rename.stored === '大王' && report.rename.rec === '大王', '改名后历史记录应该跟着改');
  need(report.rename.ava === report.rename.avaStored, '改名不该换脸');
  await shot('10-board-renamed.png');

  /* ---------- 6. 中途退出也要留档 ---------- */
  await click('#btnBoardClose');
  await sleep(250);
  await click('#btnStart');
  await sleep(700);
  await evaluate(`(() => { const g = window.__miner.game; g.score = 4321; g.level = 3; g.comboBest = 2; })()`);
  await evaluate('Object.defineProperty(document,"hidden",{value:true,configurable:true}); document.dispatchEvent(new Event("visibilitychange"));');
  await sleep(350);
  report.pauseShown = await evaluate('document.getElementById("ovPause").classList.contains("show")');
  await click('#btnQuit');
  await sleep(500);
  report.quitRecord = await evaluate(`(() => {
    const raw = window.__miner.board;
    const last = raw.filter(r => r.outcome === 'quit');
    return { count: raw.length, quit: last.length,
             score: last.length ? last[0].score : 0,
             meta: document.getElementById('lbMeta').textContent,
             onStart: document.getElementById('ovStart').classList.contains('show') };
  })()`);
  need(report.pauseShown, '暂停浮层没弹出来');
  need(report.quitRecord.quit === 1, '中途退出应该留一条 outcome=quit 的记录');
  need(report.quitRecord.score === 4321, '退出局的分没记对');
  need(report.quitRecord.onStart, '退出应该回到开始页');
  await shot('11-start-after-quit.png');

  fs.writeFileSync(path.join(OUTDIR, 'board-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('\n================ 问题 ================');
  console.log(problems.length ? problems.join('\n') : '未发现报错 ✓');
  cleanup(problems.length ? 2 : 0);
} catch (err) {
  report._中断 = err && err.message ? err.message : String(err);
  try { fs.writeFileSync(path.join(OUTDIR, 'board-report.json'), JSON.stringify(report, null, 2)); } catch (e) { /* ignore */ }
  try { await shot('99-fail.png'); } catch (e) { /* ignore */ }
  console.error('QA 中断:', report._中断);
  console.error(JSON.stringify(report, null, 2));
  console.log('已采集到的问题:\n' + (problems.join('\n') || '无'));
  cleanup(3);
}
