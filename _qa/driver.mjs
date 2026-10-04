/* 本地 QA：用 CDP 驱动无头 Chrome，走一遍真实用户流程
 * 采集：控制台报错 / 未捕获异常 / 截图 / 游戏状态
 * 零依赖，用 Node 22 内置的 WebSocket。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const TARGET = process.argv[2] || 'http://127.0.0.1:8137/miner/';
const OUTDIR = process.argv[3] || '.';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-qa-'));
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

const wsUrl = await waitDevtools();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const problems = [];
const consoleLines = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems.push('未捕获异常: ' + (d.exception?.description || d.text) +
      '  @' + (d.url || '') + ':' + d.lineNumber);
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error') { problems.push('日志错误: ' + e.text + ' @' + (e.url || '')); }
    else if (e.level === 'warning') { consoleLines.push('警告: ' + e.text); }
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLines.push(m.params.type + ': ' + txt);
    if (m.params.type === 'error') { problems.push('console.error: ' + txt); }
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
  const p = path.join(OUTDIR, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function clickSelector(sel) {
  const box = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (!box) { throw new Error('找不到元素: ' + sel); }
  await clickAt(box.x, box.y);
  return box;
}

try {
  const report = {};

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 420, height: 880, deviceScaleFactor: 2, mobile: true });

  const nav = await send('Page.navigate', { url: TARGET });
  await sleep(2600);

  report.title = await evaluate('document.title');
  report.legendItems = await evaluate('document.querySelectorAll("#legend li").length');
  report.legendSample = await evaluate(
    '[...document.querySelectorAll("#legend li")].map(li => li.querySelector("b").textContent + " " + li.querySelector("small").textContent).join(" | ")');
  report.startOverlayVisible = await evaluate('document.getElementById("ovStart").classList.contains("show")');
  report.startBtnText = await evaluate('document.getElementById("btnStart").textContent');
  report.imagesLoaded = await evaluate(
    '[...document.images].every(i => i.complete && i.naturalWidth > 0)');
  report.brokenImages = await evaluate(
    '[...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute("src")).join(", ") || "无"');
  report.stageBox = await evaluate(`(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width/r.height).toFixed(4) };
  })()`);
  report.canvasSize = await evaluate('(() => { const c = document.getElementById("cv"); return { w: c.width, h: c.height }; })()');
  await shot('01-start.png');

  // —— 真实点击「开始挖矿」 ——
  await clickSelector('#btnStart');
  await sleep(1200);
  report.afterStart = await evaluate(`(() => {
    const g = window.__miner.game;
    return g ? { phase: g.phase, level: g.level, items: g.items.length, target: g.target,
                 timeLeft: +g.timeLeft.toFixed(1), score: g.score } : null;
  })()`);
  report.startOverlayHidden = await evaluate('!document.getElementById("ovStart").classList.contains("show")');
  await shot('02-playing.png');

  // —— 模拟玩家：随机节奏点击 18 次（固定节奏会跟摆周期发生采样混叠，不真实） ——
  const c = await evaluate(`(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height*0.72 };
  })()`);
  const gaps = [900, 1450, 780, 1720, 1080, 1620, 830, 1340, 1980, 960,
                1520, 1120, 1260, 890, 1680, 1040, 1450, 1180];
  for (const g of gaps) { await clickAt(c.x, c.y); await sleep(g); }

  report.afterShots = await evaluate(`(() => {
    const g = window.__miner.game;
    return { phase: g.phase, score: g.score, combo: g.combo, comboBest: g.comboBest,
             shots: g.shots, hits: g.hits, escapes: g.escapes, angels: g.angels,
             grabbedLeft: g.items.filter(i => i.grabbed).length,
             hudScore: document.getElementById("hudScore").textContent,
             hudTime: document.getElementById("hudTime").textContent,
             barWidth: document.getElementById("barFill").style.width };
  })()`);
  await shot('03-after-shots.png');

  // —— 手感档位切换 ——
  await evaluate('document.getElementById("btnQuit") && null');
  report.presetButtons = await evaluate('document.querySelectorAll("#preset button").length');

  // —— 触发结算：把分数改到刚好不够，逼出 gameOver ——
  report.forcedEnd = await evaluate(`(() => {
    const g = window.__miner.game;
    g.score = 0; g.timeLeft = 0.05;
    return true;
  })()`);
  await sleep(900);
  report.gameOverOverlay = await evaluate('document.getElementById("ovOver").classList.contains("show")');
  report.gameOverText = await evaluate('document.getElementById("overSub").innerText.replace(/\\s+/g," ").trim()');
  report.tallyRows = await evaluate('document.querySelectorAll("#overTally span").length');
  report.bestLine = await evaluate('document.getElementById("overBest").innerText.trim()');
  await shot('04-gameover.png');

  // —— 再来一局 ——
  await clickSelector('#btnAgain');
  await sleep(800);
  report.restarted = await evaluate(`(() => {
    const g = window.__miner.game;
    return { phase: g.phase, level: g.level, score: g.score, items: g.items.length,
             overHidden: !document.getElementById("ovOver").classList.contains("show") };
  })()`);

  // —— 过关流程 ——
  report.levelClear = await evaluate(`(() => {
    const g = window.__miner.game;
    g.score = g.target; g.timeLeft = 0.05;
    return g.target;
  })()`);
  await sleep(900);
  report.clearOverlay = await evaluate('document.getElementById("ovClear").classList.contains("show")');
  report.clearBtnText = await evaluate('document.getElementById("btnNext").textContent');
  await shot('05-levelclear.png');
  await clickSelector('#btnNext');
  await sleep(700);
  report.level2 = await evaluate(`(() => {
    const g = window.__miner.game;
    return { phase: g.phase, level: g.level, items: g.items.length, target: g.target,
             score: g.score, timeLeft: +g.timeLeft.toFixed(1),
             clearHidden: !document.getElementById("ovClear").classList.contains("show") };
  })()`);
  // 第 2 关起有"会爬的目标"，单独留一张图看渲染
  await sleep(500);
  await shot('08-level2.png');
  report.movers = await evaluate(`(() => {
    const g = window.__miner.game;
    const mv = g.items.filter((it) => it.moving);
    return { 会爬的数量: mv.length, 类型: mv.map((it) => it.type),
             速度: mv.length ? +mv[0].moveSpeed.toFixed(1) : 0,
             石头数: g.items.filter((it) => it.isStone).length,
             炸弹数: g.items.filter((it) => it.isAngel).length };
  })()`);

  // —— 炸药：手里拉着东西时按按钮，东西当场消失、不给分不涨连击 ——
  report.dynamite = await evaluate(`(() => {
    const g = window.__miner.game;
    g.phase = 'pulling';
    const it = g.items.find(t => !t.removed && !t.isAngel) || g.items[0];
    it.grabbed = true; g.held = it; g.ropeLen = 420; g.hook = { x: it.x, y: it.y };
    const before = { dyn: g.dynamite, score: g.score, combo: g.combo, type: it.type };
    const ev = window.MinerLogic.blowUp(g);
    return {
      炸的是: before.type,
      炸药: before.dyn + ' → ' + g.dynamite,
      分数不变: g.score === before.score,
      连击不变: g.combo === before.combo,
      手里空了: !g.held,
      东西没了: it.removed,
      事件: ev.map(e => e.type).join(','),
    };
  })()`);
  await sleep(600);
  await shot('09-dynamite.png');

  // —— 小卖部：第 3 关起才出现 ——
  report.shop = await evaluate(`(() => {
    const g = window.__miner.game;
    g.level = 3; g.score = g.target + 2600; g.timeLeft = 0.05;
    return { 强推到第: g.level, 分数: g.score, 门槛: g.target };
  })()`);
  await sleep(900);
  report.shopBtnText = await evaluate('document.getElementById("btnNext").textContent');
  await clickSelector('#btnNext');
  await sleep(600);
  report.shopOverlay = await evaluate('document.getElementById("ovShop").classList.contains("show")');
  report.shopView = await evaluate(`(() => {
    const v = window.MinerLogic.shopView(window.__miner.game);
    return {
      商品: v.items.map(x => x.name + ' ¥' + x.price),
      能动用: v.budget,
      都能买: v.items.every(x => x.canBuy),
      下一关炸药: v.nextDynamite,
    };
  })()`);
  await shot('10-shop.png');

  // 买一发炸药：分数应该扣掉，paused/pending 应该记上
  const beforeBuy = await evaluate('window.__miner.game.score');
  await evaluate('document.querySelector("#shopList button[data-buy=\\"dynamite\\"]").click()');
  await sleep(300);
  report.buyDynamite = await evaluate(`(() => {
    const g = window.__miner.game;
    return { 扣了: ${beforeBuy} - g.score, pending: JSON.stringify(g.pending), 花费: g.shopSpent,
             下一关炸药: window.MinerLogic.shopView(g).nextDynamite };
  })()`);
  await shot('11-shop-bought.png');

  // 出发 → 第 4 关，buff 应该生效
  await clickSelector('#btnShopGo');
  await sleep(700);
  report.buffApplied = await evaluate(`(() => {
    const g = window.__miner.game;
    return { 关卡: g.level, buffs: JSON.stringify(g.buffs), pending: JSON.stringify(g.pending),
             炸药: g.dynamite, 摆动周期: +g.cfg.SWING_PERIOD.toFixed(2) };
  })()`);
  await shot('12-level4.png');

  // 再过一关 → buff 必须消失（只顶一关），炸药回到基础配发
  await evaluate(`(() => { const g = window.__miner.game; g.score = g.target; g.timeLeft = 0.05; })()`);
  await sleep(900);
  await clickSelector('#btnNext');      // 第 4 关起有小卖部，这一步进小卖部
  await sleep(500);
  await clickSelector('#btnShopGo');    // 直接出发
  await sleep(700);
  report.buffCleared = await evaluate(`(() => {
    const g = window.__miner.game;
    return { 关卡: g.level, buffs: JSON.stringify(g.buffs), 炸药: g.dynamite,
             石头面值: (g.items.find(i => i.isStone) || {}).value };
  })()`);

  // —— 收工：达标之后提前结束这一关（玩家反馈"达标就只能干等"的结构性解法）——
  // 先验"锁住"态：分数够门槛、但本关一分没赚（吃老本）→ 不该解锁
  report.cashLocked = await evaluate(`(() => {
    const g = window.__miner.game;
    g.score = g.target + 5000;
    g.levelStartScore = g.score;        // 本关一分没赚
    return { canCashOut: window.MinerLogic.canCashOut(g),
             gap: window.MinerLogic.cashOutGap(g),
             quota: g.levelQuota };
  })()`);
  await sleep(300);
  report.cashLockedChip = await evaluate(`(() => {
    const e = document.getElementById("keepHint");
    return { 出现: e.classList.contains("show"), 锁住: e.classList.contains("locked"),
             文案: e.innerText.replace(/\\s+/g, " ").trim() };
  })()`);
  await shot('13a-cashout-locked.png');
  await clickSelector('#keepHint');
  await sleep(400);
  report.cashLockedNoop = await evaluate(
    'window.__miner.game.phase !== "levelClear" && !document.getElementById("ovClear").classList.contains("show")');

  // 再验"解锁"态：门槛够 + 本关的活儿也干完了
  report.cashHintBefore = await evaluate(
    'document.getElementById("keepHint").classList.contains("show")');
  report.cashOut = await evaluate(`(() => {
    const g = window.__miner.game;
    g.score = g.target + 777;
    g.levelStartScore = g.score - g.levelQuota - 10;   // 本关已赚够配额
    return { 达标: g.score >= g.target, 时间: +g.timeLeft.toFixed(1),
             canCashOut: window.MinerLogic.canCashOut(g) };
  })()`);
  await sleep(300);
  report.cashHintAfter = await evaluate(`(() => ({
    出现: document.getElementById("keepHint").classList.contains("show"),
    文案: document.getElementById("keepHint").innerText.replace(/\\s+/g, " ").trim(),
    按钮文案: document.getElementById("keepGo").textContent,
    结余: document.getElementById("keepNum").textContent,
  }))()`);
  await shot('13-cashout-ready.png');
  await clickSelector('#keepHint');
  await sleep(700);
  report.cashOutDone = await evaluate(`(() => {
    const g = window.__miner.game;
    return {
      过关面板: document.getElementById("ovClear").classList.contains("show"),
      标题: document.getElementById("clearTitle").textContent,
      说明: document.getElementById("clearSub").innerText.replace(/\\s+/g, " ").trim(),
      相位: g.phase,
      结余: g.score - g.target,
      提示已收起: !document.getElementById("keepHint").classList.contains("show"),
    };
  })()`);
  await shot('14-cashout-done.png');
  // 关面板 → 下一关，检查收工之后流程仍然正常
  await clickSelector('#btnNext');
  await sleep(600);
  await evaluate('document.querySelector("#ovShop.show") && document.getElementById("btnShopGo").click()');
  await sleep(600);

  // —— PC 横屏：同一份代码，窗口一宽就该换成横屏布局 ——
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 820, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: TARGET });
  await sleep(2200);
  report.pcLayout = await evaluate(`(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    const g = window.__miner.game;
    return {
      识别为: window.__miner.layout,
      舞台: Math.round(r.width) + '×' + Math.round(r.height),
      宽高比: +(r.width / r.height).toFixed(3),
      世界尺寸: g.cfg.WORLD_W + '×' + g.cfg.WORLD_H,
      字号: getComputedStyle(document.getElementById("stage")).fontSize,
      图例列数: new Set([...document.querySelectorAll("#legend li")]
        .map(li => Math.round(li.getBoundingClientRect().top))).size,
    };
  })()`);
  await shot('15-pc-landscape.png');
  // 窄窗口应该回到竖屏
  await send('Emulation.setDeviceMetricsOverride',
    { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  report.pcNarrow = await evaluate(`(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return { 识别为: window.__miner.layout, 宽高比: +(r.width / r.height).toFixed(3) };
  })()`);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 420, height: 880, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: TARGET });
  await sleep(1600);

  // —— 暂停（模拟切标签页） ——
  await evaluate('Object.defineProperty(document,"hidden",{value:true,configurable:true}); document.dispatchEvent(new Event("visibilitychange"));');
  await sleep(400);
  report.pauseOverlay = await evaluate('document.getElementById("ovPause").classList.contains("show")');
  await shot('06-pause.png');
  await evaluate('Object.defineProperty(document,"hidden",{value:false,configurable:true}); document.dispatchEvent(new Event("visibilitychange"));');
  await clickSelector('#btnResume');
  await sleep(400);
  report.resumed = await evaluate('!document.getElementById("ovPause").classList.contains("show")');

  // —— 首页 ——
  await send('Page.navigate', { url: TARGET.replace(/miner\/?$/, '') });
  await sleep(1600);
  report.hub = await evaluate(`(() => ({
    cards: document.querySelectorAll(".card").length,
    playable: document.querySelectorAll("a.card").length,
    soon: document.querySelectorAll(".card.soon").length,
    broken: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).length,
  }))()`);
  await shot('07-hub.png');

  fs.writeFileSync(path.join(OUTDIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  console.log('\n================ 控制台 ================');
  console.log(consoleLines.length ? consoleLines.join('\n') : '(无输出)');
  console.log('\n================ 问题 ================');
  console.log(problems.length ? problems.join('\n') : '未发现报错 ✓');

  cleanup(problems.length ? 2 : 0);
} catch (err) {
  console.error('QA 中断:', err && err.message ? err.message : err);
  console.log('已采集到的问题:\n' + (problems.join('\n') || '无'));
  cleanup(3);
}
