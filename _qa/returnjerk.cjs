/*
 * 收钩交接诊断：node _qa/returnjerk.cjs
 * ---------------------------------------------------------------------------
 * 玩家反馈"每次收钩子还会甩一下"。这个脚本量化三件事：
 *   1) 交接瞬间手臂转过多少度、以多快的角速度追上钟摆（甩不甩）
 *   2) 追赶要多久（会不会一直追不上，显得发黏）
 *   3) 不同反应延迟下，连续 10 发的角度是否扫得开（相位有没有被锁死）
 * 判定基准：正常摆动的单帧转角约 1.53°（第 1 关，60fps）。
 * test-logic.js 里已有硬断言；这个脚本用于调 RETURN_SPEED / PHASE_DRIFT_RATE。
 */
'use strict';
var L = require('../miner/logic.js');
var FPS = 1 / 60;
var NORMAL = 1.53;

function mk() { return L.createGame({ rng: L._seededRng(20261004) }); }

function toSwing(s) {
  var g = 0;
  while (s.phase !== 'swinging' && g++ < 6000) { L.step(s, FPS); }
}

function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

/* 1 + 2) 连打 16 发，记录每次交接的角度差、追赶时长、追赶期单帧最大转角 */
var s = mk();
L.beginLevel(s);
var gaps = [], frames = [], whip = [];
for (var k = 0; k < 16; k++) {
  toSwing(s);
  for (var w = 0; w < 4 + k * 5; w++) { L.step(s, FPS); }   // 摆到不同位置再打
  L.shoot(s);

  var guard = 0;
  while (s.phase !== 'swinging' && guard++ < 900) { L.step(s, FPS); }

  var target = L.swingAngle ? L.swingAngle(s) : s.angle;
  gaps.push(Math.abs(target - s.angle));

  var f = 0, prev = s.angle, maxD = 0;
  while (s.returning && f++ < 600) {
    L.step(s, FPS);
    if (Math.abs(s.angle - prev) > maxD) { maxD = Math.abs(s.angle - prev); }
    prev = s.angle;
  }
  frames.push(f);
  whip.push(maxD);
}

console.log('[归位] 交接角度差  平均 %s°   最大 %s°',
  avg(gaps).toFixed(1), Math.max.apply(null, gaps).toFixed(1));
console.log('[归位] 追赶时长    平均 %s 秒  最长 %s 秒',
  (avg(frames) / 60).toFixed(2), (Math.max.apply(null, frames) / 60).toFixed(2));
console.log('[归位] 单帧最大转角 %s°（正常 %s°，上限应约 1.2~1.3 倍）',
  Math.max.apply(null, whip).toFixed(2), NORMAL);

/* 3) 固定节奏 + 各种反应延迟下，10 发的角度跨度 */
function span(delay) {
  var s2 = mk();
  L.beginLevel(s2);
  var arr = [], n = Math.round(delay / FPS);
  for (var i = 0; i < 10; i++) {
    toSwing(s2);
    for (var f = 0; f < n && s2.phase === 'swinging'; f++) { L.step(s2, FPS); }
    arr.push(s2.angle);
    L.shoot(s2);
  }
  return { span: Math.max.apply(null, arr) - Math.min.apply(null, arr), seq: arr };
}

console.log('\n[多样性] 回钩后等 N 秒再按，连续 10 发的角度跨度（越大越不容易被锁死）:');
[0, 0.05, 0.15, 0.30, 0.60, 1.00].forEach(function (d) {
  var r = span(d);
  console.log('  等待 %ss  → 跨度 %s°   序列 %s', d.toFixed(2), r.span.toFixed(1),
    r.seq.map(function (v) { return v.toFixed(0); }).join(','));
});
