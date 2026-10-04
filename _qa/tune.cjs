/* 数值体检：布局分布 + 命中率（模拟玩家的随机时机点击） */
const L = require('../miner/logic.js');
const C = L.CONFIG;
const FPS = 1 / 60;

/* ---------- 1. 布局分布 ---------- */
function layoutStats() {
  const bandCount = 5;
  const bands = new Array(bandCount).fill(0);
  let total = 0, minY = Infinity, maxY = -Infinity, count = 0;

  for (let k = 0; k < 200; k++) {
    const s = L.createGame({ rng: L._seededRng(1000 + k) });
    s.items.forEach((it) => {
      const t = (it.y - C.FIELD_Y) / C.FIELD_H;
      bands[Math.min(bandCount - 1, Math.floor(t * bandCount))]++;
      total++;
      count++;
      minY = Math.min(minY, it.y);
      maxY = Math.max(maxY, it.y);
    });
  }
  return {
    每局平均物品数: +(count / 200).toFixed(1),
    土层范围: [C.FIELD_Y, C.FIELD_Y + C.FIELD_H],
    实际y范围: [Math.round(minY), Math.round(maxY)],
    各层占比: bands.map((n) => +((n / total) * 100).toFixed(1) + '%'),
  };
}

/* ---------- 2. 命中率：模拟"随机时机点一下"的玩家 ---------- */
function hitRate(intervalMin, intervalMax, games) {
  let shots = 0, hits = 0, scores = [];
  for (let g = 0; g < games; g++) {
    const s = L.createGame({ rng: L._seededRng(5000 + g) });
    L.beginLevel(s);
    s.timeLeft = 1e6;                       // 屏蔽时间，只看命中
    const rng = L._seededRng(7000 + g);
    let wait = intervalMin + rng() * (intervalMax - intervalMin);
    for (let i = 0; i < 4000; i++) {
      if (s.phase === 'swinging') {
        wait -= FPS;
        if (wait <= 0) {
          L.shoot(s);
          wait = intervalMin + rng() * (intervalMax - intervalMin);
        }
      }
      L.step(s, FPS);
      s.timeLeft = 1e6;
    }
    shots += s.shots;
    hits += s.hits;
    scores.push(s.score);
  }
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { 命中率: ((hits / shots) * 100).toFixed(1) + '%', 总发数: shots, 命中: hits, 平均得分: avg };
}

/* ---------- 3. 一局 60 秒能拿多少分（用固定时机点击） ---------- */
function oneLevel(seedN, interval) {
  const s = L.createGame({ rng: L._seededRng(seedN) });
  L.beginLevel(s);
  const rng = L._seededRng(seedN + 99);
  let wait = interval;
  while (s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling') {
    if (s.phase === 'swinging') {
      wait -= FPS;
      if (wait <= 0) { L.shoot(s); wait = interval * (0.6 + rng() * 0.8); }
    }
    L.step(s, FPS);
  }
  return { score: s.score, target: s.target, pass: s.phase === 'levelClear', shots: s.shots, hits: s.hits };
}

console.log('================ 布局分布 ================');
console.log(JSON.stringify(layoutStats(), null, 2));

console.log('\n================ 命中率（随机时机点击） ================');
for (const [a, b] of [[0.8, 1.6], [1.2, 2.4], [0.4, 0.9]]) {
  console.log(`间隔 ${a}~${b}s  →`, JSON.stringify(hitRate(a, b, 12)));
}

console.log('\n================ 一局能打多少分（含目标分） ================');
const rows = [];
for (let i = 0; i < 24; i++) { rows.push(oneLevel(9000 + i, 1.3)); }
const passes = rows.filter((r) => r.pass).length;
const avgScore = Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length);
const avgTarget = Math.round(rows.reduce((a, r) => a + r.target, 0) / rows.length);
const avgShots = Math.round(rows.reduce((a, r) => a + r.shots, 0) / rows.length);
const avgHits = +(rows.reduce((a, r) => a + r.hits, 0) / rows.length).toFixed(1);
console.log(JSON.stringify({
  过关局数: `${passes}/24`,
  平均得分: avgScore,
  平均目标: avgTarget,
  平均发数: avgShots,
  平均命中: avgHits,
  该打法命中率: ((avgHits / avgShots) * 100).toFixed(1) + '%',
}, null, 2));
