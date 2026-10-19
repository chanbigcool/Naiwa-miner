/* 云排行榜客户端（WorkBuddy 云服务 · 不登录）
 * ===========================================================================
 * 为什么单独一个文件：
 *   游戏主体是纯静态、零依赖、file:// 也能跑。云端只是"锦上添花"的那一层，
 *   所以把它隔离在这里 —— 加载失败、域名不对、断网，都只是让这里返回离线，
 *   一行都不会连累到游戏本体。
 *
 * 三个必须知道的事实（都踩过/验证过）：
 *   1. 服务器按 **Origin 精确匹配** 认人。只有发布域名
 *      （https://naiwa-mini-games.app.workbuddy.host）同源时才允许读写。
 *      GitHub Pages、127.0.0.1、file:// 一律跳过 —— 不是"可能失败"，
 *      是必然被拒，所以干脆不发请求，直接告诉上层"离线"。
 *   2. 不登录 = anon 角色。表上只开了 SELECT / INSERT 两道口子，
 *      所以这里是**只增不改**：改名不会追溯旧记录（旧记录是当时名字的快照）。
 *   3. publishableKey 只是"你是哪个应用"，本身没权限；真正的门在服务端。
 *      它出现在前端源码里是正常的，但不要往日志里打。
 *
 * 对外 API：
 *   MinerCloud.available()        → 这个环境能不能连（同步，纯判断）
 *   MinerCloud.load(limit)        → Promise<{ rows:{score,level,combo}, count }>
 *   MinerCloud.submit(rec, name)  → Promise<{ ok, queued, dup, error }>
 *   MinerCloud.flush(name)        → Promise<number>  把离线攒下的补传上去
 *   MinerCloud.status / .error    → 'idle' | 'online' | 'offline' | 'disabled'
 */
(function (root) {
  'use strict';

  var TABLE = 'miner_scores';
  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  var COLUMNS = 'id, run_id, client_id, name, avatar, score, level, combo_best, preset, outcome, created_at';

  var QKEY = 'naiwa_miner_cloudq_v1';
  var CKEY = 'naiwa_miner_cid';

  /* 这四个值来自开通云服务时返回的 publicConfig。
   * 静态站没有构建步骤，没别的地方能注入，所以落在这里；
   * 换应用/重新发布后要同步更新，否则 Origin 对不上会直接 404。 */
  var CFG = {
    endpoint: 'https://naiwa-mini-games.app.workbuddy.host',
    publishableKey: 'wbpk_6g80Rkt1j3EP45NnVhqQew_XZIJkK3apECfLvCK7tSyDpcXLzxd3MhB',
  };

  var client = null;
  var loading = null;
  var status = 'idle';
  var lastError = '';

  /* ---------------- 基础设施 ---------------- */

  function store(fn, dflt) {
    try { return fn(); } catch (e) { return dflt; }
  }

  /* 这台设备的随机指纹：只用来在榜上标出"哪几条是你"，不是身份凭证。
   * 没有它，玩家在公共榜上认不出自己的成绩。 */
  function clientId() {
    var v = store(function () { return localStorage.getItem(CKEY) || ''; }, '');
    if (!v) {
      v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      store(function () { localStorage.setItem(CKEY, v); });
    }
    return v;
  }

  function available() {
    if (!CFG.endpoint || !CFG.publishableKey) { return false; }
    try {
      var want = new URL(CFG.endpoint).origin;
      return !!root.location && root.location.origin === want;
    } catch (e) { return false; }
  }

  function loadSdk() {
    if (root.WorkBuddyCloud) { return Promise.resolve(root.WorkBuddyCloud); }
    if (loading) { return loading; }
    loading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      var timer = setTimeout(function () { rej(new Error('SDK 加载超时')); }, 8000);
      s.onload = function () {
        clearTimeout(timer);
        if (root.WorkBuddyCloud) { res(root.WorkBuddyCloud); }
        else { rej(new Error('SDK 没有挂上全局')); }
      };
      s.onerror = function () { clearTimeout(timer); rej(new Error('SDK 下载失败')); };
      document.head.appendChild(s);
    });
    /* 失败后允许下次重试，不然一次断网就永久离线 */
    loading.catch(function () { loading = null; });
    return loading;
  }

  function ready() {
    if (client) { return Promise.resolve(client); }
    return loadSdk().then(function (sdk) {
      /* endpoint + publishableKey 必须都传，且都来自 publicConfig。
       * 不登录，所以不需要 oauthRelayBaseUrl。 */
      client = sdk.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        publishableKey: CFG.publishableKey,
      });
      return client;
    });
  }

  /* ---------------- 行格式转换 ---------------- */

  function pad(n) {
    var s = String(n == null ? '' : n);
    while (s.length < 12) { s = '0' + s; }
    return s;
  }

  function fromRow(x) {
    return {
      id: 'c' + pad(x.id),
      cloudId: x.id,
      runId: x.run_id || '',
      clientId: x.client_id || '',
      name: x.name,
      avatar: x.avatar,
      score: x.score,
      level: x.level,
      comboBest: x.combo_best,
      preset: x.preset,
      outcome: x.outcome,
      ts: Date.parse(x.created_at) || 0,
      named: true,
    };
  }

  function clampInt(v, lo, hi) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) { n = lo; }
    return Math.max(lo, Math.min(hi, n));
  }

  function toRow(rec, name) {
    if (!rec) { return null; }
    var n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 8);
    var ava = String(rec.avatar || '');
    return {
      run_id: String(rec.id || '') || null,
      client_id: clientId(),
      name: n,
      avatar: /^[a-z0-9-]{1,24}$/.test(ava) ? ava : 'stand',
      score: clampInt(rec.score, 0, 1000000000),
      level: clampInt(rec.level, 1, 999),
      combo_best: clampInt(rec.comboBest, 0, 9999),
      preset: (rec.preset === 'relaxed' || rec.preset === 'hard') ? rec.preset : 'standard',
      outcome: rec.outcome === 'quit' ? 'quit' : 'fail',
    };
  }

  /* ---------------- 离线队列 ---------------- */

  function readQ() {
    var raw = store(function () { return localStorage.getItem(QKEY) || '[]'; }, '[]');
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (r) { return r && r.run_id; }) : [];
    } catch (e) { return []; }
  }
  function writeQ(arr) {
    store(function () { localStorage.setItem(QKEY, JSON.stringify(arr.slice(-24))); });
  }
  function enqueue(row) {
    var q = readQ();
    for (var i = 0; i < q.length; i++) { if (q[i].run_id === row.run_id) { return; } }
    q.push(row);
    writeQ(q);
  }

  /* ---------------- 读写 ---------------- */

  function query(metric, limit) {
    return ready().then(function (c) {
      return c.database.from(TABLE)
        .select(COLUMNS, { count: 'exact' })
        .order(metric, { ascending: false })
        .order('created_at', { ascending: true })
        .limit(limit);
    }).then(function (res) {
      if (res.error) { throw res.error; }
      return res;
    });
  }

  function load(limit) {
    limit = limit || 50;
    if (!available()) {
      status = 'disabled';
      return Promise.reject(new Error('当前域名连不上云服务'));
    }
    return Promise.all([
      query('score', limit),
      query('level', limit),
      query('combo_best', limit),
    ]).then(function (res) {
      status = 'online';
      lastError = '';
      var rows = {
        score: (res[0].data || []).map(fromRow),
        level: (res[1].data || []).map(fromRow),
        combo: (res[2].data || []).map(fromRow),
      };
      return { rows: rows, count: typeof res[0].count === 'number' ? res[0].count : rows.score.length };
    }).catch(function (err) {
      status = 'offline';
      lastError = (err && (err.message || err.code)) || '网络错误';
      throw err;
    });
  }

  function insertOne(row) {
    return ready().then(function (c) {
      return c.database.from(TABLE).insert(row);
    }).then(function (res) {
      if (res.error) { throw res.error; }
      return true;
    });
  }

  /* 上报一局。**永不 reject** —— 上层不该为了一条成绩去写 catch。
   * 没名字先攒进队列：榜上留的是"当时那个名字"，匿名上传只会让榜变成一堆默认名，
   * 等玩家留了名再补传（flush）。 */
  function submit(rec, name) {
    var row = toRow(rec, name);
    if (!row) { return Promise.resolve({ ok: false, queued: false, reason: 'empty' }); }
    if (!row.name) {
      enqueue(row);
      return Promise.resolve({ ok: false, queued: true, reason: 'noname' });
    }
    if (!available()) {
      status = 'disabled';
      enqueue(row);
      return Promise.resolve({ ok: false, queued: true, reason: 'disabled' });
    }
    return insertOne(row).then(function () {
      status = 'online';
      return { ok: true };
    }).catch(function (err) {
      /* 23505 = run_id 撞了，说明这一局已经传过（重试/重复点击），当成功 */
      if (err && (err.code === '23505')) { return { ok: true, dup: true }; }
      status = 'offline';
      lastError = (err && (err.message || err.code)) || '网络错误';
      enqueue(row);          /* 网断了也要留底，下次进来补传 */
      return { ok: false, queued: true, error: lastError };
    });
  }

  /* 补传：起了名字之后，把之前攒的记录带上名字发出去 */
  function flush(name) {
    var n = String(name == null ? '' : name).trim();
    if (!n || !available()) { return Promise.resolve(0); }
    var q = readQ();
    if (!q.length) { return Promise.resolve(0); }
    var done = 0;
    var chain = Promise.resolve();
    q.forEach(function (row) {
      chain = chain.then(function () {
        return insertOne(Object.assign({}, row, { name: n.slice(0, 8) })).then(function () {
          done++;
          var rest = readQ().filter(function (r) { return r.run_id !== row.run_id; });
          writeQ(rest);
        }).catch(function (err) {
          if (err && err.code === '23505') {
            done++;
            writeQ(readQ().filter(function (r) { return r.run_id !== row.run_id; }));
          }
        });
      });
    });
    return chain.then(function () { return done; });
  }

  root.MinerCloud = {
    available: available,
    load: load,
    submit: submit,
    flush: flush,
    clientId: clientId,
    pending: function () { return readQ().length; },
    config: CFG,
    get status() { return status; },
    get error() { return lastError; },
  };
})(window);
