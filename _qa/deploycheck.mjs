/* 线上 / 本机一致性核对（零依赖）
 *
 *   node _qa/deploycheck.mjs [基址] [本机目录]
 *   node _qa/deploycheck.mjs http://127.0.0.1:8137/ .
 *
 * 干什么：
 *   1. 从两个入口页（根 index.html、miner/index.html）里把所有
 *      src= / href= 的相对路径扒出来，一个不漏地去线上取一遍；
 *   2. 逐个和本机文件比 md5 —— 线上 404 就是"漏发"，内容不同就是"发的是旧包"；
 *   3. 顺手核对 ?v= 版本号：meta miner-build 必须和每个本地脚本/样式上的 v 一致，
 *      否则一次部署里会混进两个版本的 JS（比旧包还难查）。
 *
 * 为什么需要它：这个站的响应头只有 Last-Modified，没有 Cache-Control / ETag，
 * 所以"线上到底是不是新包"没法靠浏览器看 —— 浏览器可能压根没去问服务器。
 * 用哈希比是唯一不含糊的答案。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = (process.argv[2] || 'https://naiwa-mini-games.app.workbuddy.host/').replace(/\/?$/, '/');
const ROOT = path.resolve(process.argv[3] || '.');
const PAGES = ['index.html', 'miner/index.html'];

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const short = (h) => (h ? h.slice(0, 8) : '--------');

function readLocal(rel) {
  const abs = path.join(ROOT, rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) { return null; }
    return { hash: md5(fs.readFileSync(abs)), size: st.size, mtime: st.mtime };
  } catch (e) { return null; }
}

/** 从一页 HTML 里收集相对引用（保留 ?v=，本地比对时去掉） */
function refsOf(pageRel) {
  const page = readLocal(pageRel);
  if (!page) { return []; }
  const html = fs.readFileSync(path.join(ROOT, pageRel), 'utf8');
  const dir = path.dirname(pageRel) === '.' ? '' : path.dirname(pageRel);
  const out = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^(https?:|data:|mailto:|javascript:)/i.test(raw)) { continue; }
    const q = raw.indexOf('?');
    const bare = q >= 0 ? raw.slice(0, q) : raw;
    const query = q >= 0 ? raw.slice(q) : '';
    // 指向目录的引用（如 miner/ 或 miner/?preset=standard）不是文件，真正的 index.html
    // 会在 PAGES 里单独校验，跳过避免误报"本机缺这个文件"。先剥掉 ? 再判结尾。
    if (bare.endsWith('/')) { continue; }
    const rel = path.posix.normalize(path.posix.join(dir, bare));
    out.push({ rel, url: BASE + rel + query, query, page: pageRel });
  }
  return out;
}

/** 版本号必须全页一致 */
function checkVersion() {
  const page = readLocal('miner/index.html');
  if (!page) { return { ok: false, note: '找不到 miner/index.html' }; }
  const html = fs.readFileSync(path.join(ROOT, 'miner/index.html'), 'utf8');
  const meta = /<meta\s+name="miner-build"\s+content="([^"]*)"/i.exec(html);
  const build = meta ? meta[1].trim() : '';
  const vers = new Set();
  const missing = [];
  const re = /<(?:(?:script)\s+src|link\s+rel="stylesheet"\s+href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const q = m[1].indexOf('?v=');
    if (q < 0) { missing.push(m[1]); continue; }
    vers.add(m[1].slice(q + 3));
  }
  const list = [...vers];
  return {
    ok: !!build && missing.length === 0 && list.length === 1 && list[0] === build,
    build, vers: list, missing,
  };
}

const version = checkVersion();
console.log('\n资源版本检查');
console.log('  meta miner-build : ' + (version.build || '（缺）'));
console.log('  脚本/样式上的 v  : ' + (version.vers.length ? version.vers.join(', ') : '（缺）'));
if (version.missing.length) { console.log('  没带 ?v= 的标签   : ' + version.missing.join(', ')); }
console.log('  → ' + (version.ok ? '一致' : '不一致（同一次部署里混了两个版本，必须修）'));

/* 根路径入口：
 * 根 index.html 现在是"进站落地页"（奶蛙矿工大标题 + 玩法简介 + 开始游戏按钮），
 * 也可以降级成一张纯跳转卡。两种形态都允许，只要满足：
 *   1) 站内入口确实指向 miner/（要么 refresh/location.replace 跳过去，要么有「开始游戏」a 链到 miner/）；
 *   2) 进站页带「奶蛙矿工」大标题（class="title"），别被旧集合页顶替。
 * 这条检查防的是"根页被改回旧集合页 / 入口跳到不存在的路径"。 */
function checkEntry() {
  let html = '';
  try { html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); } catch (e) {
    return { ok: false, note: '找不到 index.html' };
  }
  const meta = /http-equiv="refresh"[^>]*content="[^"]*url=([^";\s]+)"/i.exec(html);
  const js = /location\.replace\(\s*'([^']+)'/.exec(html);
  const redirectToMiner = [meta && meta[1], js && js[1]]
    .filter(Boolean).some((t) => t.indexOf('miner/') === 0);
  const hasEnterLink = /<a[^>]+href="miner\/?[^"]*"[^>]*>/.test(html);
  const hasTitle = /class="title"[^>]*>奶蛙矿工</.test(html) || /<title>奶蛙矿工<\/title>/.test(html);
  const note = redirectToMiner
    ? '跳转 miner/'
    : (hasEnterLink && hasTitle ? '进站页（标题 + 开始游戏 → miner/）' : '入口缺失');
  const ok = (redirectToMiner || hasEnterLink) && hasTitle;
  return { ok, note };
}

const entry = checkEntry();
console.log('\n根路径入口');
console.log('  形态 : ' + entry.note);
console.log('  → ' + (entry.ok ? '进站页或跳转都正常' : '不对（根路径必须能进 miner/ 且带奶蛙矿工标题）'));

const seen = new Map();
for (const page of PAGES) {
  for (const r of refsOf(page)) {
    if (!seen.has(r.rel)) { seen.set(r.rel, r); }
  }
}
const items = [...seen.values()].sort((a, b) => a.rel.localeCompare(b.rel));

console.log('\n逐文件比对 —— 本机 ' + ROOT + '  ↔  ' + BASE);
const rows = [];
let bad = 0;
for (const it of items) {
  const local = readLocal(it.rel);
  let status = 0, buf = null, headerNote = '';
  try {
    const res = await fetch(it.url, { cache: 'no-store' });
    status = res.status;
    if (res.ok) { buf = Buffer.from(await res.arrayBuffer()); }
    const cc = res.headers.get('cache-control');
    const et = res.headers.get('etag');
    headerNote = [cc ? 'Cache-Control: ' + cc : '', et ? 'ETag' : ''].filter(Boolean).join(' · ');
  } catch (e) {
    status = 0;
  }

  const liveHash = buf ? md5(buf) : '';
  let verdict;
  if (!local) { verdict = '本机缺这个文件'; bad++; }
  else if (status === 404) { verdict = '线上 404 —— 漏发了'; bad++; }
  else if (!status) { verdict = '取不到（网络或证书）'; bad++; }
  else if (!buf) { verdict = 'HTTP ' + status; bad++; }
  else if (liveHash !== local.hash) { verdict = '内容不同 —— 线上是旧包'; bad++; }
  else { verdict = '一致'; }

  rows.push({
    文件: it.rel,
    本机: short(local && local.hash),
    线上: status + ' ' + short(liveHash),
    结论: verdict,
    缓存头: headerNote || '无',
  });
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
console.log('  ' + pad('文件', 34) + pad('本机', 12) + pad('线上', 14) + '结论');
console.log('  ' + '-'.repeat(86));
for (const r of rows) {
  console.log('  ' + pad(r.文件, 34) + pad(r.本机, 12) + pad(r.线上, 14) + r.结论);
}

const noHeader = rows.filter((r) => r.缓存头 === '无').length;
console.log('\n共 ' + rows.length + ' 个引用：' +
  (bad ? bad + ' 处有问题' : '全部一致') +
  ' · ' + noHeader + ' 个响应不带 Cache-Control/ETag（所以前端资源必须靠 ?v= 换 URL）');

if (!version.ok) {
  console.log('\n版本号不一致，部署前先修 index.html。');
  process.exit(2);
}
if (bad) {
  console.log('\n线上与本机不一致，检查是否漏发或还没重新发布。');
  process.exit(1);
}
console.log('\n核对通过：线上就是这份代码。');
