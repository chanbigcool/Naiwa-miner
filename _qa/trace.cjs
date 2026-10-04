/* 逐发全量追踪：每一发都记，包括抓空的 */
const L = require('../miner/logic.js');
const FPS = 1 / 60;

function firstHitAlong(s, a) {
  const lim = L.maxRopeLen(s, a);
  for (let d = s.cfg.ROPE_IDLE_LEN; d <= lim; d += 2) {
    const hit = L.findHit(s, L.hookPos(s, a, d));
    if (hit) return hit;
  }
  return null;
}
function aim(s) {
  let best = null;
  for (let a = -75; a <= 75; a += 0.5) {
    const it = firstHitAlong(s, a);
    if (!it || it.isAngel || it.value <= 5) continue;
    const score = it.value / it.weight;
    if (!best || score > best.score) {
      // 关键：瞄准物品的"中心角度"，而不是它刚成为最优的那个边缘角度。
      // 早期版本用了边缘角度，机器人等于站在悬崖边上开枪，偏 0.4° 就打空。
      const centerA = Math.atan2(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y) * 180 / Math.PI;
      if (Math.abs(centerA) > s.cfg.SWING_AMPLITUDE) continue;
      best = { a: centerA, it, score };
    }
  }
  return best;
}

const TOL = 1.0;
const s = L.createGame({ rng: L._seededRng(31000) });
L.beginLevel(s);

console.log('每发记录：计划角度 / 实际角度 / 发射瞬间"该角度上真的有什么" / 结果\n');

let planned = null, shot = null, n = 0, hitCount = 0, emptyCount = 0;
const angleErrors = [];

while (n < 20 && s.timeLeft > 0) {
  if (s.phase === 'swinging') {
    if (!planned || planned.it.removed) { planned = aim(s) || { a: 0, it: { type: '石堆' }, junk: true }; }
    if (Math.abs(s.angle - planned.a) <= TOL) {
      // 关键诊断：发射瞬间，当前角度上到底有什么？
      const actual = firstHitAlong(s, s.angle);
      const atPlan = firstHitAlong(s, planned.a);
      shot = {
        n: ++n,
        want: planned.it.type,
        wantA: planned.a,
        fireA: s.angle,
        reallyThere: actual ? actual.type : '（空）',
        atPlan: atPlan ? atPlan.type : '（空）',
        planItem: planned.it,
        actualItem: actual,
      };
      angleErrors.push(Math.abs(s.angle - planned.a));
      L.shoot(s);
      planned = null;
    }
  }
  const removedBefore = s.items.filter((x) => x.removed).length;
  L.step(s, FPS);
  const removedNow = s.items.filter((x) => x.removed).length;

  if (shot && removedNow > removedBefore) {
    const newly = s.items.filter((x) => x.removed)[removedNow - 1];
    const isWant = newly && newly.type === shot.want;
    if (isWant) hitCount++;
    console.log(
      `第${String(shot.n).padStart(2)}发  计划 ${shot.want.padEnd(7)}@${shot.wantA.toFixed(2).padStart(7)}°  ` +
      `发射 ${shot.fireA.toFixed(2).padStart(7)}°  ` +
      `计划角->${String(shot.atPlan).padEnd(7)} 发射角->${String(shot.reallyThere).padEnd(7)}  ` +
      `→ 抓到 ${newly ? newly.type : '?'}`
    );
    shot = null;
  } else if (shot && s.phase === 'swinging') {
    emptyCount++;
    const P = shot.planItem, A = shot.actualItem;
    console.log(
      `第${String(shot.n).padStart(2)}发  计划 ${shot.want.padEnd(7)}@${shot.wantA.toFixed(2).padStart(7)}°  ` +
      `发射 ${shot.fireA.toFixed(2).padStart(7)}°  ` +
      `计划角->${String(shot.atPlan).padEnd(7)} 发射角->${String(shot.reallyThere).padEnd(7)}  → 抓空`
    );
    if (P && isFinite(P.x)) {
      const dist = Math.hypot(P.x - s.cfg.MINER_X, P.y - s.cfg.MINER_Y);
      const a = Math.atan2(P.x - s.cfg.MINER_X, P.y - s.cfg.MINER_Y) * 180 / Math.PI;
      console.log(`      ${P.type} 在 (${P.x.toFixed(0)}, ${P.y.toFixed(0)}) r=${P.r} 距离=${dist.toFixed(0)} 真实角度=${a.toFixed(2)}° ` +
        `半宽=${(Math.atan(P.r / dist) * 180 / Math.PI).toFixed(2)}°`);
    }
    if (A && isFinite(A.x)) {
      const dist = Math.hypot(A.x - s.cfg.MINER_X, A.y - s.cfg.MINER_Y);
      const a = Math.atan2(A.x - s.cfg.MINER_X, A.y - s.cfg.MINER_Y) * 180 / Math.PI;
      console.log(`      实际命中 ${A.type} 距离=${dist.toFixed(0)} 真实角度=${a.toFixed(2)}° ` +
        `半宽=${(Math.atan(A.r / dist) * 180 / Math.PI).toFixed(2)}°`);
    }
    shot = null;
  }
}

const avg = angleErrors.reduce((a, b) => a + b, 0) / angleErrors.length;
console.log(`\n共 ${n} 发：有收获 ${hitCount}，抓空 ${emptyCount}`);
console.log(`平均瞄准误差 ${avg.toFixed(3)}°  最大 ${Math.max(...angleErrors).toFixed(3)}°`);
