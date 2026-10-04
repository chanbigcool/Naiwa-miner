/* 定位：瞄准物品中心发射，到底有没有真的命中它 */
const L = require('../miner/logic.js');
const FPS = 1 / 60;
const D2R = Math.PI / 180;

function firstHitAlong(s, a) {
  const lim = L.maxRopeLen(s, a);
  for (let d = s.cfg.ROPE_IDLE_LEN; d <= lim; d += 2) {
    const hit = L.findHit(s, L.hookPos(s, a, d));
    if (hit) return hit;
  }
  return null;
}

const s = L.createGame({ rng: L._seededRng(1) });
L.beginLevel(s);

/* 1. 几何自检：瞄准物品中心的射线，首个碰到的是不是它自己 */
let reach = 0, selfFirst = 0, blockedBy = [];
s.items.forEach((it) => {
  const a = Math.atan2(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y) / D2R;
  if (Math.abs(a) > s.cfg.SWING_AMPLITUDE) return;
  reach++;
  const first = firstHitAlong(s, a);
  if (first === it) selfFirst++;
  else blockedBy.push(`${it.type} 被 ${first ? first.type : '空'} 挡住`);
});
console.log(`① 瞄准物品中心的射线，首个命中的就是它自己：${selfFirst}/${reach}`);
if (blockedBy.length) console.log('   被挡住的：', blockedBy.slice(0, 6).join(' / '));

/* 2. 真枪实弹：把角度精确设成"指向某物品中心"，发射，看结果 */
function fireAt(a) {
  const fresh = L.createGame({ rng: L._seededRng(1) });
  fresh.items = s.items.map((x) => Object.assign({}, x, { grabbed: false, removed: false }));
  fresh.phase = 'swinging';
  fresh.angle = a;
  fresh.timeLeft = 999;
  L.shoot(fresh);
  for (let i = 0; i < 3000; i++) {
    L.step(fresh, FPS);
    if (fresh.phase === 'swinging') break;
  }
  return fresh;
}

let fired = 0, hitExact = 0, wrongItem = 0, miss = 0;
const samples = [];
s.items.forEach((it) => {
  const a = Math.atan2(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y) / D2R;
  if (Math.abs(a) > s.cfg.SWING_AMPLITUDE) return;
  fired++;
  const r = fireAt(a);
  const got = r.items.find((x) => x.removed);
  if (got && got.id === it.id) hitExact++;
  else if (got) { wrongItem++; if (samples.length < 5) samples.push(`瞄 ${it.type} 却抓到 ${got.type}`); }
  else { miss++; if (samples.length < 5) samples.push(`瞄 ${it.type} 结果抓空`); }
});
console.log(`\n② 精确瞄准物品中心发射：打中目标 ${hitExact}/${fired}，抓错 ${wrongItem}，抓空 ${miss}`);
if (samples.length) console.log('   例子：', samples.join(' / '));

/* 3. 是不是"射线几何"和"实际飞行"不一致？采样比对 */
const testItem = s.items.find((it) => {
  const a = Math.atan2(it.x - s.cfg.MINER_X, it.y - s.cfg.MINER_Y) / D2R;
  return Math.abs(a) <= 60 && it.r >= 30;
});
if (testItem) {
  const a = Math.atan2(testItem.x - s.cfg.MINER_X, testItem.y - s.cfg.MINER_Y) / D2R;
  console.log(`\n③ 抽查：目标 ${testItem.type} @ (${testItem.x.toFixed(0)}, ${testItem.y.toFixed(0)}) r=${testItem.r}，角度 ${a.toFixed(2)}°`);
  console.log('   maxRopeLen =', L.maxRopeLen(s, a).toFixed(1));

  // 沿射线找最小距离，看几何上到底能不能碰到
  let minDist = Infinity, atD = -1;
  const lim = L.maxRopeLen(s, a);
  for (let d = s.cfg.ROPE_IDLE_LEN; d <= lim; d += 1) {
    const p = L.hookPos(s, a, d);
    const dd = Math.hypot(p.x - testItem.x, p.y - testItem.y);
    if (dd < minDist) { minDist = dd; atD = d; }
  }
  console.log(`   沿射线离该物品中心最近 ${minDist.toFixed(2)}（需要 < ${testItem.r} 才算碰到），发生在绳长 ${atD}`);

  const r = fireAt(a);
  const got = r.items.find((x) => x.removed);
  console.log('   实际抓到：', got ? got.type : '（空）');
}
