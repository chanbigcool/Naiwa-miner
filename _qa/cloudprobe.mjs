/* 云端榜预检：在**真实发布域名**上跑一次 insert + select
 * ---------------------------------------------------------------------------
 * 为什么必须在发布域名上跑：服务器按 Origin 精确匹配，127.0.0.1 和
 * file:// 一律被拒。本地测出来的"失败"没有参考价值。
 *
 * 用法：node _qa/cloudprobe.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9377;
const URL = 'https://naiwa-mini-games.app.workbuddy.host/miner/';
const CONFIG = {
  endpoint: 'https://naiwa-mini-games.app.workbuddy.host',
  publishableKey: 'wbpk_6g80Rkt1j3EP45NnVhqQew_XZIJkK3apECfLvCK7tSyDpcXLzxd3MhB',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-probe-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
  '--window-size=420,880', 'about:blank',
], { stdio: 'ignore' });

async function main() {
  let tabs = null;
  for (let i = 0; i < 60; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (tabs.length) { break; }
    } catch (e) { /* 等待启动 */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.text); }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  const out = await evaluate(`(async () => {
    const CONFIG = ${JSON.stringify(CONFIG)};
    const log = { origin: location.origin, sdk: false, init: false, insert: null, read: null, count: null };
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
        s.onload = res; s.onerror = () => rej(new Error('sdk load failed'));
        document.head.appendChild(s);
      });
      log.sdk = !!window.WorkBuddyCloud;
      const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CONFIG.endpoint,
        publishableKey: CONFIG.publishableKey,
      });
      log.init = !!cloud.database;

      const runId = 'probe-' + Date.now().toString(36);
      const ins = await cloud.database.from('miner_scores').insert({
        run_id: runId, client_id: 'probe-client', name: '探针', avatar: 'stand',
        score: 1234, level: 2, combo_best: 3, preset: 'standard', outcome: 'fail',
      });
      log.insert = ins.error
        ? { code: ins.error.code, message: ins.error.message }
        : { ok: true, rows: (ins.data || []).length, runId };

      const sel = await cloud.database.from('miner_scores')
        .select('id, run_id, name, score, level, combo_best, created_at', { count: 'exact' })
        .order('score', { ascending: false })
        .limit(5);
      log.read = sel.error
        ? { code: sel.error.code, message: sel.error.message }
        : { ok: true, rows: (sel.data || []).map(r => r.name + ':' + r.score) };
      log.count = sel.count;

      /* 顺手确认一下只增不改：UPDATE 应该被 RLS 挡掉（返回空数组或 42501） */
      const upd = await cloud.database.from('miner_scores')
        .update({ score: 999999 }).eq('run_id', runId).select();
      log.update = upd.error ? { code: upd.error.code, message: upd.error.message }
                             : { rows: (upd.data || []).length };
    } catch (e) {
      log.error = String(e && (e.message || e));
    }
    return log;
  })()`);

  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync('_qa/cloudprobe-report.json', JSON.stringify(out, null, 2));

  ws.close();
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  const ok = out.sdk && out.init && out.insert && out.insert.ok && out.read && out.read.ok;
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error('探针失败:', e.message);
  try { chrome.kill(); } catch (x) { /* ignore */ }
  process.exit(1);
});
