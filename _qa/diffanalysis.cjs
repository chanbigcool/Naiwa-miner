/* 难度量化预览（只读分析，不碰游戏代码）
 * 复刻 logic.js 里的 recipe / achievableValue / nextTarget / swingPeriod，
 * 把"每关塞多少、目标多少、余量多大、摆速多快"摊开给你看。
 *
 * 用法：node _qa/diffanalysis.cjs [preset]
 *   preset: relaxed | standard(默认) | hard
 */
const PRESETS = {
  relaxed:  { SWING_PERIOD_START:4.2, SWING_PERIOD_MIN:2.4, SWING_PERIOD_STEP:0.15,
              LEVEL_TIME:70, TARGET_RATIO_BASE:0.50, TARGET_RATIO_STEP:0.12, TARGET_RATIO_MAX:2.20 },
  standard: { SWING_PERIOD_START:3.6, SWING_PERIOD_MIN:2.0, SWING_PERIOD_STEP:0.16,
              LEVEL_TIME:60, TARGET_RATIO_BASE:0.58, TARGET_RATIO_STEP:0.14, TARGET_RATIO_MAX:2.70 },
  hard:     { SWING_PERIOD_START:3.2, SWING_PERIOD_MIN:2.1, SWING_PERIOD_STEP:0.12,
              LEVEL_TIME:50, TARGET_RATIO_BASE:0.68, TARGET_RATIO_STEP:0.18, TARGET_RATIO_MAX:3.10 },
};
// 名义面值（门槛按原价算，这里用名义值估算"场地总价值"）
const VAL = { stone:5, blob:10, stand:20, mouse:40, rooster:70, dog:110, horse:180,
              rabbit:280, sumo:400, angel:-150, laugh:200, god:600 };
const TARGET_BASE = 320;

function recipe(L){
  const out=[];
  const add=(t,n)=>{ for(let i=0;i<n;i++) out.push(t); };
  add('stone', 2+Math.floor(L/2));
  add('angel', L>=3 ? 2+Math.floor(L/4) : 1);
  add('blob', Math.max(1,4-Math.floor(L/3)));
  add('stand', Math.max(1,3-Math.floor(L/4)));
  add('mouse', 1+Math.floor(L/3));
  add('rooster', Math.max(1,2-Math.floor(L/5)));
  add('dog', 1+Math.floor(L/3));
  add('horse', 1+Math.floor(L/3));
  if(L>=3) add('rabbit',1);
  if(L>=4) add('sumo', Math.min(2,1+Math.floor(L/6)));
  if(L>=6) add('laugh',1);
  if(L>=4 && L%3===0) add('god',1);
  return out;
}
function achievable(list){ return list.reduce((s,t)=>s+(VAL[t]||0),0); }
function swing(L,c){ return Math.max(c.SWING_PERIOD_MIN, c.SWING_PERIOD_START-(L-1)*c.SWING_PERIOD_STEP); }

const c = PRESETS[process.argv[2]||'standard'];
const pad=(s,n)=>{ s=String(s); const w=[...s].reduce((a,ch)=>a+(/[\u4e00-\u9fa5]/.test(ch)?2:1),0); return s+' '.repeat(Math.max(0,n-w)); };
console.log(`难度预设：${process.argv[2]||'standard'}  摆速 ${c.SWING_PERIOD_START}→${c.SWING_PERIOD_MIN}(步${c.SWING_PERIOD_STEP})  限时${c.LEVEL_TIME}s  目标 ${c.TARGET_RATIO_BASE}+${c.TARGET_RATIO_STEP}/关(顶${c.TARGET_RATIO_MAX})`);
console.log();
console.log(pad('关',4)+pad('摆速',7)+pad('塞入',5)+pad('石头',5)+pad('天使',5)+pad('值钱',5)+pad('场地总',8)+pad('目标',8)+pad('累计目标',10)+pad('余量',8)+pad('有效余量',10));
console.log('-'.repeat(86));
let target=0;
for(let L=1; L<=25; L++){
  const list=recipe(L);
  const counts={}; list.forEach(t=>counts[t]=(counts[t]||0)+1);
  const total=list.length;
  const stones=counts.stone||0, angels=counts.angel||0;
  const valuable=total-stones-angels;
  const fieldVal=achievable(list);
  const ratio=Math.min(c.TARGET_RATIO_MAX, c.TARGET_RATIO_BASE+(L-1)*c.TARGET_RATIO_STEP);
  const inc=Math.max(TARGET_BASE, Math.round(fieldVal*ratio));
  target+=inc;
  const cushion=fieldVal-target;                 // 把整片场地（含垃圾）收干净后的盈余
  const valVal=achievable(list.filter(t=>t!=='stone'&&t!=='angel')); // 只算值得抓的
  const effCushion=valVal-target;                // 只抓值钱的盈余
  console.log(
    pad(L,4)+pad(swing(L,c).toFixed(2),7)+pad(total,5)+pad(stones,5)+pad(angels,5)+pad(valuable,5)+
    pad(fieldVal,8)+pad(inc,8)+pad(target,10)+pad(cushion,8)+pad(effCushion,10)
  );
}
