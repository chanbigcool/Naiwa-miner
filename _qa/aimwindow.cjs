/* 瞄准可行性分析：钩子扫过一个物品，窗口开着多久？
 * 窗口太窄（<80ms，人反应精度量级）就意味着玩家没法瞄，只能碰运气。
 */
const L = require('../miner/logic.js');
const C = L.CONFIG;
const D2R = Math.PI / 180;

const MX = C.MINER_X, MY = C.MINER_Y;

/* 钟摆：角速度随角度变化，两端慢、中间快 */
function speedPendulum(angleDeg, period) {
  const A = C.SWING_AMPLITUDE;
  const r = Math.min(1, Math.abs(angleDeg) / A);
  return A * (2 * Math.PI / period) * Math.sqrt(Math.max(0, 1 - r * r));  // 度/秒
}

/* 匀速三角波：角速度恒定 */
function speedLinear(period) {
  return (2 * C.SWING_AMPLITUDE) / (period / 2);
}

function analyze(period, label) {
  const windows = [];
  let reachable = 0, total = 0;

  for (let k = 0; k < 60; k++) {
    const s = L.createGame({ rng: L._seededRng(4000 + k) });
    s.items.forEach((it) => {
      total++;
      const dx = it.x - MX, dy = it.y - MY;
      const angle = Math.atan2(dx, dy) / D2R;
      if (Math.abs(angle) > C.SWING_AMPLITUDE) return;      // 摆不到，够不着
      reachable++;
      const dist = Math.hypot(dx, dy);
      const halfWidth = Math.atan(it.r / dist) / D2R;       // 物品的角半径（度）
      const spd = label === 'pendulum' ? speedPendulum(angle, period) : speedLinear(period);
      if (spd <= 0.001) return;
      windows.push((2 * halfWidth / spd) * 1000);           // 毫秒
    });
  }

  windows.sort((a, b) => a - b);
  const pct = (p) => windows[Math.floor(windows.length * p)];
  const easy = windows.filter((w) => w >= 80).length / windows.length;

  return {
    摆周期: period + 's',
    可取到物品占比: ((reachable / total) * 100).toFixed(1) + '%',
    窗口_中位数: pct(0.5).toFixed(0) + 'ms',
    窗口_10分位: pct(0.1).toFixed(0) + 'ms',
    窗口_90分位: pct(0.9).toFixed(0) + 'ms',
    可瞄物品占比: (easy * 100).toFixed(1) + '%',
  };
}

console.log('================ 瞄准窗口分析（当前：钟摆 @ 2.4s） ================');
console.log(JSON.stringify(analyze(2.4, 'pendulum'), null, 2));

console.log('\n================ 若把摆周期放慢 ================');
[3.0, 3.6, 4.2].forEach((p) => console.log(JSON.stringify(analyze(p, 'pendulum'))));

console.log('\n================ 若改成"匀速来回"（角速度恒定） ================');
[2.4, 3.0, 3.6].forEach((p) => console.log(JSON.stringify(analyze(p, 'linear'))));

console.log('\n注：80ms 大致是人对"看到→按下"的精度下限。窗口低于这个值，瞄准就变成碰运气。');
