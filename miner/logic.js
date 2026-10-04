/*
 * 奶蛙矿工 · 核心规则（纯逻辑：不碰 DOM / Canvas / 系统时钟）
 * ---------------------------------------------------------------------------------
 * 与参考站 naiwa-games 保持同一套工程约定：
 *   - 浏览器里 <script src="logic.js"> 加载，挂在 window.MinerLogic；
 *   - Node 里 require('./logic.js') 即可，test-logic.js 就是这么跑的。
 *   - 一局游戏的所有可变数据都在一个 state 对象里；除 shoot/step 外全是纯函数。
 *   - 随机数通过 state.rng 注入（默认 Math.random），测试时换固定种子 → 结果可复现。
 *   - 所有可调手感参数集中在 CONFIG，并附三档预设。
 *
 * 画面层（game.js）只负责"把 state 画出来 + 把按下翻译成 shoot(state)"，
 * 摆动、发射、抓取判定、重量、挣脱、计分、连击、关卡推进…… 全部在这里。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root && typeof window !== 'undefined') { root.MinerLogic = api; }
})(this, function () {
  'use strict';

  var D2R = Math.PI / 180;

  /* =====================================================================
   * 0. 两套舞台布局（竖屏 / 横屏）
   * -------------------------------------------------------------------
   * 规则完全共用，只是"世界"的尺寸和矿区形状不同：
   *   portrait  —— 手机竖屏，矿区又高又窄
   *   landscape —— 电脑横屏，矿区又宽又扁（浏览器打开不再是根竖条）
   * 逻辑层不认识"手机 / 电脑"，只认识 cfg 里这组数字，所以布局也归逻辑管。
   * 换布局时画面层调 relayout()：本关场地重铺，分数、目标、剩余时间全部保留。
   *
   * 几何死约束（两套布局都要满足，有测试守着）：
   *   (FIELD_Y - MINER_Y) · tan(SWING_AMPLITUDE) ≤ FIELD_W / 2
   * 否则 ±75° 射出时钩子会从土层顶边钻到场外。
   *   portrait ：80 × 3.732 ≈ 298.6 ≤ 314 ✓
   *   landscape：78 × 3.732 ≈ 291.1 ≤ 590 ✓
   * ===================================================================== */
  var LAYOUTS = {
    portrait: {
      WORLD_W: 720, WORLD_H: 1280,
      MINER_X: 360, MINER_Y: 220, MINER_SIZE: 168,
      FIELD_X: 46, FIELD_Y: 300, FIELD_W: 628, FIELD_H: 848,
    },
    landscape: {
      WORLD_W: 1280, WORLD_H: 800,
      MINER_X: 640, MINER_Y: 190, MINER_SIZE: 216,
      FIELD_X: 50, FIELD_Y: 268, FIELD_W: 1180, FIELD_H: 512,
    },
  };

  /* =====================================================================
   * 1. 可调参数（想调手感只改这一块）
   * ===================================================================== */
  var CONFIG = {

    /* —— 摆动 ——
     * SWING_MODE 决定钩子怎么摆，这个选择直接决定"能不能瞄"：
     *   'linear'（默认）：匀速来回。角速度恒定 → 瞄准窗口宽，玩家能瞄。
     *   'swing'         ：真钟摆。两端慢、中间快，看着最自然，
     *                     但中间角速度是匀速的 2 倍（196°/s），窗口只有 44ms≈2.6 帧，基本只能碰运气。
     * 实测（_qa/aimwindow）：钟摆@2.4s 只有 15.5% 的物品可瞄；匀速@3.0s 有 54.6%。
     * 这是本作最关键的一个手感取舍，别随手改回去。 */
    SWING_MODE: 'linear',    // 'linear' | 'swing'
    SWING_AMPLITUDE: 75,     // 摆动角度 ±75°

    /* —— 摆动速度随关卡递增，到峰值封顶 ——
     * 第 1 关慢慢摆（好瞄、不慌），越往后越快，到 SWING_PERIOD_MIN 就不再加了。
     * 峰值是**红线**：2.4s 时匀速模式的角速度是 150°/(2.4/2) = 125°/s ≈ 2.08°/帧，
     * 中等大小的物品还有 ~80ms ≈ 5 帧的窗口。再快就退化成碰运气了 ——
     * 那时候"变难"是靠废掉手感换来的，不算真的加难度。有测试守着这条。
     * 想整体调慢/调快，改这三条即可；三档预设会各自覆盖。 */
    SWING_PERIOD_START: 3.6, // 第 1 关一个来回的耗时（秒）
    SWING_PERIOD_MIN: 2.4,   // 峰值速度（周期下限，永远不突破）
    SWING_PERIOD_STEP: 0.12, // 每关缩短多少 → 第 11 关到峰值
    SWING_PERIOD: 3.6,       // 运行时值，由 applyLevelTuning() 按关卡写入（别手改）
    SWING_START_PHASE: Math.PI / 2,  // 起始相位：π/2 时钩子正好从正中起摆
    SWING_TURN_EASE: 0.10,   // 匀速模式两端轻微缓动（0=纯三角波，越大越像钟摆）
    ROPE_IDLE_LEN: 78,       // 待机时绳长（钩子离手多近）
    RETURN_BLEND: 0.22,      // 收钩归位时，从锁定角度摆回钟摆的过渡时长（秒）

    /* —— 钩子速度 —— */
    SHOOT_SPEED: 900,        // 射出速度（逻辑单位/秒）
    PULL_BASE_SPEED: 820,    // 回收速度的基准（= 最轻那件的速度）
    EMPTY_PULL_MULT: 1.25,   // 抓空时回收再快一点（不让节奏拖）

    /* —— 回收速度：经典黄金矿工规则 —— 越大越重、拉得越慢 ——
     *   速度 = PULL_BASE_SPEED / weight
     *
     * 这一版是**回退**：上一轮按需求做过"回钩速度随价值递增"（PULL_SPEED_BY='value'），
     * 玩起来大件比小石子还窜得快，眼看就是"一大块钻石像弹弓一样弹回来"，很违和。
     * 现在改回物理直觉：大块头就是沉，拖回来要花时间。
     * 想切回上一版把 PULL_SPEED_BY 改成 'value' 即可（那条分支还在，没删）。
     *
     * 关键约束（有测试守着，别只改重量不看这条）：
     *   **单位时间收益 value/weight 必须随价值单调递增。**
     *   否则大件就真的变成"越值钱越亏"，玩家会理性地只捡小件，体型阶梯白做了。
     *   当前实测阶梯（每秒收益，相对值）：
     *     小石子 16 → 小银块 29 → 铜块 51 → 银锭 78 → 金块 105
     *     → 金马 144 → 宝石 193 → 保险箱 235 → 钻石 308
     *   一路递增，所以"先叼最大的"依旧是最优解 —— 只是它现在**占时间**：
     *   拉一件钻石要 2 秒出头，这 2 秒你不能瞄也不能打，这就是经典黄金矿工的取舍。
     *
     * weight 表的排法：最小的定 1.00（速度 = PULL_BASE_SPEED），
     * 最大的定 3.15 —— 速度梯度 3.15× 与体型梯度（size 56→176 = 3.14×）**刻意对齐**，
     * 这样"看着多大 → 就知道多重 → 就知道拖多久"是一条直觉，不用查表。
     * 灰石堆给到 6.50（比钻石还慢一倍），重量最重、价值最低，永远只值得炸掉。 */
    PULL_SPEED_BY: 'weight', // 'weight'（经典：越大越慢）| 'value'（上一版：越值钱越快）
    PULL_MULT_MIN: 0.80,     // 仅 'value' 模式用：最便宜的东西
    PULL_MULT_MAX: 1.45,     // 仅 'value' 模式用：最贵的东西（钻石）
    PULL_VALUE_LO: 10,       // 仅 'value' 模式用：映射下界
    PULL_VALUE_HI: 600,      // 仅 'value' 模式用：映射上界

    /* —— 关卡 —— */
    LEVEL_TIME: 60,          // 每关限时（秒）
    TARGET_BASE: 320,        // 单关目标分下限（场地太稀疏时兜底，别让目标小到一钩子就够）
    /* 目标分 = 本关物品面值 × 这个倍数。
     * 注意倍数会 > 1：连击倍率最高 ×4，所以目标必须按"面值 × 倍数"来定，
     * 否则一个连得住的玩家可以无限打下去。
     *
     * 这三个数是**量出来的**，不是拍的。工具：_qa/targetfit.cjs
     *   它把 40 局 × 20 关的"（时刻, 得分）事件流"采样一次，然后任意门槛曲线毫秒级回算，
     *   给出两个量：
     *     (a) 玩家死在第几关               —— 整体难度
     *     (b) 达标发生在关卡时长的第几 %   —— 本关会不会空转
     *
     * ★ 一条反直觉、但被实测反复确认的结论（别再重复踩）：
     *   **抬这个倍数，几乎改不动"达标时刻"。**
     *   同一判据下对比（40 局采样）：
     *     起点 0.62 → 头 20% 就达标的关卡占 51%
     *     起点 0.65 → 52%
     *   为什么：收入是**极其前重后轻**的（最优打法先把最大件叼走），
     *   所以"第几秒达标"基本等于"第几秒叼到第一个大件"，跟门槛高低关系很小。
     *   真要把达标推到关卡后半段，倍数得开到 1.0（"这关得把场地收干净"）——
     *   代价是第 1 关通过率从 78% 掉到 48%，新人开场就卡。
     *   （收入方差也很大：第 1 关 p10 240 → p90 970，差 4 倍。一条门槛线同时要
     *     "p10 够得着"和"p75 够不着"是做不到的。）
     *
     *   → 所以这轮**没有靠抬倍数治空转**。治它的是两件别的事：
     *     1) 达标即可"收工"提前过关（见 canCashOut）—— 空转从"被迫"变"自选"；
     *     2) 收工要求本关的活儿自己干完（见 setTarget 里的 levelQuota）。
     *   实测效果：「头 20% 就达标」的关卡占比 52% → 28%，达标时刻分布变得均匀。
     *
     *   倍数曲线因此只做**标定**，不做加难度：起点比旧值略低（第 1 关更友好），
     *   坡度略陡，第 3 关和第 5 关的倍数与旧曲线基本重合。
     *   净结果：人类代理的中位关卡与旧版持平（第 5 关），难度没有上升。
     *
     * 曲线**没有再动**（回钩改按重量那轮）：因为改成"越大越慢"之后，
     * 小件变快了（原来按价值算是 496/秒，现在按重量算是 820/秒），
     * 收尾那一小段时间的利用效率变高，整体反而略松了一点 ——
     * 实测第 1 关通过率 78% → 85%，中位关卡仍是第 5 关。
     * 这个方向的偏差是玩家明确允许的（"难度允许比现在容易一点"），
     * 所以不去用抬倍数的方式把它抵消掉。 */
    TARGET_RATIO_BASE: 0.58, // 第 1 关：比旧值 0.62 略松，实测通过率 85%
    TARGET_RATIO_STEP: 0.14, // 每关 +0.14（旧值 +0.12）
    /* 上限只管到很后面。别指望靠它压难度 —— 实测把它从 2.30 提到 2.60，
     * "老手"（3° 误差）的中位数一动不动，还是第 22 关。原因见下。
     *
     * 目标分是**逐关累计**的，而前几关目标远低于收入，所以高手会攒下一大笔盈余：
     * 第 14 关时典型盈余约 1.8 万分，而后期每关的亏空只有一两千分，
     * 于是盈余能一路把他顶到 20 关开外。真正决定高手能走多远的是**前面那段坡有多陡**，
     * 不是终点定在哪。
     *
     * 仍然保留上限，是为了保证游戏不至于"数学上必然无解"：
     * 上限 2.70 明显低于连击倍率上限 4，所以理论上永远留有余地。 */
    TARGET_RATIO_MAX: 2.70,  // 约第 16 关顶到上限

    /* —— 计分与连击 —— */
    COMBO_PER_MULT: 3,       // 每 3 连击，得分倍率 +1
    MULT_MAX: 4,             // 倍率上限 ×4
    LAUGH_COMBO_FULL: 8,     // 连击到 8 时，笑声等级拉满（0~1）

    /* —— 大块头挣脱 ——
     * ESCAPE_CHANCE: 保险箱被钩住时，有多大概率会挣扎。
     *
     * 触发时机**不能按"拉了多久"算**。原来用时间（0.75s），
     * 但这一版把回收速度改成"越值钱越快"之后，保险箱回得飞快（~790/秒），
     * 从 300 远的地方 0.4 秒就到家了 —— 时间根本没走到，挣脱机制直接变成死的。
     * 所以改成按**回收进度**触发：回完 ESCAPE_AT_FRACTION 的路程就挣脱。
     * 这样不管速度快慢，"快到手了又掉回去"这个感觉都成立。 */
    ESCAPE_CHANCE: 0.30,
    ESCAPE_AT_FRACTION: 0.72, // 回完 72% 的路程时挣脱（越接近 1 越"差一点")

    /* —— 布局生成 —— */
    MAX_PLACE_TRIES: 90,     // 每个物品最多试这么多次位置，挤不下就跳过
    ITEM_GAP: 6,             // 物品之间的最小额外间隙

    /* —— 关键约束：单个物品最多遮住多大的扇形 ——
     * 奶蛙在洞口、矿区又高又窄，绝大多数物品都落在"接近垂直"的方向上（±20° 以内）。
     * 所以只要有一个大件离奶蛙太近，它的角宽度就能盖住整片矿区 ——
     * 这时**任何角度都只能勾到它**，这一关直接废掉。
     * 实测踩到过：一个天使杵在洞口正下方，第 4 关剩下的 46 秒里机器人一枪都开不出去
     * （每个角度的第一命中都是那个炸弹）。当时还以为是难度调过头了。
     * 约束：asin(r / dist) ≤ MAX_HALF_ANGLE  ⟺  dist ≥ r / sin(MAX_HALF_ANGLE)。
     * 附带好处：大件被自然推到中下层，正好符合"好东西都在深处"。 */
    MAX_HALF_ANGLE: 10,      // 单位：度。单个物品最多遮 ±10°

    /* —— 石头挡路（呼应原版"石头挡在宝物前面"）——
     * 放石头时优先把它摆到"奶蛙 → 高价值宝物"那条**射线上**，而不是随便撒。
     * 钩子是沿射线飞的，所以只有落在同一条射线上才挡得住；放"正上方"是没用的。
     * 玩家想直取宝物就会先撞到石头 —— 要么换个角度，要么先花时间把石头清掉。
     * 这就是原版那种"取舍"的来源，而且一行渲染代码都不用改。 */
    BLOCK_MIN_VALUE: 180,    // 只挡这个面值以上的（别把小件全堵死）
    BLOCK_MAX_PER_LEVEL: 3,  // 每关最多故意挡几处
    BLOCK_TRY: 24,           // 为一块石头试几个"被挡目标"

    /* —— 会爬的目标（呼应原版的鼹鼠 / 老鼠）——
     * 一部分物品会慢慢横向爬动，瞄准难度随时间上升，不能一次瞄准吃一整关。
     * 巡逻范围限制在出生点附近的 MOVE_RANGE 段场宽内，免得它跑得完全没法瞄。 */
    MOVE_TYPES: ['mouse', 'laugh'],   // 只有这两种会爬（老鼠是原版原型，幸运袋是活物）
    MOVE_FROM_LEVEL: 2,      // 第几关开始出现会爬的
    MOVE_MAX_COUNT: 3,       // 场上最多几个会爬
    MOVE_SPEED_BASE: 8,      // 基础速度（逻辑单位/秒）
    MOVE_SPEED_PER_LEVEL: 1.8,
    MOVE_SPEED_MAX: 34,      // 速度封顶
    MOVE_RANGE: 0.30,        // 在出生点左右各 30% 场宽的范围内来回

    /* —— 炸药（参考原版：把石头从"纯惩罚"变成"选择题"）——
     * 石头重得拉不动（回收速度只有空手的 1/5），一块能吃掉 5 秒以上、只值 5 分，
     * 所以玩家的最优解永远是"绕开"，没有决策。
     * 有了炸药之后就变成：被石头挡住的钻石，是花 5 秒把石头拖上来，还是炸掉省 4 秒？
     * 60 秒的关卡里，这 4 秒可能就是达标与否。 */
    DYNAMITE_PER_LEVEL: 2,   // 每关白送几发（保证玩家每关都能用上这个机制）
    DYNAMITE_BONUS_LEVEL: 6, // 第几关起每关多发 1 发
    DYNAMITE_MAX: 5,         // 单关最多带几发（小卖部也买不过这个上限）
    DYNAMITE_BOOM_RETURN: 1.15, // 炸掉之后回收的加速倍率（比空钩再快一点，别拖节奏）

    /* —— 经济与小卖部（参考原版黄金矿工）——
     * 三条从原版抄来的关键设计，别改：
     *   1. 花的就是**累计分数本身**，而累计分数就是通关门槛 → "买强"和"达标"天然冲突。
     *   2. 所有商品**只顶下一关**，不是永久升级 → 能力不复利，难度曲线稳得住。
     *      （这也是我第一版方案里搞错的地方：永久升级会让游戏越玩越简单。）
     *   3. 炸药是"口粮价"，别的商品贵得多 → 让你一次想买好几发的那种道具。
     *
     * 价格是按"一关的典型收入"定的，量法见 _qa/level.cjs（每关收入中位数）。 */
    SHOP_FROM_LEVEL: 3,      // 第几关起出现小卖部（前两关别打断节奏）
    ROCKBOOK_VALUE: 60,      // 石头图鉴生效时，灰石堆的面值（原本 5）
    DRINK_PULL_MULT: 1.35,   // 力量饮料：回收速度乘这个

    /* —— 安全阀 —— */
    MAX_DT: 0.05,            // 单步最大推进（秒），防止切标签页回来瞬移
  };

  /* 小卖部商品表（只有三件，都是"只顶下一关"的消耗品）。
   * 商品说明会原样显示在小卖部界面上，所以写得像人话，别堆术语。 */
  var SHOP_ITEMS = [
    {
      key: 'dynamite', name: '炸药', tag: '口粮', price: 450, unit: '发',
      desc: '下一关多发 1 发。拉不动的石头、不想碰的炸弹，当场炸掉。',
      hint: '手里拉着东西时点左边那个炸药按钮。',
    },
    {
      key: 'rockbook', name: '石头图鉴', tag: '改规则', price: 900,
      desc: '下一关灰石堆从 5 分变 60 分 —— 垃圾变成正经收入。',
      hint: '本来是纯亏的石头，这一关值得专门去挖。',
    },
    {
      key: 'drink', name: '力量饮料', tag: '加速', price: 1200,
      desc: '下一关回收速度快 35%，同样的时间能多叼好几个。',
      hint: '石头那种死沉的东西也会好拖很多。',
    },
  ];

  /* 三档手感预设：只覆盖需要变的字段。
   * 注意这里**同时管手感和难度** —— 摆动更快 + 目标更狠，才叫"硬核"。
   * 只改摆动速度而不动目标，会出现"更难瞄但其实更容易过关"的怪事。
   *
   * SWING_PERIOD_START/MIN 是"从第 1 关的慢速 → 到峰值"这条曲线，
   * 三档的**峰值都一样是 2.4s**（那是瞄准窗口的红线），差别在起点和爬升快慢：
   * 轻松档慢慢爬，硬核档第 9 关就到底。 */
  var PRESETS = {
    relaxed: {
      SWING_PERIOD_START: 4.2, SWING_PERIOD_MIN: 2.8, SWING_PERIOD_STEP: 0.13,
      SHOOT_SPEED: 820, PULL_BASE_SPEED: 920, ESCAPE_CHANCE: 0.15,
      LEVEL_TIME: 70,
      TARGET_RATIO_BASE: 0.50, TARGET_RATIO_STEP: 0.12, TARGET_RATIO_MAX: 2.20,
      MOVE_FROM_LEVEL: 3, MOVE_MAX_COUNT: 2,
    },
    standard: {
      SWING_PERIOD_START: 3.6, SWING_PERIOD_MIN: 2.4, SWING_PERIOD_STEP: 0.12,
      SHOOT_SPEED: 900, PULL_BASE_SPEED: 820, ESCAPE_CHANCE: 0.30,
      LEVEL_TIME: 60,
      TARGET_RATIO_BASE: 0.58, TARGET_RATIO_STEP: 0.14, TARGET_RATIO_MAX: 2.70,
      MOVE_FROM_LEVEL: 2, MOVE_MAX_COUNT: 3,
    },
    hard: {
      SWING_PERIOD_START: 3.2, SWING_PERIOD_MIN: 2.4, SWING_PERIOD_STEP: 0.09,
      SHOOT_SPEED: 1000, PULL_BASE_SPEED: 730, ESCAPE_CHANCE: 0.45,
      LEVEL_TIME: 50,
      TARGET_RATIO_BASE: 0.68, TARGET_RATIO_STEP: 0.18, TARGET_RATIO_MAX: 3.10,
      MOVE_FROM_LEVEL: 1, MOVE_MAX_COUNT: 4,
    },
  };

  /* =====================================================================
   * 2. 物品表（11 张立绘 + 1 个程序绘制的石堆）
   *
   * —— 体型就是价值刻度（这是刻意的，也是需求）——
   * 需求原话："不同奶蛙的价值按照体型能够比较明显地区分"。
   * 所以 size 与价值**严格单调**，而且梯度拉得很开（56 → 176，差 3.1 倍）。
   * 上一版是 64→124（只差 1.9 倍）而且顺序还乱：最贵的钻石(116)比保险箱(124)还小，
   * 炸弹(108)比金马(104)还大 —— 等于体型完全读不出价值，只能背表。
   *
   * 现在只要记一条：**越大越值钱**。落在深土层里那坨最大的，就是钻石。
   * 两个例外，都故意留在阶梯之外：
   *   · 灰石堆 —— 程序绘制，长得就是石头，跟立绘完全不撞脸
   *   · 炸弹（天使）—— 体积落在中段，但渲染层会给它套一圈红色警示光晕，
   *     一眼就能认出来"这个不是宝贝"。它是罚分项，不参与"越大越值钱"。
   *
   * r / size 固定在 0.43~0.45，保证"看着多大 = 判定多大"。
   * tint 现在不再用于绘制（早期版本会在立绘后面铺彩色底板，已按要求去掉）；
   * 字段保留作为主题色，做提示、高亮、粒子配色时可以取。
   * ===================================================================== */
  var ITEMS = {
    /* weight 排法见 CONFIG 里的说明：最小 1.00、最大 3.15，
     * 与 size 梯度（56→176）对齐；石头 6.50 是"沉到不合理"的极端值。
     * 每改一个 weight 都要重看 value/weight 还是不是单调递增（有测试守着）。 */
    stone:   { name: '灰石堆',     img: null,              value: 5,         weight: 6.50, r: 36, size: 86,  tint: '#9a9489', isStone: true },
    blob:    { name: '小石子',     img: 'nai01-blob',      value: 10,        weight: 1.00, r: 25, size: 56,  tint: '#ffe6a8' },
    stand:   { name: '小银块',     img: 'nai02-stand',     value: 20,        weight: 1.10, r: 30, size: 68,  tint: '#e8eef5' },
    mouse:   { name: '铜块',       img: 'nai03-mouse',     value: 40,        weight: 1.25, r: 35, size: 80,  tint: '#f0c9a0' },
    rooster: { name: '银锭',       img: 'nai04-rooster',   value: 70,        weight: 1.45, r: 40, size: 92,  tint: '#dfe7ee' },
    dog:     { name: '金块',       img: 'nai05-dog',       value: 110,       weight: 1.70, r: 46, size: 106, tint: '#ffdcae' },
    horse:   { name: '金马',       img: 'nai06-horse',     value: 180,       weight: 2.00, r: 53, size: 122, tint: '#ffd08a' },
    rabbit:  { name: '宝石',       img: 'nai07-rabbit',    value: 280,       weight: 2.35, r: 60, size: 138, tint: '#bfe3ff' },
    sumo:    { name: '保险箱',     img: 'nai08-sumo',      value: 400,       weight: 2.75, r: 68, size: 156, tint: '#c9f0cf' },
    angel:   { name: '炸弹',       img: 'nai09-angel',     value: -150,      weight: 1.60, r: 48, size: 112, tint: '#ffc9de', isAngel: true },
    laugh:   { name: '幸运袋',     img: 'nai10-laugh',     value: [100, 300], weight: 1.30, r: 43, size: 100, tint: '#e2d3ff', pullValue: 200 },
    god:     { name: '钻石',       img: 'nai11-god',       value: 600,       weight: 3.15, r: 76, size: 176, tint: '#b9efe9', timeBonus: 5 },
  };

  /* 图鉴顺序（给开始页的怪说明用） */
  var LEGEND_ORDER = ['blob', 'stand', 'mouse', 'rooster', 'dog', 'horse', 'rabbit', 'sumo', 'stone', 'angel', 'laugh', 'god'];

  /* =====================================================================
   * 3. 纯工具函数
   * ===================================================================== */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 得分倍率：连击 0~2 → ×1，3~5 → ×2，6~8 → ×3，9+ → ×4 */
  function comboMult(combo, cfg) {
    return Math.min(cfg.MULT_MAX, 1 + Math.floor(combo / cfg.COMBO_PER_MULT));
  }

  /* 笑声等级 0~1：直接喂给 NaiSFX.laugh(level) */
  function laughLevel(combo, cfg) {
    return clamp(combo / cfg.LAUGH_COMBO_FULL, 0, 1);
  }

  function itemValue(type, rng) {
    var def = ITEMS[type];
    if (def.value instanceof Array) {
      return def.value[0] + Math.floor(rng() * (def.value[1] - def.value[0] + 1));
    }
    return def.value;
  }

  /* 物品的"标称价值"：随机取值区间取中值。
   * 回收速度必须按它算，而不是按这一局随机出来的值 ——
   * 否则同一个立绘每次回收快慢都不一样，玩家一眼看不出该不该抓（幸运袋就是这种）。 */
  function nominalValue(type) {
    var def = ITEMS[type];
    if (typeof def.pullValue === 'number') { return def.pullValue; }
    if (def.value instanceof Array) { return (def.value[0] + def.value[1]) / 2; }
    return def.value;
  }

  /* 回收速度 —— 经典黄金矿工规则：越大越重、拉得越慢。
   *   speed = PULL_BASE_SPEED / weight      （weight 见 ITEMS，1.00 ~ 3.15，石头 6.50）
   * 于是"看着多大 → 就知道拖回来要多久"是一条直觉，不用记表。
   *
   * 灰石堆永远走重量分支（它本来就是最重的那个）。
   * 切到 cfg.PULL_SPEED_BY === 'value' 时走上一版的按价值映射；
   * 那种模式下**石头仍然按重量** —— 否则石头变得又快又只值 5 分，
   * "石头挡路"和"炸药"两件事同时失去意义。 */
  function pullSpeedOf(state, item) {
    var cfg = state.cfg;
    var buff = (state.buffs && state.buffs.drink) ? cfg.DRINK_PULL_MULT : 1;

    if (cfg.PULL_SPEED_BY === 'weight' || item.isStone) {
      return (cfg.PULL_BASE_SPEED / Math.max(0.5, item.weight)) * buff;
    }
    var v = nominalValue(item.type);
    var t = clamp((v - cfg.PULL_VALUE_LO) / (cfg.PULL_VALUE_HI - cfg.PULL_VALUE_LO), 0, 1);
    return cfg.PULL_BASE_SPEED * (cfg.PULL_MULT_MIN + (cfg.PULL_MULT_MAX - cfg.PULL_MULT_MIN) * t) * buff;
  }

  /* 单位时间收益 = 价值 × 回收速度。
   * 这是"大块头慢归慢、但还是该先叼它"这句话的唯一可验证形式：
   * 只要它对价值阶梯**单调递增**，最优解就还是先抢大件，
   * 体型阶梯（越大越值钱）和重量阶梯（越大越慢）就不会打架。
   * 不除距离 —— 距离对所有物品一样，比相对值不需要它。
   * 有测试守着这条单调性，改 weight 表时会被拦住。 */
  function earnRateOf(state, item) {
    return nominalValue(item.type) * pullSpeedOf(state, item);
  }

  /* 摆动周期按关卡推导：第 1 关慢慢摆，越往后越快，到 SWING_PERIOD_MIN 封顶。
   * 峰值 2.4s 是手感红线（见 CONFIG 里的说明），硬核档也一样不破。 */
  function swingPeriod(level, cfg) {
    var start = cfg.SWING_PERIOD_START === undefined ? cfg.SWING_PERIOD : cfg.SWING_PERIOD_START;
    var min = cfg.SWING_PERIOD_MIN === undefined ? start : cfg.SWING_PERIOD_MIN;
    return Math.max(min, start - (level - 1) * cfg.SWING_PERIOD_STEP);
  }

  /* 把"当前关卡"该有的参数写回 cfg。进关/换布局都要调一次。 */
  function applyLevelTuning(state) {
    state.cfg.SWING_PERIOD = swingPeriod(state.level, state.cfg);
  }

  /* 本关配发几发炸药（白送的 + 小卖部买的，封顶 DYNAMITE_MAX） */
  function dynamiteFor(state, level) {
    var cfg = state.cfg;
    var n = cfg.DYNAMITE_PER_LEVEL;
    if (level >= cfg.DYNAMITE_BONUS_LEVEL) { n += 1; }
    var bought = (state.buffs && state.buffs.dynamite) ? state.buffs.dynamite : 0;
    return Math.min(cfg.DYNAMITE_MAX, n + bought);
  }

  /* 建立一件物品时的面值：石头图鉴生效时，灰石堆从 5 分变 60 分。
   * 注意 achievableValue() 是直接累加 item.value 的，所以目标分会自动跟着变，
   * 不需要在别处再补一次 —— 只在"进下一关"那一刻算一次就够了。 */
  function itemWorth(state, type) {
    if (state.buffs && state.buffs.rockbook && type === 'stone') {
      return state.cfg.ROCKBOOK_VALUE;
    }
    return itemValue(type, state.rng);
  }

  /* 钩子的摆动角度。这是整个手感的核心，见 CONFIG 里 SWING_MODE 的说明。 */
  function swingAngle(state) {
    var cfg = state.cfg;
    var p = state.swingClock / cfg.SWING_PERIOD + cfg.SWING_START_PHASE / (2 * Math.PI);
    p = p - Math.floor(p);                          // 归一化到 [0,1)

    var h = p < 0.5 ? p * 2 : 2 - p * 2;            // 0 → 1 → 0（一个来回）
    var u;
    if (cfg.SWING_MODE === 'swing') {
      u = 0.5 - 0.5 * Math.cos(Math.PI * h);        // 真钟摆：两端慢、中间快
    } else {
      var k = cfg.SWING_TURN_EASE;                  // 匀速来回，两端轻微缓动
      u = h - k * Math.sin(2 * Math.PI * h) / (2 * Math.PI);
    }
    return cfg.SWING_AMPLITUDE * (2 * u - 1);
  }

  /* =====================================================================
   * 4. 几何：钩子位置 / 最大绳长
   * ===================================================================== */

  /* 钩子末端坐标：以矿工为圆心，绳长 ropeLen，与竖直方向夹角 angle（度，右正） */
  function hookPos(state, angleDeg, ropeLen) {
    var a = (angleDeg === undefined ? state.angle : angleDeg) * D2R;
    var len = ropeLen === undefined ? state.ropeLen : ropeLen;
    return {
      x: state.cfg.MINER_X + len * Math.sin(a),
      y: state.cfg.MINER_Y + len * Math.cos(a),
    };
  }

  /* 当前角度下，钩子不越出可抓取区域的最大绳长（解析解，避免逐帧试探） */
  function maxRopeLen(state, angleDeg) {
    var cfg = state.cfg;
    var a = angleDeg * D2R;
    var sa = Math.sin(a), ca = Math.cos(a);
    var lim = Infinity;

    // 下边界
    var bottom = cfg.FIELD_Y + cfg.FIELD_H - cfg.MINER_Y;
    if (ca > 1e-6) { lim = Math.min(lim, bottom / ca); }

    // 左右边界
    if (sa > 1e-6) {
      lim = Math.min(lim, (cfg.FIELD_X + cfg.FIELD_W - cfg.MINER_X) / sa);
    } else if (sa < -1e-6) {
      lim = Math.min(lim, (cfg.FIELD_X - cfg.MINER_X) / sa);
    }
    return Math.max(cfg.ROPE_IDLE_LEN, lim);
  }

  /* 钩子末端是否落在可抓取区域内 */
  function inField(state, p) {    var cfg = state.cfg;
    return p.x >= cfg.FIELD_X && p.x <= cfg.FIELD_X + cfg.FIELD_W &&
           p.y >= cfg.FIELD_Y && p.y <= cfg.FIELD_Y + cfg.FIELD_H;
  }

  /* 找到钩子末端碰到的第一个物品（未被抓走、未移除的） */
  function findHit(state, p) {
    var items = state.items;
    var best = null, bestD = Infinity;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.removed || it.grabbed) { continue; }
      var dx = p.x - it.x, dy = p.y - it.y;
      var d2 = dx * dx + dy * dy;
      if (d2 <= it.r * it.r && d2 < bestD) { bestD = d2; best = it; }
    }
    return best;
  }

  /* =====================================================================
   * 5. 关卡布局生成
   * ===================================================================== */

  /* 每一关要放哪些东西（返回一份"采购清单"，按固定顺序，保证同种子可复现）
   *
   * 难度的真正来源不是"东西变多"，而是**时间被垃圾吃掉**：
   *   - 灰石堆重量 5.0 → 回收速度只有空手的 1/5，一块石头能吃掉 5 秒以上
   *   - 炸弹（天使）虽然轻，但抓到就扣 150 分并且连击清零
   * 所以随关卡上升的是"石头和炸弹"，随关卡下降的是"又快又便宜的小件"。
   * 玩家被迫去打又重又慢的重物，这就是原版那种"关数越高越难钩"的手感。 */
  function recipe(level) {
    var L = level, out = [];
    function add(t, n) { for (var i = 0; i < n; i++) { out.push(t); } }

    /* —— 垃圾：随关卡猛涨 —— */
    add('stone',   2 + Math.floor(L / 2));               // L1:2 → L4:4 → L10:7 → L20:12
    add('angel',   L >= 3 ? 2 + Math.floor(L / 4) : 1);  // L1:1 → L3:2 → L8:4

    /* —— 小件（快、便宜）：随关卡递减，逼玩家去打重物 —— */
    add('blob',    Math.max(1, 4 - Math.floor(L / 3)));
    add('stand',   Math.max(1, 3 - Math.floor(L / 4)));

    /* —— 中件：慢速增长 —— */
    add('mouse',   1 + Math.floor(L / 3));
    add('rooster', Math.max(1, 2 - Math.floor(L / 5)));
    add('dog',     1 + Math.floor(L / 3));
    add('horse',   1 + Math.floor(L / 3));

    /* —— 大件：真正的分数来源，但又重又会挣脱 —— */
    if (L >= 3) { add('rabbit', 1); }
    if (L >= 4) { add('sumo', Math.min(2, 1 + Math.floor(L / 6))); }

    /* —— 甜头：延后发放，免得早期随机高分把难度冲淡 —— */
    if (L >= 6) { add('laugh', 1); }                     // 幸运袋：第 6 关才有
    if (L >= 4 && L % 3 === 0) { add('god', 1); }        // 钻石：从"每关白送"改成"每 3 关一个"

    return out;
  }

  /* 这个位置能不能放下：不越出土层、不和已有物品重叠、
   * 而且不能离奶蛙太近（太近的话角宽度会盖住整片矿区，见 CONFIG.MAX_HALF_ANGLE 的说明） */
  function fitsInField(cfg, items, x, y, r) {
    if (x < cfg.FIELD_X + r || x > cfg.FIELD_X + cfg.FIELD_W - r) { return false; }
    if (y < cfg.FIELD_Y + r || y > cfg.FIELD_Y + cfg.FIELD_H - r) { return false; }

    var ddx = x - cfg.MINER_X, ddy = y - cfg.MINER_Y;
    var dist2 = ddx * ddx + ddy * ddy;
    var minDist = r / Math.sin(cfg.MAX_HALF_ANGLE * D2R);
    if (dist2 < minDist * minDist) { return false; }

    for (var j = 0; j < items.length; j++) {
      var o = items[j];
      var dx = x - o.x, dy = y - o.y;
      var need = r + o.r + cfg.ITEM_GAP;
      if (dx * dx + dy * dy < need * need) { return false; }
    }
    return true;
  }

  /* 造一个物品实体（会被挣脱的会用它记 homeX/homeY） */
  function makeItem(state, type, def, x, y, id) {
    return {
      id: id,
      type: type,
      name: def.name,
      img: def.img,
      tint: def.tint,
      x: x,
      y: y,
      r: def.r,
      size: def.size,
      homeX: x,              // 被挣脱后掉回原位
      homeY: y,
      weight: def.weight,
      value: itemWorth(state, type),
      isStone: !!def.isStone,
      isAngel: !!def.isAngel,
      timeBonus: def.timeBonus || 0,
      grabbed: false,
      removed: false,
      wobble: 0,             // 渲染层的抖动提示（被抓住/挣扎时）
      // —— 会爬的目标（只有 MOVE_TYPES 里且在门槛关卡之后才会被点亮）——
      moving: false, moveDir: 1, moveSpeed: 0, minX: x, maxX: x,
    };
  }

  /* 把清单铺进土层。顺序很重要：
   *   1) 先放所有非石头（大件优先，保证最大的那几个不会因为没地方而消失）
   *   2) 再放石头 —— 石头要"贴着宝物放"来挡路，所以必须等宝物都就位了才能算
   *   3) 最后点名几个物品让它们会爬
   */
  function buildItems(state, level) {
    var cfg = state.cfg, rng = state.rng;
    var list = recipe(level).map(function (t, i) { return { type: t, order: i }; });

    // 石头挑出来单独处理（它不参与"大件优先"，也不吃深度偏置）
    var stones = 0, solids = [], i, k;
    for (i = 0; i < list.length; i++) {
      if (list[i].type === 'stone') { stones += 1; } else { solids.push(list[i]); }
    }

    // 大件优先占位
    solids.sort(function (a, b) { return ITEMS[b.type].r - ITEMS[a.type].r || a.order - b.order; });

    var items = [], id = 0;

    for (i = 0; i < solids.length; i++) {
      var type = solids[i].type, def = ITEMS[type];
      var placed = null;

      // 越值钱的东西越靠下（呼应原版"好东西都在深处"）
      var depthBias = 0;
      if (def.value instanceof Array || def.value >= 280) { depthBias = 0.42; }
      else if (def.value >= 110) { depthBias = 0.22; }
      else if (def.value >= 40) { depthBias = 0.08; }

      for (var t = 0; t < cfg.MAX_PLACE_TRIES; t++) {
        var yLo = cfg.FIELD_Y + def.r + depthBias * cfg.FIELD_H;
        var yHi = cfg.FIELD_Y + cfg.FIELD_H - def.r;
        if (yLo > yHi) { yLo = cfg.FIELD_Y + def.r; }

        var x = cfg.FIELD_X + def.r + rng() * (cfg.FIELD_W - def.r * 2);
        var y = yLo + rng() * (yHi - yLo);

        if (fitsInField(cfg, items, x, y, def.r)) { placed = { x: x, y: y }; break; }
      }

      if (!placed) { continue; }  // 挤不下，这一件就不放了

      items.push(makeItem(state, type, def, placed.x, placed.y, id++));
    }

    /* —— 石头：优先摆到"奶蛙 → 高价值宝物"的射线上，形成真正的遮挡 ——
     * 关键：必须落在**同一条射线**上。钩子是沿射线飞的，
     * 把石头摆在宝物的"正上方"是挡不住的（这是很容易写错的一点）。
     * 落点算法：从宝物沿射线朝奶蛙方向退 (宝物半径 + 石头半径 + 间隙) 的距离。 */
    var sdef = ITEMS.stone;
    var blocked = 0;

    for (var s = 0; s < stones; s++) {
      var pos = null;

      if (blocked < cfg.BLOCK_MAX_PER_LEVEL && items.length > 0) {
        for (var q = 0; q < cfg.BLOCK_TRY; q++) {
          var cand = items[Math.floor(rng() * items.length)];
          if (!cand || cand.isStone || cand.isAngel) { continue; }
          if (cand.value < cfg.BLOCK_MIN_VALUE) { continue; }

          var ddx = cand.x - cfg.MINER_X, ddy = cand.y - cfg.MINER_Y;
          var dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < 1) { continue; }

          // 沿射线往奶蛙方向退一段，正好卡在"钩子从奶蛙飞到宝物"的路上
          var back = dist - (cand.r + sdef.r + cfg.ITEM_GAP);
          if (back <= cfg.ROPE_IDLE_LEN + sdef.r) { continue; }   // 贴脸放没意义

          var bx = cfg.MINER_X + (ddx / dist) * back;
          var by = cfg.MINER_Y + (ddy / dist) * back;
          if (!fitsInField(cfg, items, bx, by, sdef.r)) { continue; }

          pos = { x: bx, y: by };
          blocked += 1;
          break;
        }
      }

      // 挡不上就随机撒一块（原版也是满地石头）
      for (var t2 = 0; !pos && t2 < cfg.MAX_PLACE_TRIES; t2++) {
        var sx = cfg.FIELD_X + sdef.r + rng() * (cfg.FIELD_W - sdef.r * 2);
        var sy = cfg.FIELD_Y + sdef.r + rng() * (cfg.FIELD_H - sdef.r * 2);
        if (fitsInField(cfg, items, sx, sy, sdef.r)) { pos = { x: sx, y: sy }; }
      }

      if (pos) { items.push(makeItem(state, 'stone', sdef, pos.x, pos.y, id++)); }
    }

    /* —— 点名会爬的目标 —— */
    if (level >= cfg.MOVE_FROM_LEVEL) {
      var movers = [];
      for (i = 0; i < items.length; i++) {
        if (cfg.MOVE_TYPES.indexOf(items[i].type) >= 0) { movers.push(items[i]); }
      }
      // Fisher-Yates 洗牌（用注入的 rng，保证同种子可复现）
      for (k = movers.length - 1; k > 0; k--) {
        var j2 = Math.floor(rng() * (k + 1));
        var tmp = movers[k]; movers[k] = movers[j2]; movers[j2] = tmp;
      }

      var n = Math.min(cfg.MOVE_MAX_COUNT, movers.length);
      var speed = Math.min(cfg.MOVE_SPEED_MAX,
        cfg.MOVE_SPEED_BASE + (level - cfg.MOVE_FROM_LEVEL) * cfg.MOVE_SPEED_PER_LEVEL);
      var half = cfg.FIELD_W * cfg.MOVE_RANGE * 0.5;

      for (i = 0; i < n; i++) {
        var mv = movers[i];
        mv.moving = true;
        mv.moveSpeed = speed;
        mv.moveDir = rng() < 0.5 ? -1 : 1;
        mv.minX = Math.max(cfg.FIELD_X + mv.r, mv.x - half);
        mv.maxX = Math.min(cfg.FIELD_X + cfg.FIELD_W - mv.r, mv.x + half);
      }
    }

    return items;
  }

  /* 本关"理论最高可得"（只算正收益），用来自适应地算目标分 */
  function achievableValue(items) {
    var sum = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.value > 0) { sum += it.value; }
    }
    return sum;
  }

  /* 目标分是累计的：第 n 关的门槛 = 前 n-1 关门槛 + 本关增量 */
  function nextTarget(state, level, items) {
    var cfg = state.cfg;
    var ratio = Math.min(cfg.TARGET_RATIO_MAX, cfg.TARGET_RATIO_BASE + (level - 1) * cfg.TARGET_RATIO_STEP);
    var inc = Math.max(cfg.TARGET_BASE, Math.round(achievableValue(items) * ratio));
    return (state.target || 0) + inc;
  }

  /* 写门槛。顺便记下"本关要求你**自己赚**多少"（levelQuota = 新门槛 − 旧门槛）。
   *
   * 为什么要单独记这个数：门槛和分数都是累计的，所以一个打得很好的玩家会攒下一大笔盈余。
   * 盈余盖过下一关的门槛时，`score >= target` 在开局第一帧就成立 ——
   * 如果收工只看这一条，玩家就能一路连点"收工"白嫖过十几关，一秒都不用打。
   * 所以收工的条件是"本关该赚的赚到了"，盈余可以帮门槛、但不能替你干活。 */
  function setTarget(state, level, items) {
    var prev = state.target || 0;
    state.target = nextTarget(state, level, items);
    state.levelQuota = state.target - prev;
    return state.target;
  }

  /* =====================================================================
   * 6. 状态构造
   * ===================================================================== */

  /* 简易可复现随机数（测试用）：mulberry32 */
  function seededRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function resolveConfig(opts) {
    opts = opts || {};
    var cfg = {}, k;
    for (k in CONFIG) { if (Object.prototype.hasOwnProperty.call(CONFIG, k)) { cfg[k] = CONFIG[k]; } }

    // 舞台布局（世界尺寸 / 悬挂点 / 矿区）。逻辑层不认"手机电脑"，只认这组数字。
    var layout = LAYOUTS[opts.layout] ? opts.layout : 'portrait';
    for (k in LAYOUTS[layout]) { if (Object.prototype.hasOwnProperty.call(LAYOUTS[layout], k)) { cfg[k] = LAYOUTS[layout][k]; } }
    cfg.LAYOUT = layout;

    var preset = (opts && opts.preset) || 'standard';
    if (PRESETS[preset]) {
      for (k in PRESETS[preset]) { if (Object.prototype.hasOwnProperty.call(PRESETS[preset], k)) { cfg[k] = PRESETS[preset][k]; } }
    }
    if (opts && opts.config) {
      for (k in opts.config) { if (Object.prototype.hasOwnProperty.call(opts.config, k)) { cfg[k] = opts.config[k]; } }
    }
    return cfg;
  }

  function createGame(opts) {
    opts = opts || {};
    var cfg = resolveConfig(opts);
    var state = {
      cfg: cfg,
      rng: opts.rng || Math.random,
      preset: opts.preset || 'standard',

      phase: 'ready',        // ready | swinging | shooting | pulling | levelClear | gameOver
      level: 1,
      score: 0,
      target: 0,
      levelQuota: 0,         // 本关要求"自己赚"多少（= 本关门槛增量），收工的前置条件
      levelStartScore: 0,    // 本关开打时的分数，用来算"这一关赚了多少"
      timeLeft: cfg.LEVEL_TIME,

      angle: 0,              // 当前角度（度），右正
      swingClock: 0,         // 摆钟相位时钟（秒）——只增不减，永不重置，见 step() 里的说明
      blend: 0,              // >0 表示正在从"发射锁定角度"摆回钟摆
      returnFrom: 0,         // 摆回的起点角度
      ropeLen: cfg.ROPE_IDLE_LEN,
      hook: { x: cfg.MINER_X, y: cfg.MINER_Y + cfg.ROPE_IDLE_LEN },

      held: null,            // 正被拉着的物品
      pullT: 0,              // 本次回收已经拉了多久（给挣脱用）
      grabbedThisShot: false,
      escapeAtLen: 0,        // >0 表示这次抓到的会挣脱，值 = 缩到这个绳长就挣（见 ESCAPE_AT_FRACTION）

      combo: 0,
      comboBest: 0,
      items: [],

      /* —— 经济 ——
       * score 就是钱：它既是通关门槛，也是小卖部里的钱。
       * 花钱会把手里的分数压下去 → "买强"和"达标"天然冲突（从原版抄来的张力）。 */
      buffs: {},             // 本关生效的 buff（只顶一关）
      pending: {},           // 小卖部刚买、还没开打的 buff
      shopSpent: 0,          // 一共在小卖部花了多少
      dynamite: 0,           // 本关剩余炸药
      boomBoost: false,      // 刚炸过 → 这一趟回收再快一点（别拖节奏）

      shots: 0, hits: 0, escapes: 0, angels: 0, bombs: 0,
      floaters: [],          // 飘字（渲染用，逻辑只负责生成）
      shake: 0,              // 屏幕震动强度（渲染用）
      lastEventT: 0,
    };
    applyLevelTuning(state);
    state.items = buildItems(state, 1);
    setTarget(state, 1, state.items);
    state.dynamite = dynamiteFor(state, 1);
    return state;
  }

  function restart(state) {
    var cfg = state.cfg;
    state.phase = 'ready';
    state.level = 1;
    state.score = 0;
    state.target = 0;
    state.levelStartScore = 0;
    state.timeLeft = cfg.LEVEL_TIME;
    state.angle = 0; state.swingClock = 0; state.blend = 0; state.returnFrom = 0;
    state.ropeLen = cfg.ROPE_IDLE_LEN;
    state.hook = { x: cfg.MINER_X, y: cfg.MINER_Y + cfg.ROPE_IDLE_LEN };
    state.held = null; state.pullT = 0; state.grabbedThisShot = false; state.escapeAtLen = 0;
    state.combo = 0; state.comboBest = 0;
    state.shots = 0; state.hits = 0; state.escapes = 0; state.angels = 0; state.bombs = 0;
    state.buffs = {}; state.pending = {}; state.shopSpent = 0;
    state.floaters = []; state.shake = 0;
    applyLevelTuning(state);
    state.items = buildItems(state, 1);
    setTarget(state, 1, state.items);
    state.dynamite = dynamiteFor(state, 1);
    return state;
  }

  /* 开始本关（ready → swinging） */
  function beginLevel(state) {
    if (state.phase !== 'ready') { return []; }
    var cfg = state.cfg;
    state.phase = 'swinging';
    state.timeLeft = cfg.LEVEL_TIME;
    state.levelStartScore = state.score;
    state.combo = 0;
    state.swingClock = 0;
    state.blend = 0;
    applyLevelTuning(state);
    state.angle = swingAngle(state);
    state.ropeLen = cfg.ROPE_IDLE_LEN;
    state.hook = hookPos(state);
    state.dynamite = dynamiteFor(state, state.level);
    return [{ type: 'levelStart', level: state.level, target: state.target }];
  }

  /* 进下一关 */
  function nextLevel(state) {
    var ev = [], cfg = state.cfg;
    state.level += 1;

    /* 小卖部买的东西在这里生效，并且**只顶这一关**。
     * 把 pending 搬成 buffs 之后立刻清空 pending —— 所以下一关没有 buff，
     * 能力不会复利，难度曲线稳得住（这是从原版抄来的最关键的一条）。 */
    state.buffs = state.pending;
    state.pending = {};

    applyLevelTuning(state);
    state.timeLeft = cfg.LEVEL_TIME;
    state.levelStartScore = state.score;
    state.combo = 0;
    state.held = null; state.pullT = 0; state.escapeAtLen = 0;
    state.ropeLen = cfg.ROPE_IDLE_LEN;
    state.swingClock = 0;
    state.blend = 0;
    state.angle = swingAngle(state);
    state.hook = hookPos(state);
    state.items = buildItems(state, state.level);
    setTarget(state, state.level, state.items);
    state.dynamite = dynamiteFor(state, state.level);
    state.phase = 'swinging';
    ev.push({ type: 'levelStart', level: state.level, target: state.target });
    return ev;
  }

  /* 换舞台布局（竖屏 ↔ 横屏）。
   * 画面层检测到窗口方向变了会调它：本关场地重铺，但**分数、目标、剩余时间、连击全部保留**，
   * 所以中途拉窗口不会让你白打一关。飞行中的那一钩会作废（这种时机很少）。
   * 目标分不重算 —— 它是"已经谈好的门槛"，不该因为换个窗口就变。 */
  function relayout(state, layoutName) {
    var name = LAYOUTS[layoutName] ? layoutName : 'portrait';
    if (state.cfg.LAYOUT === name) { return false; }

    var k;
    for (k in LAYOUTS[name]) {
      if (Object.prototype.hasOwnProperty.call(LAYOUTS[name], k)) { state.cfg[k] = LAYOUTS[name][k]; }
    }
    state.cfg.LAYOUT = name;
    applyLevelTuning(state);

    var active = (state.phase === 'swinging' || state.phase === 'shooting' || state.phase === 'pulling');
    var ready = (state.phase === 'ready');

    state.held = null; state.pullT = 0; state.escapeAtLen = 0; state.grabbedThisShot = false;
    state.ropeLen = state.cfg.ROPE_IDLE_LEN;
    state.blend = 0;
    state.swingClock = 0;
    state.angle = swingAngle(state);
    state.hook = hookPos(state);
    state.floaters = [];
    state.items = buildItems(state, state.level);
    state.dynamite = dynamiteFor(state, state.level);
    if (active || ready) { state.phase = ready ? 'ready' : 'swinging'; }
    return true;
  }

  /* =====================================================================
   * 7. 动作：发射
   * ===================================================================== */

  function shoot(state) {
    if (state.phase !== 'swinging') { return []; }
    state.phase = 'shooting';
    state.shots += 1;
    state.grabbedThisShot = false;
    state.escapeAtLen = 0;
    state.held = null;
    return [{ type: 'shoot', angle: state.angle }];
  }

  /* 引爆炸药：把手里的东西当场炸掉，绳子立刻回收。
   *
   * 四条边界条件都是刻意的，别随手改：
   *   1. **必须手里拉着东西**。否则它就成了"瞬间清屏"，石头挡路的设计直接作废。
   *   2. **不给分、不涨连击**。否则玩家会拿它刷连击 —— 炸掉永远该比正常拉回来差。
   *   3. **炸掉炸弹不扣那 150 分**。否则炸药只是"花钱免罚"，而不是"止损工具"。
   *   4. **空手点不消耗**。只播一个"咔"，不然误触就白瞎一发。
   *
   * 它存在的意义：把石头从"纯惩罚"变成"选择题"——
   * 被石头挡住的钻石，是花 5 秒拖开石头，还是炸掉省 4 秒？
   * 60 秒的关卡里，这 4 秒可能就是达标与否。 */
  function blowUp(state) {
    var cfg = state.cfg;

    if (state.phase !== 'pulling' || !state.held) {
      return [{ type: 'boomEmpty', reason: 'nothing' }];
    }
    if (state.dynamite <= 0) {
      return [{ type: 'boomEmpty', reason: 'none' }];
    }

    var it = state.held;
    state.dynamite -= 1;
    state.bombs += 1;

    it.removed = true;          // 直接消失，绕开 settle() 的计分分支
    it.grabbed = false;
    state.held = null;
    state.escapeAtLen = 0;
    state.boomBoost = true;     // 这一趟回收加速，别让玩家等
    state.shake = 0.85;
    state.hook = hookPos(state);
    pushFloat(state, state.hook.x, state.hook.y - 26, '轰！', 'bad');

    return [{
      type: 'boom', itemType: it.type, item: it,
      x: state.hook.x, y: state.hook.y, left: state.dynamite,
    }];
  }

  /* =====================================================================
   * 7b. 小卖部（经济）
   * -------------------------------------------------------------------
   * 三条从原版抄来的规矩：
   *   · 花的就是**累计分数本身**，而累计分数就是通关门槛 → 买强和达标天然冲突
   *   · 商品只顶下一关，不是永久升级 → 能力不复利
   *   · 不许把自己买到"低于已经通过的门槛"以下（方案 B）
   *     保留"花钱会推迟进度"的张力，但不会让你直接掉进死局
   * ===================================================================== */

  function shopItem(key) {
    for (var i = 0; i < SHOP_ITEMS.length; i++) {
      if (SHOP_ITEMS[i].key === key) { return SHOP_ITEMS[i]; }
    }
    return null;
  }

  /* 这件商品现在能不能买？不能的话给人话理由（界面直接显示）。 */
  function canBuy(state, key) {
    var item = shopItem(key);
    if (!item) { return { ok: false, reason: '没有这件商品' }; }
    if (state.score - item.price < state.target) {
      return {
        ok: false, item: item,
        reason: '买完就只剩 ' + (state.score - item.price) + ' 分，低于 ' + state.target + ' 的门槛了',
      };
    }
    return { ok: true, item: item };
  }

  /* 买一件：扣分、记到 pending（下一关生效）。
   * 注意 buff 是**累加**的：炸药可以连买几发。 */
  function buy(state, key) {
    var c = canBuy(state, key);
    if (!c.ok) { return { ok: false, reason: c.reason, item: c.item || null }; }

    state.score -= c.item.price;
    state.shopSpent += c.item.price;
    state.pending[key] = (state.pending[key] || 0) + 1;

    return {
      ok: true, item: c.item, score: state.score,
      count: state.pending[key],
      left: state.score - state.target,       // 还能花多少（界面用来置灰按钮）
    };
  }

  /* 这一关要不要开小卖部？ */
  function shopOpen(state) {
    return state.phase === 'levelClear' && state.level >= state.cfg.SHOP_FROM_LEVEL;
  }

  /* 小卖部界面要显示的东西：商品 + 当前能不能买 + 下一关炸药总数（预览） */
  function shopView(state) {
    var view = { open: shopOpen(state), budget: state.score - state.target,
      spentNow: 0, items: [] };
    for (var i = 0; i < SHOP_ITEMS.length; i++) {
      var it = SHOP_ITEMS[i];
      var c = canBuy(state, it.key);
      view.items.push({
        key: it.key, name: it.name, tag: it.tag, price: it.price, unit: it.unit || '',
        desc: it.desc, hint: it.hint,
        owned: state.pending[it.key] || 0,
        canBuy: c.ok, reason: c.reason,
      });
    }
    // 下一关会带几发炸药：把 pending 里的炸药临时算进去（给界面预览用）
    var probe = { cfg: state.cfg, buffs: { dynamite: state.pending.dynamite || 0 } };
    view.nextDynamite = dynamiteFor(probe, state.level + 1);
    return view;
  }

  /* ---------------------------------------------------------------------
   * 7.5 "收工"：达标之后主动结束这一关
   * ---------------------------------------------------------------------
   * 为什么要有这个东西：
   *   关卡是**打满 LEVEL_TIME 才判成败**的（见 step() 末尾）。于是出现了玩家
   *   反馈的那个行为 ——"一达标就停手干等": 达标之后再挖，收益归零（分数已经够了）、
   *   风险却是实打实的（撞一下天使就是 -150 还把连击清掉）。
   *   理性打法当然是不动。
   *
   *   收工把"干等"换成一个真选择：
   *     现在落袋为安（分数原样带进小卖部），还是再挖几钩多攒点钱。
   *   于是"继续挖"重新有了理由（小卖部的钱），"停手"也不再是唯一正解。
   * ------------------------------------------------------------------- */
  function canCashOut(state) {
    if (state.phase !== 'swinging' && state.phase !== 'shooting' && state.phase !== 'pulling') { return false; }
    if (state.score < state.target) { return false; }
    /* 还差多少"自己赚"的分才解锁收工。
     * 光看 score >= target 是不够的（见 setTarget 的说明）：
     * 吃老本的盈余能顶门槛，但顶不了"这一关的活儿"。 */
    return (state.score - state.levelStartScore) >= (state.levelQuota || 0);
  }

  /* 收工还差多少分（0 表示现在就能收）。界面用它把按钮置灰 + 报数。 */
  function cashOutGap(state) {
    if (state.phase !== 'swinging' && state.phase !== 'shooting' && state.phase !== 'pulling') { return 0; }
    var byTarget = Math.max(0, state.target - state.score);
    var byQuota = Math.max(0, (state.levelQuota || 0) - (state.score - state.levelStartScore));
    return Math.max(byTarget, byQuota);
  }

  /* 过关事件的统一载荷：时间到过关 和 主动收工 走同一个形状，
   * 上层（结算面板 / 小卖部）不用分两套。cashedOut 只是给文案用的。 */
  function levelClearEvent(state, cashedOut) {
    return {
      type: 'levelClear', cashedOut: !!cashedOut,
      level: state.level, score: state.score, target: state.target,
      levelGain: state.score - state.levelStartScore,
      comboBest: state.comboBest, escapes: state.escapes, angels: state.angels,
      bombs: state.bombs, shopSpent: state.shopSpent,
      timeLeft: state.timeLeft,
    };
  }

  function cashOut(state) {
    if (!canCashOut(state)) { return []; }
    var ev = levelClearEvent(state, true);
    state.phase = 'levelClear';
    state.held = null;
    state.escapeAtLen = 0;
    return [ev];
  }

  /* =====================================================================
   * 8. 推进一帧
   * ===================================================================== */

  function pushFloat(state, x, y, text, kind) {
    state.floaters.push({ x: x, y: y, text: text, kind: kind, t: 0, life: 1.0 });
  }

  /* 回收结束：结算手里的东西 */
  function settle(state, ev) {
    var it = state.held;
    state.held = null;

    if (!it) {
      // 抓空：连击清零，节奏上不额外惩罚
      if (!state.grabbedThisShot) {
        state.combo = 0;
        ev.push({ type: 'empty', combo: state.combo });
      }
      return;
    }

    it.removed = true;
    var isAngel = it.isAngel;

    if (isAngel) {
      // 天使奶蛙是炸弹：扣分 + 连击清零（呼应打奶蛙里"天使 别打！"）
      state.score = Math.max(0, state.score + it.value);
      state.combo = 0;
      state.angels += 1;
      state.shake = 1;
      pushFloat(state, state.cfg.MINER_X, state.cfg.MINER_Y - 10, String(it.value), 'bad');
      ev.push({
        type: 'resolve', itemType: it.type, item: it, base: it.value, points: it.value,
        combo: 0, mult: 1, isAngel: true, isGod: false, timeBonus: 0, laughLevel: 0,
        score: state.score,
      });
      ev.push({ type: 'angel', points: it.value, score: state.score });
      return;
    }

    // 正常收获
    if (!it.isStone) { state.combo += 1; }
    if (state.combo > state.comboBest) { state.comboBest = state.combo; }

    var mult = comboMult(state.combo, state.cfg);
    var points = Math.round(it.value * mult);
    state.score += points;

    var timeBonus = 0;
    if (it.timeBonus) {
      timeBonus = it.timeBonus;
      state.timeLeft += timeBonus;
      ev.push({ type: 'god', timeBonus: timeBonus });
    }

    var lv = it.type === 'laugh' ? 1 : laughLevel(state.combo, state.cfg);

    pushFloat(state, state.cfg.MINER_X, state.cfg.MINER_Y - 10,
      '+' + points + (mult > 1 ? ' ×' + mult : ''),
      it.type === 'laugh' || it.type === 'god' ? 'great' : 'good');

    ev.push({
      type: 'resolve', itemType: it.type, item: it, base: it.value, points: points,
      combo: state.combo, mult: mult, isAngel: false, isGod: !!it.timeBonus, timeBonus: timeBonus,
      laughLevel: lv, score: state.score,
    });
    return;
  }

  function step(state, dt) {
    var ev = [];
    if (state.phase !== 'swinging' && state.phase !== 'shooting' && state.phase !== 'pulling') {
      tickEffects(state, dt);
      return ev;
    }

    dt = Math.min(dt, state.cfg.MAX_DT);
    var cfg = state.cfg;

    /* —— 计时 —— */
    state.timeLeft -= dt;

    /* —— 摆钟相位：永远连续推进，绝不重置 ——
     * 这一行是刻意的，别改成"每发之后归零"。
     * 如果每发都把摆动归零，钩子就总是从正中重新起摆，于是"固定节奏点击"的玩家
     * 每次都会落到同一个角度上，被系统性地锁死——点得越稳反而越打不中。
     * 让相位随绝对时间连续推进，玩家的节奏才会自然扫过全部角度。
     * （实证：改之前 0.4~0.9 秒节奏的命中率只有 1.1%，改之后见 test-logic.js 的节奏测试） */
    state.swingClock += dt;

    /* —— 会爬的目标：慢速横向巡逻（呼应原版会跑的鼹鼠/老鼠）——
     * 只推进"没被抓住"的：一旦 grabbed，它的位置就由绳子接管了（见 pulling 分支）。
     * 结算态（ready / levelClear / gameOver）不动，免得在浮层后面偷偷爬。 */
    if (state.phase === 'swinging' || state.phase === 'shooting' || state.phase === 'pulling') {
      for (var mi = 0; mi < state.items.length; mi++) {
        var mob = state.items[mi];
        if (!mob.moving || mob.removed || mob.grabbed) { continue; }
        mob.x += mob.moveDir * mob.moveSpeed * dt;
        if (mob.x <= mob.minX) { mob.x = mob.minX; mob.moveDir = 1; }
        else if (mob.x >= mob.maxX) { mob.x = mob.maxX; mob.moveDir = -1; }
      }
    }

    /* —— 待机：钩子来回摆 —— */
    if (state.phase === 'swinging') {
      var target = swingAngle(state);

      if (state.blend > 0) {
        // 收钩归位：从"发射时锁定的角度"平滑摆回正在进行的摆动，避免绳子瞬移
        state.blend = Math.max(0, state.blend - dt);
        var k = 1 - state.blend / cfg.RETURN_BLEND;
        k = k * k * (3 - 2 * k);                    // smoothstep
        state.angle = state.returnFrom + (target - state.returnFrom) * k;
      } else {
        state.angle = target;
      }

      state.ropeLen = cfg.ROPE_IDLE_LEN;
      state.hook = hookPos(state);
    }

    /* —— 射出：绳长增加，碰到东西或到边界就转回收 —— */
    else if (state.phase === 'shooting') {
      var lim = maxRopeLen(state, state.angle);
      state.ropeLen += cfg.SHOOT_SPEED * dt;
      if (state.ropeLen >= lim) { state.ropeLen = lim; }
      state.hook = hookPos(state);

      var hit = findHit(state, state.hook);
      if (hit) {
        hit.grabbed = true;
        state.held = hit;
        state.grabbedThisShot = true;
        state.hits += 1;
        state.pullT = 0;

        /* 大块头会挣扎：先假装拉一段，快到手时脱钩掉回去。
         * 触发点是"绳长缩到多少"，不是"拉了多久" —— 原因见 CONFIG 里 ESCAPE_AT_FRACTION。 */
        if (hit.type === 'sumo' && state.rng() < cfg.ESCAPE_CHANCE) {
          state.escapeAtLen = cfg.ROPE_IDLE_LEN +
            (1 - cfg.ESCAPE_AT_FRACTION) * (state.ropeLen - cfg.ROPE_IDLE_LEN);
        } else {
          state.escapeAtLen = 0;
        }

        state.phase = 'pulling';
        ev.push({ type: 'grab', item: hit, itemType: hit.type, weight: hit.weight });
      } else if (state.ropeLen >= lim) {
        state.phase = 'pulling';
        state.pullT = 0;
      }
    }

    /* —— 回收：绳长减少，带回或带回个寂寞 —— */
    else if (state.phase === 'pulling') {
      state.pullT += dt;

      // 挣脱判定
      if (state.held && state.escapeAtLen > 0 && state.ropeLen <= state.escapeAtLen) {
        var lost = state.held;
        lost.grabbed = false;
        lost.x = lost.homeX;
        lost.y = lost.homeY;
        lost.wobble = 1;
        state.held = null;
        state.escapeAtLen = 0;
        state.escapes += 1;
        state.shake = 0.6;
        ev.push({ type: 'escape', item: lost, itemType: lost.type });
      }

      var spd;
      if (state.held) {
        // 回收速度按物品的"价值"给 —— 越值钱回来越快（见 pullSpeedOf）。
        // 灰石堆是例外：它永远按重量算，慢得离谱，所以"被石头挡住"才是真的取舍。
        spd = pullSpeedOf(state, state.held);
      } else {
        // 空钩：抓空 / 被挣脱 / 刚被炸掉，都走这条
        spd = cfg.PULL_BASE_SPEED * cfg.EMPTY_PULL_MULT *
          (state.boomBoost ? cfg.DYNAMITE_BOOM_RETURN : 1);
      }

      state.ropeLen -= spd * dt;
      if (state.held) {
        state.hook = hookPos(state);
        state.held.x = state.hook.x;
        state.held.y = state.hook.y;
        state.held.wobble = 0;
      } else {
        state.hook = hookPos(state);
      }

      if (state.ropeLen <= cfg.ROPE_IDLE_LEN) {
        state.ropeLen = cfg.ROPE_IDLE_LEN;
        state.hook = hookPos(state);
        state.boomBoost = false;
        settle(state, ev);
        // 从当前锁定角度摆回钟摆（而不是把钟摆归零）
        state.returnFrom = state.angle;
        state.blend = cfg.RETURN_BLEND;
        state.phase = 'swinging';
      }
    }

    /* —— 时间到：定成败 —— */
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      var pass = state.score >= state.target;
      state.phase = pass ? 'levelClear' : 'gameOver';
      if (pass) {
        ev.push(levelClearEvent(state, false));
      } else {
        ev.push({
          type: 'levelFail',
          level: state.level, score: state.score, target: state.target,
          levelGain: state.score - state.levelStartScore,
          comboBest: state.comboBest, escapes: state.escapes, angels: state.angels,
          bombs: state.bombs, shopSpent: state.shopSpent,
        });
      }
    }

    tickEffects(state, dt);
    return ev;
  }

  /* 飘字生命期 + 震动衰减（纯表现，但放在逻辑里方便单测） */
  function tickEffects(state, dt) {
    for (var i = state.floaters.length - 1; i >= 0; i--) {
      var f = state.floaters[i];
      f.t += dt;
      f.y -= 46 * dt;
      if (f.t >= f.life) { state.floaters.splice(i, 1); }
    }
    if (state.shake > 0) { state.shake = Math.max(0, state.shake - dt * 4); }
  }

  /* =====================================================================
   * 9. 供渲染层读取的派生量
   * ===================================================================== */

  function progress(state) {
    return state.target > 0 ? clamp(state.score / state.target, 0, 1) : 0;
  }

  function timeRatio(state) {
    var full = state.cfg.LEVEL_TIME;
    return full > 0 ? clamp(state.timeLeft / full, 0, 1) : 0;
  }

  /* 钩子"有没有东西"的视觉线索 */
  function heldType(state) {
    return state.held ? state.held.type : null;
  }

  /* =====================================================================
   * 10. 导出
   * ===================================================================== */
  return {
    CONFIG: CONFIG,
    PRESETS: PRESETS,
    LAYOUTS: LAYOUTS,
    ITEMS: ITEMS,
    LEGEND_ORDER: LEGEND_ORDER,
    SHOP_ITEMS: SHOP_ITEMS,

    createGame: createGame,
    restart: restart,
    beginLevel: beginLevel,
    nextLevel: nextLevel,
    relayout: relayout,
    shoot: shoot,
    blowUp: blowUp,
    step: step,

    /* —— 小卖部 / 经济 —— */
    shopItem: shopItem,
    shopOpen: shopOpen,
    shopView: shopView,
    canBuy: canBuy,
    buy: buy,

    /* —— 收工 —— */
    canCashOut: canCashOut,
    cashOut: cashOut,
    cashOutGap: cashOutGap,
    levelClearEvent: levelClearEvent,

    hookPos: hookPos,
    maxRopeLen: maxRopeLen,
    inField: inField,
    findHit: findHit,

    swingAngle: swingAngle,
    swingPeriod: swingPeriod,
    applyLevelTuning: applyLevelTuning,
    comboMult: comboMult,
    laughLevel: laughLevel,
    itemValue: itemValue,
    itemWorth: itemWorth,
    nominalValue: nominalValue,
    pullSpeedOf: pullSpeedOf,
    earnRateOf: earnRateOf,
    dynamiteFor: dynamiteFor,
    achievableValue: achievableValue,
    recipe: recipe,
    buildItems: buildItems,
    progress: progress,
    timeRatio: timeRatio,
    heldType: heldType,
    fitsInField: fitsInField,

    _seededRng: seededRng,
  };
});
