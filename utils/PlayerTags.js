/**
 * 牌风标签（Player Tags）—— 规则牌风部分
 *
 * 「牌风」在本插件与 THsBot 中都涵盖两类标签，二者同为牌风、只是来源不同：
 *   1) PCA 聚类牌风（见 PlayStyle.js）：门清防守型 / 先手押型 / 均衡型 … 6 选 1；
 *   2) 规则牌风（本文件）：按阈值直接判定的倾向 / 强度 / 特征标签。
 * THsBot 亦将两者统称「牌风」—— 作者在 Koishi 论坛被问及「牌风 tag 的判定依据」时，
 * 给出的正是规则牌风这一套阈值逻辑。
 *
 * 阈值来源（**有 THsBot 原逻辑就直接沿用，它没有的才拟合**）：
 *
 * 1) 四麻 —— **原样沿用 THsBot 作者 sjn4048 在 Koishi 论坛公开的那套值**
 *    （topic 9963 第 8 楼，2025-04-19）：
 *      naki > 0.36 / < 0.28、hora > 0.235、dealin < 0.12 / > 0.14、riichi > 0.22、
 *      rank1 > 0.35、rankLast > 0.30、winpt > 7100 / < 6000、
 *      beizha > 0.125、libao > 0.37、dama > 0.15
 *
 * 2) 三麻 —— THsBot **只公布了上面那一套，没有三麻版本**；直接套用会崩
 *    （实测本插件样本：hora > 0.235 触发 100%、winpt > 7100 触发 100%）。
 *    故按「与四麻触发率一致」在本插件样本上反解，使两模式稀有度可比。
 *
 * 3) 绝好调 / 恶调中 —— 这两个是**状态**词（「当前手气」），THsBot 的 0.35 / 0.30
 *    必须配**近期窗口**才有意义：实测全生涯 1 位率 p95 仅 0.29，用 0.35 卡是死标签（0% 触发）；
 *    改用最近 RANK_WINDOW 场后 0.35 才落在合理尾部。故本插件按近期顺位率判定。
 *    但**阈值不沿用 THsBot 原值**：实测 0.35/0.30 给出绝好调 6.0% / 恶调中 39.0%，
 *    严重失衡（39% 正是「恶调中」被诟病过多的原因），故改为按两标签稀有度对称定阈值。
 *
 * 标定样本（本插件自行采集，非 THsBot 的）：**四麻 n=500 / 三麻 n=500**，均为 ≥150 场玩家，
 * 窗口 20 场（近期顺位率取自 player_records 逐局顺位，与走势图同一套判定）。
 *
 * 标签分三类：
 *   1. 倾向（style）：互斥，只出一个，描述打法取向，无优劣
 *   2. 强度（power）：可叠加，描述相对同段的强弱
 *   3. 特征（meme）：可叠加，稀有/玩梗向，带传播性
 */

/**
 * 绝好调 / 恶调中 的判定窗口上限（场）。
 * 取 20 场：THsBot 的 0.35 / 0.30 恰为 7/20 与 6/20（即它的窗口就是 20 场）。
 * 窗口过短噪声大，过长则被生涯均值抹平（生涯 1 位率 p95 仅 0.29，任何尾部阈值都卡不住）。
 *
 * ⚠️ 这是**上限**而非硬性要求：近期对局不足 20 场时用实际可得场次
 * （下限见 MIN_RANK_WINDOW），否则 10~19 场的玩家这两个标签永远不出，
 * 会把 MIN_GAMES_FOR_TAGS(10) 的牌风门槛架空。
 */
export const RANK_WINDOW = 20

/**
 * 绝好调 / 恶调中 的判定窗口下限（场），与牌风总门槛 MIN_GAMES_FOR_TAGS 一致。
 * 少于 10 场时顺位率方差过大 —— 1 场一位就是 100%，会人人「绝好调」。
 */
export const MIN_RANK_WINDOW = 10

// 阈值来源：四麻沿用 THsBot 原值（顺位两项除外，见下）；三麻按「与四麻触发率一致」拟合（n=500/500）；
// rank1Hi/rankLastHi 为「最近 RANK_WINDOW 场」口径（其余字段仍为生涯口径）。
const THRESHOLDS = {
  4: {
    nakiHi: 0.36, nakiLo: 0.28,
    horaHi: 0.235,
    dealinLo: 0.12, dealinHi: 0.14,
    riichiHi: 0.22,
    winptHi: 7100, winptLo: 6000,
    damaHi: 0.15,
    libaoHi: 0.37,
    beizhaHi: 0.125,
    // 绝好调 / 恶调中 的基准门槛（满 RANK_WINDOW=20 场口径）。
    // ⚠️ 这两个值按**实测触发率**标定，不是沿用 THsBot，也不是理论推算：
    //    实测 2000 名真实玩家（满 20 场者 1082 人）各门槛触发率——
    //      一位 ≥7/20 → 21.4%    ≥8/20 → 11.1%    ≥9/20 → 4.2%
    //      末位 ≥7/20 → 28.9%    ≥8/20 → 14.8%    ≥9/20 → 7.1%
    //    取 ≥8/20（0.35）：两标签触发率 11.1% / 14.8%，稀有度相当。
    //    （注：玩家一位次数均值 4.81、末位 5.34，均低于理论值 5 —— 整体比随机好，
    //      故门槛需比理论值更严才能达到同等稀有度。）
    rank1Hi: 0.35,
    rankLastHi: 0.35,
    // 净打点效率 p90（THsBot 的 point_ev>200 口径不同：实测触发 99.2%，人人都有）
    neteffHi: 778
  },
  3: {
    nakiHi: 0.3297, nakiLo: 0.2571,
    horaHi: 0.3124,
    dealinLo: 0.1436, dealinHi: 0.1727,
    riichiHi: 0.3121,
    winptHi: 10214, winptLo: 8819,
    damaHi: 0.2004,
    libaoHi: 0.471,
    beizhaHi: 0.1763,
    // 三麻无 THsBot 原值（其只公布一套四麻值）→ 同样按**实测触发率**标定。
    //    实测 2000 名真实玩家（满 20 场者 1090 人）各门槛触发率——
    //      一位 ≥9/20 → 19.3%    ≥10/20 → 10.8%    ≥11/20 → 5.6%
    //      末位 ≥9/20 → 23.5%    ≥10/20 → 12.8%    ≥11/20 → 6.5%
    //    取 ≥10/20（0.45）：两标签触发率 10.8% / 12.8%，与四麻同档（约 11~15%）。
    rank1Hi: 0.45,
    rankLastHi: 0.45,
    neteffHi: 1395
  }
}

// 样本量低于此值时不出结论（统计上不可靠）
export const MIN_GAMES_FOR_TAGS = 10

// 标签配色：按类别区分
//   stable   ：安定段位（StableRank.js），牌谱屋公开算法
//   playstyle：牌风聚类结果（PlayStyle.js），本插件自行拟合
const TAG_STYLE = {
  stable: { bg: 'rgba(38,132,110,0.95)', fg: '#e6fff7' },
  playstyle: { bg: 'rgba(52,104,168,0.95)', fg: '#eaf3ff' },
  style: { bg: 'rgba(96,110,140,0.92)', fg: '#e8edf7' },
  power: { bg: 'rgba(184,142,54,0.92)', fg: '#fff6e0' },
  meme: { bg: 'rgba(146,88,132,0.92)', fg: '#fbe9f5' }
}

/**
 * 判断字段是否可用于判定（0 / undefined / NaN 视为无数据）
 * 本地兜底路径只填 和牌率/自摸率/放铳率，副露率/立直率等为 0，必须跳过对应标签
 */
function usable (v) {
  return typeof v === 'number' && isFinite(v) && v > 0
}

/**
 * 二项分布上尾概率 P(X ≥ k)，n 次试验、单次概率 p。
 * n ≤ 20，直接用精确公式，无需数值近似。
 */
function binomTail (n, k, p) {
  let s = 0
  for (let i = k; i <= n; i++) {
    let c = 1
    for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1)
    s += c * Math.pow(p, i) * Math.pow(1 - p, n - i)
  }
  return s
}

/**
 * 在窗口 n 下求「尾概率最接近 target 的命中次数门槛 k」。
 *
 * 为什么要这样做：判定只能用**整数**命中次数（n 场里 k 次一位），而阈值若写成固定
 * **比率**，可达值就只有 k/n 这些离散档位，窗口一变门槛就跳档。实测（2000 名真实玩家）
 * 固定比率 0.30 在 n=12 时落到 ≥4/12=33.3%（尾概率 35%）、n=20 时落到 ≥7/20=35.0%
 * （尾概率 21%）—— 同一名玩家近期打 12 场比打 20 场更容易拿「绝好调」，且实测触发率
 * 从 39.4% 跳到 21.5%，差近一倍。
 *
 * 故改为：先按满窗口（n=20）的比率定出**基准尾概率**，再对实际窗口长度取尾概率最接近
 * 的整数门槛。这样「绝好调 / 恶调中」的稀有度不随可得场次变化。
 *
 * @param {number} n 实际窗口场数
 * @param {number} p 单顺位概率（四麻 1/4、三麻 1/3）
 * @param {number} target 目标尾概率
 * @returns {number} 命中次数门槛 k（达到即触发）
 */
function alignedMinCount (n, p, target) {
  let best = 1, bestD = Infinity
  for (let k = 1; k <= n; k++) {
    const d = Math.abs(binomTail(n, k, p) - target)
    if (d < bestD) { bestD = d; best = k }
  }
  return best
}

/**
 * 取最近 window 场（上限）的顺位统计，供「绝好调 / 恶调中」判定。
 *
 * `recentRanks` 为顺位序列（新→旧，元素形如 `{ rank }`，rank 从 1 起），
 * 由 render.js 的 extractRecentRanks 从对局记录（本地优先，牌谱屋回退）提取。
 *
 * 窗口是**上限**：不足 window 场时按实际可得场次计算，只要不少于 MIN_RANK_WINDOW。
 * 此前硬性要求满 window 场，导致 10~19 场的玩家「绝好调/恶调中」永远不出，
 * 把 MIN_GAMES_FOR_TAGS(10) 的牌风门槛架空了。
 *
 * @param {Array<{rank:number}>|null} recentRanks
 * @param {number} window 窗口上限场数
 * @param {number} mode 4 或 3（决定末位是第 4 还是第 3）
 * @returns {{n:number, c1:number, cl:number, k1:number, kl:number}|null}
 *          n 为实际场数；c1/cl 为窗口内一位/末位次数；k1/kl 为对应门槛
 */
function recentRanksWindow (recentRanks, window, mode) {
  if (!Array.isArray(recentRanks)) return null
  const last = mode === 3 ? 3 : 4
  const ranks = []
  for (const g of recentRanks) {
    const r = g && g.rank
    if (typeof r === 'number' && r >= 1 && r <= last) ranks.push(r)
    if (ranks.length >= window) break
  }
  if (ranks.length < MIN_RANK_WINDOW) return null

  const n = ranks.length
  let c1 = 0, cl = 0
  for (const r of ranks) {
    if (r === 1) c1++
    else if (r === last) cl++
  }

  const p = mode === 3 ? 1 / 3 : 1 / 4
  const T = THRESHOLDS[mode]
  // 基准：按满窗口的比率算出整数门槛，取其尾概率作为目标稀有度
  const baseK1 = Math.floor(RANK_WINDOW * T.rank1Hi) + 1
  const baseKl = Math.floor(RANK_WINDOW * T.rankLastHi) + 1
  return {
    n, c1, cl,
    k1: alignedMinCount(n, p, binomTail(RANK_WINDOW, baseK1, p)),
    kl: alignedMinCount(n, p, binomTail(RANK_WINDOW, baseKl, p))
  }
}

/**
 * 计算玩家牌风标签
 * @param {object} data     牌谱屋 player_stats（需 rank_rates / count）
 * @param {object} extended 牌谱屋 player_extended_stats（中文键）
 * @param {number|string} mode 4 或 3
 * @param {Array<{rank:number}>|null} recentRanks 最近若干场的顺位序列（新→旧），
 *        用于「绝好调 / 恶调中」。缺省或不足 MIN_RANK_WINDOW(10) 场时这两个标签不出。
 * @returns {{tags: Array<{text:string,type:string}>, reliable:boolean}}
 */
export function buildPlayerTags (data, extended, mode, recentRanks = null) {
  const m = String(mode) === '3' ? 3 : 4
  const T = THRESHOLDS[m]
  const tags = []

  const count = data?.count || 0
  const reliable = count >= MIN_GAMES_FOR_TAGS

  const hora = extended?.['和牌率']
  const dealin = extended?.['放铳率']
  const naki = extended?.['副露率']
  const riichi = extended?.['立直率']
  const winpt = extended?.['平均打点']
  const dama = extended?.['默听率']
  const libao = extended?.['里宝率']
  const beizha = extended?.['被炸率']
  const neteff = extended?.['净打点效率']

  // 绝好调 / 恶调中：用**最近 RANK_WINDOW 场**（上限）的顺位，不用生涯顺位率。
  // 这两个标签是状态词（「当前手气」）；生涯均值会被长期平均掉，
  // 实测全生涯 1 位率 p95 仅 0.29，套 THsBot 的 0.35 恒不触发。
  // 不足 20 场时按实际可得场次算（下限 MIN_RANK_WINDOW=10，与牌风总门槛一致），
  // 且门槛按尾概率对齐到整数命中次数，避免稀有度随窗口长度跳档（见 alignedMinCount）。
  const win = recentRanksWindow(recentRanks, RANK_WINDOW, m)

  const push = (text, type) => tags.push({ text, type })

  // ---- 1. 倾向（互斥，只出一个）：以副露率为主轴 ----
  // 注：副露率与和牌率强正相关（实测 r≈0.66 四麻 / 0.67 三麻），门清人群的和牌率
  // 系统性低于全体 1.4~1.7pp。因此「门清 + 高和牌」的组合在统计上几乎不存在
  // （实测触发率 0~1.7%），不能作为倾向分支，否则是死标签。
  // 门清分支改用「立直率」区分：门清人群里立直率高的才是进攻型。
  if (usable(naki)) {
    if (naki > T.nakiHi) {
      push(usable(dealin) && dealin < T.dealinLo ? '副露防守' : '副露流', 'style')
    } else if (naki < T.nakiLo) {
      if (usable(dealin) && dealin < T.dealinLo) push('门清防守', 'style')
      else if (usable(riichi) && riichi > T.riichiHi) push('门清立直', 'style')
      else push('门清流', 'style')
    } else {
      // 注意：此处不可叫「中庸」。THsBot 的牌风聚类里有一个「中庸后手反击型」，
      // 那是 PCA 降维聚类的簇名（其算法与参数均未公开）；本标签只是「副露率落在中间带」，
      // 两者含义毫无关系，同名会让人误以为等价，故用「均衡」区分。
      push('均衡', 'style')
    }
  }

  // ---- 2. 强度（可叠加）----
  if (usable(hora) && hora > T.horaHi) push('进攻大师', 'power')
  if (usable(dealin)) {
    if (dealin < T.dealinLo) push('防守大师', 'power')
    else if (dealin > T.dealinHi) push('狂战士', 'power')
  }
  if (usable(riichi) && riichi > T.riichiHi) push('立直超人', 'power')
  if (usable(winpt)) {
    if (winpt > T.winptHi) push('打点重视', 'power')
    else if (winpt < T.winptLo) push('臭水重视', 'power')
  }

  // ---- 3. 特征 / 玩梗（可叠加）----
  if (usable(libao) && libao > T.libaoHi) push('里宝仙人', 'meme')
  if (usable(beizha) && beizha > T.beizhaHi) push('被炸仙人', 'meme')
  if (usable(dama) && dama > T.damaHi) push('dama怪', 'meme')
  if (usable(neteff) && neteff > T.neteffHi) push('局收支重视', 'meme')
  // 绝好调 / 恶调中：基于最近 RANK_WINDOW 场（上限）的顺位命中次数（见上）。两者互斥 ——
  // 「绝好调」优先；同时满足时只出前者（THsBot 用两个独立 if 可同时出，
  // 但实测三麻有 21% 的玩家会同时命中两者，同屏显示自相矛盾，故取互斥）。
  if (win) {
    if (win.c1 >= win.k1) push('绝好调', 'meme')
    else if (win.cl >= win.kl) push('恶调中', 'meme')
  }

  return { tags, reliable, count }
}

/**
 * 在 canvas 上横向排布标签，返回实际占用高度
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{text:string,type:string}>} tags
 * @param {object} opts { x, y, maxWidth, height, fontSize, gap, padX, align }
 * @returns {number} 占用的总高度（换行则累加）
 */
export function drawTags (ctx, tags, opts = {}) {
  const {
    x = 0, y = 0, maxWidth = 1000,
    height = 30, fontSize = 15, gap = 8, padX = 12,
    align = 'center', maxLines = Infinity,
    minFontSize = null, shrinkSteps = 0,
    centerInHeight = null
  } = opts
  if (!tags || tags.length === 0) return 0

  // 字号自适应：标签多到放不下时，先逐步缩小字号（最多 shrinkSteps 次，
  // 不低于 minFontSize），仍放不下才用 +N 折叠。避免"字号固定 + 直接折叠"
  // 导致常用场景下文字过小或信息被截断。
  //
  // ⚠️ 判定必须按**折行后**的行数，不能按单行总宽：
  // 允许 maxLines>1 时（如详情卡牌风带 2 行），单行总宽永远超限，
  // 若按单行判断会一路缩到最小字号，白浪费第二行空间、字变得很小。
  const sizes = [fontSize]
  if (shrinkSteps > 0) {
    const floor = minFontSize || Math.max(11, fontSize - 6)
    const step = Math.max(1, Math.round((fontSize - floor) / shrinkSteps))
    for (let s = fontSize - step; s >= floor; s -= step) sizes.push(s)
  }

  const measure = (size, list) => {
    ctx.font = `bold ${size}px "Microsoft YaHei", sans-serif`
    const items = list.map(t => ({ ...t, w: Math.ceil(ctx.measureText(t.text).width) + padX * 2 }))
    return { items }
  }

  // 按 maxWidth 折行
  const wrap = (items) => {
    const lines = []
    let line = [], lineW = 0
    for (const t of items) {
      const add = line.length === 0 ? t.w : t.w + gap
      if (lineW + add > maxWidth && line.length > 0) {
        lines.push({ items: line, w: lineW })
        line = [t]; lineW = t.w
      } else {
        line.push(t); lineW += add
      }
    }
    if (line.length) lines.push({ items: line, w: lineW })
    return lines
  }

  // 选第一个「折行数 ≤ maxLines」的字号（sizes 由大到小）
  let lines = null
  let usedSize = fontSize
  for (const size of sizes) {
    const m = measure(size, tags)
    lines = wrap(m.items)
    usedSize = size
    if (lines.length <= maxLines) break
  }

  // 超出 maxLines 时，最后一行末尾改为「+N」提示（避免静默丢标签）
  let shown = lines
  if (lines.length > maxLines) {
    shown = lines.slice(0, maxLines)
    const hidden = lines.slice(maxLines).reduce((s, l) => s + l.items.length, 0)
    const last = shown[shown.length - 1]
    const more = { text: `+${hidden}`, type: 'style', w: 0 }
    ctx.font = `bold ${usedSize}px "Microsoft YaHei", sans-serif`
    more.w = Math.ceil(ctx.measureText(more.text).width) + padX * 2
    // 从末行末尾移除若干标签，腾出「+N」的位置
    let hiddenCount = hidden
    while (last.items.length > 0) {
      const w = last.items.reduce((s, t, i) => s + t.w + (i ? gap : 0), 0)
      if (w + gap + more.w <= maxWidth) break
      last.items.pop()
      hiddenCount += 1
      more.text = `+${hiddenCount}`
      more.w = Math.ceil(ctx.measureText(more.text).width) + padX * 2
    }
    last.items.push(more)
    last.w = last.items.reduce((s, t, i) => s + t.w + (i ? gap : 0), 0)
  }

  const lineH = height + gap
  // 垂直居中：把「n 行」整体在 centerInHeight 高度内上下居中
  // （n 行视觉高 = (n-1)*lineH + height；1 行时即 height）
  let startY = y
  if (centerInHeight != null && shown.length > 0) {
    const visualH = (shown.length - 1) * lineH + height
    startY = y + Math.max(0, (centerInHeight - visualH) / 2)
  }
  let cy = startY
  for (const ln of shown) {
    let cx = align === 'center' ? x + (maxWidth - ln.w) / 2 : x
    for (const t of ln.items) {
      const st = TAG_STYLE[t.type] || TAG_STYLE.style
      const r = height / 2
      ctx.beginPath()
      ctx.moveTo(cx + r, cy)
      ctx.arcTo(cx + t.w, cy, cx + t.w, cy + height, r)
      ctx.arcTo(cx + t.w, cy + height, cx, cy + height, r)
      ctx.arcTo(cx, cy + height, cx, cy, r)
      ctx.arcTo(cx, cy, cx + t.w, cy, r)
      ctx.closePath()
      ctx.fillStyle = st.bg
      ctx.fill()

      ctx.font = `bold ${usedSize}px "Microsoft YaHei", sans-serif`
      ctx.fillStyle = st.fg
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(t.text, cx + t.w / 2, cy + height / 2)
      cx += t.w + gap
    }
    cy += lineH
  }
  return shown.length * lineH
}
