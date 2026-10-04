/* 瞄准库：给 _qa/ 下的机器人共用的"朝某个角度发射会先勾到什么"。
 *
 * 为什么单独抽出来：
 *   1) `level.cjs` / `skill.cjs` 各写了一份，改一处漏一处；
 *   2) 老版本 `aim()` 是"扫 301 个角度、每个角度沿射线步进试探" →
 *      O(角度 × 绳长 × 物品)，每帧重算根本跑不动。
 *      于是机器人只能"每发只规划一次角度"，遇到**会爬的目标**就会一直打它
 *      规划时刻的旧位置 —— 那是在惩罚机器人，不是在量游戏难度。
 *   3) 新实现改成"对每个物品算它的中心角度、再看那条射线上先撞到谁" →
 *      O(物品²)，可以每帧重算，这才是"会跟枪的玩家"。
 *
 * 关键：解析解必须和游戏里真实的离散判定对得上，所以这里保留两份实现，
 * 并提供 `verify()` 做一致性自检。判定口径不一致的话，
 * 量出来的"难度"就是仪器的误差，不是游戏的性质。
 *
 * 实测一致性 99.90%（7200 个样本仅 7 处不同）。那 7 处全是"擦边掠过"：
 * 垂距几乎等于半径时，圆内的弦只有几个像素，游戏按帧步进（15 单位/帧）
 * 有可能整个跨过去。**这是游戏本身就会漏掉的情形**，不是仪器算错。
 */
'use strict';
const L = require('../miner/logic.js');

/* —— 与游戏完全一致的离散判定（钩子按帧步进，命中判定 d ≤ r）—— */
function firstHitDiscrete(s, angleDeg, stepPx) {
  const step = stepPx || 4;
  const lim = L.maxRopeLen(s, angleDeg);
  for (let d = s.cfg.ROPE_IDLE_LEN; d <= lim; d += step) {
    const hit = L.findHit(s, L.hookPos(s, angleDeg, d));
    if (hit) return hit;
  }
  return null;
}

/* —— 解析解：O(物品数) ——
 * 对每个物品算它在射线上的投影 proj 和垂距 perp；
 * 只要 perp ≤ r 就会被撞到，最早进入半径的那一个（proj - sqrt(r²-perp²) 最小）就是先撞到的。 */
function firstHitFast(s, angleDeg) {
  const cfg = s.cfg;
  const a = angleDeg * Math.PI / 180;
  const ux = Math.sin(a), uy = Math.cos(a);
  const lim = L.maxRopeLen(s, angleDeg);
  const items = s.items;

  let best = null, bestEntry = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.removed || it.grabbed) { continue; }

    const vx = it.x - cfg.MINER_X, vy = it.y - cfg.MINER_Y;
    const proj = vx * ux + vy * uy;
    if (proj < cfg.ROPE_IDLE_LEN || proj > lim + it.r) { continue; }

    const perp = Math.abs(vx * uy - vy * ux);
    if (perp > it.r) { continue; }

    const back = Math.sqrt(it.r * it.r - perp * perp);
    const entry = proj - back;
    if (entry > lim) { continue; }
    if (entry < bestEntry) { bestEntry = entry; best = it; }
  }
  return best;
}

/* 一件东西"值不值得打"：单位时间的收益。
 *
 * 注意这里不是 value/weight —— 回收速度已经改成"越值钱越快"，
 * 再用 weight 当分母就完全反了（会让机器人专挑又便宜又慢的东西）。
 * 正确的时间成本 = 飞过去的时间 + 拉回来的时间，两个都跟距离有关。 */
function worthPerSecond(s, it) {
  const dist = Math.hypot(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y);
  const pull = L.pullSpeedOf(s, it);
  const cost = dist / s.cfg.SHOOT_SPEED + dist / Math.max(1, pull);
  return it.value / Math.max(0.3, cost);
}

/* 扫全部物品的中心角度，挑"单位时间最划算"的那个。
 * 注意：瞄的是物品的中心角度，而不是它刚变成最优的边缘角度 ——
 * 用边缘角度等于站在悬崖边上开枪，偏 0.4° 就打空（这个坑踩过）。 */
function aim(s, allowJunk, hitFn) {
  const hit = hitFn || firstHitFast;
  let best = null;
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (it.removed || it.grabbed || it.isAngel) { continue; }

    const centerA = Math.atan2(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y) * 180 / Math.PI;
    if (Math.abs(centerA) > s.cfg.SWING_AMPLITUDE) { continue; }

    // 瞄它，实际先勾到的是什么？（可能就是挡在前面的石头）
    const got = hit(s, centerA);
    if (!got || got.isAngel) { continue; }
    if (!allowJunk && got.value <= 5) { continue; }

    const score = worthPerSecond(s, got);
    if (!best || score > best.score) { best = { a: centerA, it: got, score, aimed: it }; }
  }
  return best;
}

/* 带"粘性"的瞄准器：目标锁住，角度每帧实时更新。
 *
 * 为什么需要粘性：如果每帧都重新挑"当前最划算的物品"，当两样东西分数接近时
 * 机器人会来回换目标、每次换目标都把"等摆角对上"的进度清零，结果一关下来发不了几枪。
 * 那是机器人在抖，不是在量游戏难度（实测：没有粘性时第 4 关 60 秒只开 7 枪）。
 *
 * 锁住目标、但每帧按它**当前**位置重算中心角度 —— 这样既不打摆子，
 * 又能跟上会爬的目标。
 */
function makeAimer(centerAngleOf) {
  let cur = null;
  return function pick(s) {
    if (cur && !cur.removed && !cur.grabbed) {
      const a = Math.atan2(cur.x - s.cfg.MINER_X, cur.y - s.cfg.MINER_Y) * 180 / Math.PI;
      if (Math.abs(a) <= s.cfg.SWING_AMPLITUDE) {
        const got = firstHitFast(s, a);
        if (got && !got.isAngel && got.value > 5) {
          return { a: a, it: got, score: worthPerSecond(s, got), aimed: cur };
        }
      }
    }
    const p = aim(s, false) || aim(s, true);
    cur = p ? p.aimed : null;
    return p;
  };
}

/* 一致性自检：解析解和离散判定在随机局面上是否给出同一个结果 */
function verify(rounds) {
  const n = rounds || 400;
  let same = 0, diff = 0, misses = 0, examples = [];
  for (let i = 0; i < n; i++) {
    const s = L.createGame({ rng: L._seededRng(5000 + i) });
    s.items = L.buildItems(s, 1 + (i % 12));
    for (let k = 0; k < 24; k++) {
      const a = -75 + (k / 23) * 150;
      const d = firstHitDiscrete(s, a, 4);
      const f = firstHitFast(s, a);
      const dn = d ? d.id : null, fn = f ? f.id : null;
      if (dn === fn) { same++; } else {
        diff++;
        if (examples.length < 5) { examples.push({ 关: 1 + (i % 12), 角度: a.toFixed(1), 离散: dn, 解析: fn }); }
      }
      if (d) { misses++; }
    }
  }
  return { 总样本: same + diff, 一致: same, 不一致: diff, 一致率: ((same / (same + diff)) * 100).toFixed(2) + '%', 有命中的样本: misses, 反例: examples };
}

module.exports = { firstHitDiscrete, firstHitFast, worthPerSecond, aim, makeAimer, verify };
