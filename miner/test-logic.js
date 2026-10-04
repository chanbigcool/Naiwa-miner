/*
 * 奶蛙矿工 · 逻辑测试（Node 直接跑：node miner/test-logic.js）
 * ---------------------------------------------------------------------------
 * 只测 logic.js，不碰 DOM / Canvas。随机源全部换成固定种子，结果可复现。
 */
'use strict';

var L = require('./logic.js');

/* ---------------------------------- 微型测试框架 ---------------------------------- */
var pass = 0, fail = 0, lines = [];
function test(name, fn) {
  try {
    fn();
    pass++; lines.push('  \u2713 ' + name);
  } catch (e) {
    fail++; lines.push('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message : e));
  }
}
function assert(cond, msg) { if (!cond) { throw new Error(msg || '断言失败'); } }
function eq(a, b, msg) {
  if (a !== b) { throw new Error((msg || '不相等') + '：期望 ' + b + '，实际 ' + a); }
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > (tol === undefined ? 1e-6 : tol)) {
    throw new Error((msg || '数值偏差过大') + '：期望 ' + b + '±' + tol + '，实际 ' + a);
  }
}

/* ---------------------------------- 测试工具 ---------------------------------- */
var FPS = 1 / 60;

/* 推进若干秒，收集事件；遇到指定事件类型提前停 */
function advance(state, seconds, wantType) {
  var evs = [], t = 0, hit = null;
  while (t < seconds - 1e-9) {
    var ev = L.step(state, FPS);
    t += FPS;
    if (ev.length) {
      evs = evs.concat(ev);
      if (wantType) {
        for (var i = 0; i < ev.length; i++) {
          if (ev[i].type === wantType) { hit = ev[i]; break; }
        }
        if (hit) { break; }
      }
    }
    if (state.phase === 'levelClear' || state.phase === 'gameOver') { break; }
  }
  return { evs: evs, hit: hit, t: t };
}

/* 造一个受控场地：清空随机布局，只放我们指定的东西 */
function setField(state, specs) {
  state.items = specs.map(function (s, i) {
    var def = L.ITEMS[s.type];
    return {
      id: i, type: s.type, name: def.name, img: def.img, tint: def.tint,
      x: s.x, y: s.y, r: def.r, size: def.size,
      homeX: s.x, homeY: s.y,
      weight: s.weight === undefined ? def.weight : s.weight,
      value: s.value === undefined ? L.itemValue(s.type, function () { return 0; }) : s.value,
      isStone: !!def.isStone, isAngel: !!def.isAngel, timeBonus: def.timeBonus || 0,
      grabbed: false, removed: false, wobble: 0,
    };
  });
  return state;
}

/* 在矿工正下方 y 距离处放一个物品，钩子垂直下放必中 */
function belowMiner(state, type, dist, extra) {
  var spec = { type: type, x: state.cfg.MINER_X, y: state.cfg.MINER_Y + dist };
  if (extra) { for (var k in extra) { spec[k] = extra[k]; } }
  return setField(state, [spec]);
}

function newGame(opts) {
  var o = { rng: L._seededRng(20261004) };
  if (opts) { for (var k in opts) { o[k] = opts[k]; } }
  return L.createGame(o);
}

/* 让钩子垂直射出：把摆动推到正中并锁定角度 */
function shootStraightDown(state) {
  state.phase = 'swinging';
  state.angle = 0;
  var ev = L.shoot(state);
  return ev;
}

/* ==================================================================================
 * A. 纯函数
 * ================================================================================== */
console.log('\nA. 纯函数');

test('comboMult：连击 0~2 → ×1', function () {
  var c = L.CONFIG;
  eq(L.comboMult(0, c), 1); eq(L.comboMult(2, c), 1);
});
test('comboMult：连击 3~5 → ×2，6~8 → ×3，9+ → ×4', function () {
  var c = L.CONFIG;
  eq(L.comboMult(3, c), 2); eq(L.comboMult(5, c), 2);
  eq(L.comboMult(6, c), 3); eq(L.comboMult(8, c), 3);
  eq(L.comboMult(9, c), 4);
});
test('comboMult：倍率封顶 ×4，不会无限涨', function () {
  eq(L.comboMult(999, L.CONFIG), L.CONFIG.MULT_MAX);
});
test('laughLevel：0 → 0，连击 8 → 1，且封顶在 1', function () {
  var c = L.CONFIG;
  eq(L.laughLevel(0, c), 0);
  eq(L.laughLevel(8, c), 1);
  eq(L.laughLevel(50, c), 1);
});
test('itemValue：固定值物品返回固定值', function () {
  eq(L.itemValue('god', Math.random), 600);
  eq(L.itemValue('angel', Math.random), -150);
});
test('itemValue：幸运袋落在 100~300 区间内', function () {
  var rng = L._seededRng(7);
  for (var i = 0; i < 300; i++) {
    var v = L.itemValue('laugh', rng);
    assert(v >= 100 && v <= 300, '幸运袋取值越界：' + v);
  }
});
test('hookPos：角度 0 时钩子在矿工正下方', function () {
  var s = newGame();
  var p = L.hookPos(s, 0, 200);
  near(p.x, s.cfg.MINER_X, 1e-9);
  near(p.y, s.cfg.MINER_Y + 200, 1e-9);
});
test('hookPos：正角度偏右、负角度偏左', function () {
  var s = newGame();
  assert(L.hookPos(s, 45, 200).x > s.cfg.MINER_X, '正角度应偏右');
  assert(L.hookPos(s, -45, 200).x < s.cfg.MINER_X, '负角度应偏左');
});

/* ==================================================================================
 * B. 建局与布局
 * ================================================================================== */
console.log('\nB. 建局与布局');

test('createGame：初始状态正确', function () {
  var s = newGame();
  eq(s.phase, 'ready');
  eq(s.level, 1);
  eq(s.score, 0);
  eq(s.combo, 0);
  eq(s.timeLeft, s.cfg.LEVEL_TIME);
  assert(s.target > 0, '目标分应该大于 0');
  assert(s.items.length > 0, '应该有物品');
});

test('createGame：所有物品都落在可抓取区域内', function () {
  var s = newGame();
  var f = { x: s.cfg.FIELD_X, y: s.cfg.FIELD_Y, w: s.cfg.FIELD_W, h: s.cfg.FIELD_H };
  for (var i = 0; i < s.items.length; i++) {
    var it = s.items[i];
    assert(it.x - it.r >= f.x - 1e-6, '物品 ' + it.type + ' 越出左边界');
    assert(it.x + it.r <= f.x + f.w + 1e-6, '物品 ' + it.type + ' 越出右边界');
    assert(it.y - it.r >= f.y - 1e-6, '物品 ' + it.type + ' 越出上边界');
    assert(it.y + it.r <= f.y + f.h + 1e-6, '物品 ' + it.type + ' 越出下边界');
  }
});

test('createGame：物品之间互不重叠', function () {
  var s = newGame();
  for (var i = 0; i < s.items.length; i++) {
    for (var j = i + 1; j < s.items.length; j++) {
      var a = s.items[i], b = s.items[j];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      assert(d >= a.r + b.r, '物品 ' + i + '(' + a.type + ') 与 ' + j + '(' + b.type + ') 重叠，间距 ' + d.toFixed(1));
    }
  }
});

test('createGame：同一随机种子 → 完全相同的布局（可复现）', function () {
  var a = newGame(), b = newGame();
  eq(a.items.length, b.items.length, '物品数量应一致');
  for (var i = 0; i < a.items.length; i++) {
    eq(a.items[i].type, b.items[i].type, '第 ' + i + ' 个物品种类应一致');
    near(a.items[i].x, b.items[i].x, 1e-9);
    near(a.items[i].y, b.items[i].y, 1e-9);
    eq(a.items[i].value, b.items[i].value, '第 ' + i + ' 个物品价值应一致');
  }
});

test('createGame：不同种子 → 布局不同', function () {
  var a = L.createGame({ rng: L._seededRng(1) });
  var b = L.createGame({ rng: L._seededRng(2) });
  var diff = false;
  for (var i = 0; i < Math.min(a.items.length, b.items.length); i++) {
    if (Math.abs(a.items[i].x - b.items[i].x) > 1e-6) { diff = true; break; }
  }
  assert(diff, '不同种子应产生不同布局');
});

test('recipe：关卡越高垃圾越多（石头 + 炸弹单调不减）', function () {
  // 难度的真正来源是"时间被垃圾吃掉"：石头重得离谱，炸弹扣分又断连击。
  // 所以这条断言的是垃圾**单调不减** —— 早期版本这里断言的是反过来的"好货单调增加"，
  // 那正是造成"越打越简单"的原因，已经被刻意反转掉了。
  function junk(lv) {
    return L.recipe(lv).filter(function (t) { return t === 'stone' || t === 'angel'; }).length;
  }
  for (var lv = 1; lv <= 14; lv++) {
    assert(junk(lv + 1) >= junk(lv), '第 ' + (lv + 1) + ' 关的垃圾不该少于第 ' + lv + ' 关');
  }
  assert(junk(10) >= junk(1) * 2,
    '第 10 关的垃圾应该明显多于第 1 关，实际 ' + junk(10) + ' vs ' + junk(1));
});

test('recipe：小件随关卡递减（逼玩家去打重物）', function () {
  function light(lv) {
    return L.recipe(lv).filter(function (t) { return t === 'blob' || t === 'stand'; }).length;
  }
  assert(light(1) > light(10), '第 1 关的小件该多于第 10 关，实际 ' + light(1) + ' vs ' + light(10));
  assert(light(12) >= 2, '第 12 关也要留至少 2 个小件，否则连击根本无从建立（会变成纯看脸）');
});

test('第 1 关必须有足量轻货可刷（保证开局不憋屈）', function () {
  var r = L.recipe(1);
  var light = r.filter(function (t) { return ['blob', 'stand', 'mouse'].indexOf(t) >= 0; }).length;
  assert(light >= 6, '第 1 关轻货至少 6 个，实际 ' + light);
});

test('目标分自适应：不会超过本关理论上限（含连击倍率）', function () {
  var s = newGame();
  // 上限要按"面值 × 最高倍率"算：连击倍率最高 ×4，所以目标可以高于物品面值
  var ceiling = L.achievableValue(s.items) * s.cfg.MULT_MAX;
  assert(s.target < ceiling,
    '目标分 ' + s.target + ' 应低于理论上限 ' + ceiling + '（面值 × ×' + s.cfg.MULT_MAX + '）');
  assert(s.target >= s.cfg.TARGET_BASE, '目标分不应低于下限');
});

test('难度确实会爬升：后期关卡的目标分超过物品面值', function () {
  var s = newGame();
  function targetAt(lv) {
    var t = 0, cfg = s.cfg;
    for (var k = 1; k <= lv; k++) {
      var items = L.buildItems({ cfg: cfg, rng: L._seededRng(9000 + k) }, k);
      var ratio = Math.min(cfg.TARGET_RATIO_MAX, cfg.TARGET_RATIO_BASE + (k - 1) * cfg.TARGET_RATIO_STEP);
      t += Math.max(cfg.TARGET_BASE, Math.round(L.achievableValue(items) * ratio));
    }
    return t;
  }
  function faceAt(lv) {
    var s2 = newGame();
    var total = 0;
    for (var k = 1; k <= lv; k++) {
      total += L.achievableValue(L.buildItems({ cfg: s2.cfg, rng: L._seededRng(9000 + k) }, k));
    }
    return total;
  }
  // 第 1 关应当宽松：目标低于面值，新手不会一上来就卡住
  assert(targetAt(1) < faceAt(1), '第 1 关目标 ' + targetAt(1) + ' 应低于面值 ' + faceAt(1));
  // 后期必须反过来：目标高于面值，逼玩家靠连击倍率才够分
  assert(targetAt(12) > faceAt(12),
    '第 12 关目标 ' + targetAt(12) + ' 应高于面值 ' + faceAt(12) + '，否则难度形同虚设');
});

test('目标分逐关递增', function () {
  var s = newGame();
  var t1 = s.target;
  L.beginLevel(s);
  s.timeLeft = 0; s.score = 999999; L.step(s, FPS);
  eq(s.phase, 'levelClear');
  L.nextLevel(s);
  assert(s.target > t1, '第 2 关目标分应高于第 1 关：' + s.target + ' vs ' + t1);
});

/* ==================================================================================
 * C. 摆动与发射
 * ================================================================================== */
console.log('\nC. 摆动与发射');

test('摆动：角度始终不超过 ±SWING_AMPLITUDE', function () {
  var s = newGame();
  L.beginLevel(s);
  for (var i = 0; i < 600; i++) {
    L.step(s, FPS);
    assert(Math.abs(s.angle) <= s.cfg.SWING_AMPLITUDE + 1e-6,
      '角度越界：' + s.angle.toFixed(2));
  }
});

test('摆动：一个周期后角度回到起点（周期性）', function () {
  var s = newGame();
  L.beginLevel(s);
  L.step(s, 0.01);
  var a0 = s.angle;
  // 推进整整一个周期
  var steps = Math.round(s.cfg.SWING_PERIOD / FPS);
  for (var i = 0; i < steps; i++) { L.step(s, FPS); }
  near(s.angle, a0, 0.35, '一个周期后角度应基本回到原处');
});

test('shoot：只有待机（swinging）时才能发射', function () {
  var s = newGame();
  eq(L.shoot(s).length, 0, 'ready 状态不该能发射');
  L.beginLevel(s);
  eq(s.phase, 'swinging');
  eq(L.shoot(s).length, 1, '待机时应能发射');
  eq(s.phase, 'shooting');
  eq(L.shoot(s).length, 0, '射出过程中不该能二次发射');
});

test('shoot：发射后角度被锁定，不再随摆动变化', function () {
  var s = newGame();
  L.beginLevel(s);
  for (var i = 0; i < 30; i++) { L.step(s, FPS); }
  L.shoot(s);
  var locked = s.angle;
  var n = 0;
  while (s.phase === 'shooting' || s.phase === 'pulling') {
    L.step(s, FPS);
    near(s.angle, locked, 1e-9, '射出/回收过程中角度不该变');
    if (++n > 900) { break; }
  }
  assert(n > 0, '应该真的经历了一段射出过程');
  assert(n < 900, '这一发不该卡住回不来');
});

test('节奏不锁死：固定节奏点击会扫过各种角度（回归测试）', function () {
  // 曾经的 bug：每发之后把摆动相位归零 → 钩子总从正中重新起摆，
  // 于是"固定节奏点击"每次落到同一角度，点得越稳反而越打不中（实测命中率 1.1%）。
  var s = newGame();
  L.beginLevel(s);
  var angles = [];
  for (var k = 0; k < 10; k++) {
    var g = 0;
    while (s.phase !== 'swinging' && g++ < 4000) { L.step(s, FPS); }
    for (var i = 0; i < 36; i++) { L.step(s, FPS); }      // 每次固定等 0.6 秒
    angles.push(s.angle);
    L.shoot(s);
  }
  var lo = Math.min.apply(null, angles), hi = Math.max.apply(null, angles);
  assert(hi - lo > 60,
    '固定节奏下 10 次发射的角度跨度只有 ' + (hi - lo).toFixed(1) + '°，说明摆动被锁死在窄区间里了');
});

test('摆钟相位只增不减', function () {
  var s = newGame();
  L.beginLevel(s);
  var prev = s.swingClock;
  for (var i = 0; i < 600; i++) {
    if (s.phase === 'swinging') { L.shoot(s); }
    L.step(s, FPS);
    assert(s.swingClock > prev, 'swingClock 出现停滞/回退：' + s.swingClock + ' <= ' + prev);
    prev = s.swingClock;
  }
});

test('两种摆动模式都落在 ±SWING_AMPLITUDE 之内', function () {
  ['linear', 'swing'].forEach(function (mode) {
    var s = newGame({ config: { SWING_MODE: mode } });
    L.beginLevel(s);
    for (var i = 0; i < 900; i++) {
      L.step(s, FPS);
      assert(Math.abs(s.angle) <= s.cfg.SWING_AMPLITUDE + 1e-6,
        mode + ' 模式角度越界：' + s.angle.toFixed(2));
    }
  });
});

test('匀速模式的每帧角度变化显著小于钟摆模式（手感核心取舍）', function () {
  // 钟摆中间角速度是匀速的 ~1.6 倍，导致瞄准窗口只有 ~2.6 帧，玩家没法瞄。
  // 这条测试守着"默认必须用匀速"这个决定。
  function maxStep(mode) {
    var s = newGame({ config: { SWING_MODE: mode } });
    L.beginLevel(s);
    var prev = s.angle, mx = 0;
    for (var i = 0; i < 900; i++) {
      L.step(s, FPS);
      mx = Math.max(mx, Math.abs(s.angle - prev));
      prev = s.angle;
    }
    return mx;
  }
  var lin = maxStep('linear');
  var sw = maxStep('swing');
  assert(lin < sw * 0.8,
    '匀速模式每帧最大转角 ' + lin.toFixed(2) + '° 应显著小于钟摆的 ' + sw.toFixed(2) + '°');
  assert(lin <= 2.2,
    '匀速模式每帧最大转角 ' + lin.toFixed(2) + '° 偏大，中等大小的物品窗口会少于 3 帧');
});

test('默认配置用的是匀速模式', function () {
  eq(newGame().cfg.SWING_MODE, 'linear');
});

test('levelStart 时钩子从正中起摆', function () {
  var s = newGame();
  L.beginLevel(s);
  near(s.angle, 0, 1e-9, '开局钩子应该在正中');
});

test('几何自洽：悬挂点高度必须让整个摆动锥收在土层内', function () {
  var s = newGame(), c = s.cfg;
  var drop = c.FIELD_Y - c.MINER_Y;                 // 悬挂点到土层顶边的距离
  var halfCone = drop * Math.tan(c.SWING_AMPLITUDE * Math.PI / 180);
  var halfField = c.FIELD_W / 2;
  assert(drop > 0, '悬挂点必须在土层顶边之上');
  assert(halfCone <= halfField,
    '摆动锥在土层顶边处半宽 ' + halfCone.toFixed(1) + ' 超过了土层半宽 ' + halfField.toFixed(1) +
    '，大角度射出会钻出场外');
});

test('钩子的极限位置全部落在土层边界上（只扫摆动范围内的角度）', function () {
  var s = newGame(), c = s.cfg;
  var amp = c.SWING_AMPLITUDE;
  for (var deg = -amp; deg <= amp; deg += 1) {
    var lim = L.maxRopeLen(s, deg);
    var p = L.hookPos(s, deg, lim);
    assert(p.x >= c.FIELD_X - 1e-6 && p.x <= c.FIELD_X + c.FIELD_W + 1e-6,
      '角度 ' + deg + ' 处钩子 x 越界：' + p.x.toFixed(1));
    assert(p.y >= c.FIELD_Y - 1e-6 && p.y <= c.FIELD_Y + c.FIELD_H + 1e-6,
      '角度 ' + deg + ' 处钩子 y 越界（可能从土层顶边钻出去了）：' + p.y.toFixed(1));
  }
});

test('实际射出：钩子进入土层后始终不越界', function () {
  for (var deg = -75; deg <= 75; deg += 15) {
    var s = newGame();
    L.beginLevel(s);
    s.angle = deg;
    L.shoot(s);
    var guard = 0;
    while (s.phase !== 'swinging' && guard++ < 900) {
      L.step(s, FPS);
      var h = s.hook, c = s.cfg;
      if (h.y >= c.FIELD_Y - 1e-6) {                 // 已经进入土层，就必须守土层的规矩
        assert(h.x >= c.FIELD_X - 1e-6 && h.x <= c.FIELD_X + c.FIELD_W + 1e-6,
          '角度 ' + deg + ' 射出时钩子在土层内横向越界：x=' + h.x.toFixed(1));
        assert(h.y <= c.FIELD_Y + c.FIELD_H + 1e-6,
          '角度 ' + deg + ' 射出时钩子越过土层底部：y=' + h.y.toFixed(1));
      }
    }
    assert(guard < 900, '角度 ' + deg + ' 这一发卡住回不来');
  }
});

/* ==================================================================================
 * D. 抓取与结算
 * ================================================================================== */
console.log('\nD. 抓取与结算');

test('抓住物品：产生 grab 事件，并且最终加分', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'dog', 320);
  shootStraightDown(s);
  var r = advance(s, 12, 'resolve');
  assert(r.hit, '应该出现 resolve 事件');
  eq(r.hit.itemType, 'dog', '抓到的应该是 dog');
  assert(r.evs.some(function (e) { return e.type === 'grab'; }), '应该有 grab 事件');
  eq(s.score, r.hit.points, '分数应等于本次得分');
  assert(s.score >= 110, '至少拿到金块的 110 分');
  eq(s.combo, 1, '连击应变成 1');
});

test('抓空：钩子回来了但什么都没抓到，连击清零', function () {
  var s = newGame();
  L.beginLevel(s);
  setField(s, []);                 // 场地清空，必然抓空
  s.combo = 5;
  shootStraightDown(s);
  var r = advance(s, 12, 'empty');
  assert(r.hit, '应该出现 empty 事件');
  eq(s.combo, 0, '抓空后连击应清零');
  eq(s.score, 0, '抓空不该加减分');
});

test('连击倍率真正作用在得分上：连抓 3 个后 ×2', function () {
  var s = newGame();
  L.beginLevel(s);
  var total = 0;
  for (var k = 0; k < 3; k++) {
    belowMiner(s, 'stand', 300);
    shootStraightDown(s);
    var r = advance(s, 12, 'resolve');
    assert(r.hit, '第 ' + (k + 1) + ' 次应抓到');
    total += r.hit.points;
  }
  eq(s.combo, 3, '连击应为 3');
  var last = L.comboMult(3, s.cfg);
  eq(last, 2, '连击 3 时倍率应为 ×2');
  eq(total, 20 + 20 + 20 * 2, '得分应为 20+20+40');
});

test('灰色石堆：加分但不算连击（浪费一发）', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'stone', 300);
  shootStraightDown(s);
  var r = advance(s, 12, 'resolve');
  assert(r.hit, '应该抓到石堆');
  eq(r.hit.itemType, 'stone');
  eq(s.score, 5, '石堆只值 5 分');
  eq(s.combo, 0, '石堆不该涨连击');
});

test('回钩速度按重量递减：越大越重、拖回来越慢（经典黄金矿工规则）', function () {
  /* 这一版是**回退**：上一轮做过"回钩速度随价值递增"，玩起来大件比小石子窜得还快，
   * 视觉上很违和。现在改回物理直觉：大块头就是沉，拖回来要花时间。
   * 速度 = PULL_BASE_SPEED / weight，所以只要比较 pullSpeedOf 的倒数即可。 */
  var s = newGame();
  eq(s.cfg.PULL_SPEED_BY, 'weight', '默认必须是经典重量模式');
  function spd(type) {
    return L.pullSpeedOf(s, { type: type, weight: L.ITEMS[type].weight });
  }
  var small = spd('blob'), mid = spd('horse'), big = spd('god');
  assert(small > mid && mid > big,
    '回收速度应随重量单调递减，实际 ' + Math.round(small) + ' / ' + Math.round(mid) + ' / ' + Math.round(big));
  near(small, s.cfg.PULL_BASE_SPEED / L.ITEMS.blob.weight, 1e-9,
    '最轻的那件速度 = PULL_BASE_SPEED / 1.00');
  assert(small / big > 2.5,
    '最大最小之间要拉得开（体型梯度 3.14×），实际只有 ' + (small / big).toFixed(2) + '×');
});

test('速度梯度与体型梯度对齐：看着多大就知道拖多久', function () {
  /* 设计意图：weight 和 size 是同一条阶梯的两种表达。
   * 不要求完全相等（size 还要照顾"能不能看清"），但必须同向且量级相当 ——
   * 否则会出现"看着巨大拖回来飞快"或"看着很小拖半天"的错觉。 */
  var s = newGame();
  var order = ['blob', 'stand', 'mouse', 'rooster', 'dog', 'horse', 'rabbit', 'sumo', 'god'];
  for (var i = 1; i < order.length; i++) {
    var a = L.ITEMS[order[i - 1]], b = L.ITEMS[order[i]];
    assert(b.size > a.size, '体型必须随阶梯递增：' + order[i]);
    assert(b.weight > a.weight, '重量必须随阶梯递增：' + order[i]);
    assert(b.value > a.value, '价值必须随阶梯递增：' + order[i]);
  }
  var sizeSpread = L.ITEMS.god.size / L.ITEMS.blob.size;
  var weightSpread = L.ITEMS.god.weight / L.ITEMS.blob.weight;
  assert(Math.abs(sizeSpread - weightSpread) < 0.5,
    '体型梯度 ' + sizeSpread.toFixed(2) + '× 与重量梯度 ' + weightSpread.toFixed(2) + '× 不该差太远');
});

test('单位时间收益仍随价值递增：大块头慢归慢，还是最划算的目标', function () {
  /* 这是整套重量机制的**安全绳**。
   * "越大越慢"很容易滑向"越值钱越亏"—— 那就没人愿意抓大件了，体型阶梯白做。
   * 唯一的判据是 value/weight（等价于 value × 速度）必须单调递增。
   * 改 weight 表改坏了，这条会先红。 */
  var s = newGame();
  var order = ['blob', 'stand', 'mouse', 'rooster', 'dog', 'horse', 'rabbit', 'sumo', 'god'];
  var prev = 0;
  for (var i = 0; i < order.length; i++) {
    var t = order[i];
    var rate = L.earnRateOf(s, { type: t, weight: L.ITEMS[t].weight });
    assert(rate > prev,
      t + ' 的单位时间收益(' + Math.round(rate) + ') 应该高于前一档(' + Math.round(prev) + ')');
    prev = rate;
  }
  // 石头必须远远垫底，否则"挡路 + 炸药"没有意义
  var stoneRate = L.earnRateOf(s, { type: 'stone', weight: L.ITEMS.stone.weight, isStone: true });
  assert(stoneRate < L.earnRateOf(s, { type: 'blob', weight: L.ITEMS.blob.weight }) / 5,
    '石头的单位时间收益应该是垃圾级，实际 ' + Math.round(stoneRate));
  // 炸弹是负收益（抓它纯亏）
  assert(L.earnRateOf(s, { type: 'angel', weight: L.ITEMS.angel.weight }) < 0,
    '炸弹的单位时间收益必须为负');
});

test('石头是重量表的极端值：最慢、最不值钱', function () {
  var s = newGame();
  var stone = L.pullSpeedOf(s, { type: 'stone', weight: L.ITEMS.stone.weight, isStone: true });
  eq(Math.round(stone), Math.round(s.cfg.PULL_BASE_SPEED / L.ITEMS.stone.weight));
  var god = L.pullSpeedOf(s, { type: 'god', weight: L.ITEMS.god.weight });
  assert(stone < god,
    '石头应该比钻石回得还慢（这是它唯一"重"的理由），实际 ' + Math.round(stone) + ' vs ' + Math.round(god));
  for (var i = 0; i < ['blob', 'sumo', 'god'].length; i++) {
    var t = ['blob', 'sumo', 'god'][i];
    assert(L.ITEMS.stone.weight > L.ITEMS[t].weight, '石头的重量应该压过 ' + t);
  }
});

test('实测：一次完整往返的耗时随重量逐档变长（经典手感）', function () {
  /* 注意只测"速度"是看不出手感的 —— 得测**一次完整往返的秒数**，
   * 因为那才是玩家真正付出的东西。落点固定在奶蛙下方 600，所有物品同一起跑线。 */
  function tripSeconds(type) {
    var s = newGame();
    L.beginLevel(s);
    belowMiner(s, type, 600, { weight: L.ITEMS[type].weight });
    s.rng = function () { return 0.99; };   // 屏蔽挣脱
    shootStraightDown(s);
    var r = advance(s, 30, 'resolve');
    assert(r.hit, type + ' 应该被抓到');
    return r.t;
  }
  var order = ['blob', 'stand', 'mouse', 'rooster', 'dog', 'horse', 'rabbit', 'sumo', 'god'];
  var times = order.map(tripSeconds);
  for (var i = 1; i < times.length; i++) {
    assert(times[i] > times[i - 1],
      order[i] + '(' + times[i].toFixed(2) + 's) 应该比 ' + order[i - 1] +
      '(' + times[i - 1].toFixed(2) + 's) 慢');
  }
  var ratio = times[times.length - 1] / times[0];
  assert(ratio > 1.7,
    '钻石的往返耗时应该明显超过小石子，实际只有 ' + ratio.toFixed(2) + '×');
});

/* ==================================================================================
 * E. 奶蛙特色机制
 * ================================================================================== */
console.log('\nE. 奶蛙特色机制');

test('大块头挣脱：概率命中时脱钩，物品掉回原位', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'sumo', 300);
  var home = { x: s.items[0].x, y: s.items[0].y };
  s.rng = function () { return 0; };       // 必然触发挣脱
  shootStraightDown(s);
  var r = advance(s, 20, 'escape');
  assert(r.hit, '应该出现 escape 事件');
  eq(s.escapes, 1, '挣脱计数应为 1');
  eq(s.score, 0, '挣脱了就不该加分');
  eq(s.items[0].grabbed, false, '物品应回到未被抓状态');
  near(s.items[0].x, home.x, 1e-9, '应掉回原位 x');
  near(s.items[0].y, home.y, 1e-9, '应掉回原位 y');
});

test('大块头没挣脱时正常到手', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'sumo', 300);
  s.rng = function () { return 0.99; };    // 必然不挣脱
  shootStraightDown(s);
  var r = advance(s, 20, 'resolve');
  assert(r.hit, '应该成功抓到');
  eq(s.score, 400, '保险箱值 400');
  eq(s.escapes, 0);
});

test('挣脱后这一发不算抓空：不清零连击', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'sumo', 300);
  s.combo = 4;
  s.rng = function () { return 0; };
  shootStraightDown(s);
  var r = advance(s, 20, 'escape');
  assert(r.hit, '应该挣脱');
  eq(s.combo, 4, '挣脱不该把连击清零');
  assert(!r.evs.some(function (e) { return e.type === 'empty'; }), '挣脱后不该再报抓空');
});

test('天使是炸弹：扣分且连击清零，分数不会变负', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'angel', 300);
  s.score = 40;
  s.combo = 7;
  shootStraightDown(s);
  var r = advance(s, 12, 'angel');
  assert(r.hit, '应该出现 angel 事件');
  eq(r.hit.points, -150);
  eq(s.score, 0, '40 分扣 150 应被夹到 0，不能是负数');
  eq(s.combo, 0, '连击应清零');
  eq(s.angels, 1);
});

test('天使扣分：分数够多时正常扣', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'angel', 300);
  s.score = 500;
  shootStraightDown(s);
  var r = advance(s, 12, 'angel');
  assert(r.hit, '应该出现 angel 事件');
  eq(s.score, 350, '500 - 150 = 350');
});

test('神奶蛙：加分之外还加时间', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'god', 300);
  s.timeLeft = 30;
  shootStraightDown(s);
  var r = advance(s, 12, 'resolve');
  assert(r.hit, '应该抓到神奶蛙');
  eq(r.hit.timeBonus, 5, '加时 5 秒');
  eq(r.hit.isGod, true);
  assert(s.timeLeft > 30, '时间应该变多，实际 ' + s.timeLeft.toFixed(2));
  eq(s.score, 600, '钻石值 600');
});

test('幸运袋：触发最高等级笑声', function () {
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'laugh', 300);
  s.combo = 0;
  shootStraightDown(s);
  var r = advance(s, 12, 'resolve');
  assert(r.hit, '应该抓到幸运袋');
  eq(r.hit.laughLevel, 1, '幸运袋笑声等级应为 1');
  assert(r.hit.points >= 100 && r.hit.points <= 300, '幸运袋得分应在 100~300，实际 ' + r.hit.points);
});

test('笑声等级随连击升高', function () {
  var s = newGame();
  L.beginLevel(s);
  var levels = [];
  for (var k = 0; k < 5; k++) {
    belowMiner(s, 'stand', 300);
    shootStraightDown(s);
    var r = advance(s, 12, 'resolve');
    levels.push(r.hit.laughLevel);
  }
  for (var i = 1; i < levels.length; i++) {
    assert(levels[i] >= levels[i - 1], '笑声等级不该回落：' + levels.join(','));
  }
  assert(levels[levels.length - 1] > levels[0], '连击涨了笑声等级也该涨：' + levels.join(','));
});

/* ==================================================================================
 * F. 关卡推进
 * ================================================================================== */
console.log('\nF. 关卡推进');

test('beginLevel：ready → swinging，并重置计时', function () {
  var s = newGame();
  s.timeLeft = 5;
  var ev = L.beginLevel(s);
  eq(s.phase, 'swinging');
  eq(s.timeLeft, s.cfg.LEVEL_TIME);
  assert(ev.some(function (e) { return e.type === 'levelStart'; }), '应有 levelStart 事件');
});

test('beginLevel：重复调用是幂等的（不会重复开一关）', function () {
  var s = newGame();
  L.beginLevel(s);
  eq(L.beginLevel(s).length, 0, '第二次调用应无效');
});

test('达标 → levelClear', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = s.target;
  s.timeLeft = 0.05;
  var r = advance(s, 1);
  eq(s.phase, 'levelClear');
  assert(r.evs.some(function (e) { return e.type === 'levelClear'; }), '应有 levelClear 事件');
});

test('差一分未达标 → gameOver', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = s.target - 1;
  s.timeLeft = 0.05;
  var r = advance(s, 1);
  eq(s.phase, 'gameOver');
  assert(r.evs.some(function (e) { return e.type === 'levelFail'; }), '应有 levelFail 事件');
});

test('摊平后 timeLeft 归零，不会是负数', function () {
  var s = newGame();
  L.beginLevel(s);
  s.timeLeft = 0.02;
  advance(s, 1);
  eq(s.timeLeft, 0);
});

test('nextLevel：关卡 +1、场地重铺、计时重置', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = 999999; s.timeLeft = 0; L.step(s, FPS);
  eq(s.phase, 'levelClear');
  var oldItems = s.items;
  L.nextLevel(s);
  eq(s.level, 2);
  eq(s.phase, 'swinging');
  eq(s.timeLeft, s.cfg.LEVEL_TIME);
  eq(s.combo, 0);
  assert(s.items !== oldItems, '应该重新铺场地');
  assert(s.items.length > 0, '新场地应有物品');
});

test('nextLevel：分数累计保留（经典规则）', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = 1234; s.timeLeft = 0;
  L.step(s, FPS);
  L.nextLevel(s);
  eq(s.score, 1234, '跨关分数应保留');
});

test('结算后 step 不再扣时间（相位已冻结）', function () {
  var s = newGame();
  L.beginLevel(s);
  s.timeLeft = 0;
  L.step(s, FPS);
  eq(s.phase, 'gameOver');
  var t = s.timeLeft;
  advance(s, 1);
  eq(s.timeLeft, t, 'gameOver 后时间不该继续走');
});

test('restart：一切归零，回到第 1 关', function () {
  var s = newGame();
  L.beginLevel(s);
  s.level = 5; s.score = 9000; s.combo = 6; s.escapes = 3;
  L.restart(s);
  eq(s.phase, 'ready');
  eq(s.level, 1);
  eq(s.score, 0);
  eq(s.combo, 0);
  eq(s.escapes, 0);
  eq(s.timeLeft, s.cfg.LEVEL_TIME);
  assert(s.items.length > 0);
});

/* ==================================================================================
 * G. 手感预设
 * ================================================================================== */
console.log('\nG. 手感预设');

test('三档预设都存在，且硬核档摆得更快、时更短', function () {
  var a = L.createGame({ preset: 'relaxed' });
  var b = L.createGame({ preset: 'standard' });
  var c = L.createGame({ preset: 'hard' });
  assert(a.cfg.SWING_PERIOD > b.cfg.SWING_PERIOD, '轻松档摆动应更慢');
  assert(c.cfg.SWING_PERIOD < b.cfg.SWING_PERIOD, '硬核档摆动应更快');
  assert(c.cfg.LEVEL_TIME < a.cfg.LEVEL_TIME, '硬核档时间应更短');
  assert(c.cfg.ESCAPE_CHANCE > a.cfg.ESCAPE_CHANCE, '硬核档挣脱应更频繁');
});

test('自定义参数能覆盖预设', function () {
  var s = L.createGame({ preset: 'hard', config: { LEVEL_TIME: 99 } });
  eq(s.cfg.LEVEL_TIME, 99);
  // 摆动周期现在是"按关卡推导"的运行时值，预设里给的是曲线的起点
  eq(s.cfg.SWING_PERIOD, L.PRESETS.hard.SWING_PERIOD_START, '其余字段仍应来自预设');
});

test('未知预设名自动回落，不会崩', function () {
  var s = L.createGame({ preset: '不存在的档位' });
  eq(s.cfg.SWING_PERIOD_START, L.CONFIG.SWING_PERIOD_START);
  eq(s.cfg.TARGET_RATIO_BASE, L.CONFIG.TARGET_RATIO_BASE);
});

/* ==================================================================================
 * H. 长时间稳定性
 * ================================================================================== */
console.log('\nH. 长时间稳定性');

test('狂按发射 400 发：状态机不卡死、分数不炸、计时正常', function () {
  var s = newGame();
  L.beginLevel(s);
  s.timeLeft = 1e6;                     // 屏蔽时间到，只压状态机
  var rng = L._seededRng(42);
  s.rng = rng;
  var guard = 0;
  while (guard++ < 200000) {
    if (s.phase === 'swinging') { L.shoot(s); }
    L.step(s, FPS);
    if (guard % 37 === 0) { s.timeLeft = 1e6; }
    if (guard > 100000) { break; }
  }
  assert(s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling',
    '状态机不该卡死，实际 ' + s.phase);
  assert(isFinite(s.score) && s.score >= 0, '分数应有限且非负：' + s.score);
  assert(isFinite(s.ropeLen) && s.ropeLen >= s.cfg.ROPE_IDLE_LEN - 1e-6, '绳长应有限且不小于待机长度');
  assert(s.shots > 100, '应该真的发了很多发，实际 ' + s.shots);
});

test('超大 dt 被钳制，不会瞬移穿场', function () {
  var s = newGame();
  L.beginLevel(s);
  shootStraightDown(s);
  L.step(s, 999);                        // 模拟切标签页回来
  assert(L.inField(s, s.hook), '钩子不该被一帧甩出场外');
  assert(s.ropeLen <= L.maxRopeLen(s, s.angle) + 1e-6, '绳长不该超过当前角度上限');
});

test('每一关都能铺出至少 8 个物品（高关卡也不至于空场）', function () {
  for (var lv = 1; lv <= 10; lv++) {
    var s = L.createGame({ rng: L._seededRng(1000 + lv) });
    s.level = lv;
    s.items = L.buildItems(s, lv);
    assert(s.items.length >= 8, '第 ' + lv + ' 关只铺了 ' + s.items.length + ' 个物品');
  }
});

test('每一关的目标分都低于该关可得分（不至于无解）', function () {
  for (var lv = 1; lv <= 8; lv++) {
    var s = L.createGame({ rng: L._seededRng(2000 + lv) });
    s.items = L.buildItems(s, lv);
    s.target = 0;
    var t = 0, cfg = s.cfg;
    for (var k = 1; k <= lv; k++) {
      var items = k === lv ? s.items : L.buildItems(s, k);
      var ratio = Math.min(cfg.TARGET_RATIO_MAX, cfg.TARGET_RATIO_BASE + (k - 1) * cfg.TARGET_RATIO_STEP);
      t += Math.max(cfg.TARGET_BASE, Math.round(L.achievableValue(items) * ratio));
    }
    // 每一关的目标都必须落在"面值 × 最高倍率"之内，否则理论上无解
    var ceiling = 0;
    for (var m = 1; m <= lv; m++) {
      ceiling += L.achievableValue(L.buildItems(s, m)) * cfg.MULT_MAX;
    }
    assert(t < ceiling, '第 ' + lv + ' 关累计目标 ' + t + ' 超过理论上限 ' + ceiling);
  }
});

/* ==================================================================================
 * I. 难度升级：石头挡路 / 会爬的目标 / 激进目标曲线
 * ================================================================================== */

/* 找出所有"被石头挡在奶蛙视线上"的宝物。
 * 判据：石头中心到"奶蛙→宝物"这条射线的垂距几乎为 0，且夹在两者之间。
 * 故意摆上去的挡路石头垂距严格等于 0（它是沿射线算出来的），所以很好认。 */
function occlusions(state) {
  var cfg = state.cfg, out = [];
  for (var i = 0; i < state.items.length; i++) {
    var tg = state.items[i];
    if (tg.isStone || tg.isAngel) { continue; }
    if (tg.value < cfg.BLOCK_MIN_VALUE) { continue; }

    var ddx = tg.x - cfg.MINER_X, ddy = tg.y - cfg.MINER_Y;
    var dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dist < 1) { continue; }
    var ux = ddx / dist, uy = ddy / dist;

    for (var j = 0; j < state.items.length; j++) {
      var st = state.items[j];
      if (!st.isStone) { continue; }
      var vx = st.x - cfg.MINER_X, vy = st.y - cfg.MINER_Y;
      var proj = vx * ux + vy * uy;
      if (proj <= 0 || proj >= dist) { continue; }
      var perp = Math.abs(vx * uy - vy * ux);
      if (perp <= st.r * 0.5) { out.push({ target: tg, stone: st }); break; }
    }
  }
  return out;
}

test('布局：所有物品（含挡路石头）都完全落在土层内', function () {
  for (var lv = 1; lv <= 16; lv++) {
    for (var seed = 0; seed < 4; seed++) {
      var s = L.createGame({ rng: L._seededRng(7000 + lv * 10 + seed) });
      s.items = L.buildItems(s, lv);
      for (var i = 0; i < s.items.length; i++) {
        var it = s.items[i];
        assert(it.x - it.r >= s.cfg.FIELD_X - 0.01 && it.x + it.r <= s.cfg.FIELD_X + s.cfg.FIELD_W + 0.01,
          '第 ' + lv + ' 关 ' + it.type + ' 横向越界：x=' + it.x.toFixed(1));
        assert(it.y - it.r >= s.cfg.FIELD_Y - 0.01 && it.y + it.r <= s.cfg.FIELD_Y + s.cfg.FIELD_H + 0.01,
          '第 ' + lv + ' 关 ' + it.type + ' 纵向越界：y=' + it.y.toFixed(1));
      }
    }
  }
});

test('石头挡路：确实造出了遮挡，而且只挡够值钱的', function () {
  var total = 0;
  for (var lv = 1; lv <= 14; lv++) {
    var s = L.createGame({ rng: L._seededRng(9000 + lv) });
    s.items = L.buildItems(s, lv);
    var occ = occlusions(s);
    total += occ.length;
    for (var i = 0; i < occ.length; i++) {
      assert(occ[i].target.value >= s.cfg.BLOCK_MIN_VALUE,
        '第 ' + lv + ' 关挡了一个只值 ' + occ[i].target.value + ' 的东西，太便宜了不该挡');
    }
  }
  assert(total >= 8, '14 关下来只造出 ' + total + ' 处遮挡，覆盖率太低（A2 形同虚设）');
});

test('石头挡路：正对着宝物射出去，先撞到的必须是石头', function () {
  // 这是"石头挡路"的核心断言：不测几何，直接测实际钩子撞到谁。
  var checked = 0;
  for (var lv = 1; lv <= 14 && checked < 10; lv++) {
    var s = L.createGame({ rng: L._seededRng(9200 + lv) });
    s.items = L.buildItems(s, lv);
    var occ = occlusions(s);

    for (var i = 0; i < occ.length && checked < 10; i++) {
      var tg = occ[i].target, st = occ[i].stone;

      // 把场清成只有这两个，排除"路上还横着第三样东西"的干扰
      tg.moving = false; st.moving = false;
      s.items = [tg, st];

      var a = Math.atan2(tg.x - s.cfg.MINER_X, tg.y - s.cfg.MINER_Y) * 180 / Math.PI;
      if (Math.abs(a) > s.cfg.SWING_AMPLITUDE) { continue; }   // 超出摆动锥就瞄不到，跳过

      // 每一发都从"刚开一关"的干净状态起手。
      // 不重置 ropeLen 的话，第二发会从上一发的残余绳长开始，
      // 一上来就判"到底了"直接回收，于是什么都没撞到（这个坑真踩过）。
      s.phase = 'swinging';
      s.angle = a;
      s.held = null;
      s.ropeLen = s.cfg.ROPE_IDLE_LEN;
      s.hook = L.hookPos(s);
      tg.grabbed = false; tg.removed = false;
      st.grabbed = false; st.removed = false;
      L.shoot(s);

      var guard = 0, first = null;
      while (s.phase === 'shooting' && guard++ < 900) {
        L.step(s, FPS);
        if (s.held) { first = s.held; break; }
      }

      assert(first, '钩子沿射线飞出去，居然什么都没撞到');
      eq(first.type, 'stone', '挡路失败：先撞到的是 ' + first.type + '，应该是石头');
      checked++;
    }
  }
  assert(checked >= 3, '只验证到 ' + checked + ' 组遮挡，样本太少（A2 覆盖率不足）');
});

test('目标分曲线：前松后紧、穿过面值、封顶可解', function () {
  var cfg = newGame().cfg;
  function ratioAt(lv) {
    return Math.min(cfg.TARGET_RATIO_MAX, cfg.TARGET_RATIO_BASE + (lv - 1) * cfg.TARGET_RATIO_STEP);
  }

  /* 第 1 关的倍数是被**实测标定**出来的，不是随手写的：
   *   < 0.50 → 第 1 关目标太松，一钩子就够
   *   > 0.62 → 第 1 关通过率跌破 75%（_qa/targetfit.cjs 的 40 局采样）
   * 注意**别指望用这个数去治"达标太早"** —— 实测起点从 0.62 抬到 0.65，
   * "头 20% 就达标"的关卡占比只从 51% 动到 52%。要治那个，靠的是收工机制。
   * 所以这里锁一个区间而不是具体值：改数字可以，但别把两头都踩穿。 */
  assert(ratioAt(1) >= 0.50 && ratioAt(1) <= 0.62,
    '第 1 关倍数应落在实测标定区间 [0.50, 0.62]，实际 ' + ratioAt(1).toFixed(2));
  assert(cfg.TARGET_RATIO_STEP >= 0.12,
    '坡度太缓的话中期就没压力了，实际 +' + cfg.TARGET_RATIO_STEP);

  // 曲线要在"人类代理的收入水平"附近穿过。实测那个收入只有面值的 ~0.84，
  // 所以倍数 = 1.0 就已经是"这一关得把场地收干净"的硬门槛了。
  assert(ratioAt(3) < 1.0 && ratioAt(5) > 1.0,
    '第 3~5 关之间应该穿过 1.0（=面值），实际 ' +
    ratioAt(3).toFixed(2) + ' → ' + ratioAt(5).toFixed(2));

  assert(ratioAt(15) > 2.4, '第 15 关应超过面值 2.4 倍，实际 ' + ratioAt(15).toFixed(2));
  near(ratioAt(60), cfg.TARGET_RATIO_MAX, 1e-9, '高关卡应封顶');

  // 理论上必须留有余地：上限要低于连击倍率上限，否则满连击也追不上
  assert(cfg.TARGET_RATIO_MAX < cfg.MULT_MAX,
    '目标上限 ' + cfg.TARGET_RATIO_MAX + ' 必须低于连击倍率上限 ' + cfg.MULT_MAX);

  // 比上一版（0.50 / +0.08 / 1.40）更陡：第 2 关就反超，之后一路更狠
  for (var lv = 2; lv <= 16; lv++) {
    var old = Math.min(1.40, 0.50 + (lv - 1) * 0.08);
    assert(ratioAt(lv) > old,
      '第 ' + lv + ' 关应比上一版更狠，实际 ' + ratioAt(lv).toFixed(2) + ' vs ' + old.toFixed(2));
  }
});

test('三档预设的难度也要跟着走（硬核最狠、轻松最宽）', function () {
  function base(p) { return L.createGame({ preset: p, rng: L._seededRng(1) }).cfg; }
  var r = base('relaxed'), s = base('standard'), h = base('hard');
  assert(r.TARGET_RATIO_BASE < s.TARGET_RATIO_BASE && s.TARGET_RATIO_BASE < h.TARGET_RATIO_BASE,
    '目标倍数应随档位递增，实际 ' + r.TARGET_RATIO_BASE + ' / ' + s.TARGET_RATIO_BASE + ' / ' + h.TARGET_RATIO_BASE);
  assert(h.MOVE_FROM_LEVEL <= s.MOVE_FROM_LEVEL && s.MOVE_FROM_LEVEL <= r.MOVE_FROM_LEVEL,
    '会爬的目标应该硬核来得最早、轻松来得最晚');
});

test('会爬的目标：第 1 关没有，之后每关都有且不超过上限', function () {
  var s = newGame();
  eq(s.items.filter(function (it) { return it.moving; }).length, 0, '第 1 关不该有会爬的');

  for (var lv = 2; lv <= 12; lv++) {
    s.items = L.buildItems(s, lv);
    var n = s.items.filter(function (it) { return it.moving; }).length;
    assert(n <= s.cfg.MOVE_MAX_COUNT, '第 ' + lv + ' 关会爬的有 ' + n + ' 个，超过上限 ' + s.cfg.MOVE_MAX_COUNT);
    assert(n >= 1, '第 ' + lv + ' 关一个会爬的都没有');
  }
});

test('会爬的目标：真的在爬，且始终留在巡逻范围内', function () {
  var s = newGame();
  L.beginLevel(s);
  L.nextLevel(s);                     // 跳到第 2 关，会爬的从这关开始
  var movers = s.items.filter(function (it) { return it.moving; });
  assert(movers.length > 0, '第 2 关应该有会爬的目标');

  var before = movers.map(function (it) { return it.x; });
  advance(s, 1.0);
  for (var i = 0; i < movers.length; i++) {
    assert(Math.abs(movers[i].x - before[i]) > 0.5,
      '会爬的目标 ' + movers[i].type + ' 一秒内几乎没动（' + before[i] + ' → ' + movers[i].x + '）');
  }

  // 跑久一点，检查它不会爬出土层、也不会爬出自己的巡逻段
  for (var t = 0; t < 45; t++) {
    advance(s, 1.0);
    for (var k = 0; k < s.items.length; k++) {
      var it = s.items[k];
      if (!it.moving || it.removed) { continue; }
      assert(it.x >= s.cfg.FIELD_X + it.r - 1 && it.x <= s.cfg.FIELD_X + s.cfg.FIELD_W - it.r + 1,
        '会爬的目标跑出土层：x=' + it.x.toFixed(1));
      assert(it.x >= it.minX - 1 && it.x <= it.maxX + 1,
        '会爬的目标跑出巡逻段：x=' + it.x.toFixed(1) + ' ∉ [' + it.minX.toFixed(1) + ', ' + it.maxX.toFixed(1) + ']');
    }
    if (s.phase !== 'swinging') { break; }
  }
});

test('会爬的目标：被抓住之后就交给绳子，不再自己爬', function () {
  var s = newGame();
  L.beginLevel(s);
  L.nextLevel(s);
  var mv = s.items.filter(function (it) { return it.moving; })[0];
  assert(mv, '第 2 关应该有会爬的目标');

  // 手动把它"抓起来"，然后推进——它的 x 应该只跟钩子走，不再累加自己的速度
  s.phase = 'pulling';
  s.held = mv;
  mv.grabbed = true;
  s.angle = 0;
  s.ropeLen = 400;
  s.hook = L.hookPos(s);
  mv.x = s.hook.x; mv.y = s.hook.y;

  L.step(s, FPS);
  near(mv.x, s.hook.x, 1e-6, '被抓住的目标应该贴着钩子，而不是自己继续爬');
});

test('布局：没有物品离奶蛙近到能盖住整片矿区', function () {
  // 这是踩过的真 bug：一个天使被摆在洞口正下方很近的地方，它的角宽度盖住了整片矿区，
  // 于是**任何角度都只能勾到那个炸弹**，一关剩下的几十秒彻底打不出东西。
  // 当时误判成"难度调过头了"。约束见 CONFIG.MAX_HALF_ANGLE。
  for (var lv = 1; lv <= 16; lv++) {
    for (var seed = 0; seed < 3; seed++) {
      var s = L.createGame({ rng: L._seededRng(41000 + lv * 17 + seed) });
      s.items = L.buildItems(s, lv);
      for (var i = 0; i < s.items.length; i++) {
        var it = s.items[i];
        var d = Math.sqrt(Math.pow(it.x - s.cfg.MINER_X, 2) + Math.pow(it.y - s.cfg.MINER_Y, 2));
        var half = Math.asin(Math.min(1, it.r / d)) * 180 / Math.PI;
        assert(half <= s.cfg.MAX_HALF_ANGLE + 0.01,
          '第 ' + lv + ' 关 ' + it.type + ' 遮了 ±' + half.toFixed(1) + '°（上限 ' + s.cfg.MAX_HALF_ANGLE + '°）');
      }
    }
  }
});

test('每一关都不会被某一个物品挡死', function () {
  /* 注意判据：不是"有多少东西能直接打到"。
   * 矿区又高又窄，前后两件东西本来就会沿射线排队 —— 先勾掉前面那个，后面自然露出来，
   * 这是正常玩法，不是死局。真正要防的是**某一件东西吃掉几乎所有射线**：
   * 那种情况下整关只剩一个可打目标，玩家还看不出发生了什么。
   * （故障现场：第 4 关一个近处天使吃掉了全部 15 条中心射线，剩下 46 秒一枪开不出去。） */
  function firstHitAlong(state, a) {
    var lim = L.maxRopeLen(state, a);
    for (var d = state.cfg.ROPE_IDLE_LEN; d <= lim; d += 4) {
      var h = L.findHit(state, L.hookPos(state, a, d));
      if (h) { return h; }
    }
    return null;
  }

  for (var lv = 1; lv <= 16; lv++) {
    for (var seed = 0; seed < 3; seed++) {
      var s = L.createGame({ rng: L._seededRng(31000 + lv * 31 + seed) });
      s.items = L.buildItems(s, lv);

      // 指标一：沿全部角度能触达到多少个**不同**的物品
      var distinct = {}, distinctN = 0;
      for (var a = -75; a <= 75; a += 0.5) {
        var h0 = firstHitAlong(s, a);
        if (h0 && !distinct[h0.id]) { distinct[h0.id] = 1; distinctN++; }
      }
      assert(distinctN >= 6,
        '第 ' + lv + ' 关(种子' + seed + ') 全角度下来只能碰到 ' + distinctN + ' 个物品，太单调');

      // 指标二：单个物品最多能挡掉多少条"朝其它物品中心"的射线
      var blocks = {}, maxBlock = 0;
      for (var i = 0; i < s.items.length; i++) {
        var tg = s.items[i];
        var ca = Math.atan2(tg.x - s.cfg.MINER_X, tg.y - s.cfg.MINER_Y) * 180 / Math.PI;
        if (Math.abs(ca) > s.cfg.SWING_AMPLITUDE) { continue; }
        var got = firstHitAlong(s, ca);
        if (got && got !== tg) {
          blocks[got.id] = (blocks[got.id] || 0) + 1;
          if (blocks[got.id] > maxBlock) { maxBlock = blocks[got.id]; }
        }
      }
      var cap = Math.ceil(s.items.length * 0.6);
      assert(maxBlock <= cap,
        '第 ' + lv + ' 关(种子' + seed + ') 有一个 ' + s.items.length + ' 件物品里的单个物品挡掉了 ' +
        maxBlock + ' 条射线（上限 ' + cap + '），这一关等于只剩一个目标可打');
    }
  }
});

/* ==================================================================================
 * I. 体型即价值刻度（需求："不同奶蛙的价值按照体型能够比较明显地区分"）
 * ================================================================================== */
console.log('\nI. 体型即价值刻度');

test('体型与价值严格单调：越值钱的越大，一眼能读出来', function () {
  var rows = L.LEGEND_ORDER.map(function (t) { return { t: t, v: L.ITEMS[t].value, s: L.ITEMS[t].size }; })
    .filter(function (r) { return typeof r.v === 'number' && r.v > 0 && !L.ITEMS[r.t].isStone; });
  rows.sort(function (a, b) { return a.v - b.v; });
  for (var i = 1; i < rows.length; i++) {
    assert(rows[i].s > rows[i - 1].s,
      rows[i].t + '(价值 ' + rows[i].v + ') 反而比 ' + rows[i - 1].t +
      '(价值 ' + rows[i - 1].v + ') 小：' + rows[i].s + ' vs ' + rows[i - 1].s);
  }
});

test('体型梯度拉得够开（最大 / 最小 ≥ 2.5 倍，不是差几个像素）', function () {
  var sizes = L.LEGEND_ORDER.map(function (t) { return L.ITEMS[t].size; });
  var lo = Math.min.apply(null, sizes), hi = Math.max.apply(null, sizes);
  assert(hi / lo >= 2.5, '最大 ' + hi + ' / 最小 ' + lo + ' = ' + (hi / lo).toFixed(2) + '，梯度不够明显');
});

test('碰撞半径跟着体型走（不能画得很大却很难勾到）', function () {
  L.LEGEND_ORDER.forEach(function (t) {
    var it = L.ITEMS[t];
    var expect = it.size * 0.43;
    near(it.r, expect, expect * 0.08, t + ' 的 r 与 size×0.43 差太多');
  });
});

/* ==================================================================================
 * J. 摆动速度：随关卡递增到峰值（需求："让它随关卡递增到一个合理峰值"）
 * ================================================================================== */
console.log('\nJ. 摆动速度随关卡递增');

test('摆动周期：第 1 关最慢，逐关加快，封顶在峰值', function () {
  var cfg = newGame().cfg;
  eq(L.swingPeriod(1, cfg), cfg.SWING_PERIOD_START, '第 1 关应该是起点');
  var prev = Infinity;
  for (var lv = 1; lv <= 20; lv++) {
    var p = L.swingPeriod(lv, cfg);
    assert(p <= prev + 1e-9, '第 ' + lv + ' 关比上一关还慢：' + p.toFixed(2) + ' > ' + prev.toFixed(2));
    prev = p;
  }
  eq(L.swingPeriod(40, cfg), cfg.SWING_PERIOD_MIN, '高关卡应封顶');
});

test('摆动周期的红线：任何关卡都不得低于 2.4 秒（瞄准窗口）', function () {
  /* 这是手感红线，实测来的：
   * 匀速模式下每帧角速度 ≈ 2×幅度 ÷ (周期×180)×360，
   * 周期 2.4s 时约 2.1°/帧 —— 中等大小的物品只剩 ~5 帧窗口。
   * 再快就变成"看得见打不着"，那正是这轮玩家反馈的"钩子甩得太快、手感很差"。 */
  ['relaxed', 'standard', 'hard'].forEach(function (p) {
    var cfg = L.createGame({ preset: p }).cfg;
    for (var lv = 1; lv <= 40; lv++) {
      var per = L.swingPeriod(lv, cfg);
      assert(per >= 2.4 - 1e-9,
        p + ' 档第 ' + lv + ' 关周期掉到 ' + per.toFixed(2) + 's，突破 2.4s 红线');
    }
    assert(cfg.SWING_PERIOD_MIN >= 2.4 - 1e-9, p + ' 档的峰值本身就越线了');
  });
});

test('applyLevelTuning：把曲线写回 state.cfg，关卡一换就更新', function () {
  var s = newGame();
  s.level = 1; L.applyLevelTuning(s);
  eq(s.cfg.SWING_PERIOD, L.swingPeriod(1, s.cfg));
  s.level = 12; L.applyLevelTuning(s);
  eq(s.cfg.SWING_PERIOD, L.swingPeriod(12, s.cfg));
  assert(s.cfg.SWING_PERIOD < L.swingPeriod(1, s.cfg), '第 12 关应该比第 1 关快');
});

/* ==================================================================================
 * K. 炸药
 * ================================================================================== */
console.log('\nK. 炸药');

test('炸药配发：白送 N 发，第 6 关起多一发，始终不超过上限', function () {
  var s = newGame(), cfg = s.cfg;
  eq(L.dynamiteFor(s, 1), cfg.DYNAMITE_PER_LEVEL);
  eq(L.dynamiteFor(s, cfg.DYNAMITE_BONUS_LEVEL), cfg.DYNAMITE_PER_LEVEL + 1);
  // 白送的部分本身不该顶到上限（上限是给"白送 + 买"留的空间）
  assert(L.dynamiteFor(s, 40) < cfg.DYNAMITE_MAX, '白送不该顶满上限，那 DYNAMITE_MAX 就没意义了');
  // 买多了也不能突破上限
  s.buffs = { dynamite: 99 };
  eq(L.dynamiteFor(s, 40), cfg.DYNAMITE_MAX);
});

test('空手引爆炸药：只响一声，不消耗、不扣分', function () {
  var s = newGame();
  L.beginLevel(s);
  var before = s.dynamite, score0 = s.score;
  var ev = L.blowUp(s);
  eq(ev[0].type, 'boomEmpty');
  eq(s.dynamite, before, '空响不该消耗炸药');
  eq(s.score, score0);
});

test('拉着东西引爆：炸掉物品、消耗一发、分数和连击都不动', function () {
  /* 这是**刻意**的边界：炸药只负责"清场"，不负责"得分"。
   * 如果炸掉还给分，玩家就会拿它当白嫖手段，石堆和炸弹就失去威慑了。 */
  var s = newGame();
  L.beginLevel(s);
  belowMiner(s, 'stone', 300);
  s.rng = function () { return 0.99; };
  shootStraightDown(s);
  advance(s, 20, 'grab');
  assert(s.phase === 'pulling' && s.held, '应该已经咬住石头');

  var dyn0 = s.dynamite, score0 = s.score, combo0 = s.combo;
  var ev = L.blowUp(s);
  eq(ev[0].type, 'boom');
  eq(s.dynamite, dyn0 - 1);
  eq(s.score, score0, '炸药不该给分');
  eq(s.combo, combo0, '炸药不该动连击');
  eq(s.bombs, 1);
  assert(s.held === null, '手里的东西应该没了');
  assert(s.items.every(function (it) { return it.removed || it.type !== 'stone'; }), '石头应该被移除');

  // 炸完这一趟回收会加速（别让玩家炸完还要干等）
  assert(s.boomBoost, '应该置上回收加速标记');
  var back = advance(s, 20, 'empty');
  assert(s.phase === 'swinging', '绳子应该回到待机');
});

test('炸掉天使：不扣那 150 分（炸弹只是被清掉）', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = 500; s.target = 100;
  belowMiner(s, 'angel', 300);
  s.rng = function () { return 0.99; };
  shootStraightDown(s);
  advance(s, 20, 'grab');
  assert(s.held && s.held.isAngel, '应该咬住了天使');
  L.blowUp(s);
  eq(s.score, 500, '炸掉天使不该扣分');
});

/* ==================================================================================
 * L. 经济与小卖部
 * ================================================================================== */
console.log('\nL. 经济与小卖部');

test('小卖部三件套都带说明文案（需求：小卖部界面要有介绍说明）', function () {
  eq(L.SHOP_ITEMS.length, 3);
  L.SHOP_ITEMS.forEach(function (it) {
    assert(it.key && it.name && it.tag, it.key + ' 缺字段');
    assert(typeof it.desc === 'string' && it.desc.length >= 10, it.name + ' 缺 desc（界面上的介绍说明）');
    assert(typeof it.hint === 'string' && it.hint.length >= 8, it.name + ' 缺 hint（用法提示）');
    assert(it.price > 0, it.name + ' 应该有价格');
  });
  var keys = L.SHOP_ITEMS.map(function (i) { return i.key; }).join(',');
  eq(keys, 'dynamite,rockbook,drink', '三件套的构成变了，界面文案要跟着改');
});

test('买：扣分、记进 pending、累计次数', function () {
  var s = newGame();
  s.level = 5; s.score = 5000; s.target = 1000;
  var r = L.buy(s, 'dynamite');
  assert(r.ok, '应该买得起');
  eq(s.score, 5000 - r.item.price);
  eq(s.pending.dynamite, 1);
  eq(s.shopSpent, r.item.price);
  L.buy(s, 'dynamite');
  eq(s.pending.dynamite, 2, '炸药应该能连买');
});

test('买不起 / 买完会低于门槛：拦住并给出理由', function () {
  var s = newGame();
  s.level = 5; s.score = 1000; s.target = 900;   // 只剩 100 的余量
  var r = L.buy(s, 'rockbook');                   // 石头图鉴 900
  assert(!r.ok, '买完只剩 100 < 门槛 900，应该被拦住');
  assert(/门槛/.test(r.reason), '应该说明原因，实际：' + r.reason);
  eq(s.score, 1000, '被拦住时不该扣分');
});

test('buff 只顶一关：nextLevel 之后生效，再下一关就没了', function () {
  var s = newGame();
  s.level = 5; s.score = 9000; s.target = 1000;
  L.buy(s, 'drink');
  var slow = L.pullSpeedOf(s, { type: 'blob', weight: L.ITEMS.blob.weight });

  L.nextLevel(s);                       // 第 6 关开局 → buff 生效
  eq(s.buffs.drink, 1);
  eq(Object.keys(s.pending).length, 0, 'pending 应该被清空（不然能力会复利）');
  var fast = L.pullSpeedOf(s, { type: 'blob', weight: L.ITEMS.blob.weight });
  near(fast / slow, s.cfg.DRINK_PULL_MULT, 1e-9, '力量饮料应该让回收快 ' + s.cfg.DRINK_PULL_MULT + ' 倍');

  L.nextLevel(s);                       // 第 7 关 → buff 已过期
  eq(s.buffs.drink, undefined, 'buff 必须只顶一关');
  near(L.pullSpeedOf(s, { type: 'blob', weight: L.ITEMS.blob.weight }), slow, 1e-9);
});

test('石头图鉴：把灰石堆从 5 分抬成正经收入', function () {
  var s = newGame();
  eq(L.itemWorth(s, 'stone'), L.ITEMS.stone.value, '平时灰石堆就是那点分');
  s.buffs = { rockbook: 1 };
  eq(L.itemWorth(s, 'stone'), s.cfg.ROCKBOOK_VALUE);
  assert(s.cfg.ROCKBOOK_VALUE > L.ITEMS.stone.value * 5, '要抬得够狠才叫"垃圾变收入"');
});

test('小卖部只在过关之后、第 3 关起开门', function () {
  var s = newGame();
  eq(L.shopOpen(s), false, '开局不该开店');
  s.level = 2; s.phase = 'levelClear';
  eq(L.shopOpen(s), false, '前两关不开（别打断节奏）');
  s.level = 3; s.phase = 'levelClear';
  eq(L.shopOpen(s), true);
  s.phase = 'swinging';
  eq(L.shopOpen(s), false, '打到一半不该能买东西');
});

test('shopView：把商品、能不能买、下一关炸药数一次给全', function () {
  var s = newGame();
  s.level = 3; s.phase = 'levelClear'; s.score = 2000; s.target = 1000;
  var v = L.shopView(s);
  assert(v.open);
  eq(v.budget, 1000);
  eq(v.items.length, 3);
  v.items.forEach(function (i) {
    assert(typeof i.desc === 'string' && i.desc.length > 0, i.name + ' 的界面文案没带出来');
    assert(typeof i.canBuy === 'boolean');
  });
  assert(v.nextDynamite >= 1, '界面要能预告下一关几发炸药');
});

/* ==================================================================================
 * M. 收工（达标之后主动结束这一关）
 * ================================================================================== */
console.log('\nM. 收工');

test('没达标不能收工', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = s.target - 1;
  eq(L.canCashOut(s), false);
  eq(L.cashOut(s).length, 0, '不该产生任何事件');
  eq(s.phase, 'swinging', '相位不该变');
});

test('levelQuota 跟着门槛一起写：每关的"活儿"= 本关门槛增量', function () {
  var s = newGame();
  eq(s.levelQuota, s.target, '第 1 关之前是 0，所以活儿就是第 1 关的门槛');
  var t1 = s.target;
  L.nextLevel(s);
  eq(s.levelQuota, s.target - t1, '第 2 关的活儿应该是门槛增量');
  assert(s.levelQuota > 0, '活儿不能是 0');
});

test('收工的"本关活儿"约束：盈余顶得了门槛，顶不了收工', function () {
  /* 没有这条约束，一个打得很好的玩家会一路连点"收工"白嫖过关 ——
   * 因为分数和门槛都是累计的，盈余一旦盖过门槛，score >= target 在开局第一帧就成立。 */
  var s = newGame();
  L.beginLevel(s);
  s.levelQuota = 800;                 // 这一关要求自己赚 800
  s.score = s.target + 5000;          // 盈余远远盖过门槛
  s.levelStartScore = s.score;        // 但本关一分还没赚

  eq(L.canCashOut(s), false, '本关没干活就不该能收工');
  eq(L.cashOutGap(s), 800, '应该报出还差多少');
  eq(L.cashOut(s).length, 0, '被拦住时不该产生事件');

  s.score += 800;                     // 自己赚够了
  eq(L.canCashOut(s), true);
  eq(L.cashOutGap(s), 0);
});

test('达标就能收工：相位转 levelClear，事件带上剩余时间', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = s.target + 250;
  s.timeLeft = 37;
  eq(L.canCashOut(s), true);
  var ev = L.cashOut(s);
  eq(ev.length, 1);
  eq(ev[0].type, 'levelClear');
  eq(ev[0].cashedOut, true);
  eq(ev[0].score, s.target + 250);
  assert(ev[0].timeLeft > 30 && ev[0].timeLeft <= 37, '要报出还剩多少秒，实际 ' + ev[0].timeLeft);
  eq(s.phase, 'levelClear');
});

test('收工之后 step 不再推进（计时/物品都不动）', function () {
  var s = newGame();
  L.beginLevel(s);
  s.score = s.target;
  L.cashOut(s);
  var t0 = s.timeLeft;
  advance(s, 3);
  eq(s.timeLeft, t0, '收工之后不该继续扣时间');
  eq(s.phase, 'levelClear');
});

test('收工的钱能带进小卖部：结余就是预算', function () {
  /* 这条是收工机制存在的理由本身 ——
   * 达标之后每多挖一分，都会变成小卖部里的预算。 */
  var s = newGame();
  L.beginLevel(s);
  s.level = 4;
  s.score = s.target + 1200;
  L.cashOut(s);
  var v = L.shopView(s);
  assert(v.open, '第 4 关收工应该能进小卖部');
  eq(v.budget, 1200, '结余应该原样变成预算');
});

test('时间到过关 和 主动收工 走同一套事件形状', function () {
  function keys(o) { return Object.keys(o).sort().join(','); }
  var a = newGame(); L.beginLevel(a); a.score = a.target; a.timeLeft = 0;
  var evA = advance(a, 1, 'levelClear').hit;
  var b = newGame(); L.beginLevel(b); b.score = b.target; b.timeLeft = 30;
  var evB = L.cashOut(b)[0];
  eq(keys(evA), keys(evB), '两种过关的载荷字段必须一致（上层只写一套界面）');
  eq(evA.cashedOut, false);
  eq(evB.cashedOut, true);
});

/* ==================================================================================
 * N. 横屏布局（需求："优化 pc 端体验，浏览器打开不要竖屏"）
 * ================================================================================== */
console.log('\nN. 横屏布局');

test('两套布局都存在，且横屏确实是横的', function () {
  var p = L.LAYOUTS.portrait, q = L.LAYOUTS.landscape;
  assert(p.WORLD_H > p.WORLD_W, '竖屏布局应该是高的');
  assert(q.WORLD_W > q.WORLD_H, '横屏布局应该是宽的');
});

test('横屏布局的几何同样自洽（摆动锥收在土层内）', function () {
  var q = L.LAYOUTS.landscape;
  var drop = q.FIELD_Y - q.MINER_Y;
  var halfCone = drop * Math.tan(L.CONFIG.SWING_AMPLITUDE * Math.PI / 180);
  assert(drop > 0, '悬挂点必须在土层顶边之上');
  assert(halfCone <= q.FIELD_W / 2,
    '横屏摆动锥半宽 ' + halfCone.toFixed(1) + ' 超过土层半宽 ' + (q.FIELD_W / 2).toFixed(1));
});

test('横屏：也能正常铺场，且物品都不越界', function () {
  var s = L.createGame({ layout: 'landscape', rng: L._seededRng(9001) });
  eq(s.cfg.LAYOUT, 'landscape');
  for (var lv = 1; lv <= 12; lv++) {
    s.items = L.buildItems(s, lv);
    assert(s.items.length >= 8, '第 ' + lv + ' 关物品太少');
    s.items.forEach(function (it) {
      var b = Math.max(it.r, it.size / 2) * 0.72;
      assert(it.x - b >= s.cfg.FIELD_X - 1 && it.x + b <= s.cfg.FIELD_X + s.cfg.FIELD_W + 1,
        '第 ' + lv + ' 关 ' + it.type + ' 横向越界');
      assert(it.y - it.r >= s.cfg.FIELD_Y - 1 && it.y + it.r <= s.cfg.FIELD_Y + s.cfg.FIELD_H + 1,
        '第 ' + lv + ' 关 ' + it.type + ' 纵向越界');
    });
  }
});

test('切布局（relayout）：分数、门槛、时间都保留，只重铺场地', function () {
  /* 玩家在电脑上把窗口拉宽/拉窄时会触发这个。
   * 绝不能顺手把这一关作废 —— 分数和目标必须原样带过去。 */
  var s = newGame();                     // portrait
  L.beginLevel(s);
  s.score = 1234; s.target = 900; s.timeLeft = 41; s.combo = 5;
  s.level = 6;

  var changed = L.relayout(s, 'landscape');
  eq(changed, true, '布局真的换了应该返回 true');
  eq(s.cfg.LAYOUT, 'landscape');
  eq(s.score, 1234, '分数不该动');
  eq(s.target, 900, '门槛不该重算（重算就等于白送/白扣）');
  eq(s.timeLeft, 41, '时间不该重置');
  eq(s.combo, 5, '连击不该清');
  eq(s.level, 6);

  L.relayout(s, 'portrait');
  eq(s.cfg.LAYOUT, 'portrait');
  eq(s.score, 1234);
  eq(s.target, 900);
});

test('relayout：同一个布局重复调用是幂等的（不会每次重铺）', function () {
  var s = newGame();
  L.beginLevel(s);
  s.items = L.buildItems(s, 4);
  var first = s.items[0];
  eq(L.relayout(s, 'portrait'), false, '布局没变应该返回 false');
  eq(s.items[0], first, '布局没变就不该重铺场地');
});

/* ==================================================================================
 * 汇总
 * ================================================================================== */
console.log(lines.join('\n'));
console.log('\n' + '-'.repeat(64));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项，共 ' + (pass + fail) + ' 项');
console.log('-'.repeat(64));
process.exit(fail === 0 ? 0 : 1);
