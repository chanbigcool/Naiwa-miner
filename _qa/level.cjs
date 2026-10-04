/* 逐关收集率体检：一个"完美瞄准的机器人"能走多远、每关能收到面值的百分之多少。
 *
 * 收集率 = 本关得分 ÷ 本关物品面值。
 *   - 稳定低于 100% → 机器人也收不完，说明关卡偏紧
 *   - 远高于 100%   → 连击倍率吃得满满的，说明关卡偏松
 * 用它来判断"目标分该定在面值的几倍"。
 *
 * 机器人现在每帧重新瞄（见 _qa/aimlib.cjs 的说明）——
 * 只在单帧规划一次的话，遇到会爬的目标会一直打它规划时刻的旧位置。
 */
const L = require('../miner/logic.js');
const A = require('./aimlib.cjs');
const FPS = 1 / 60;

const s = L.createGame({ rng: L._seededRng(77000) });
console.log('关  物品数  可得分  目标增量  时间   发数  勾到  炸掉  得分增量  收集率');
let prevTarget = 0;

for (let lv = 1; lv <= 14; lv++) {
  const items = s.items.length;
  const top = L.achievableValue(s.items);
  const need = s.target - prevTarget;
  const before = s.score, shots0 = s.shots, bombs0 = s.bombs;

  L.beginLevel(s);
  const pick = A.makeAimer();          // 带粘性的瞄准器：目标锁住、角度实时更新
  let guard = 0, grabbed = 0;
  while (s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling') {
    if (s.phase === 'swinging') {
      const p = pick(s);
      if (p && Math.abs(s.angle - p.a) <= 1.5) { L.shoot(s); }
    }
    /* 手里拉着石头而且还有炸药 → 炸掉省时间。
     * 这是玩家真会做的事（石头要拉 5 秒以上、只值 5 分），
     * 机器人不这么做的话，量出来的收入会系统性偏低。 */
    if (s.phase === 'pulling' && s.held && s.held.isStone && s.dynamite > 0) { L.blowUp(s); }
    const rb = s.items.filter(x => x.removed).length;
    L.step(s, FPS);
    if (s.items.filter(x => x.removed).length > rb) grabbed++;
    if (guard++ > 60 * 300) break;
  }

  const gained = s.score - before;
  console.log(
    String(lv).padStart(2) + '  ' + String(items).padStart(5) + '  ' + String(top).padStart(6) +
    '  ' + String(need).padStart(8) + '  ' + (60 - s.timeLeft).toFixed(1).padStart(5) + 's' +
    '  ' + String(s.shots - shots0).padStart(4) + '  ' + String(grabbed).padStart(4) +
    '  ' + String(s.bombs - bombs0).padStart(4) +
    '  ' + String(gained).padStart(8) + '  ' + ((gained / top) * 100).toFixed(0).padStart(5) + '%'
  );

  prevTarget = s.target;
  if (s.phase !== 'levelClear') { console.log('  → 卡住，结束'); break; }
  L.nextLevel(s);
}
