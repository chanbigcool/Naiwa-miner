/* 难度体检 v3：会瞄准的玩家，但"手有多稳"参数化
 * tol = 允许的瞄准误差（度）。tol 越小 = 玩家手越稳。
 * 目的：看清"命中率随精度怎么变"，以及"游戏到底是不是只能碰运气"。
 *
 * v3 改动：瞄准统一走 _qa/aimlib.cjs（O(物品数) 的解析解 + 目标粘性），
 * 于是可以**每帧重新瞄** —— 会爬的目标必须这样，否则机器人一直在打
 * 它规划时刻的旧位置，量出来的是机器人的缺陷而不是游戏的难度。
 */
const L = require('../miner/logic.js');
const A = require('./aimlib.cjs');
const FPS = 1 / 60;

function playLevel(s, tol) {
  L.beginLevel(s);
  const pick = A.makeAimer();
  let guard = 0;
  while (s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling') {
    if (s.phase === 'swinging') {
      const p = pick(s);
      if (p && Math.abs(s.angle - p.a) <= tol) { L.shoot(s); }
    }
    // 拉着石头还有炸药就炸掉省时间（玩家真会这么干，见 _qa/level.cjs）
    if (s.phase === 'pulling' && s.held && s.held.isStone && s.dynamite > 0) { L.blowUp(s); }
    L.step(s, FPS);
    if (guard++ > 60 * 300) break;
  }
  return s.phase;
}

function run(seed, tol) {
  const s = L.createGame({ rng: L._seededRng(seed) });
  for (let lv = 1; lv <= 30; lv++) {
    const phase = playLevel(s, tol);
    if (phase !== 'levelClear') return { level: lv, score: s.score, target: s.target, s };
    L.nextLevel(s);
  }
  return { level: 30, score: s.score, target: s.target, s };
}

console.log('tol = 允许的瞄准误差（度）。人对着"可预测的周期运动"出手，精度大致 3~6 度以内。\n');

const tols = [1.5, 3.0];
const summary = [];

for (const tol of tols) {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(run(31000 + i * 137, tol));
  const reached = results.map((r) => r.level);
  const sorted = [...reached].sort((a, b) => a - b);
  const lv1pass = results.filter((r) => r.level > 1).length;
  const shots = results.reduce((a, r) => a + r.s.shots, 0);
  const hits = results.reduce((a, r) => a + r.s.hits, 0);
  summary.push({
    瞄准误差: tol + '°',
    '第1关通过率': `${lv1pass}/10`,
    最远关卡中位数: sorted[Math.floor(sorted.length / 2)],
    最远关卡最大: sorted[sorted.length - 1],
    命中率: ((hits / shots) * 100).toFixed(1) + '%',
  });
}
console.log('================ 精度 → 成绩 ================');
summary.forEach((r) => console.log(JSON.stringify(r)));

/* ============ 人类代理：4~8° 瞄偏 + 25% 手抖打歪 ============ */
function humanRun(seed) {
  const s = L.createGame({ rng: L._seededRng(seed) });
  const rng = L._seededRng(seed + 555);
  const pick = A.makeAimer();
  for (let lv = 1; lv <= 30; lv++) {
    L.beginLevel(s);
    let hand = null, guard = 0;
    while (s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling') {
      if (s.phase === 'swinging') {
        const p = pick(s);
        if (p) {
          // 每次出手的"手稳程度"和"会不会抖"定一次，但瞄的角度每帧跟着目标更新
          if (!hand) { hand = { tol: 4 + rng() * 4, shake: rng() < 0.25 }; }
          if (Math.abs(s.angle - p.a) <= hand.tol) {
            if (hand.shake) { s.angle += (rng() - 0.5) * 26; }   // 手抖打歪
            L.shoot(s); hand = null;
          }
        }
      }
      // 手里拉着石头 → 用炸药省时间（偶尔也会忘了用，所以加一点随机）
      if (s.phase === 'pulling' && s.held && s.held.isStone && s.dynamite > 0 && rng() < 0.8) {
        L.blowUp(s);
      }
      L.step(s, FPS);
      if (guard++ > 60 * 300) break;
    }
    if (s.phase !== 'levelClear') return { level: lv, score: s.score };
    L.nextLevel(s);
  }
  return { level: 30, score: s.score };
}

const human = [];
for (let i = 0; i < 16; i++) human.push(humanRun(77000 + i * 197));
const lv = human.map((h) => h.level).sort((a, b) => a - b);
const scores = human.map((h) => h.score).sort((a, b) => a - b);
console.log('\n================ 人类代理的成绩分布（16 局） ================');
console.log('最远关卡：', lv.join(', '));
console.log('  中位数', lv[Math.floor(lv.length / 2)], ' 最低', lv[0], ' 最高', lv[lv.length - 1]);
console.log('最终分数中位数', scores[Math.floor(scores.length / 2)]);
