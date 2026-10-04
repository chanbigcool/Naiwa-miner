/*
 * 奶蛙矿工 · 画面与交互层
 * ---------------------------------------------------------------------------
 * 这一层只做两件事：
 *   1. 把 state 画出来（Canvas）
 *   2. 把"按下"翻译成 MinerLogic.shoot / blowUp / buy
 * 任何规则（摆动多少、抓到了给几分、能不能挣脱、小卖部多少钱）都不在这里。
 * 详见 logic.js 顶部注释。
 *
 * 竖屏 / 横屏两套布局都在 logic.js 的 LAYOUTS 里，这里只负责"按窗口方向挑一套"，
 * 方向变了就调 L.relayout() 让逻辑层换场地（分数、目标、剩余时间都保留）。
 */
(function () {
  'use strict';

  var L = window.MinerLogic;
  if (!L) { console.error('[miner] 缺少 logic.js'); return; }
  var SFX = window.NaiSFX || null;

  /* ============================ 当前布局 ============================ */
  /* W/H/C 不是常量：换布局时会变。所有绘制都从这三个走，别直接读 L.CONFIG。 */
  var W = 0, H = 0, C = null;

  /* ============================ DOM ============================ */
  var stage = document.getElementById('stage');
  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');

  var el = {
    score: document.getElementById('hudScore'),
    target: document.getElementById('hudTarget'),
    level: document.getElementById('hudLevel'),
    time: document.getElementById('hudTime'),
    bar: document.getElementById('barFill'),
    combo: document.getElementById('comboChip'),
    comboNum: document.getElementById('comboNum'),
    comboMult: document.getElementById('comboMult'),
    keep: document.getElementById('keepHint'),
    keepNum: document.getElementById('keepNum'),
    keepGo: document.getElementById('keepGo'),
    mute: document.getElementById('btnMute'),
    dyn: document.getElementById('btnDyn'),
    dynNum: document.getElementById('dynNum'),
    dynTip: document.getElementById('dynTip'),
    timeStat: document.querySelector('.stat.time'),

    ovStart: document.getElementById('ovStart'),
    ovPause: document.getElementById('ovPause'),
    ovClear: document.getElementById('ovClear'),
    ovOver: document.getElementById('ovOver'),
    ovShop: document.getElementById('ovShop'),

    btnStart: document.getElementById('btnStart'),
    btnResume: document.getElementById('btnResume'),
    btnQuit: document.getElementById('btnQuit'),
    btnNext: document.getElementById('btnNext'),
    btnAgain: document.getElementById('btnAgain'),
    btnShopGo: document.getElementById('btnShopGo'),

    legend: document.getElementById('legend'),
    preset: document.getElementById('preset'),
    bestScore: document.getElementById('bestScore'),
    bestLevel: document.getElementById('bestLevel'),
    clearSub: document.getElementById('clearSub'),
    clearTally: document.getElementById('clearTally'),
    clearTitle: document.getElementById('clearTitle'),
    overSub: document.getElementById('overSub'),
    overTally: document.getElementById('overTally'),
    overBest: document.getElementById('overBest'),

    shopSub: document.getElementById('shopSub'),
    shopWallet: document.getElementById('shopWallet'),
    shopTarget: document.getElementById('shopTarget'),
    shopBudget: document.getElementById('shopBudget'),
    shopList: document.getElementById('shopList'),
    shopSpent: document.getElementById('shopSpent'),
    shopDyn: document.getElementById('shopDyn'),
    swingNote: document.getElementById('swingNote'),
  };

  /* ============================ 状态 ============================ */
  var IMG = {};                       // 立绘缓存
  var pending = 0;
  var assetsReady = false;

  var game = null;                    // MinerLogic 的 state
  var paused = false;
  var preset = 'standard';
  var lastT = 0;
  var raf = 0;
  var parts = [];                     // 粒子（纯视觉）
  var flash = 0;                      // 全屏白闪（抓到钻石时）
  var bgGrads = null;
  var pebbles = null;                 // 土层颗粒（按布局缓存）
  var dynNope = 0;                    // 炸药按钮"空响"提示的剩余时间

  var BEST_KEY = 'naiwa_miner_best';
  var LV_KEY = 'naiwa_miner_bestlevel';

  /* ============================ 存档 ============================ */
  function loadNum(key, dflt) {
    try {
      var v = parseInt(localStorage.getItem(key), 10);
      return isFinite(v) && v >= 0 ? v : dflt;
    } catch (e) { return dflt; }
  }
  function saveNum(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (e) { /* 无痕模式等，忽略 */ }
  }

  var best = { score: loadNum(BEST_KEY, 0), level: loadNum(LV_KEY, 1) };

  /* ============================ 素材 ============================ */
  function preload() {
    var keys = Object.keys(L.ITEMS).filter(function (k) { return !!L.ITEMS[k].img; });
    keys.push('__miner__');
    pending = keys.length;
    keys.forEach(function (k) {
      var src = k === '__miner__' ? '../assets/nai/nai02-stand.webp'
                                 : '../assets/nai/' + L.ITEMS[k].img + '.webp';
      var im = new Image();
      im.onload = im.onerror = function () {
        pending -= 1;
        if (pending <= 0) { assetsReady = true; el.btnStart.textContent = '开始挖矿'; }
      };
      im.src = src;
      IMG[k] = im;
    });
  }

  /* ============================ 布局与尺寸 ============================ */

  /* 按窗口方向挑布局。留 1.15 的余量，免得正方窗口在两种布局之间反复横跳。 */
  function pickLayoutName() {
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    return (vw > vh * 1.15) ? 'landscape' : 'portrait';
  }

  function cacheFor(cfg) {
    C = cfg; W = cfg.WORLD_W; H = cfg.WORLD_H;
    bgGrads = null;
    pebbles = null;
  }

  function buildPebbles() {
    var rng = L._seededRng(20261004);
    var out = [];
    for (var i = 0; i < 54; i++) {
      out.push({
        x: C.FIELD_X * 0.4 + rng() * (W - C.FIELD_X * 0.8),
        y: C.FIELD_Y + 24 + rng() * (C.FIELD_H - 30),
        r: 2 + rng() * 8,
        a: 0.05 + rng() * 0.1,
        d: rng() < 0.5,
      });
    }
    return out;
  }

  function fit() {
    if (!game) { return; }

    var name = pickLayoutName();
    if (game.cfg.LAYOUT !== name) {
      L.relayout(game, name);
      parts = [];
      lastT = 0;                        // 丢掉换布局那一帧的时间差
    }
    cacheFor(game.cfg);

    /* 舞台宽高比跟着布局走（CSS 用这两个变量算 aspect-ratio 和高度上限） */
    stage.style.setProperty('--arw', W);
    stage.style.setProperty('--arh', H);

    var rect = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    var s = Math.min(w / W, h / H);          // 等比缩放，两侧留边
    ctx.setTransform(s, 0, 0, s, (w - W * s) / 2, (h - H * s) / 2);

    /* 舞台内的排版单位（em）。
     * 以前是 rect.width / 30 —— 那是按竖屏 720 宽调的，一换横屏（宽 1280）就变成巨大字号。
     * 现在按"舞台实际像素尺寸"取，跟布局无关，竖屏横屏都差不多大。 */
    var em = Math.min(rect.width / 30, rect.height / 42);
    stage.style.fontSize = Math.max(11, Math.min(26, em)) + 'px';

    bgGrads = null;
  }

  function grads() {
    if (bgGrads) { return bgGrads; }
    var sky = ctx.createLinearGradient(0, 0, 0, C.FIELD_Y);
    sky.addColorStop(0, '#ffd7a0');
    sky.addColorStop(0.55, '#ffeccb');
    sky.addColorStop(1, '#fff8ec');

    var dirt = ctx.createLinearGradient(0, C.FIELD_Y, 0, H);
    dirt.addColorStop(0, '#d9a468');
    dirt.addColorStop(0.42, '#bb7f48');
    dirt.addColorStop(1, '#7f5029');

    var grass = ctx.createLinearGradient(0, C.FIELD_Y - 16, 0, C.FIELD_Y + 4);
    grass.addColorStop(0, '#9ed471');
    grass.addColorStop(1, '#69a94a');

    bgGrads = { sky: sky, dirt: dirt, grass: grass };
    return bgGrads;
  }

  /* ============================ 绘制工具 ============================ */
  function rr(c, x, y, w, h, r) {
    var k = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + k, y);
    c.arcTo(x + w, y, x + w, y + h, k);
    c.arcTo(x + w, y + h, x, y + h, k);
    c.arcTo(x, y + h, x, y, k);
    c.arcTo(x, y, x + w, y, k);
    c.closePath();
  }

  function drawBg() {
    var g = grads();

    ctx.fillStyle = g.sky;
    ctx.fillRect(0, 0, W, C.FIELD_Y);

    // 远山（横屏更宽，山也铺得更开）
    ctx.fillStyle = 'rgba(201, 168, 116, .38)';
    ctx.beginPath();
    ctx.moveTo(-20, C.FIELD_Y);
    ctx.quadraticCurveTo(W * 0.18, C.FIELD_Y - 96, W * 0.42, C.FIELD_Y - 8);
    ctx.quadraticCurveTo(W * 0.60, C.FIELD_Y - 74, W + 20, C.FIELD_Y);
    ctx.closePath();
    ctx.fill();

    // 土层
    ctx.fillStyle = g.dirt;
    ctx.fillRect(0, C.FIELD_Y, W, H - C.FIELD_Y);

    // 土层里的层理（画成微微起伏的曲线，比直线自然）
    ctx.strokeStyle = 'rgba(255, 236, 200, .085)';
    ctx.lineWidth = 2.5;
    var lines = 7;
    for (var i = 1; i <= lines; i++) {
      var y = C.FIELD_Y + (C.FIELD_H / (lines + 1)) * i;
      var ph = i * 1.7;
      ctx.beginPath();
      ctx.moveTo(C.FIELD_X - 34, y);
      ctx.quadraticCurveTo(W / 2, y + Math.sin(ph) * 16 + 6, C.FIELD_X + C.FIELD_W + 34, y + 8);
      ctx.stroke();
    }

    // 碎石颗粒
    if (!pebbles) { pebbles = buildPebbles(); }
    for (var j = 0; j < pebbles.length; j++) {
      var p = pebbles[j];
      ctx.fillStyle = p.d ? 'rgba(90, 55, 28, ' + p.a + ')' : 'rgba(255, 232, 195, ' + p.a + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      ctx.fill();
    }

    // 草皮
    ctx.fillStyle = g.grass;
    ctx.fillRect(0, C.FIELD_Y - 15, W, 19);
    ctx.fillStyle = 'rgba(255, 255, 255, .18)';
    ctx.fillRect(0, C.FIELD_Y - 15, W, 4);
  }

  function drawMiner(t) {
    var bob = Math.sin(t * 2.1) * 1.6;              // 待机时的轻微起伏
    var size = C.MINER_SIZE;

    // 影子
    ctx.fillStyle = 'rgba(90, 55, 28, .2)';
    ctx.beginPath();
    ctx.ellipse(C.MINER_X, C.FIELD_Y + 2, size * 0.37, size * 0.078, 0, 0, 6.2832);
    ctx.fill();

    // 矿工本体：脚踩在土层表面
    var im = IMG.__miner__;
    if (im && im.complete && im.naturalWidth) {
      ctx.save();
      ctx.translate(C.MINER_X, C.FIELD_Y - 4 + bob);
      ctx.rotate(Math.sin(t * 1.35) * 0.035);
      ctx.drawImage(im, -size / 2, -size, size, size);
      ctx.restore();
    } else {
      ctx.fillStyle = '#f2c94c';
      ctx.beginPath();
      ctx.arc(C.MINER_X, C.FIELD_Y - size * 0.42 + bob, size * 0.33, 0, 6.2832);
      ctx.fill();
    }
  }

  /* 悬挂点上的绞盘。必须画在矿工之后、绳子之前，
   * 否则要么被奶蛙身体挡住，要么绳子像从空气里长出来。 */
  function drawWinch() {
    var k = C.MINER_SIZE / 168;                     // 跟着矿工一起缩放
    ctx.fillStyle = 'rgba(60, 38, 20, .45)';
    ctx.beginPath();
    ctx.arc(C.MINER_X, C.MINER_Y + 1.5 * k, 13 * k, 0, 6.2832);
    ctx.fill();

    ctx.fillStyle = '#6b4a2f';
    ctx.beginPath();
    ctx.arc(C.MINER_X, C.MINER_Y, 11.5 * k, 0, 6.2832);
    ctx.fill();

    ctx.fillStyle = '#a98055';
    ctx.beginPath();
    ctx.arc(C.MINER_X, C.MINER_Y, 6 * k, 0, 6.2832);
    ctx.fill();

    ctx.fillStyle = '#4a3325';
    ctx.beginPath();
    ctx.arc(C.MINER_X, C.MINER_Y, 2.4 * k, 0, 6.2832);
    ctx.fill();
  }

  function drawRope() {
    var h = game.hook;
    var k = C.MINER_SIZE / 168;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(48, 30, 14, .42)';
    ctx.lineWidth = 9 * k;
    ctx.beginPath();
    ctx.moveTo(C.MINER_X, C.MINER_Y);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();

    ctx.strokeStyle = '#8d6a45';
    ctx.lineWidth = 5 * k;
    ctx.beginPath();
    ctx.moveTo(C.MINER_X, C.MINER_Y);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 230, 195, .55)';
    ctx.lineWidth = 1.8 * k;
    ctx.beginPath();
    ctx.moveTo(C.MINER_X, C.MINER_Y);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();
  }

  function drawHook() {
    var h = game.hook;
    var s = 1.55 * (C.MINER_SIZE / 168);
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(game.angle * Math.PI / 180);
    ctx.scale(s, s);

    // 深色打底：保证钩子在土层、立绘上都能看清
    ctx.strokeStyle = 'rgba(48, 30, 14, .5)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-15, -6); ctx.quadraticCurveTo(-19, 12, -5, 17);
    ctx.moveTo(15, -6); ctx.quadraticCurveTo(19, 12, 5, 17);
    ctx.stroke();
    ctx.fillStyle = 'rgba(48, 30, 14, .5)';
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, 6.2832);
    ctx.fill();

    // 爪钩本体
    ctx.strokeStyle = '#5d636e';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-15, -6); ctx.quadraticCurveTo(-19, 12, -5, 17);
    ctx.moveTo(15, -6); ctx.quadraticCurveTo(19, 12, 5, 17);
    ctx.stroke();

    ctx.fillStyle = '#8a919d';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = '#c3c9d2';
    ctx.beginPath();
    ctx.arc(-2.6, -2.6, 3.6, 0, 6.2832);
    ctx.fill();
    ctx.restore();
  }

  /* 灰石堆：不占立绘，直接在代码里画 */
  function drawRock(it) {
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.fillStyle = 'rgba(60, 42, 26, .22)';
    ctx.beginPath();
    ctx.ellipse(0, it.r * 0.55, it.r * 0.9, it.r * 0.28, 0, 0, 6.2832);
    ctx.fill();

    var lumps = [
      [-0.45, 0.2, 0.56], [0.42, 0.24, 0.5], [0, -0.28, 0.62], [-0.08, 0.34, 0.54],
    ];
    for (var i = 0; i < lumps.length; i++) {
      var l = lumps[i];
      var g = ctx.createRadialGradient(
        l[0] * it.r * 0.6, l[1] * it.r - it.r * 0.35, it.r * 0.1,
        l[0] * it.r, l[1] * it.r, it.r * l[2] * 1.35);
      g.addColorStop(0, '#b9b3a6');
      g.addColorStop(1, '#6b6659');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l[0] * it.r, l[1] * it.r, it.r * l[2], 0, 6.2832);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, .16)';
    ctx.beginPath();
    ctx.ellipse(-it.r * 0.2, -it.r * 0.42, it.r * 0.3, it.r * 0.14, -0.4, 0, 6.2832);
    ctx.fill();
    ctx.restore();
  }

  function drawItem(it, t) {
    if (it.removed) { return; }

    if (it.isStone) { drawRock(it); return; }

    var wob = it.grabbed ? 0 : (it.wobble > 0 ? Math.sin(it.wobble * 40) * 4 * it.wobble : 0);

    /* "会爬的目标"（见 logic.js 的 MOVE_TYPES）在逻辑层只是慢速横向位移，
     * 基础速度只有 8~34 逻辑单位/秒 —— 光靠位移，玩家会以为是画面卡了。
     * 所以这里叠一层纯表现的小动作：上下颠 + 轻微摇摆，一眼就能看出"那个东西是活的"。
     * 相位按 it.id 错开，免得全场整齐划一地动。 */
    var bob = 0, rock = 0;
    if (it.moving && !it.grabbed) {
      var ph = (t || 0) * 6.5 + it.id * 1.7;
      bob = Math.sin(ph) * 3.4;
      rock = Math.sin(ph * 0.5) * 0.065;
    }

    ctx.save();
    ctx.translate(it.x + wob, it.y + bob);
    if (rock) { ctx.rotate(rock); }

    /* 炸弹（天使）：套一圈脉动的红色警示光晕。
     * 它是罚分项，不参与"越大越值钱"那套体型刻度；立绘又跟别的奶蛙一样是浅色系，
     * 在土里非常容易认错。这一圈光晕就是为了"别抓错" —— 不是彩色底板，只勾个边。 */
    if (it.isAngel) {
      var pulse = 0.5 + 0.5 * Math.sin((t || 0) * 4.2 + it.id);
      var rad = it.size * (0.50 + pulse * 0.08);
      var gg = ctx.createRadialGradient(0, 0, it.size * 0.26, 0, 0, rad);
      gg.addColorStop(0, 'rgba(255, 90, 90, 0)');
      gg.addColorStop(0.7, 'rgba(255, 72, 72, ' + (0.20 + pulse * 0.16).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(255, 72, 72, 0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, 6.2832);
      ctx.fill();

      ctx.strokeStyle = 'rgba(226, 72, 63, ' + (0.30 + pulse * 0.32).toFixed(3) + ')';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([9, 7]);
      ctx.lineDashOffset = -(t || 0) * 26;
      ctx.beginPath();
      ctx.arc(0, 0, it.size * 0.45, 0, 6.2832);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 只画本体：不再铺彩色底板。
     * 立绘本身是浅色，落在深棕土层上对比度已经够；
     * 只补一层很淡的落地影，让它"踩在土里"而不是浮着。
     * 注意：碰撞半径 it.r 一直是按立绘算的，去底板不改变判定。 */
    ctx.fillStyle = 'rgba(60, 42, 26, .17)';
    ctx.beginPath();
    ctx.ellipse(0, it.size * 0.40, it.size * 0.33, it.size * 0.095, 0, 0, 6.2832);
    ctx.fill();

    // 奶蛙立绘
    var im = IMG[it.type];
    if (im && im.complete && im.naturalWidth) {
      var s = it.size;
      ctx.drawImage(im, -s / 2, -s / 2 + it.size * 0.03, s, s);
    } else {
      ctx.fillStyle = 'rgba(240, 200, 90, .8)';
      ctx.beginPath();
      ctx.arc(0, 0, it.size * 0.4, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFloaters() {
    for (var i = 0; i < game.floaters.length; i++) {
      var f = game.floaters[i];
      var k = 1 - f.t / f.life;
      var col = f.kind === 'bad' ? '#e2483f' : (f.kind === 'great' ? '#e08a1e' : '#2f9b63');
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.7));
      ctx.font = '700 40px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(255, 255, 255, .95)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = col;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  /* ============================ 粒子 ============================ */
  function burst(x, y, n, colors, spread, life) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.2832;
      var v = spread * (0.35 + Math.random() * 0.65);
      parts.push({
        x: x, y: y,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - spread * 0.25,
        r: 3 + Math.random() * 6,
        c: colors[(Math.random() * colors.length) | 0],
        t: 0, life: (life || 0.6) * (0.6 + Math.random() * 0.7),
      });
    }
  }
  function updateParts(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 900 * dt;
      if (p.t >= p.life) { parts.splice(i, 1); }
    }
  }
  function drawParts() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var k = 1 - p.t / p.life;
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + k * 0.6), 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ============================ 事件 → 声音/粒子 ============================ */
  function handle(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];

      if (e.type === 'shoot') {
        if (SFX) { SFX.pop(); }
      }

      else if (e.type === 'grab') {
        if (SFX) { SFX.click(); }
        burst(game.hook.x, game.hook.y, 8, ['#ffe6a8', '#ffd08a', '#fff'], 130, 0.4);
      }

      else if (e.type === 'escape') {
        if (SFX) { SFX.bad(); }
        var it = e.item;
        burst(it.homeX, it.homeY, 16, ['#d9a468', '#bb7f48', '#8d6a45'], 210, 0.55);
      }

      else if (e.type === 'empty') {
        if (SFX) { SFX.tone(220, 0.09, 'sine', 0.16, 150); }
      }

      else if (e.type === 'boom') {
        if (SFX) { SFX.bad(); SFX.noise && SFX.noise(0.22, 0.5); }
        burst(e.x, e.y, 34, ['#ffe9a8', '#ffb347', '#ff6b3d', '#6b4a2f'], 380, 0.75);
        syncDyn();
      }

      else if (e.type === 'boomEmpty') {
        // 空响：只提示，不消耗。按钮抖一下 + 一个"咔"的降调。
        if (SFX) { SFX.tone(160, 0.1, 'square', 0.14, 110); }
        dynNope = 0.9;
      }

      else if (e.type === 'angel') {
        if (SFX) { SFX.bad(); }
        burst(C.MINER_X, C.MINER_Y, 26, ['#ff8f8f', '#e2483f', '#ffd0d0'], 300, 0.7);
      }

      else if (e.type === 'resolve') {
        var x = C.MINER_X, y = C.MINER_Y;
        if (e.isAngel) { /* 上面 angel 事件已经处理 */ }
        else {
          if (e.isGod) {
            flash = 0.5;
            burst(x, y, 30, ['#ffe9a8', '#ffd24a', '#fff8dc', '#9fe1cb'], 320, 0.85);
          }
          if (SFX) { SFX.good(e.combo); }
          if (SFX) { SFX.laugh(e.laughLevel); }
          if (e.mult >= 3) {
            burst(x, y, 12, ['#ff8a5b', '#ff6b6b', '#ffc46b'], 200, 0.5);
          }
        }
      }

      else if (e.type === 'god') {
        if (SFX) { SFX.clear(4); }
      }

      else if (e.type === 'levelClear') {
        if (SFX) { SFX.win(); }
        burst(C.MINER_X, C.MINER_Y, 40,
          ['#7ddfa8', '#35a06b', '#ffe9a8', '#fff'], 340, 1.0);
        onLevelClear(e);
      }

      else if (e.type === 'levelFail') {
        if (SFX) { SFX.lose(); }
        onLevelFail(e);
      }
    }
  }

  /* ============================ HUD ============================ */
  function syncDyn() {
    if (!game) { return; }
    var n = game.dynamite;
    el.dynNum.textContent = n;
    el.dyn.classList.toggle('empty', n <= 0);
    // 手里拉着东西 → 按钮亮起（"现在按有用"的明确提示）
    var armed = n > 0 && game.phase === 'pulling' && !!game.held;
    el.dyn.classList.toggle('armed', armed);
  }

  function syncHud() {
    if (!game) { return; }
    el.score.textContent = game.score;
    el.target.textContent = game.target;
    el.level.textContent = game.level;

    var t = Math.ceil(game.timeLeft);
    if (el.time.textContent !== String(t)) { el.time.textContent = t; }
    el.timeStat.classList.toggle('urgent', game.timeLeft <= 10);

    var p = L.progress(game);
    el.bar.style.width = (p * 100).toFixed(1) + '%';
    el.bar.parentNode.classList.toggle('full', p >= 1);

    /* 达标提示 —— 现在它同时是"收工"按钮。
     *
     * 这是这轮针对玩家那句"我直接不操作进下一关"的结构性解法：
     * 旧版达标之后只能干等（继续挖只承担天使扣分的风险，收益还是零），
     * 于是理性打法就是停手发呆。现在达标那一刻，"收工"亮起 ——
     * 玩家自己决定是现在过关，还是多挖几钩给小卖部攒钱。
     * 空转从"被迫"变成了"自选"。
     *
     * 只在关卡进行中显示：结算面板/小卖部已经盖在上面了，
     * 这时候再挂一个可点的按钮纯属添乱（实测点上去还会漏到浮层底下）。 */
    var live = game.phase === 'swinging' || game.phase === 'shooting' || game.phase === 'pulling';
    var gap = L.cashOutGap(game);
    var showChip = live && L.progress(game) >= 1;      // 进度条满了才谈收工
    el.keep.classList.toggle('show', showChip);
    if (showChip) {
      /* 进度条满 = 分数够了。但"分数够了"不等于"能收工"：
       * 吃老本（前几关攒下的盈余）能顶门槛，顶不了这一关的活儿。
       * 所以那一种情况把按钮锁上并说明还差多少 —— 别让玩家对着满格进度条纳闷。 */
      var locked = gap > 0;
      el.keep.classList.toggle('locked', locked);
      el.keepNum.textContent = Math.max(0, game.score - game.target);
      if (locked) {
        el.keepGo.textContent = '再赚 ' + gap + ' 分可收工';
      } else {
        el.keepGo.textContent = shopWillOpen() ? '收工进小卖部' : '收工过关';
      }
    }

    if (game.combo >= 2) {
      el.comboNum.textContent = game.combo;
      el.comboMult.textContent = '×' + L.comboMult(game.combo, game.cfg);
      el.combo.classList.add('show');
    } else {
      el.combo.classList.remove('show');
    }

    syncDyn();
  }

  /* ============================ 覆盖层 ============================ */
  var ALL_OV = null;
  function show(node) {
    if (!ALL_OV) { ALL_OV = [el.ovStart, el.ovPause, el.ovClear, el.ovOver, el.ovShop]; }
    ALL_OV.forEach(function (o) { o.classList.toggle('show', o === node); });
  }
  function hideAll() {
    if (!ALL_OV) { ALL_OV = [el.ovStart, el.ovPause, el.ovClear, el.ovOver, el.ovShop]; }
    ALL_OV.forEach(function (o) { o.classList.remove('show'); });
  }
  function ovShown(node) { return node.classList.contains('show'); }
  function anyOverlayShown() {
    if (!ALL_OV) { ALL_OV = [el.ovStart, el.ovPause, el.ovClear, el.ovOver, el.ovShop]; }
    for (var i = 0; i < ALL_OV.length; i++) { if (ALL_OV[i].classList.contains('show')) { return true; } }
    return false;
  }

  function tally(host, rows) {
    host.innerHTML = '';
    rows.forEach(function (r) {
      var s = document.createElement('span');
      if (r.kind) { s.className = r.kind; }
      s.innerHTML = r.label + '<b>' + r.value + '</b>';
      host.appendChild(s);
    });
  }

  function commitBest() {
    if (!game) { return false; }
    var changed = false;
    if (game.score > best.score) { best.score = game.score; saveNum(BEST_KEY, best.score); changed = true; }
    if (game.level > best.level) { best.level = game.level; saveNum(LV_KEY, best.level); changed = true; }
    return changed;
  }

  /* 该不该在"过关面板"上把小卖部入口亮出来 */
  function shopWillOpen() {
    return !!game && game.level >= game.cfg.SHOP_FROM_LEVEL;
  }

  function onLevelClear(e) {
    commitBest();
    /* 主动收工 和 打满时间 是同一张面板，只有标题和一句余量说明不同。
     * 收工要说清"你提前走了、还剩多少时间"，玩家才知道自己放弃了什么。 */
    el.clearTitle.textContent = e.cashedOut ? '收工！' : '过关！';
    el.clearSub.innerHTML = e.cashedOut
      ? '第 <b>' + e.level + '</b> 关提前收工，还剩 <b>' + Math.ceil(e.timeLeft) +
        '</b> 秒。这一关赚了 <b>' + e.levelGain + '</b> 分，总分 <b>' + e.score + '</b>。'
      : '第 <b>' + e.level + '</b> 关达标。这一关赚了 <b>' + e.levelGain +
        '</b> 分，总分 <b>' + e.score + '</b>。';
    var rows = [
      { label: '本关收入', value: e.levelGain, kind: 'good' },
      { label: '总分', value: e.score },
    ];
    if (e.cashedOut) { rows.push({ label: '省下的时间', value: Math.ceil(e.timeLeft) + ' 秒' }); }
    rows.push(
      { label: '最高连击', value: e.comboBest },
      { label: '撞到炸弹', value: e.angels, kind: e.angels > 0 ? 'bad' : '' },
      { label: '被挣脱', value: e.escapes, kind: e.escapes > 0 ? 'bad' : '' },
      { label: '用掉炸药', value: e.bombs }
    );
    tally(el.clearTally, rows);
    el.btnNext.textContent = shopWillOpen() ? '先去小卖部 →' : '进入第 ' + (e.level + 1) + ' 关';
    show(el.ovClear);
  }

  function onLevelFail(e) {
    var isBest = commitBest();
    el.overSub.innerHTML = '第 <b>' + e.level + '</b> 关卡住了：门槛 <b>' + e.target +
      '</b> 分，你差了 <b>' + (e.target - e.score) + '</b> 分。';
    tally(el.overTally, [
      { label: '总分', value: e.score },
      { label: '最远关卡', value: '第 ' + e.level + ' 关' },
      { label: '最高连击', value: e.comboBest },
      { label: '撞到炸弹', value: e.angels, kind: e.angels > 0 ? 'bad' : '' },
      { label: '被挣脱', value: e.escapes, kind: e.escapes > 0 ? 'bad' : '' },
      { label: '小卖部花掉', value: e.shopSpent },
    ]);
    el.overBest.innerHTML = isBest
      ? '新纪录！最高分 <b>' + best.score + '</b> · 最远到第 <b>' + best.level + '</b> 关'
      : '最高分 <b>' + best.score + '</b> · 最远到第 <b>' + best.level + '</b> 关';
    show(el.ovOver);
  }

  /* ============================ 小卖部 ============================ */
  function renderShop() {
    var v = L.shopView(game);

    el.shopSub.innerHTML = '第 <b>' + game.level + '</b> 关的账结完了，先买点东西再进第 <b>' +
      (game.level + 1) + '</b> 关。';
    el.shopWallet.textContent = game.score;
    el.shopTarget.textContent = game.target;
    el.shopBudget.textContent = v.budget;
    el.shopSpent.textContent = game.shopSpent;
    el.shopDyn.textContent = v.nextDynamite;

    var html = '';
    v.items.forEach(function (it) {
      var owned = it.owned > 0 ? '<span class="si-owned">已买 ' + it.owned + (it.unit || '') + '</span>' : '';
      var btn = it.canBuy
        ? '<button class="si-buy" type="button" data-buy="' + it.key + '">买</button>'
        : '<button class="si-buy off" type="button" disabled>' +
          (it.reason.indexOf('门槛') >= 0 ? '买不起' : '已买满') + '</button>';

      html += '<div class="shop-item' + (it.canBuy ? '' : ' off') + '">' +
        '<div class="si-head">' +
          '<b>' + it.name + '</b>' +
          '<em class="si-tag">' + it.tag + '</em>' +
          owned +
          '<span class="si-price"><i>¥</i>' + it.price + '</span>' +
        '</div>' +
        '<p class="si-desc">' + it.desc + '</p>' +
        '<p class="si-hint">' + it.hint + '</p>' +
        (it.canBuy ? '' : '<p class="si-why">' + it.reason + '</p>') +
        btn +
      '</div>';
    });
    el.shopList.innerHTML = html;
    show(el.ovShop);
  }

  /* ============================ 主循环 ============================ */
  function loop(now) {
    raf = requestAnimationFrame(loop);
    var dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
    lastT = now;

    var t = now / 1000;

    if (game && !paused && !anyOverlayShown()) {
      var ev = L.step(game, dt);
      if (ev.length) { handle(ev); }
      syncHud();
    }

    updateParts(dt);
    if (flash > 0) { flash = Math.max(0, flash - dt * 2.2); }
    if (dynNope > 0) {
      dynNope = Math.max(0, dynNope - dt);
      el.dyn.classList.add('nope');
    } else {
      el.dyn.classList.remove('nope');
    }
    render(t);
  }

  function render(t) {
    if (!game) { return; }

    ctx.save();
    if (game.shake > 0) {
      var m = game.shake * 11;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }

    drawBg();

    // 绘制顺序很关键：
    //   未抓住的物品 → 奶蛙 → 绞盘 → 绳子 → 钩子 → 手里的东西
    // 绳钩必须画在奶蛙之后，否则会被身体整个盖住（这个坑踩过一次）。
    for (var i = 0; i < game.items.length; i++) {
      if (!game.items[i].grabbed) { drawItem(game.items[i], t); }
    }

    drawMiner(t);
    drawWinch();
    drawRope();
    drawHook();

    for (var k = 0; k < game.items.length; k++) {
      if (game.items[k].grabbed) { drawItem(game.items[k], t); }
    }

    drawParts();
    drawFloaters();

    ctx.restore();

    if (flash > 0) {
      ctx.fillStyle = 'rgba(255, 250, 220, ' + (flash * 0.5) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ============================ 流程 ============================ */
  function newRun() {
    game = L.createGame({ preset: preset, layout: pickLayoutName() });
    paused = false;
    parts = [];
    flash = 0;
    lastT = 0;
    cacheFor(game.cfg);
    syncHud();
    refreshSwingNote();
  }

  function start() {
    if (!assetsReady) { return; }
    if (SFX) { SFX.init(); }
    newRun();
    fit();
    handle(L.beginLevel(game));
    hideAll();
    syncHud();
  }

  function toNextLevel() {
    handle(L.nextLevel(game));
    hideAll();
    syncHud();
    refreshSwingNote();
  }

  /* 过关面板上的主按钮：有小卖部就先进小卖部 */
  function advance() {
    if (shopWillOpen()) { renderShop(); }
    else { toNextLevel(); }
  }

  function quitToStart() {
    paused = false;
    newRun();
    fit();
    refreshBestLine();
    show(el.ovStart);
  }

  function refreshBestLine() {
    el.bestScore.textContent = best.score;
    el.bestLevel.textContent = best.level;
  }

  /* 开始页显示当前的摆动速度，让"越往后越快"这件事是可见的 */
  function refreshSwingNote() {
    if (!el.swingNote) { return; }
    var cfg = game ? game.cfg : L.CONFIG;
    var a = cfg.SWING_PERIOD_START === undefined ? cfg.SWING_PERIOD : cfg.SWING_PERIOD_START;
    var b = cfg.SWING_PERIOD_MIN === undefined ? a : cfg.SWING_PERIOD_MIN;
    el.swingNote.innerHTML = '钩子第 1 关 ' + a.toFixed(1) + ' 秒摆一个来回，' +
      '越往后越快，到 ' + b.toFixed(1) + ' 秒封顶（不再变快）。';
  }

  /* ============================ 输入 ============================ */
  function tryShoot() {
    if (!game || paused) { return; }
    if (anyOverlayShown()) { return; }
    if (game.phase !== 'swinging') { return; }
    handle(L.shoot(game));
    syncHud();
  }

  function tryBoom() {
    if (!game || paused) { return; }
    if (anyOverlayShown()) { return; }
    if (game.dynamite <= 0) { return; }
    if (SFX) { SFX.init(); }
    var ev = L.blowUp(game);
    handle(ev);
    syncHud();
  }

  /* 收工：达标之后提前结束这一关。
   * 判定放逻辑层（L.canCashOut），这里只管按钮/键盘和反馈。 */
  function tryCashOut() {
    if (!game || paused) { return; }
    if (anyOverlayShown()) { return; }
    if (!L.canCashOut(game)) { return; }
    if (SFX) { SFX.init(); }
    var ev = L.cashOut(game);
    if (!ev.length) { return; }
    handle(ev);   // levelClear 事件自己会放过关音效
    syncHud();
  }

  stage.addEventListener('pointerdown', function (ev) {
    // 覆盖层 / 按钮自己处理点击
    if (ev.target.closest && (ev.target.closest('.overlay') || ev.target.closest('.mute') ||
        ev.target.closest('.dyn') || ev.target.closest('.keep-hint'))) { return; }
    tryShoot();
  });

  document.addEventListener('keydown', function (ev) {
    if (anyOverlayShown()) { return; }
    if (ev.code === 'Space' || ev.key === ' ' || ev.code === 'Enter') {
      /* 只有**浮层里**的按钮才允许吞掉空格/回车（那是它们的"确认"键）。
       * HUD 上的按钮（静音/炸药/收工）点完之后会留在焦点上，
       * 以前那版判断会让它们把空格一起吞掉 —— 点一下炸药，空格就发射不了了。
       * 拾音按钮的"焦后吞键"实测就是这么来的。 */
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON' && ae.closest && ae.closest('.overlay')) { return; }
      ev.preventDefault();
      /* 达标之后 Enter 是"收工"，没达标时 Enter 还是发射。
       * 一件事只记一个键：Enter = 现在最该做的那个动作。 */
      if (L.canCashOut(game)) { tryCashOut(); } else { tryShoot(); }
    } else if (ev.code === 'KeyB' || ev.key === 'b' || ev.key === 'B') {
      ev.preventDefault();
      tryBoom();
    }
  });

  el.btnStart.addEventListener('click', start);
  el.btnNext.addEventListener('click', advance);
  el.btnAgain.addEventListener('click', start);
  el.btnQuit.addEventListener('click', quitToStart);
  el.btnResume.addEventListener('click', function () {
    paused = false;
    lastT = 0;
    hideAll();
  });

  el.btnShopGo.addEventListener('click', toNextLevel);
  el.dyn.addEventListener('click', tryBoom);
  el.keep.addEventListener('click', tryCashOut);

  el.shopList.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-buy]') : null;
    if (!b || !game) { return; }
    var key = b.getAttribute('data-buy');
    var r = L.buy(game, key);
    if (r.ok) {
      if (SFX) { SFX.good(3); }
      syncHud();
      renderShop();
    } else {
      if (SFX) { SFX.tone(180, 0.1, 'square', 0.14, 120); }
    }
  });

  el.preset.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-preset]') : null;
    if (!b) { return; }
    preset = b.getAttribute('data-preset');
    Array.prototype.forEach.call(el.preset.querySelectorAll('button'), function (x) {
      x.classList.toggle('on', x === b);
    });
    if (SFX) { SFX.click(); }
    if (game && game.phase === 'ready') { newRun(); fit(); }
    refreshSwingNote();
  });

  el.mute.addEventListener('click', function () {
    if (!SFX) { return; }
    SFX.init();
    var m = SFX.toggleMuted();
    el.mute.classList.toggle('off', !!m);
  });

  /* 切走标签页 → 自动暂停 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (game && !paused && !anyOverlayShown()) {
        paused = true;
        show(el.ovPause);
      }
    } else {
      lastT = 0;                              // 丢掉离开这段时间
    }
  });

  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });

  /* ============================ 图鉴 ============================ */
  /* 缩略图按体型缩放 —— 图鉴本身就要教会玩家"越大越值钱"，
   * 所以不能所有缩略图一样大（那等于把这个线索藏了起来）。
   * 用图片百分比而不是盒子尺寸：盒子统一，网格才不会被撑得东倒西歪。 */
  function legendThumbPercent(size) {
    var lo = L.ITEMS.blob.size, hi = L.ITEMS.god.size;
    var t = Math.max(0, Math.min(1, (size - lo) / (hi - lo)));
    return Math.round(46 + t * 54);           // 小石子 46% → 钻石 100%
  }

  function buildLegend() {
    var html = '';
    L.LEGEND_ORDER.forEach(function (type) {
      var d = L.ITEMS[type];
      var val;
      if (d.value instanceof Array) { val = d.value[0] + '~' + d.value[1]; }
      else { val = (d.value > 0 ? '+' : '') + d.value; }

      var kind = d.value < 0 ? 'minus' : 'plus';
      var note = val;
      if (d.isStone) { note = val + ' · 不算连击'; }
      if (d.timeBonus) { note = val + ' · 加时'; }
      if (d.isAngel) { note = val + ' · 别碰'; }

      var thumb;
      if (d.img) {
        thumb = '<span class="thumb"><img src="../assets/nai/' + d.img + '.webp" alt="" ' +
          'style="width:' + legendThumbPercent(d.size) + '%;height:' + legendThumbPercent(d.size) + '%"></span>';
      } else {
        thumb = '<span class="thumb rock"></span>';
      }

      html += '<li' + (d.value < 0 ? ' class="danger"' : '') + '>' + thumb +
        '<div class="txt"><b>' + d.name + '</b><small class="' + kind + '">' + note + '</small></div></li>';
    });
    el.legend.innerHTML = html;
  }

  /* ============================ 启动 ============================ */
  el.btnStart.textContent = '加载奶蛙中…';
  preload();
  newRun();                 // 先建一局（ready 态）当开始页的背景，别让舞台空着
  fit();
  buildLegend();
  refreshBestLine();
  if (SFX && SFX.isMuted && SFX.isMuted()) { el.mute.classList.add('off'); }
  raf = requestAnimationFrame(loop);

  // 兜底：万一某张图挂了，2.5 秒后也放行
  setTimeout(function () {
    if (!assetsReady) { assetsReady = true; el.btnStart.textContent = '开始挖矿'; }
  }, 2500);

  window.__miner = {
    get game() { return game; },
    get layout() { return game ? game.cfg.LAYOUT : null; },
    start: start,
    fit: fit,
  };  // 方便调试
})();
