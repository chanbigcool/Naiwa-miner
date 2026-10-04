/* ============================================================
 *  奶蛙小游戏 · 共用音效 (NaiSFX)
 *  笑声：播放用户提供的「奶蛙捧腹大笑」真实录音（common/laugh-data.js，自动加载）。
 *        每次都播同一整段「啊哈哈哈哈哈哈」（约 1 秒），连击时允许叠在一起；
 *        主通道用 Web Audio；Web Audio 起不来时（比如微信内置浏览器）改用 <audio> 备用通道；
 *        录音没加载好时，退回现场合成的近似笑声，游戏照常能玩。
 *  其它音效：全部用 Web Audio 现场合成，没有音频文件，file:// 下也能用。
 *
 *  用法：
 *    <script src="../common/sfx.js"></script>
 *    声音解锁由本模块自己负责：它会监听 pointerdown / pointerup / touchend / click / keydown 等手势，
 *    直到声音真正跑起来为止（手机浏览器只认部分手势）；游戏里额外调 NaiSFX.init() 也行，是幂等的。
 *    之后随时调 NaiSFX.laugh(level) 等；静音 / 浏览器不支持时都是空操作，不会报错。
 *    手机没声音时：网址后面加 ?audiodebug=1，左上角会显示声音状态，点一下还会试播一声笑。
 *    注意：iPhone 上网页声音默认受侧面静音键控制（和原生游戏一样），静音键打开时是没有声音的。
 *    微信内置浏览器对网页声音限制更严：本模块会自动改用备用通道，仍不行时会提示「在浏览器打开」。
 *
 *  API：
 *    init()                     初始化 / 恢复音频（需在用户手势里调）
 *    setMuted(b) isMuted() toggleMuted()   静音开关，记在 localStorage 的 nai_muted
 *    laugh(level)               奶蛙大笑。每次都是同一整段；level 0~1 只让它略快、略尖一点点
 *    laughReady()               真实录音是否已解码就绪（调试用）
 *    pop()                      冒头 / 弹出的“啵”
 *    click()                    轻点
 *    good(n)                    命中 / 加分的上扬提示，n=连击数，越大音越高
 *    bad()                      失误 / 扣分的下坠音
 *    boing()                    弹簧“嘣”（起跳、落地）
 *    swap()                     交换 / 移动
 *    clear(n)                   消除，n=连消数，越大音越高
 *    win() lose()               过关 / 失败的小旋律
 *    tone(freq, dur, type, vol, slideTo, delay)   自定义单音
 *    noise(dur, vol, hpFreq, delay)               自定义噪声
 * ============================================================ */
(function (root) {
  'use strict';

  var AC = root.AudioContext || root.webkitAudioContext;
  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';   // 本文件的地址，用来找同目录的 laugh-data.js
  var UA = String((root.navigator && root.navigator.userAgent) || '');
  var IN_WECHAT = /MicroMessenger/i.test(UA);
  var ctx = null;          // AudioContext
  var master = null;       // 总音量（静音时为 0）
  var noiseBuf = null;     // 1 秒白噪声：做“气声”和打击感
  var muted = false;
  var MASTER_VOL = 0.8;
  var MIN_LAUGH_GAP = 30;  // 两次笑声最短间隔（毫秒）：只防同一帧里重复触发，连击时允许叠在一起
  var MAX_LAUGH_VOICES = 6;// 真实笑声最多同时播几个，超过就把最老的快速淡出
  var lastLaughAt = 0;

  // 手机浏览器的「声音解锁」：
  //   手机只认某几种用户手势才允许出声（iOS Safari：touchend / click；Chrome 触屏：pointerup / touchend / click；
  //   触摸时的 pointerdown / touchstart 不算），电脑上鼠标按下就算。所以这里在所有可能的手势上都试一次，
  //   直到声音真的跑起来（state === 'running'）为止；之后若被系统打断（来电、切后台）再重新挂上。
  var unlockEvents = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown'];
  var listening = false;
  var lastUnlockVia = '';  // 诊断用：最近一次是哪个事件触发了解锁
  var unlockTries = 0;     // 已经尝试解锁的次数（微信提示用）
  var hintShown = false;

  // 真实笑声
  var laughData = root.NAI_LAUGH || null;  // { mime, b64 }，由 laugh-data.js 提供
  var laughBuf = null;                     // 解码后的 AudioBuffer（一整段「啊哈哈哈哈哈哈」）
  var laughDecoding = false;
  var laughVoices = [];                    // 正在播的真实笑声：[{ src, steal, endAt }]

  // 备用通道：<audio> 元素池（Web Audio 起不来时用，比如微信内置浏览器）
  var htmlPool = null;
  var htmlIdx = 0;
  var htmlReady = false;                   // 至少有一个 <audio> 在手势里成功 play 过

  try { muted = root.localStorage.getItem('nai_muted') === '1'; } catch (e) {}

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function makeNoise(c) {
    var b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* ---------- 真实笑声：加载 / 解码 ---------- */
  function b64ToBuf(b64) {
    var bin = atob(b64.replace(/\s+/g, '')), n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  function decodeBuffer(c, ab) {
    return new Promise(function (resolve, reject) {
      var p = c.decodeAudioData(ab, resolve, reject);   // 老 Safari 只支持回调写法
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function prepareLaugh() {
    if (!ctx || !laughData || laughBuf || laughDecoding) return;
    laughDecoding = true;
    try {
      decodeBuffer(ctx, b64ToBuf(laughData.b64)).then(function (buf) {
        laughBuf = buf;
      }, function () { /* 解码失败就走备用通道 / 合成笑声 */ }).then(function () { laughDecoding = false; });
    } catch (e) { laughDecoding = false; }
  }

  // 页面一加载就去拉数据文件（同目录的 laugh-data.js），不需要每个游戏页面单独引用
  function loadLaughScript() {
    if (laughData || !SELF_SRC) return;
    try {
      var s = document.createElement('script');
      s.async = true;
      s.src = SELF_SRC.replace(/[^\/]*(\?.*)?$/, 'laugh-data.js');
      s.onload = function () { laughData = root.NAI_LAUGH || null; prepareLaugh(); ensureHtmlPool(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  /* ---------- 备用通道：<audio> 元素 ---------- */
  function ensureHtmlPool() {
    if (htmlPool || !laughData || typeof root.Audio !== 'function') return;
    try {
      var url = 'data:' + (laughData.mime || 'audio/mpeg') + ';base64,' + laughData.b64.replace(/\s+/g, '');
      htmlPool = [];
      for (var i = 0; i < 4; i++) {
        var a = new root.Audio();
        a.preload = 'auto';
        a.src = url;
        htmlPool.push(a);
      }
    } catch (e) { htmlPool = null; }
  }

  // iOS / 微信要求每个 <audio> 元素都在用户手势里 play 过一次，之后才能随时播。
  // 这里在手势里用「静音 play → 立刻暂停」把它们都点亮，听不到任何声音。
  function unlockHtml() {
    ensureHtmlPool();
    if (!htmlPool || htmlReady) return;
    htmlPool.forEach(function (a) {
      try {
        a.muted = true;
        var settle = function (ok) {
          try { a.pause(); a.currentTime = 0; } catch (e) {}
          a.muted = false;
          if (ok) htmlReady = true;
        };
        var p = a.play();
        if (p && p.then) p.then(function () { settle(true); }, function () { settle(false); });
        else settle(true);
      } catch (e) {}
    });
  }

  function playHtmlLaugh(level) {
    ensureHtmlPool();
    if (!htmlPool) return false;
    var a = htmlPool[htmlIdx++ % htmlPool.length];
    try {
      a.muted = false;
      a.currentTime = 0;
      try { a.playbackRate = 1 + clamp(+level || 0, 0, 1) * 0.06 + (Math.random() * 0.05 - 0.025); } catch (e) {}
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 音频上下文 ---------- */
  function init() {
    if (!AC) return false;
    try {
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOL;
        var comp = ctx.createDynamicsCompressor();   // 多个声音叠加时压一下，防爆音
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        comp.attack.value = 0.003;
        comp.release.value = 0.12;
        master.connect(comp);
        comp.connect(ctx.destination);
        noiseBuf = makeNoise(ctx);
        // 被系统打断（来电 / 切后台 / 锁屏）后，下一次手势要能重新解锁
        if (ctx.addEventListener) ctx.addEventListener('statechange', function () { if (ctx.state !== 'running') attachUnlock(); });
      }
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {   // interrupted 是 iOS 特有的状态
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      prepareLaugh();
      return true;
    } catch (e) {
      return false;
    }
  }

  function unlock(ev) {
    lastUnlockVia = (ev && ev.type) || 'call';
    unlockTries++;
    unlockHtml();                              // 备用通道也在同一个手势里点亮
    if (unlockTries >= 3) setTimeout(maybeShowHint, 900);
    if (!AC) return;
    if (!init() || !ctx) return;               // init 里会 resume —— 必须在手势事件的同一个调用栈里
    try {                                      // iOS：先放一小段静音数据，把音频通道真正“点亮”
      var s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    } catch (e) {}
    if (ctx.state === 'running') { detachUnlock(); return; }
    var p = ctx.resume && ctx.resume();
    if (p && p.then) p.then(function () { if (ctx.state === 'running') detachUnlock(); }, function () {});
  }

  function attachUnlock() {
    if (listening) return;
    listening = true;
    unlockEvents.forEach(function (t) { root.addEventListener(t, unlock, { capture: true, passive: true }); });
  }

  function detachUnlock() {
    if (!listening) return;
    listening = false;
    unlockEvents.forEach(function (t) { root.removeEventListener(t, unlock, true); });
  }

  function setMuted(b) {
    muted = !!b;
    try { root.localStorage.setItem('nai_muted', muted ? '1' : '0'); } catch (e) {}
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ctx.currentTime, 0.02);
    return muted;
  }

  // 微信里试了几次手势声音还是没起来：给一句不打扰的提示
  function maybeShowHint() {
    if (!IN_WECHAT || hintShown) return;
    if (ctx && ctx.state === 'running') return;
    hintShown = true;
    try {
      var el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
        'z-index:2147483646;width:max-content;max-width:92vw;padding:10px 12px 10px 14px;border-radius:14px;' +
        'background:rgba(74,51,37,.94);color:#fff;font:13px/1.55 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
        'display:flex;gap:10px;align-items:center';
      var tx = document.createElement('span');
      tx.textContent = '没有声音？微信有时会限制网页声音。点右上角「···」，选「在浏览器打开」（iPhone 是「在 Safari 中打开」）就有了。';
      var bt = document.createElement('button');
      bt.type = 'button';
      bt.textContent = '知道了';
      bt.style.cssText = 'flex:0 0 auto;border:0;border-radius:10px;padding:6px 10px;background:#ff8a5b;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
      var close = function () { if (el.parentNode) el.parentNode.removeChild(el); };
      bt.addEventListener('click', close);
      el.appendChild(tx);
      el.appendChild(bt);
      (document.body || document.documentElement).appendChild(el);
      setTimeout(close, 15000);
    } catch (e) {}
  }

  // 声音诊断面板：网址后面加 ?audiodebug=1 就会在左上角显示声音状态，点它会试播一声笑。
  // 手机上没声音时，打开这个网址、截图给开发者，就能判断是「没解锁」还是「被静音键/音量挡住了」。
  function audioDebug() {
    if (!/[?&]audiodebug=1/.test((root.location && root.location.search) || '')) return;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;max-width:92vw;padding:8px 10px;border-radius:10px;' +
      'background:rgba(0,0,0,.82);color:#fff;font:12px/1.6 monospace;white-space:pre-wrap;word-break:break-all';
    function mount() { (document.body || document.documentElement).appendChild(el); }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
    function render() {
      var as = root.navigator && root.navigator.audioSession;
      var web = !!(ctx && ctx.state === 'running');
      el.textContent = ['声音诊断（点我试播一声笑）',
        'AudioContext: ' + (AC ? '支持' : '不支持'),
        '状态: ' + (ctx ? ctx.state : '还没创建（还没点过屏幕）'),
        '静音按钮: ' + (muted ? '已静音' : '开'),
        '笑声数据: ' + (laughData ? '已加载' : '未加载') + '   Web Audio 解码: ' + (laughBuf ? '好了 ' + laughBuf.duration.toFixed(2) + '秒' : '还没有'),
        '笑声通道: ' + (web ? 'Web Audio' : (htmlPool ? '<audio> 备用（' + (htmlReady ? '已解锁' : '未解锁') + '）' : '无')),
        '微信内置浏览器: ' + (IN_WECHAT ? '是' : '否'),
        'audioSession: ' + (as ? as.type : '不支持'),
        '最近解锁事件: ' + (lastUnlockVia || '无') + '（共 ' + unlockTries + ' 次）',
        'UA: ' + UA.slice(0, 100)].join('\n');
    }
    el.addEventListener('click', function () { unlock({ type: 'debug-tap' }); setTimeout(function () { root.NaiSFX.laugh(0.5); }, 250); });
    setInterval(render, 500);
    render();
  }

  /* ---------- 底层积木：都接收 S = { c: 上下文, out: 输出节点, noise: 噪声缓冲, laughBuf }，
   *            这样既能实时播放，也能用 OfflineAudioContext 离线渲染做测试 ---------- */

  // 单音：可带滑音
  function bTone(S, t, freq, dur, type, vol, slideTo) {
    var c = S.c, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(S.out);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // 噪声：高通后做“咔哒/沙沙”
  function bNoise(S, t, dur, vol, hp) {
    var c = S.c, n = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    n.buffer = S.noise;
    n.loop = true;
    f.type = 'highpass';
    f.frequency.value = hp || 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f);
    f.connect(g);
    g.connect(S.out);
    n.start(t);
    n.stop(t + dur + 0.03);
  }

  // 一声“齁”：先一点气声(h)，再接带共振峰的元音(o / a)   —— 合成版笑声（真实录音没就绪时的备用）
  var FORMANTS = {
    o: [[520, 1.0, 7], [900, 0.7, 9], [2400, 0.25, 10]],
    a: [[800, 1.0, 7], [1220, 0.7, 9], [2600, 0.25, 10]]
  };
  function bHo(S, t, f0, dur, vol, vowel) {
    var c = S.c, F = FORMANTS[vowel] || FORMANTS.o;

    // 声带：锯齿波，基频略微下滑（像“哈↘”）
    var o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 1.1, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.88, t + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.025);
    g.gain.setValueAtTime(1, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);

    // 共振峰：几个并联的带通滤波器，决定“o”还是“a”的音色
    var mix = c.createGain();
    mix.gain.value = vol;
    F.forEach(function (p) {
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p[0];
      bp.Q.value = p[2];
      var pg = c.createGain();
      pg.gain.value = p[1] * 2.6;      // 带通会衰减很多，这里补回来
      g.connect(bp);
      bp.connect(pg);
      pg.connect(mix);
    });
    mix.connect(S.out);
    o.start(t);
    o.stop(t + dur + 0.03);

    // 气声“h”：每一声开头一小撮噪声
    var n = c.createBufferSource();
    n.buffer = S.noise;
    var nf = c.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = F[1][0] * 1.3;
    nf.Q.value = 0.9;
    var ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(vol * 0.5, t + 0.012);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur * 0.7, 0.1));
    n.connect(nf);
    nf.connect(ng);
    ng.connect(S.out);
    n.start(t);
    n.stop(t + 0.14);
  }

  // 合成版整段笑声：一声拖长的“哦～”，再跟若干声急促的“齁齁齁”
  function bLaugh(S, t, level) {
    level = clamp(+level || 0, 0, 1);
    var base = 175 + level * 90 + (Math.random() * 16 - 8);   // 基频：越疯越尖
    var n = 3 + Math.round(level * 3);                         // 后面跟几声“齁”
    var gap = 0.165 - level * 0.055;                           // 间隔：越疯越快
    var tt = t;
    bHo(S, tt, base * 0.92, 0.26, 0.55, 'o');
    tt += 0.25;
    for (var i = 0; i < n; i++) {
      bHo(S, tt, base * (i % 2 ? 1.06 : 0.97), gap * 0.8, 0.5 * (1 - i * 0.06), i % 3 === 2 ? 'a' : 'o');
      tt += gap;
    }
    if (level > 0.7) {                                         // 笑到岔气：结尾拖一声上扬的“嘻～”
      bTone(S, tt, base * 3, 0.2, 'sine', 0.07, base * 4.4);
    }
  }

  // 真实笑声：每次都播同一整段（音量、淡入淡出都已经做进录音里，不会被截断）。
  // level 只让它略快、略尖一点点，再加一点随机，这样好几个叠在一起时不会完全重合成一团。
  function bRealLaugh(S, t, level) {
    level = clamp(+level || 0, 0, 1);
    var rate = 1 + level * 0.06 + (Math.random() * 0.05 - 0.025);
    var c = S.c, src = c.createBufferSource(), steal = c.createGain();
    src.buffer = S.laughBuf;
    src.playbackRate.value = rate;
    src.connect(steal);
    steal.connect(S.out);
    src.start(t);
    return { src: src, steal: steal, endAt: t + S.laughBuf.duration / rate };
  }

  /* ---------- 其它音效 ---------- */
  function bPop(S, t)   { bTone(S, t, 320, 0.09, 'sine', 0.25, 760); bNoise(S, t, 0.04, 0.05, 3000); }
  function bClick(S, t) { bTone(S, t, 700, 0.04, 'triangle', 0.15, 520); }
  function bGood(S, t, n) {
    var f = 520 * Math.pow(1.0595, Math.min(+n || 0, 8) * 2);
    bTone(S, t, f, 0.1, 'triangle', 0.22);
    bTone(S, t + 0.07, f * 1.5, 0.16, 'triangle', 0.2);
  }
  function bBad(S, t)   { bTone(S, t, 300, 0.28, 'sawtooth', 0.14, 110); }
  function bBoing(S, t) { bTone(S, t, 180, 0.28, 'sine', 0.3, 520); bTone(S, t + 0.03, 360, 0.24, 'sine', 0.12, 140); }
  function bSwap(S, t)  { bTone(S, t, 440, 0.07, 'sine', 0.15, 660); }
  function bClear(S, t, n) {
    var f = 440 * Math.pow(1.0595, Math.min(+n || 1, 8) * 2);
    bTone(S, t, f, 0.12, 'triangle', 0.2);
    bTone(S, t + 0.06, f * 1.26, 0.12, 'triangle', 0.18);
    bTone(S, t + 0.12, f * 1.5, 0.2, 'triangle', 0.18);
    bNoise(S, t, 0.06, 0.03, 5000);
  }
  function bWin(S, t) {
    [523, 659, 784, 1047, 784, 1047].forEach(function (f, i) { bTone(S, t + i * 0.11, f, 0.18, 'triangle', 0.22); });
  }
  function bLose(S, t) {
    [392, 330, 262, 196].forEach(function (f, i) { bTone(S, t + i * 0.16, f, 0.24, 'sawtooth', 0.12, f * 0.96); });
  }

  /* ---------- 对外 API ---------- */
  function sink() { return { c: ctx, out: master, noise: noiseBuf, laughBuf: laughBuf }; }

  function play(build, a, b) {
    if (muted || !init() || ctx.state !== 'running') return;
    try {
      build(sink(), ctx.currentTime + 0.005, a, b);
    } catch (e) { /* 音效出错绝不能影响游戏 */ }
  }

  function playRealLaugh(level) {
    try {
      var now = ctx.currentTime;
      laughVoices = laughVoices.filter(function (v) { return v.endAt > now; });
      while (laughVoices.length >= MAX_LAUGH_VOICES) {         // 同时最多 6 个声部，最老的快速淡出
        var old = laughVoices.shift();
        old.steal.gain.setTargetAtTime(0, now, 0.012);
        try { old.src.stop(now + 0.1); } catch (e) {}
      }
      laughVoices.push(bRealLaugh(sink(), now + 0.005, level));
    } catch (e) { /* 出错就当没播 */ }
  }

  function laughNow(level) {
    if (muted) return;
    var web = AC && init() && ctx && ctx.state === 'running';
    if (web && laughBuf) { playRealLaugh(level); return; }      // 主通道：Web Audio 播真实录音
    if (web) { play(bLaugh, level); return; }                   // 录音还在解码：这一声先用合成的
    if (!playHtmlLaugh(level)) play(bLaugh, level);             // Web Audio 没起来（微信等）：走 <audio> 备用通道
  }

  root.NaiSFX = {
    version: 3,
    init: init,
    setMuted: setMuted,
    isMuted: function () { return muted; },
    toggleMuted: function () { return setMuted(!muted); },

    laugh: function (level) {
      var nowMs = Date.now();
      if (nowMs - lastLaughAt < MIN_LAUGH_GAP) return;
      lastLaughAt = nowMs;
      laughNow(level);
    },
    laughReady: function () { return !!laughBuf; },
    unlock: unlock,                                             // 手动触发一次解锁（一般不用：本模块会自己监听手势）
    state: function () { return ctx ? ctx.state : 'none'; },    // AudioContext 状态：none / suspended / running / interrupted
    pop:   function () { play(bPop); },
    click: function () { play(bClick); },
    good:  function (n) { play(bGood, n); },
    bad:   function () { play(bBad); },
    boing: function () { play(bBoing); },
    swap:  function () { play(bSwap); },
    clear: function (n) { play(bClear, n); },
    win:   function () { play(bWin); },
    lose:  function () { play(bLose); },
    tone: function (freq, dur, type, vol, slideTo, delay) {
      play(function (S, t) { bTone(S, t + (delay || 0), freq, dur || 0.1, type, vol, slideTo); });
    },
    noise: function (dur, vol, hp, delay) {
      play(function (S, t) { bNoise(S, t + (delay || 0), dur || 0.1, vol, hp); });
    },

    // 仅供离线测试（用 OfflineAudioContext 渲染后检查音量/时长）
    _build: {
      makeNoise: makeNoise, tone: bTone, noise: bNoise, ho: bHo, laugh: bLaugh, realLaugh: bRealLaugh,
      pop: bPop, click: bClick, good: bGood, bad: bBad, boing: bBoing,
      swap: bSwap, clear: bClear, win: bWin, lose: bLose
    },
    _laugh: {
      data: function () { return laughData; },
      b64ToBuf: b64ToBuf, decodeBuffer: decodeBuffer,
      html: function () { return { pool: htmlPool ? htmlPool.length : 0, ready: htmlReady }; },
      hintShown: function () { return hintShown; }
    }
  };

  loadLaughScript();
  attachUnlock();                                   // 页面一加载就开始监听手势，第一次点屏幕就把声音解锁
  document.addEventListener('visibilitychange', function () {   // 切回前台时，若声音被系统暂停了，下一次手势再解锁
    if (!document.hidden && ctx && ctx.state !== 'running') attachUnlock();
  });
  // 微信内置浏览器：WeixinJSBridge 就绪后，借它的回调再点亮一次 <audio>（微信放行音频的惯用做法）
  document.addEventListener('WeixinJSBridgeReady', function () {
    attachUnlock();
    try { root.WeixinJSBridge.invoke('getNetworkType', {}, function () { unlockHtml(); }); } catch (e) {}
  }, false);
  audioDebug();
})(window);
