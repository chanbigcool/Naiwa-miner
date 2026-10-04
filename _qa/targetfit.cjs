/* 目标曲线拟合器：一次采样，离线试任意多条门槛曲线。
 *
 * 为什么要有它：
 *   要回答两个问题——
 *     (a) 「玩家打到第几关会卡住」（整体难度）
 *     (b) 「一关里打到目标分用掉多少时间」（本关是否空转）
 *   (b) 才是这轮玩家抱怨的正主：
 *     "我不一会就抓到目标分数了，为了不抓到天使奶蛙我直接不操作进下一关"。
 *     这句话的意思是：达标的时刻来得太早，剩下的时间是纯空转，而且继续挖只承担
 *     天使扣分的风险。所以真正要拟合的量是**达标时刻 / 关卡时长**，不是"死在第几关"。
 *
 * 关键观察：**目标分只影响成败，不影响玩法**。
 *   一关能收多少分、收分发生在第几秒，跟门槛定多高完全无关 ——
 *   所以先把 N 局 × 每关的「(时刻, 得分) 事件流」采样下来，
 *   再拿这些事件流去套任意门槛曲线，毫秒级出结果。
 *
 * 用法：
 *   node _qa/targetfit.cjs                 # 当前曲线 + 候选网格
 *   node _qa/targetfit.cjs 0.55 0.115 2.6  # 指定 base / step / max
 *   node _qa/targetfit.cjs 0.55 0.115 2.6 240   # 再指定 TARGET_BASE
 */
'use strict';
const L = require('../miner/logic.js');
const A = require('./aimlib.cjs');
const FPS = 1 / 60;
const MAXLV = 20;

/* —— 人类代理：4~8° 瞄偏 + 25% 手抖打歪 + 会用炸药（跟 skill.cjs 保持一致）—— */
function playLevel(s, rng) {
  L.beginLevel(s);
  const pick = A.makeAimer();
  const T = s.cfg.LEVEL_TIME;
  const ev = [];
  let hand = null, guard = 0, elapsed = 0, last = s.score;
  while (s.phase === 'swinging' || s.phase === 'shooting' || s.phase === 'pulling') {
    if (s.phase === 'swinging') {
      const p = pick(s);
      if (p) {
        if (!hand) { hand = { tol: 4 + rng() * 4, shake: rng() < 0.25 }; }
        if (Math.abs(s.angle - p.a) <= hand.tol) {
          if (hand.shake) { s.angle += (rng() - 0.5) * 26; }
          L.shoot(s); hand = null;
        }
      }
    }
    if (s.phase === 'pulling' && s.held && s.held.isStone && s.dynamite > 0 && rng() < 0.8) { L.blowUp(s); }
    L.step(s, FPS);
    elapsed += FPS;
    if (s.score !== last) { ev.push({ at: Math.min(elapsed, T), d: s.score - last }); last = s.score; }
    if (guard++ > 60 * 300) break;
  }
  return ev;
}

const RUNS = parseInt(process.env.RUNS || '40', 10);

/* —— 采样：每局 × 每关的 (时刻, 得分) 事件流 —— */
const samples = [];
for (let i = 0; i < RUNS; i++) {
  const seed = 88000 + i * 233;
  const s = L.createGame({ rng: L._seededRng(seed) });
  const rng = L._seededRng(seed + 555);
  const row = [];
  for (let lv = 1; lv <= MAXLV; lv++) {
    const face = L.achievableValue(s.items);
    row.push({ lv, face, ev: playLevel(s, rng) });
    L.nextLevel(s);
  }
  samples.push(row);
}

/* —— 用一条曲线去套样本 ——
 * 返回：每局"死在第几关" + 每关"达标时刻占关卡时长的比例" */
function evaluateCurve(base, step, max, tbase) {
  const cfg = L.CONFIG;
  const TB = tbase === undefined ? cfg.TARGET_BASE : tbase;
  const T = cfg.LEVEL_TIME;
  const ratio = lv => Math.min(max, base + (lv - 1) * step);

  const died = [];
  const perLevel = [];
  const idle = [];             // 每关"达标之后还剩多少秒"（只统计通过的关）

  for (const row of samples) {
    let score = 0, target = 0, prevTarget = 0, dead = MAXLV + 1;
    for (const r of row) {
      prevTarget = target;
      target += Math.max(TB, Math.round(r.face * ratio(r.lv)));
      /* 两个不同的时刻，别混：
       *   过关 = 时间到时 score >= target（只看门槛）
       *   收工 = score >= target 且**本关自己赚够了**（levelQuota = 门槛增量）
       * 玩家能停手的最早时刻是"收工"那一刻，所以节奏指标用后者。 */
      const quota = target - prevTarget;
      let passAt = -1, income = 0;
      for (const e of r.ev) {
        income += e.d; score += e.d;
        if (passAt < 0 && score >= target && income >= quota) { passAt = e.at; }
      }
      const st = perLevel[r.lv] || (perLevel[r.lv] = { pass: 0, n: 0, face: 0, atSum: 0, atN: 0 });
      st.n++;
      st.face += r.face;
      if (passAt >= 0) {
        st.pass++;
        st.atSum += passAt / T;
        st.atN++;
        idle.push(T - passAt);
      }
      if (score < target && dead === MAXLV + 1) { dead = r.lv; }
    }
    died.push(dead);
  }

  died.sort((a, b) => a - b);
  idle.sort((a, b) => a - b);
  const pct = p => (p.pass / p.n * 100);
  const atOf = p => (p.atN ? p.atSum / p.atN * 100 : NaN);
  const pick = lv => perLevel[lv]
    ? pct(perLevel[lv]).toFixed(0) + '% / ' + atOf(perLevel[lv]).toFixed(0) + '%'
    : '--';
  return {
    median: died[Math.floor(died.length / 2)],
    p25: died[Math.floor(died.length * 0.25)],
    p75: died[Math.floor(died.length * 0.75)],
    l1: pick(1), l3: pick(3), l5: pick(5),
    idleMed: idle.length ? Math.round(idle[Math.floor(idle.length / 2)]) : null,
    perLevel,
  };
}

/* —— 一条曲线的"体感诊断"：达标时刻落在哪里 —— */
function diagnose(base, step, max, tbase) {
  const r = evaluateCurve(base, step, max, tbase);
  const cfg = L.CONFIG;
  const T = cfg.LEVEL_TIME;
  const TB = tbase === undefined ? cfg.TARGET_BASE : tbase;
  const ratio = lv => Math.min(max, base + (lv - 1) * step);

  // 汇总所有"通过的关"的达标时刻分布
  let buckets = [0, 0, 0, 0, 0];   // 0-20 / 20-40 / 40-60 / 60-80 / 80-100%
  /* 两种口径分别统计，**不要把两者混着比**：
   *   raw  = score >= target          （老口径：分数够了）
   *   cash = score >= target 且本关赚够（新口径：可以收工）
   * 和旧版本对比节奏时，只能拿 raw 对 raw。 */
  let rawBuckets = [0, 0, 0, 0, 0];
  for (const row of samples) {
    let score = 0, target = 0, prevTarget = 0;
    for (const rr of row) {
      prevTarget = target;
      target += Math.max(TB, Math.round(rr.face * ratio(rr.lv)));
      const quota = target - prevTarget;
      let passAt = -1, rawAt = -1, income = 0;
      for (const e of rr.ev) {
        income += e.d; score += e.d;
        if (rawAt < 0 && score >= target) { rawAt = e.at; }
        if (passAt < 0 && score >= target && income >= quota) { passAt = e.at; }
      }
      if (passAt >= 0) { buckets[Math.min(4, Math.floor(passAt / T * 5))]++; }
      if (rawAt >= 0) { rawBuckets[Math.min(4, Math.floor(rawAt / T * 5))]++; }
    }
  }
  return { r, buckets, rawBuckets, sum: 0 };
}

function bar(n, sum) {
  const w = Math.round(n / sum * 34);
  return String(Math.round(n / sum * 100)).padStart(3) + '% ' + '#'.repeat(w);
}

const cfg = L.CONFIG;
const argBase = process.argv[2] ? parseFloat(process.argv[2]) : null;

console.log('样本：' + RUNS + ' 局 × ' + MAXLV + ' 关（人类代理，含用炸药）\n');
{
  let faceSum = 0;
  for (const row of samples) { faceSum += row[0].face; }
  const faceAvg = faceSum / samples.length;
  console.log('第 1 关平均面值 ' + Math.round(faceAvg) +
    ' · ratio ' + cfg.TARGET_RATIO_BASE + ' 算出 ' + Math.round(faceAvg * cfg.TARGET_RATIO_BASE) +
    ' · TARGET_BASE ' + cfg.TARGET_BASE +
    (faceAvg * cfg.TARGET_RATIO_BASE <= cfg.TARGET_BASE ? '  ← TARGET_BASE 在起主导' : '  ← TARGET_BASE 不生效（被 ratio 盖住）'));
}

function show(label, base, step, max, tbase) {
  const d = diagnose(base, step, max, tbase);
  const sum = d.buckets.reduce((a, b) => a + b, 0) || 1;
  const rawSum = d.rawBuckets.reduce((a, b) => a + b, 0) || 1;
  console.log('\n' + label + '  [' + [base, '+' + step, max].join(' / ') +
    (tbase !== undefined ? ' / BASE ' + tbase : '') + ']');
  console.log('  中位数第 ' + d.r.median + ' 关（25% ' + d.r.p25 + '，75% ' + d.r.p75 + '）· ' +
    '第 1 关通过率 ' + d.r.l1.split(' / ')[0]);
  console.log('  达标(=可收工)时刻分布：');
  ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'].forEach((nm, i) => {
    console.log('    ' + nm.padStart(7) + '  ' + bar(d.buckets[i], sum));
  });
  console.log('  【对旧口径】分数够了(score>=target)的时刻分布：');
  ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'].forEach((nm, i) => {
    console.log('    ' + nm.padStart(7) + '  ' + bar(d.rawBuckets[i], rawSum));
  });
}

if (argBase !== null) {
  show('指定曲线', argBase, parseFloat(process.argv[3]), parseFloat(process.argv[4]),
    process.argv[5] ? parseFloat(process.argv[5]) : undefined);
} else {
  show('当前 logic.js', cfg.TARGET_RATIO_BASE, cfg.TARGET_RATIO_STEP, cfg.TARGET_RATIO_MAX);
  console.log('\n\n==================== 候选网格 ====================');
  const cands = [
    [0.50, 0.10, 2.30], [0.55, 0.11, 2.40], [0.55, 0.115, 2.60],
    [0.62, 0.12, 2.60], [0.70, 0.12, 2.60], [0.80, 0.12, 2.60],
    [0.90, 0.12, 2.60], [1.00, 0.12, 2.60],
  ];
  for (const [b, st, mx] of cands) {
    const d = diagnose(b, st, mx);
    console.log('  ' + [b, '+' + st, mx].join(' / ').padEnd(20) +
      '→ 第 ' + String(d.r.median).padStart(2) + ' 关' +
      ' · L1 ' + d.r.l1.padStart(11) +
      ' · L3 ' + d.r.l3.padStart(11) +
      ' · 空转 ' + String(d.r.idleMed).padStart(2) + 's');
  }
}
