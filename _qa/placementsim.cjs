/* 落位容量模拟（只读，复刻 logic.js 的 recipe + buildItems 落位，竖屏参数）
 * 目的：看"每关实际能放下多少件"，为后期数量上限定标。
 * 用法：node _qa/placementsim.cjs [recipeMode]
 *   recipeMode: current(默认) | capped
 */
const cfg = {
  FIELD_X:46, FIELD_Y:300, FIELD_W:628, FIELD_H:848, MINER_X:360, MINER_Y:220,
  ITEM_GAP:6, MAX_PLACE_TRIES:90, MAX_HALF_ANGLE:10, ROPE_IDLE_LEN:78,
  BLOCK_MAX_PER_LEVEL:3, BLOCK_TRY:24, BLOCK_MIN_VALUE:180,
};
const D2R = Math.PI/180;
const ITEMS = {
  stone:{r:36,value:5}, blob:{r:25,value:10}, stand:{r:30,value:20}, mouse:{r:35,value:40},
  rooster:{r:40,value:70}, dog:{r:46,value:110}, horse:{r:53,value:180}, rabbit:{r:60,value:280},
  sumo:{r:68,value:400}, angel:{r:48,value:-150}, laugh:{r:43,value:200}, god:{r:76,value:600},
};
function recipeCurrent(L){
  const out=[]; const add=(t,n)=>{for(let i=0;i<n;i++)out.push(t);};
  add('stone', 2+Math.floor(L/2));
  add('angel', L>=3?2+Math.floor(L/4):1);
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
function recipeCapped(L){
  const out=[]; const add=(t,n)=>{for(let i=0;i<n;i++)out.push(t);};
  const cap=(n,m)=>Math.min(n,m);
  add('stone', Math.min(2+Math.floor(L/2), 9));
  add('angel', Math.min(L>=3?2+Math.floor(L/4):1, 6));
  add('blob', Math.max(1,4-Math.floor(L/3)));
  add('stand', Math.max(1,3-Math.floor(L/4)));
  add('mouse', cap(1+Math.floor(L/3), 4));
  add('rooster', Math.max(1,2-Math.floor(L/5)));
  add('dog', cap(1+Math.floor(L/3), 4));
  add('horse', cap(1+Math.floor(L/3), 4));
  if(L>=3) add('rabbit',1);
  if(L>=4) add('sumo', Math.min(2,1+Math.floor(L/6)));
  if(L>=6) add('laugh',1);
  if(L>=4 && L%3===0) add('god',1);
  return out;
}
const RECIPE = process.argv[2]==='capped'?recipeCapped:recipeCurrent;
function fits(items, x, y, r){
  if(x<cfg.FIELD_X+r||x>cfg.FIELD_X+cfg.FIELD_W-r) return false;
  if(y<cfg.FIELD_Y+r||y>cfg.FIELD_Y+cfg.FIELD_H-r) return false;
  const ddx=x-cfg.MINER_X, ddy=y-cfg.MINER_Y; const dist2=ddx*ddx+ddy*ddy;
  const minDist=r/Math.sin(cfg.MAX_HALF_ANGLE*D2R);
  if(dist2<minDist*minDist) return false;
  for(const o of items){ const dx=x-o.x, dy=y-o.y; const need=r+o.r+cfg.ITEM_GAP; if(dx*dx+dy*dy<need*need) return false; }
  return true;
}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function place(L, rng){
  const list=RECIPE(L); let stones=0; const solids=[];
  for(const t of list){ if(t==='stone') stones++; else solids.push(t); }
  solids.sort((a,b)=>ITEMS[b].r-ITEMS[a].r);
  const items=[];
  for(const type of solids){ const def=ITEMS[type]; let placed=null;
    let depthBias=0; if(def.value>=280) depthBias=0.42; else if(def.value>=110) depthBias=0.22; else if(def.value>=40) depthBias=0.08;
    for(let t=0;t<cfg.MAX_PLACE_TRIES;t++){ const yLo=cfg.FIELD_Y+def.r+depthBias*cfg.FIELD_H; const yHi=cfg.FIELD_Y+cfg.FIELD_H-def.r; const yy=yLo>yHi?cfg.FIELD_Y+def.r:yLo;
      const x=cfg.FIELD_X+def.r+rng()*(cfg.FIELD_W-def.r*2); const y=yy+rng()*(yHi-yy);
      if(fits(items,x,y,def.r)){placed={x,y};break;} }
    if(placed) items.push({...placed, r:def.r, value:def.value}); }
  // 石头：先挡再随机
  let blocked=0; const sdef=ITEMS.stone;
  for(let s=0;s<stones;s++){ let pos=null;
    if(blocked<cfg.BLOCK_MAX_PER_LEVEL && items.length>0){ for(let q=0;q<cfg.BLOCK_TRY;q++){ const cand=items[Math.floor(rng()*items.length)]; if(!cand||cand.value<sdef.value||cand.value<cfg.BLOCK_MIN_VALUE) continue; const ddx=cand.x-cfg.MINER_X, ddy=cand.y-cfg.MINER_Y; const dist=Math.sqrt(ddx*ddx+ddy*ddy); if(dist<1) continue; const back=dist-(cand.r+sdef.r+cfg.ITEM_GAP); if(back<=cfg.ROPE_IDLE_LEN+sdef.r) continue; const bx=cfg.MINER_X+(ddx/dist)*back, by=cfg.MINER_Y+(ddy/dist)*back; if(fits(items,bx,by,sdef.r)){pos={x:bx,y:by};blocked++;break;} } }
    for(let t2=0;!pos&&t2<cfg.MAX_PLACE_TRIES;t2++){ const sx=cfg.FIELD_X+sdef.r+rng()*(cfg.FIELD_W-sdef.r*2); const sy=cfg.FIELD_Y+sdef.r+rng()*(cfg.FIELD_H-sdef.r*2); if(fits(items,sx,sy,sdef.r)) pos={x:sx,y:sy}; }
    if(pos) items.push({...pos, r:sdef.r, value:5}); }
  return items.length;
}
const SEEDS=40; const sums={}; const reqs={};
for(let L=1;L<=25;L++){ sums[L]=0; reqs[L]=RECIPE(L).length; for(let s=0;s<SEEDS;s++){ const rng=mulberry32(1000+L*7+s*13); sums[L]+=place(L,rng); } sums[L]=Math.round(sums[L]/SEEDS); }
console.log('模式:', process.argv[2]==='capped'?'capped(上限)':'current(当前)');
console.log('关 请求 实际落位');
for(let L=1;L<=25;L++){ console.log(String(L).padEnd(3), String(reqs[L]).padEnd(4), sums[L]); }
