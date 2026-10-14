/* ============================================================================
   inspect-engine.js —— 「查任意一件」的浏览器端计算内核（只读、零网络）

   为什么要单独一个文件：
     deploy/inspect-data.json 只存 800 个品种的日线原始数据，评分/指标/断层率
     全都在手机浏览器里**当场算**。这段算法必须和电脑上的 cs-quant/inspect.cjs
     完全等价，所以：
       · 浏览器：index.html 用 <script src="./inspect-engine.js"> 加载
       · Node  ：_test/_verify_inspect_parity.cjs 用 require() 加载同一份文件
     只有同一份代码，才谈得上「一致」——不是两处各写一遍再肉眼比。

   等价范围（逐条对照 cs-quant/inspect.cjs 与 cs-quant/lib_indicators.cjs）：
     · buildSpread()        ← inspect.cjs L413-442
     · calcIndicators()     ← inspect.cjs L472-487 + lib_indicators.cjs
                              sma / rsi(Wilder) / bollinger / zscore /
                              annualizedVolatility / maxDrawdown
     · buildSupplyDemand()  ← inspect.cjs L492-527
     · score()              ← inspect.cjs L966-1063（含每一项的加减分与等级阈值）
     · dataGaps 的判定顺序与文案 ← inspect.cjs L1153-1254 + L1431
     · hasUsableVolume()    ← inspect.cjs L1128-1134

   ⚠️ 已知且写进页面的口径差异（不隐藏）：
     · 本地缓存只有 ~363 天，inspect.cjs 在电脑上要的是 730 天 → 本页的
       「2 年分位 / 2 年最大回撤」实际是 1 年口径，标签直接写「1 年」。
     · 日线来自 cs-quant/data/_absorb-cache.json（sell_price / sell_num /
       buy_num）与 _buyprice-cache.json（buy_price），都是 A 平台（悠悠有品）
       csqaq 官方接口的日线；每天随流水线导出一次。
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CsInspectEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const V = 1;

  /* ── 阈值：逐字抄 cs-quant/inspect.cjs L67-89，一处都不改 ──────────────── */
  const TH = {
    SPREAD_MARKUP_MAX: 0.03,
    SPREAD_WASH_MIN: 0.10,
    SPREAD_WASH_MAX: 0.15,
    SPREAD_TRAP_MIN: 0.15,
    SPREAD_SUSPECT: 0.08,
    PRICE_JUNK: 1.0, PRICE_THIN: 3.0, PRICE_MIN_TRADEABLE: 10.0,
    WEAR_FWD90: { '崭新出厂': 0.2564, '略有磨损': 0.1462, '久经沙场': 0.1276, '破损不堪': 0.0968, '战痕累累': 0.0574 },
    WEAR_N: { '崭新出厂': 659, '略有磨损': 363, '久经沙场': 342, '破损不堪': 23, '战痕累累': 33 },
    EXIT_HARD_DAYS: 30,
    GRADE: { A: 78, B: 62, C: 45 }
  };

  /* ── 7 平台字段映射：抄 inspect.cjs L92-100 ───────────────────────────── */
  const PLATFORMS = [
    { key: 'yyyp', label: '悠悠有品', sell: 'yyyp_sell_price', buy: 'yyyp_buy_price' },
    { key: 'buff', label: 'BUFF', sell: 'buff_sell_price', buy: 'buff_buy_price' },
    { key: 'steam', label: 'Steam', sell: 'steam_sell_price', buy: 'steam_buy_price' },
    { key: 'c5', label: 'C5GAME', sell: 'c5_sell_price', buy: 'c5_buy_price' },
    { key: 'igxe', label: 'IGXE', sell: 'igxe_sell_price', buy: 'igxe_buy_price' },
    { key: 'eco', label: 'ECOsteam', sell: 'eco_sell_price', buy: 'eco_buy_price' },
    { key: 'r8', label: 'R8', sell: 'r8_sell_price', buy: null }
  ];

  /* ── 数值小工具：与 inspect.cjs L104-114 同名同义 ─────────────────────── */
  const MS_DAY = 86400000;
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const r2 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;
  const r4 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 10000) / 10000;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const med = a => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) / 2; return s.length % 2 ? s[(s.length - 1) / 2] : (s[Math.floor(i)] + s[Math.ceil(i)]) / 2; };
  const qtl = (a, p) => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
  const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / MS_DAY);
  const money = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const pctS = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : ((v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%');
  const wearOf = cn => (String(cn || '').match(/[（(](崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累)[）)]/) || [])[1] || null;

  /* ======================================================================
     A) 数据集解码 —— 把压缩过的日线还原成 inspect.cjs 认的 {t, v} 结构
     打包格式（每件一个字符串，4 段用 | 分隔，顺序固定）：
        sell_price | buy_price | sell_num | buy_num
     每段 = "起点天序号.跨度.差1.差2.…"
       · 天序号是**全局连续日期轴**（dataset.d0 + n 天）上的位置
       · 空值写 '~'（日线里本来就有随机缺日）
       · 差 = 与上一个有效值的差，zigzag 后的十进制
     解码后把 '~' 丢掉 —— 于是 t/v 里只剩真实存在的交易日，
     与 inspect.cjs 从 csqaq 拿到的序列结构完全一致（缺日就是缺条目，不是 null 条目）。
     空段 = 该序列缺失（不编造 0）
     ====================================================================== */
  function unzig(u) { return (u >>> 1) ^ -(u & 1); }

  function decodeSeg(seg, axis0Ms) {
    if (!seg) return null;
    const a = seg.split('.');
    const start = Number(a[0]), span = Number(a[1]);
    if (!Number.isFinite(start) || !Number.isFinite(span) || span <= 0) return null;
    const t = [], v = [];
    let prev = 0;
    for (let i = 0; i < span; i++) {
      const raw = a[2 + i];
      if (raw === '~' || raw === '' || raw === undefined) continue;
      prev = prev + unzig(Number(raw));
      t.push(axis0Ms + (start + i) * MS_DAY);
      v.push(prev);
    }
    if (!t.length) return null;
    return { t: t, v: v };
  }
  /* 价格端点：打包时按「分」存，取回时 ÷100（判定与展示都用元） */
  function unscale(s, k) { if (!s) return null; if (k === 1) return s; const v = new Array(s.v.length); for (let i = 0; i < s.v.length; i++) v[i] = s.v[i] === null ? null : s.v[i] / k; return { t: s.t, v: v }; }

  function rowOf(dataset, idx) {
    return {
      idx: idx,
      gid: dataset.g[idx],
      cn: dataset.n[idx],
      hash: dataset.h[idx],
      snap: dataset.m[idx] || null
    };
  }

  /* 日线（惰性：只有真正要看的那一件才解压） */
  function seriesOf(dataset, idx) {
    const packed = String(dataset.s[idx] || '');
    const parts = packed.split('|');
    const axis0Ms = Date.parse(dataset.d0 + 'T00:00:00Z');
    return {
      sell_price: unscale(decodeSeg(parts[0], axis0Ms), 100),
      buy_price: unscale(decodeSeg(parts[1], axis0Ms), 100),
      sell_num: decodeSeg(parts[2], axis0Ms),
      buy_num: decodeSeg(parts[3], axis0Ms)
    };
  }

  /* ======================================================================
     B) 指标 —— lib_indicators.cjs 的逐行复刻
     ====================================================================== */
  function _clean(prices) {
    const out = [];
    if (!Array.isArray(prices)) return out;
    for (let i = 0; i < prices.length; i++) {
      const v = prices[i];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v > 0) out.push(v);
    }
    return out;
  }
  function _window(values, period) {
    if (!Number.isInteger(period) || period <= 0) return null;
    if (values.length < period) return null;
    return values.slice(values.length - period);
  }
  function _sampleVariance(values) {
    const n = values.length;
    if (n < 2) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += (values[i] - mean) * (values[i] - mean);
    return acc / (n - 1);
  }
  function sma(prices, period) {
    const win = _window(_clean(prices), period);
    if (!win) return null;
    let s = 0; for (let i = 0; i < win.length; i++) s += win[i];
    return s / period;
  }
  function stddev(prices, period) {
    let values = _clean(prices);
    if (period) { const win = _window(values, period); if (!win) return null; values = win; }
    const v = _sampleVariance(values);
    return v === null ? null : Math.sqrt(v);
  }
  /* Wilder RSI（不是简单平均）—— [FACET] facet__indicators.py:62-90 */
  function rsi(prices, period) {
    const p = period === undefined ? 14 : period;
    const values = _clean(prices);
    if (!Number.isInteger(p) || p <= 0) return null;
    if (values.length < p + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= p; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gains += d; else losses -= d; }
    let avgGain = gains / p, avgLoss = losses / p;
    for (let i = p + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      avgGain = (avgGain * (p - 1) + Math.max(d, 0)) / p;
      avgLoss = (avgLoss * (p - 1) + Math.max(-d, 0)) / p;
    }
    if (avgLoss === 0) return avgGain > 0 ? 100.0 : 50.0;
    return 100.0 - (100.0 / (1.0 + avgGain / avgLoss));
  }
  function bollinger(prices, period, mult) {
    const p = period === undefined ? 20 : period;
    const m = mult === undefined ? 2.0 : mult;
    const win = _window(_clean(prices), p);
    if (!win) return null;
    let s = 0; for (let i = 0; i < win.length; i++) s += win[i];
    const middle = s / p;
    const sd = stddev(win);
    if (sd === null) return null;
    const upper = middle + m * sd, lower = middle - m * sd;
    return { upper: upper, middle: middle, lower: lower, width: middle ? (upper - lower) / middle : 0.0 };
  }
  function volatility(prices, period) {
    const p = period === undefined ? 30 : period;
    const values = _clean(prices);
    if (!Number.isInteger(p) || p <= 0) return null;
    if (values.length < p + 1) return null;
    const win = values.slice(values.length - (p + 1));
    const ret = [];
    for (let i = 1; i < win.length; i++) if (win[i - 1] > 0 && win[i] > 0) ret.push(Math.log(win[i] / win[i - 1]));
    if (ret.length < 2) return null;
    const v = _sampleVariance(ret);
    return v === null ? null : Math.sqrt(v);
  }
  function annualizedVolatility(prices, period, ppy) {
    const v = volatility(prices, period);
    return v === null ? null : v * Math.sqrt(ppy === undefined ? 365 : ppy);
  }
  function maxDrawdown(prices) {
    const values = _clean(prices);
    if (values.length < 2) return null;
    let peak = values[0], worst = 0.0;
    for (let i = 0; i < values.length; i++) {
      const price = values[i];
      if (price > peak) peak = price;
      if (peak > 0) { const dd = price / peak - 1.0; if (dd < worst) worst = dd; }
    }
    return worst;
  }
  function zscore(prices, period) {
    const p = period === undefined ? 30 : period;
    const values = _clean(prices);
    const win = _window(values, p);
    if (!win) return null;
    let s = 0; for (let i = 0; i < win.length; i++) s += win[i];
    const mean = s / win.length;
    const sd = stddev(win);
    if (!sd) return null;
    return (values[values.length - 1] - mean) / sd;
  }
  /* ← inspect.cjs L472-487 */
  function calcIndicators(P) {
    const out = { rsi14: null, bollBandwidth: null, zscore30: null, annualVol: null, maxDrawdown: null, ma7: null, ma30: null, ma90: null, notes: {} };
    if (!P || P.length < 31) { out.notes.err = '价格序列 <31 点，指标一律给 null（算不出 ≠ 0）'; return out; }
    out.rsi14 = r2(rsi(P, 14));
    const b = bollinger(P, 20, 2.0);
    out.bollBandwidth = b ? r4(b.width) : null;
    out.zscore30 = r4(zscore(P, 30));
    out.annualVol = r4(annualizedVolatility(P, 30, 365));
    out.maxDrawdown = r4(maxDrawdown(P));
    out.ma7 = r2(sma(P, 7)); out.ma30 = r2(sma(P, 30)); out.ma90 = r2(sma(P, 90));
    out.notes.bollinger = '布林带宽 = (上轨−下轨)/中轨，facet 20/2.0 口径；窄带宽 = 波动压缩，是状态描述、不是买卖信号';
    return out;
  }

  /* ======================================================================
     C) 断层率序列 —— ← inspect.cjs L413-442
     ====================================================================== */
  function buildSpread(sp, bp) {
    if (!sp || !bp) return null;
    const S = {}, B = {};
    for (let i = 0; i < sp.t.length; i++) S[isoOf(sp.t[i])] = sp.v[i];
    for (let i = 0; i < bp.t.length; i++) B[isoOf(bp.t[i])] = bp.v[i];
    const dates = Object.keys(S).filter(d => B[d] != null && S[d] != null && S[d] > 0).sort();
    const rows = [];
    dates.forEach(d => {
      const s = Number(S[d]), b = Number(B[d]);
      if (!Number.isFinite(s) || !Number.isFinite(b) || s <= 0) return;
      const v = (s - b) / s;                       // ★ 小数，不是百分数
      if (!Number.isFinite(v)) return;
      rows.push({ d: d, v: v, s: s, b: b });
    });
    if (rows.length < 5) return null;
    const last = rows[rows.length - 1];
    const win = rows.filter(r => diffDays(r.d, last.d) <= 365).map(r => r.v);
    const all = win.length >= 30 ? win : rows.map(r => r.v);
    return {
      now: last.v, asOf: last.d, median365: med(all),
      p10: qtl(all, 0.10), p90: qtl(all, 0.90),
      days: rows.length, sellNow: last.s, buyNow: last.b, series: rows
    };
  }
  /* ← inspect.cjs L444-457（文本按 118 字截断，与电脑端一致） */
  function spreadVerdict(sp) {
    if (!sp || sp.now === null) return '断层率算不出（缺 sell_price 或 buy_price 日线）';
    const n = sp.now, m = sp.median365;
    const parts = [];
    if (n > TH.SPREAD_TRAP_MIN) parts.push('>15% ⇒ 按 cs-trade-system 口径属【画线】（挂低价占位压盘/假深度）：看都不看，绝不套利');
    else if (n >= TH.SPREAD_WASH_MIN) parts.push('10~15% ⇒ 属【洗盘】区间（挂单核盘、震出浮筹），可观察但别追');
    else if (n < TH.SPREAD_MARKUP_MAX) parts.push('<3% ⇒ 盘口收窄，属【拉升】特征（供给被吃薄），是三者里唯一偏正面的形态');
    else if (n >= TH.SPREAD_SUSPECT) parts.push('8~10% ⇒ 未到三条阈值，但已高于实盘 8% 警戒线，盘口偏松');
    else parts.push('3~8% ⇒ 不在三条阈值任一档，属正常偏松');
    parts.push('现 ' + (n * 100).toFixed(2) + '% vs 365 天中位 ' + (m * 100).toFixed(2) + '%（p10 ' + (sp.p10 * 100).toFixed(2) + '% / p90 ' + (sp.p90 * 100).toFixed(2) + '%）：' +
      (n > m ? '高于常态 ' + ((n - m) * 100).toFixed(2) + 'pp，盘口比平时更松/更假' : n < m ? '低于常态 ' + ((m - n) * 100).toFixed(2) + 'pp，盘口比平时更紧' : '等于常态'));
    parts.push('单位口径：小数（0.15 = 15%），与 cs-trade-system 一致');
    return parts.join('；').slice(0, 118);
  }

  /* ======================================================================
     D) 供给 / 需求 —— ← inspect.cjs L492-539
     ====================================================================== */
  function buildSupplyDemand(nSeries, bSeries, statSeries) {
    const out = {
      listed: { now: null, d7: null, d30: null, d90: null, d180: null, pctile: null, n: 0 },
      buy: { now: null, d30: null, chg30: null, d7: null, chg7: null, n: 0 },
      slope30: null, slope90: null, supplyFn: null, supplyTrend: null, verdict: ''
    };
    const toMap = s => { const m = {}; if (s) for (let i = 0; i < s.t.length; i++) m[isoOf(s.t[i])] = s.v[i]; return m; };
    const N = toMap(nSeries), B = toMap(bSeries);
    const nd = Object.keys(N).sort();
    if (nd.length) {
      const last = nd[nd.length - 1];
      const at = k => { const d = addDays(last, -k); for (let i = 0; i <= 7; i++) { const dd = addDays(d, i); if (N[dd] != null) return N[dd]; } return null; };
      out.listed.now = N[last]; out.listed.n = nd.length; out.listed.asOf = last;
      out.listed.d7 = at(7); out.listed.d30 = at(30); out.listed.d90 = at(90); out.listed.d180 = at(180);
      const all = nd.map(d => N[d]).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
      out.listed.pctile = all.length ? all.filter(x => x <= N[last]).length / all.length : null;
      out.slope30 = out.listed.d30 ? N[last] / out.listed.d30 - 1 : null;
      out.slope90 = out.listed.d90 ? N[last] / out.listed.d90 - 1 : null;
    }
    const bd = Object.keys(B).sort();
    if (bd.length) {
      const last = bd[bd.length - 1];
      const at = k => { const d = addDays(last, -k); for (let i = 0; i <= 7; i++) { const dd = addDays(d, i); if (B[dd] != null) return B[dd]; } return null; };
      out.buy.now = B[last]; out.buy.n = bd.length; out.buy.asOf = last;
      out.buy.d7 = at(7); out.buy.d30 = at(30);
      out.buy.chg30 = out.buy.d30 ? out.buy.now / out.buy.d30 - 1 : null;
      out.buy.chg7 = out.buy.d7 ? out.buy.now / out.buy.d7 - 1 : null;
    }
    if (Array.isArray(statSeries) && statSeries.length) {
      const s = statSeries.filter(x => x && Number.isFinite(Number(x.statistic)))
        .map(x => ({ d: String(x.created_at).slice(0, 10), v: Number(x.statistic) }))
        .sort((a, b) => a.d.localeCompare(b.d));
      if (s.length >= 2) {
        out.supplyFn = s[s.length - 1].v;
        out.supplyTrend = { from: s[0].d, to: s[s.length - 1].d, days: s.length, chg: s[0].v ? s[s.length - 1].v / s[0].v - 1 : null, first: s[0].v, last: s[s.length - 1].v };
      }
    }
    out.verdict = sdVerdict(out);
    return out;
  }
  function sdVerdict(sd) {
    const p = [];
    if (sd.listed.now === null) { p.push('在售量日线缺失，存量倾角算不出'); }
    else {
      p.push('悠悠在售 ' + sd.listed.now + ' 把（1 年分位 ' + (sd.listed.pctile === null ? '—' : (sd.listed.pctile * 100).toFixed(0) + '%') + '）');
      if (sd.slope30 !== null) p.push('30 天存量倾角 ' + pctS(sd.slope30) + (sd.slope30 < -0.15 ? '（跌破 MM 吸筹口径 −15%，供给在快速变薄）' : sd.slope30 < 0 ? '（供给在减少）' : '（供给在增加 → 抛压方向）'));
      if (sd.slope90 !== null) p.push('90 天 ' + pctS(sd.slope90));
    }
    if (sd.buy.now !== null) p.push('求购 ' + sd.buy.now + ' 单' + (sd.buy.chg30 !== null ? '（30 天 ' + pctS(sd.buy.chg30) + '）' : ''));
    if (sd.listed.now && sd.buy.now) { const r = sd.buy.now / sd.listed.now; p.push('求购/在售 ' + r.toFixed(3) + (r > 1 ? '（求购多于在售，偏紧）' : r > 0.3 ? '（供需均衡）' : '（买盘薄）')); }
    return p.join('；').slice(0, 148);
  }

  /* ======================================================================
     E) 评分 —— ← inspect.cjs L964-1063（★ 只用已验证有效的条件）
     ====================================================================== */
  function hasUsableVolume(gi, nowMs) {
    const v = num(gi && gi.turnover_number);
    if (!v || v <= 0) return false;
    if (!gi.period_at) return false;
    const age = Math.round(((nowMs || Date.now()) - new Date(gi.period_at).getTime()) / MS_DAY);
    return age <= 30;
  }

  function score(cn, marketYyyp, marketBuff, ctx) {
    const B = [];
    const add = (k, v, why) => B.push({ k: k, v: r2(v), why: String(why).slice(0, 58) });
    const wear = wearOf(cn);
    /* ← inspect.cjs L970：price = (item.v.yyyp && item.v.yyyp[0]) || (item.v.buff && item.v.buff[0]) || null
       注意是「真值」语义（0 会继续往后退），不是「非 null」语义 —— 照抄。 */
    const price = (marketYyyp ? Number(marketYyyp) : 0) || (marketBuff ? Number(marketBuff) : 0) || null;

    /* ① 磨损段位 30 分 */
    if (wear && TH.WEAR_FWD90[wear] !== undefined) {
      const f = TH.WEAR_FWD90[wear];
      let s = 30 * clamp((f - 0.05) / (0.2564 - 0.05), 0, 1);
      const n = TH.WEAR_N[wear];
      add('磨损段位', s, wear + '：前向 90 天最高涨幅中位 ' + (f * 100).toFixed(2) + '%（n=' + n + '）' + (n < 100 ? '，⚠️样本<100 仅参考' : ''));
      if (n < 100) { s = s * 0.5; add('小样本折半', -s, 'n=' + n + ' < 100，该档数字不可单独引用，得分减半'); }
    } else add('磨损段位', 0, '未识别磨损档（非枪皮/印花/箱子类），本项不给分');

    /* ② 单价下限 20 分 */
    if (price === null) add('单价下限', 0, '无价格');
    else if (price < TH.PRICE_JUNK) add('单价下限', 0, money(price) + ' < ¥1：振幅是假的，无法作为交易标的');
    else if (price < TH.PRICE_THIN) add('单价下限', 8, money(price) + ' 在 ¥1~3：能交易但盘口薄、¥0.01 跳动就是 1%');
    else if (price < TH.PRICE_MIN_TRADEABLE) add('单价下限', 14, money(price) + ' 在 ¥3~10：可交易，注意单笔成本占比');
    else add('单价下限', 20, money(price) + ' ≥ ¥10：价格粒度足够，交易成本可控');

    /* ③ 断层率 25 分 */
    const sp = ctx.spread;
    if (!sp || sp.now === null) add('断层率', 0, '断层率算不出（缺 sell_price/buy_price 日线）');
    else if (sp.sellNow && sp.sellNow < 1 && (sp.sellNow - sp.buyNow) <= 0.02) add('断层率', 0, '单价 ¥' + sp.sellNow + ' 过低，断层率只是分位舍入噪声（价差仅 ¥' + (sp.sellNow - sp.buyNow).toFixed(2) + '）→ 不作为盘口证据');
    else {
      let s;
      if (sp.now < TH.SPREAD_MARKUP_MAX) s = 25;
      else if (sp.now < 0.05) s = 20;
      else if (sp.now < TH.SPREAD_WASH_MIN) s = 14;
      else if (sp.now <= TH.SPREAD_WASH_MAX) s = 8;
      else s = 0;
      add('断层率', s, '现 ' + (sp.now * 100).toFixed(2) + '%' +
        (sp.now > TH.SPREAD_TRAP_MIN ? '（>15% 画线档，cs-trade-system 口径：看都不看）' : sp.now < TH.SPREAD_MARKUP_MAX ? '（<3% 拉升档）' : sp.now >= TH.SPREAD_WASH_MIN ? '（10~15% 洗盘档）' : sp.now >= TH.SPREAD_SUSPECT ? '（8~10% 高于实盘警戒线）' : '（3~8% 正常偏松）') +
        '；365 天中位 ' + (sp.median365 * 100).toFixed(2) + '%');
      if (sp.now > (sp.p90 === null ? 1 : sp.p90)) add('断层率处极端', -4, '已高于 365 天 p90（' + (sp.p90 * 100).toFixed(2) + '%），盘口异常松');
    }

    /* ④ 退出天数 10 分 */
    const exit = ctx.exitDays;
    if (exit === null || exit === undefined) add('退出天数', 0, '无可用/新鲜的成交量口径（Steam 口径已过期）→ 退出天数不可估，本项不给分');
    else if (exit <= 7) add('退出天数', 10, '清 50% 流通盘约 ' + exit.toFixed(1) + ' 天（≤7 天，退出顺畅）');
    else if (exit <= TH.EXIT_HARD_DAYS) add('退出天数', 6, '清 50% 流通盘约 ' + exit.toFixed(1) + ' 天（≤30 天）');
    else add('退出天数', 0, '清 50% 流通盘约 ' + exit.toFixed(1) + ' 天（>30 天，退出困难）');

    /* ⑤ 数据完整性 15 分 */
    const gaps = ctx.dataGaps || [];
    const info = ctx.infoNotes || [];
    const sData = clamp(15 - gaps.length * 2.5, 0, 15);
    add('数据完整性', sData, (gaps.length ? ('缺 ' + gaps.length + ' 项真数据，每缺 1 项 −2.5（' + gaps.slice(0, 3).join('；').slice(0, 28) + '…）') : '真数据齐全') +
      (info.length ? ('；另有 ' + info.length + ' 条口径说明（不扣分，见 dataNotes）') : ''));

    /* ⑥ 趋势修正 −10~0 分 */
    const ma90 = ctx.indicators && ctx.indicators.ma90;
    const p30 = ctx.price30, p7 = ctx.price7;
    if (ctx.price !== null && ctx.price !== undefined && ma90) {
      const belowMa = ctx.price < ma90;
      const bad30 = (p30 !== null && p30 !== undefined && p30 < -0.15);
      const bad7 = (p7 !== null && p7 !== undefined && p7 < -0.10);
      const nCond = (belowMa ? 1 : 0) + ((bad30 || bad7) ? 1 : 0);
      if (nCond) {
        const mag = Math.max(bad30 ? Math.abs(p30) : 0, bad7 ? Math.abs(p7) : 0);
        const full = clamp(5 + mag * 20, 5, 10);
        const ded = -r2(nCond === 2 ? full : full / 2);
        add('趋势修正', ded, (belowMa ? '现价 ' + money(ctx.price) + ' < MA90 ' + money(ma90) : '') +
          (belowMa && (bad30 || bad7) ? '，且 ' : '') +
          (bad30 ? '30 天 ' + (p30 * 100).toFixed(1) + '%' : '') + (bad30 && bad7 ? '、' : '') +
          (bad7 ? '7 天 ' + (p7 * 100).toFixed(1) + '%' : '') +
          ' → ' + (nCond === 2 ? '下行趋势确认' : '单一转弱信号') + '，扣 ' + Math.abs(ded).toFixed(1) + ' 分（机械规则，非预测）');
      } else add('趋势修正', 0, '现价 ≥ MA90 且 30 天跌幅未超 −15%、7 天未超 −10%，趋势无扣分');
    } else add('趋势修正', 0, '无 MA90 或价格，趋势修正不适用');

    /* ⑦ 供给集中度 ±3 分（只观察） */
    const conc = ctx.concentration;
    const cp = v => (v * 100).toFixed(0) + '%';
    if (conc === null || conc === undefined) add('供给集中度', 0, '在售量数据缺失，无法看集中度');
    else if (conc > 0.9) add('供给集中度', 2, '在售量处 1 年 ' + cp(conc) + ' 分位 → 盘口极厚，短期难被拉（双刃）');
    else if (conc < 0.15) add('供给集中度', 3, '在售量处 1 年 ' + cp(conc) + ' 分位 → 浮筹薄，小资金即可推动（也是坐庄前提）');
    else add('供给集中度', 0, '在售量处 1 年 ' + cp(conc) + ' 分位 → 中性。⚠️ 本项目对集中度没有做实测校准，本项只作观察');

    add('【不计分】铺货墙', 0, '随机对照组已证伪（铺货日 +27.2% vs 随机日 +27.7%），只陈列历史事实');
    add('【不计分】吸筹合成分', 0, '三轮对照全被证伪，本项目已弃用');
    add('【不计分】计分模型信号', 0, '同分数段配对对照差中位 −0.95pp、胜率 45.6%，无判别力');

    let total = 0;
    for (let i = 0; i < B.length; i++) total += B[i].v;
    total = clamp(total, 0, 100);
    const grade = total >= 78 ? 'A' : total >= 62 ? 'B' : total >= 45 ? 'C' : 'D';
    return {
      total: r2(total), breakdown: B, grade: grade, thresholds: TH.GRADE,
      note: '满分 100 = 磨损 30 + 单价 20 + 断层率 25 + 退出天数 10 + 数据完整性 15，集中度 −0~+3，趋势修正 −10~0。等级阈值 78/62/45（工程标定，非实测校准）。不含任何已被证伪的预测类条件。'
    };
  }

  /* ======================================================================
     F) 完整体检 —— 装配 series + snapshot + dataGaps，再调 score
     snapshot 字段顺序（build_inspect_data.cjs 写入）：
       0 infoFlag 1 turnover_number 2 period_at 3 pUncovered 4 pNoBuy
       5 statEmptyFlag 6 inLedger 7 marketYyyp 8 marketBuff
       9 rate7 10 rate30 11 rate90 12 rate180 13 rate365
     ====================================================================== */
  const SNAP = { INFO: 0, TU: 1, PA: 2, PU: 3, PNB: 4, ST: 5, PF: 6, YP: 7, BF: 8, R7: 9, R30: 10, R90: 11, R180: 12, R365: 13 };

  function computeItem(dataset, idx, opts) {
    opts = opts || {};
    const nowMs = opts.nowMs || Date.now();
    const row = rowOf(dataset, idx);
    const m = row.snap || [];
    const hasInfo = Number(m[SNAP.INFO]) === 1;
    /* TU = -1 表示 goods_info 里根本没有 turnover_number 这个字段（≠ null） */
    const tuUndefined = (m[SNAP.TU] === -1 || m[SNAP.TU] === '-1');
    const gi = hasInfo ? {
      turnover_number: tuUndefined ? null : m[SNAP.TU],
      period_at: m[SNAP.PA] || null,
      yyyp_sell_price: m[SNAP.YP]
    } : null;
    const ser = opts.series || seriesOf(dataset, idx);
    const spS = ser.sell_price, bpS = ser.buy_price, snS = ser.sell_num, bnS = ser.buy_num;

    const dataGaps = [];
    const P = spS ? spS.v : null;
    const priceNow = (P && P.length) ? P[P.length - 1]
      : ((m[SNAP.YP] !== null && m[SNAP.YP] !== undefined) ? Number(m[SNAP.YP]) : null);

    /* 价格块 */
    let monthly = [], pctile = null, drawdownPeak = null, priceCloses = {};
    if (P && P.length > 20) {
      const dates = spS.t.map(isoOf);
      const last = dates[dates.length - 1];
      const at = k => { const tgt = addDays(last, -k); for (let i = 0; i <= 7; i++) { const d = addDays(tgt, i); const ix = dates.indexOf(d); if (ix >= 0 && P[ix]) return P[ix]; } return null; };
      const cur = P[P.length - 1];
      ['d7', 'd30', 'd90', 'd180', 'd365'].forEach((k, i) => {
        const p0 = at([7, 30, 90, 180, 365][i]);
        priceCloses[k] = p0 ? r4(cur / p0 - 1) : null;
      });
      const sorted = P.slice().sort((a, b) => a - b);
      pctile = sorted.filter(x => x <= cur).length / sorted.length;
      const peak = sorted[sorted.length - 1];
      drawdownPeak = cur / peak - 1;
      const mo = {};
      for (let i = 0; i < P.length; i++) {
        const k = dates[i].slice(0, 7);
        if (!mo[k]) mo[k] = { f: P[i], l: P[i], mx: P[i], mn: P[i] };
        mo[k].l = P[i]; mo[k].mx = Math.max(mo[k].mx, P[i]); mo[k].mn = Math.min(mo[k].mn, P[i]);
      }
      monthly = Object.keys(mo).sort().slice(-12).map(k => ({ m: k, f: r2(mo[k].f), l: r2(mo[k].l), chg: r4(mo[k].l / mo[k].f - 1), min: r2(mo[k].mn), max: r2(mo[k].mx) }));
    } else {
      ['d7', 'd30', 'd90', 'd180', 'd365'].forEach(k => priceCloses[k] = null);
      dataGaps.push('价格日线不足 20 点（新上架 SKU 常见）→ 涨跌/分位/回撤/指标全部为 null');
    }
    priceCloses.now = priceNow === null ? null : r2(priceNow);
    priceCloses.pctile1y = r4(pctile);
    priceCloses.drawdownFromPeak = r4(drawdownPeak);
    priceCloses.monthly = monthly;

    /* 断层率 */
    const spread = buildSpread(spS, bpS);
    if (!spread) dataGaps.push('断层率历史序列算不出：' + (!spS ? 'sell_price 日线缺失' : !bpS ? 'buy_price 日线缺失（该 key 偶发瞬时失败，重跑一次通常能拿到）' : '两序列按日期对齐后有效点 <5'));
    else if (spread.days < 300) dataGaps.push('断层率序列只有 ' + spread.days + ' 天（<300），中位/p10/p90 代表性偏弱');
    if (spread && spread.now !== null && spread.sellNow && spread.sellNow < 1 && (spread.sellNow - spread.buyNow) <= 0.02) {
      dataGaps.push('⚠️ 断层率失真：卖一 ¥' + spread.sellNow + ' / 买一 ¥' + spread.buyNow + '，绝对价差仅 ¥' +
        (spread.sellNow - spread.buyNow).toFixed(2) + '（≤¥0.02），断层率 ' + (spread.now * 100).toFixed(2) + '% 只是四舍五入噪声 —— 该品单价过低，盘口指标不可用');
    }

    /* 指标 */
    const indicators = calcIndicators(P);
    if (!P || P.length < 31) dataGaps.push('价格序列 <31 点 → RSI/布林/Z值/年化波动/最大回撤 全 null（指标"算不出"≠0）');

    /* 供需 */
    const supplyDemand = buildSupplyDemand(snS, bnS, null);
    if (!snS) dataGaps.push('在售量日线缺失 → 存量倾角/分位/退出天数不可算');
    if (!bnS) dataGaps.push('求购量日线缺失');

    /* 口径差异（不扣分） */
    const dataNotes = [];
    const csqaqRate = {
      d7: num(m[SNAP.R7]) === null ? null : r4(num(m[SNAP.R7])),
      d30: num(m[SNAP.R30]) === null ? null : r4(num(m[SNAP.R30])),
      d90: num(m[SNAP.R90]) === null ? null : r4(num(m[SNAP.R90])),
      d180: num(m[SNAP.R180]) === null ? null : r4(num(m[SNAP.R180])),
      d365: num(m[SNAP.R365]) === null ? null : r4(num(m[SNAP.R365]))
    };
    [['d7', 7], ['d30', 30], ['d90', 90], ['d180', 180], ['d365', 365]].forEach(function (p) {
      const a = priceCloses[p[0]], b = csqaqRate[p[0]];
      if (a !== null && b !== null && Math.abs(a - b) > 0.03) {
        dataNotes.push('口径差异：' + p[0] + ' 自算（按日期回找最近交易日）' + pctS(a) + ' vs csqaq 自报 ' + pctS(b) + '，差 ' + Math.abs((a - b) * 100).toFixed(1) + 'pp —— 平台基准日不同，以 csqaq 字段为准时需注明');
      }
    });

    /* 快照缺失：整段标出来，绝不假装知道 */
    if (!hasInfo) {
      dataGaps.push('本页没有该品的 csqaq info/good 截面快照（成交量/平台覆盖/存世量日线三项无法判定）→ 退出天数与数据完整性按「不可用」计');
    } else {
      if (Number(m[SNAP.ST]) === 1) dataGaps.push('存世量日线（/info/good/statistic）为空 → 供给增速不可算');
      if (m[SNAP.PA]) {
        const stale = Math.round((nowMs - new Date(m[SNAP.PA]).getTime()) / MS_DAY);
        if (stale > 30) dataGaps.push('goods_info.turnover_number 的 period_at 落后 ' + stale + ' 天 → 成交量口径过期，仅当数量级参考');
      } else if (!tuUndefined) {
        dataGaps.push('goods_info.turnover_number 存在但无 period_at 时效标识 → 不采用');
      }
      if (!hasUsableVolume(gi, nowMs)) {
        dataGaps.push('成交量（goods_info.turnover_number = ' + JSON.stringify(m[SNAP.TU]) + '，period_at = ' + (m[SNAP.PA] || '无') + '）不可用 → 退出天数不可算。chart 的 turnover_number/volume/deal_num 实测全部 404，成交量无时序');
      }
      const pu = Number(m[SNAP.PU] || 0), pnb = Number(m[SNAP.PNB] || 0);
      if (pu > 0) dataGaps.push('7 平台里只有 ' + (7 - pu) + ' 个有卖一；缺的：见平台覆盖（csqaq 无该平台 ID 或该平台无挂单）');
      if (pnb > 0) dataGaps.push('有 ' + pnb + ' 个平台有卖一但无买一（断层率不可算）');
    }

    /* 退出天数（口径新鲜才进评分） */
    let exitDays = null, exitBasis = null;
    const dailyVol = gi ? num(gi.turnover_number) : null;
    const listedNow = supplyDemand.listed.now;
    const volOk = gi ? hasUsableVolume(gi, nowMs) : false;
    if (volOk && listedNow) {
      exitDays = (listedNow * 0.5) / dailyVol;
      exitBasis = '悠悠在售×50% ÷ Steam 日成交量 ' + dailyVol + '（口径新鲜）';
    } else if (dailyVol > 0 && listedNow) {
      exitDays = (listedNow * 0.5) / dailyVol;
      exitBasis = '悠悠在售×50% ÷ Steam 日成交量 ' + dailyVol + '（⚠️ 口径过期 ' + Math.round((nowMs - new Date(m[SNAP.PA]).getTime()) / MS_DAY) + ' 天，仅数量级）';
    }
    const exitForScore = volOk ? exitDays : null;

    /* 台账位置：inspect.cjs 在**算完分之后**才 push 这一条（L1431），
       所以它会出现在 dataGaps 列表里、但**不参与**「数据完整性」扣分。
       这里必须分两份，否则分数会凭空低 2.5 分。 */
    const gapsForScore = dataGaps.slice();
    const inLedger = Number(m[SNAP.PF]) === 1;
    if (!inLedger) dataGaps.push('该品不在 data/my-portfolio-app.json 的 44 个持仓里 → position = null');

    const ctx = {
      spread: spread, exitDays: exitForScore, dataGaps: gapsForScore, infoNotes: dataNotes,
      concentration: supplyDemand.listed.pctile, price: priceNow,
      indicators: indicators, price30: priceCloses.d30, price7: priceCloses.d7
    };
    const sc = score(row.cn, m[SNAP.YP], m[SNAP.BF], ctx);

    return {
      gid: row.gid, name: row.cn, hash: row.hash,
      seriesAsOf: spS && spS.t.length ? isoOf(spS.t[spS.t.length - 1]) : null,
      spread: spread, spreadVerdict: spreadVerdict(spread),
      price: priceCloses, priceNow: priceNow, pctile1y: priceCloses.pctile1y, drawdownFromPeak: priceCloses.drawdownFromPeak,
      indicators: indicators, supplyDemand: supplyDemand, dataGaps: dataGaps, dataNotes: dataNotes,
      exitDays: exitDays, exitBasis: exitBasis, exitForScore: exitForScore,
      score: sc, hasInfoSnapshot: hasInfo
    };
  }

  /* ======================================================================
     G) 搜索：中文名 / 英文名 / gid，实时过滤（800 条，纯内存）
     ====================================================================== */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '')
      .replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[|｜]/g, '|').replace(/[·・]/g, '');
  }
  function normLoose(s) { return norm(s).replace(/[()（）\s\-_★*]/g, ''); }

  function search(dataset, q, limit) {
    const n = dataset.g.length;
    const query = String(q || '').trim();
    const out = [];
    if (!query) {
      for (let i = 0; i < n && out.length < (limit || 30); i++) out.push(i);
      return out;
    }
    if (/^\d+$/.test(query)) {
      for (let i = 0; i < n; i++) if (String(dataset.g[i]) === query) { out.push(i); break; }
      if (out.length) return out;
    }
    const nq = norm(query), nl = normLoose(query);
    /* 一轮：前缀 / 完全相等 */
    for (let i = 0; i < n && out.length < (limit || 30); i++) {
      const a = norm(dataset.n[i]), b = norm(dataset.h[i]);
      if (a.indexOf(nq) === 0 || b.indexOf(nq) === 0 || normLoose(dataset.n[i]) === nl) out.push(i);
    }
    /* 二轮：包含 */
    for (let i = 0; i < n && out.length < (limit || 30); i++) {
      if (out.indexOf(i) >= 0) continue;
      if (norm(dataset.n[i]).indexOf(nq) >= 0 || norm(dataset.h[i]).indexOf(nq) >= 0) out.push(i);
    }
    return out;
  }

  return {
    V: V, TH: TH, PLATFORMS: PLATFORMS, SNAP: SNAP, MS_DAY: MS_DAY,
    /* 数值工具（页面格式化用，与手机端一致） */
    num: num, r2: r2, r4: r4, med: med, qtl: qtl, isoOf: isoOf, addDays: addDays, diffDays: diffDays,
    money: money, pctS: pctS, wearOf: wearOf, norm: norm, normLoose: normLoose,
    /* 计算 */
    decodeSeg: decodeSeg, seriesOf: seriesOf, rowOf: rowOf,
    sma: sma, stddev: stddev, rsi: rsi, bollinger: bollinger, volatility: volatility,
    annualizedVolatility: annualizedVolatility, maxDrawdown: maxDrawdown, zscore: zscore,
    calcIndicators: calcIndicators, buildSpread: buildSpread, spreadVerdict: spreadVerdict,
    buildSupplyDemand: buildSupplyDemand, sdVerdict: sdVerdict, hasUsableVolume: hasUsableVolume,
    score: score, computeItem: computeItem, search: search
  };
});
