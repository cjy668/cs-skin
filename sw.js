/* CS 饰品仓位管理 · Service Worker
   离线可用 + 更新必达：
     · 页面（html）→ 联网优先（network-first），打开就是最新；断网回退缓存
     · 实时数据（live.json / api）→ 联网优先，永远要最新价
     · 大文件行情（market.json / catalog.json 等）→ 缓存优先 + 后台更新
       （market.json 已扩到 2.2 万件 ≈ 3.5 MB，每次打开都重下太浪费流量；它一天只更新 3 次）
     · 静态资源（图标/manifest）→ 缓存优先
   只在 https / localhost 下注册。
   ★ 2026-10-18 → v18：监控清单 / 阶段看板 / 卖出看板三个数据文件都加了新字段
     （exitLocked 出口锁死 / 剩余拉升空间 room / 盘的类型 stockType），
     老客户端缓存里没有这些字段 → CACHE 必须 +1 把它换掉。
   ⚠️ 2026-10-20 修：上面这段注释在 v19 时被误写了一个「注释结束符」，
     导致整个 sw.js 语法错误、Service Worker 根本注册不上（浏览器控制台报
     "Invalid or unexpected token"）—— 也就是说 2026-10-19 之后的缓存策略全部没生效。
     现在只保留最后那一个注释结束符，语法恢复正常。
   ⚠️ 2026-10-19 十三修正：首页最上方新增「拉升前候选」卡（用户最高优先级），
      数据源 pre-rally-candidates.json（cs-quant/build_pre_rally_candidates.cjs 产出：
        1,073 品按【①阶段 ②剩余空间 ③强盘排序】三条件串联后的候选名单 +
        每条的批次强弱 / 剩余空间 / 出口锁死 / 控盘倒货型 / 之后 60 日走势分布 / 命中痕迹 +
        没有候选时的 near-miss）。
      **必须进 NET_FIRST**：它是"今天哪些品在拉升前"，卡在缓存里 = 用户拿着昨天的名单做今天的决定
      —— 同一个坑的第十四次。CACHE v19 → v20。
      体积控制：约 320 KB，但页面侧 setTimeout(60ms) 才拉（让出首屏关键路径），
      且只在「大盘」（首页）时拉，不拖首屏。 */
/*   ★ 2026-10-21 v24：事件急跌抄底点判据重写（四条件改为【时序】关系，
     并且 state 从对象改成字符串）—— 首页 #sec-crash 的渲染逻辑整段换过。
     老客户端缓存里是旧 index.html + 旧 crash-buy.json（旧 schema），
     两者混用会出现"卡片一直隐藏"或"字段 undefined" → CACHE 必须 +1。
     历史回放文件（crashdemo-*.json / crash-buy-demo.json）也一起进 NET_FIRST：
     它们只被 ?crashdemo= 显式请求，进 NET_FIRST 不拖首屏，但能保证截图/核验看到的是最新那份。 */
/*   ★ 2026-10-21 v25：S5 时效闸门（data/bars-freshness.json）—— 首页 <header> 里
     新增常显条「结论基于哪一天的日线 / 价格是哪一天的」，并在落后时变黄变红。
     ★ 这条闸门的存在意义就是"不让用户再看到旧结论当新结论"，所以它自己绝不能被
       老缓存挡住：老客户端的 index.html 没有 #bars-gate 这个节点，CSS 也没有 .barsgate，
       拉不到/渲染不出就等于闸门失效 → CACHE 必须 +1。 */
/*   ★ 2026-10-21 v26（台账 B3）：工具页新增「CS2 官方更新监测」区块，
     数据源 cs2-news-watch.json（cs-quant/update_watcher.cjs 每 30 分钟只读巡检
     Steam 官方公告后写出的"有没有新更新"）。
     ★ 为什么必须进 NET_FIRST：这一块的全部意义就是"明天早上更新，本机能知道"——
       卡在缓存里 = 用户看到的是几小时前的"没有新更新"，那比没有这一块更糟
       （它会让人以为巡检过了、其实看到的是旧的）。CACHE 必须 +1（v25 → v26）。
     体积：目前几 KB（只存最近 7 天 + 本次新增），只有切到「工具」页才拉。 */
const CACHE = 'cs-skin-app-v26';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];
/* 页面与实时/每日数据：永远优先联网
   ⚠️ 2026-10-13 修正：analysis.json / signals.json 必须在这里
      它们每天更新 3 次、体积小（314 KB / 18 KB），放缓存优先会导致
      手机上【永远停在旧版本】（用户实测：分析页数据停在 2 天 23 小时前，
      而 live.json 是新的 —— 正是因为当时只有 live.json 在名单里）。
      只有 market.json（3.5 MB，一天 3 次）才适合缓存优先。
   ⚠️ 2026-10-13 再修正：加了 market-pulse.json —— analysis.json 现在每 3 分钟被
      cs-quant/fast_refresh.cjs 轻刷一次价格，脉搏文件同样是 3 分钟级；
      放缓存优先同样会让「大盘」页停在旧数字。
   ⚠️ 2026-10-13 三修正：加了 tools.json（工具页：4 个 Node CLI 的静态快照，
      cs-quant/build_tools.cjs 每天随流水线重生成）。同一个坑：**不在 NET_FIRST
      名单里 = 手机上永远看到旧版本**，所以它必须在这里，不能只放进 ASSETS。
      同时 CACHE 版本号 v6 → v7，让老客户端下次打开就换掉旧缓存。
   ⚠️ 2026-10-14 四修正：工具页新增「查任意一件」（单品体检器手机版），加了两个文件，
      都进 NET_FIRST：
        · inspect-engine.js（38 KB，算分内核；与 cs-quant/inspect.cjs 等价）
        · inspect-data.json（3.65 MB / gzip ≈ 1.28 MB，800 个品种的日线 + 截面快照）
      为什么大文件也用联网优先，而不是「缓存优先 + 每日版本号」：
      本文件的缓存分支用的是 caches.match(req, { ignoreSearch: true })，
      **查询串会被忽略** → 靠 `?d=日期` 当版本号在这里根本不生效，会一直命中旧缓存。
      而体检数据的口径（断层率 / 退出天数 / dataGaps）过期，比多下 1.28 MB 更糟。
      缓解：页面侧只在用户点开「查任意一件」时才请求（懒加载），且同一次会话只下一次。
      CACHE v7 → v8。
   ⚠️ 2026-10-15 五修正：加了 health.json（数据新鲜度徽标的数据源，
      cs-quant/watchdog.cjs 每约 12 分钟重写一次）。
      **同样必须进 NET_FIRST**：它是「哪些数据不新鲜」的报告本身，
      要是它自己卡在缓存里，用户看到的报警状态就是过期的 ——
      那正好又是事故 A 的同一种失败（提示器自己失效）。CACHE v8 → v9。
   ⚠️ 2026-10-15 六修正：信号页新增「做盘类型」区块，数据源两个：
        · pattern-types.json（核心结论：类型/检验/退出规律/当前命中）
        · _types-detail.json（按需加载：逐件持仓跟踪 + 月度时期网格）
      两个都进 NET_FIRST —— 理由是同一个：结论是日更的、每 3 分钟
      fast_refresh 还可能刷新，放缓存优先手机上就永远停在旧结论。
      另：_types-detail.json 体积较大（几百 KB），页面侧**只在用户点开
      「不同时期的特点」时才请求**，所以放进 NET_FIRST 不会拖慢首屏。
      CACHE v9 → v10。
   ⚠️ 2026-10-15 七修正：信号页新增「卖出警报」区块，数据源 sell-alerts.json
      （3 个已通过样本外对照检验的风险型做盘类型 + 44 件持仓逐件判定 +
        关注品/断层率名单；由 cs-quant/sell_alert.cjs 产出，日更 + fast_refresh 每 3 分钟重扫）。
      **必须进 NET_FIRST**：这是「该不该减仓」的提示，要是它卡在缓存里，
      用户会拿着几小时前的警报做决策 —— 同一个坑的第八次。CACHE v10 → v11。
   ⚠️ 2026-10-16 八修正：信号页新增「监控清单」区块，数据源 watchlist-status.json
      （cs-quant/monitor_watchlist.cjs 产出：1,073 个【已知会被反复做】的品的当前阶段 +
        每条命中的痕迹与效应量 exp(DiD) + 容量约束 maxTradable + 44 件持仓逐件判定；
        日更全量 + fast_refresh 每 3 分钟轻刷实时价与卖出信号）。
      **同样必须进 NET_FIRST**：它是「今天谁在拉升前」的名单，卡在缓存里 =
      用户拿着昨天的阶段做今天的决定 —— 同一个坑的第九次。CACHE v11 → v12。
   ⚠️ 2026-10-16 九修正：新增「做盘痕迹图谱」页 mani-atlas.html（全量 1,073 品的
      逐品做盘痕迹：按武器箱分组、箱内按稀有度上下级排、点开看逐次拉升表 +
      拉升前 30 天盘口快照 + 断层率 + 配对对照 + 故事线 + SVG 图）。
      数据源三个，**都要进 NET_FIRST**（页签里没有它，但它是独立页面、会被直接打开）：
        · mani-atlas.json    （索引：80 个箱子 / 1,073 品摘要，730 KB）
        · mani-shard-*.json  （★ 懒加载分片：点开某个品才拉它那一片，120 片 × ≤9 品）
        · mani-svg/<gid>.svg （点开才拉那张图）
      为什么不能走"缓存优先"：这一页的数字全是日更的（清洗后的序列每天可能变），
      卡在缓存里就是同一个坑的第十次。CACHE v12 → v13。
      体积控制：首屏只加载 mani-atlas.json（730 KB）+ 什么都不拉；
      分片与图都是用户点开那一行才请求，所以放进 NET_FIRST 不会拖慢首屏。
   ⚠️ 2026-10-17 十修正：信号页新增「做盘阶段看板」区块（替代旧的「卖出警报」主提示），
      数据源 dealer-stage-board.json（cs-quant/dealer_stage_board.cjs 产出：
        7 个阶段的定义与判定依据 + 每个阶段的历史持续时长 + 进入该阶段后
        60 个交易日的走势分布 p25/中位/p75 + 1,073 品的当前阶段与逐条命中痕迹）。
      **必须进 NET_FIRST**：它是「现在处于做盘的什么环节」的答案，卡在缓存里就是
      拿几天前的阶段做今天的判断 —— 同一个坑的第十一次。CACHE v13 → v14。
      体积控制：约 470 KB，但只在用户切到「信号」页才拉（懒加载），不拖首屏。
   ⚠️ 2026-10-17 十二修正：库存页新增「持仓退出看板」区块，数据源 exit-board.json
      （cs-quant/exit_board.cjs 产出：44 个持仓逐品的当前阶段 + 所处行情批次与批内强弱
        + 拉升三形态 C/A/B/N + 是否命中已验证卖出信号 + 五合一出口 covert_arb_gap
        + 该阶段历史上之后 60 个交易日的走势分布 + 按六项加权的卖出优先级）。
      **必须进 NET_FIRST**：它回答的是「我这 44 个持仓各自处在拉升的哪个时期」，
      卡在缓存里就会拿昨天的阶段决定今天卖不卖 —— 同一个坑的第十二次。CACHE v16 → v17。
      体积控制：约 184 KB，且只在用户切到「库存」页才拉（懒加载），不拖首屏。
   ⚠️ 2026-10-20 十三修正：★ 唯一价格源 price-live.json（cs-quant/price_live.cjs 产出，
      由 fast_refresh.cjs 每 3 分钟刷新）。它是全站所有价格的唯一来源：
      用户当天报「M4A4 | 红色 DDPAT 今日 845，app 说 754」，就是各派生文件里
      写死的生成时刻旧价造成的（同一个品在 7 个 JSON 里有 7 个价）。
      **必须进 NET_FIRST**：它进了「缓存优先」分支就等于价格永远停在第一次打开时 ——
      那正是这次事故的同一种失败（数据是旧价、用户不知道）。CACHE v21 → v22。 */
const NET_FIRST = /\.html?(\?|$)|\/api\/|live\.json|price-live\.json|analysis\.json|signals\.json|portfolio\.json|market-pulse\.json|tools\.json|inspect-data\.json|inspect-engine\.js|health\.json|pattern-types\.json|_types-detail\.json|_types-live\.json|sell-alerts\.json|watchlist-status\.json|dealer-stage-board\.json|rally-batches\.json|exit-board\.json|pre-rally-candidates\.json|watch-list\.json|replenish-points\.json|crash-buy\.json|crash-buy-demo\.json|crashdemo-\d+\.json|data-freshness\.json|bars-freshness\.json|mani-atlas\.json|mani-shard-\d+\.json|mani-svg\/|cs2-news-watch\.json/i;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;

  const isNav = req.mode === 'navigate' || NET_FIRST.test(url.pathname + url.search);

  if (isNav){
    /* 联网优先：拿到就更新缓存并返回；失败再回退缓存（保证离线也能开） */
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic'){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  /* 静态资源：缓存优先 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic'){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
