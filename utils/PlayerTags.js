/**
 * 牌风标签（Player Tags）—— 规则牌风部分
 *
 * 「牌风」在本插件与 THsBot 中都涵盖两类标签，二者同为牌风、只是来源不同：
 *   1) PCA 聚类牌风（见 PlayStyle.js）：门清防守型 / 先手押型 / 均衡型 … 6 选 1；
 *   2) 规则牌风（本文件）：按阈值直接判定的倾向 / 强度 / 特征标签。
 * THsBot 亦将两者统称「牌风」—— 作者在 Koishi 论坛被问及「牌风 tag 的判定依据」时，
 * 给出的正是规则牌风这一套阈值逻辑。
 *
 * 设计参考 THsBot 的 tag 思路（作者 sjn4048 在 Koishi 论坛公开），但**阈值全部按本插件
 * 实测玩家分布重新标定**，不能直接沿用其原始阈值：
 *   - 其 里宝率 > 0.37 / 被炸率 > 0.125 在四麻玉之间几乎永不触发（实测 p95 仅 33.7% / 11.1%）
 *   - 其 和牌率 > 0.235 / 立直率 > 0.22 在三麻则几乎必然触发（三麻 p50 已达 31.2% / 25.9%）
 * 因此四麻、三麻各用一套独立阈值，均取自真实样本分位数（四麻 n=60、三麻 n=25，均 ≥150 场）。
 *
 * 标签分三类：
 *   1. 倾向（style）：互斥，只出一个，描述打法取向，无优劣
 *   2. 强度（power）：可叠加，描述相对同段的强弱
 *   3. 特征（meme）：可叠加，稀有/玩梗向，带传播性
 */

// 阈值来源：四麻 60 人 / 三麻 25 人真实样本分位数（见开发时标定脚本输出）
// hi 取 p85 附近，lo 取 p15 附近；nakiHi/nakiLo 取 p75/p25
const THRESHOLDS = {
  4: {
    nakiHi: 0.36, nakiLo: 0.28,
    horaHi: 0.24,
    dealinLo: 0.121, dealinHi: 0.155,
    riichiHi: 0.215,
    winptHi: 6900, winptLo: 6150,
    damaHi: 0.155,
    libaoHi: 0.335,
    beizhaHi: 0.109,
    rank1Hi: 0.27,
    rankLastHi: 0.255,
    neteffHi: 780
  },
  3: {
    nakiHi: 0.335, nakiLo: 0.285,
    horaHi: 0.32,
    dealinLo: 0.16, dealinHi: 0.185,
    riichiHi: 0.305,
    winptHi: 9700, winptLo: 8900,
    damaHi: 0.21,
    libaoHi: 0.425,
    beizhaHi: 0.144,
    rank1Hi: 0.36,
    rankLastHi: 0.335,
    neteffHi: 1420
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
 * 计算玩家牌风标签
 * @param {object} data     牌谱屋 player_stats（需 rank_rates / count）
 * @param {object} extended 牌谱屋 player_extended_stats（中文键）
 * @param {number|string} mode 4 或 3
 * @returns {{tags: Array<{text:string,type:string}>, reliable:boolean}}
 */
export function buildPlayerTags (data, extended, mode) {
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

  const rates = Array.isArray(data?.rank_rates) ? data.rank_rates : []
  const rank1 = rates[0]
  const rankLast = rates.length >= (m === 3 ? 3 : 4) ? rates[m === 3 ? 2 : 3] : undefined

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
  if (typeof rank1 === 'number' && rank1 > T.rank1Hi) push('绝好调', 'meme')
  else if (typeof rankLast === 'number' && rankLast > T.rankLastHi) push('恶调中', 'meme')

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
