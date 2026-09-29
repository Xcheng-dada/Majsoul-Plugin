/**
 * 安定段位（Stable Rank）
 *
 * 与「牌风聚类」性质不同：本算法**公开可推导**——完整实现就在雀魂牌谱屋（amae-koromo）
 * 的前端 bundle 里（estimateStableLevel2 / estimateStableLevel / calculateRankDeltaPoints），
 * 并非服务端私有逻辑，故此处为忠实复现。
 *
 * 单局 PT 变动公式（已用 1042 条真实牌谱 gradingScore 校验，精确吻合、误差 0.00）：
 *   PT_i = levelpoint[i] + ceil((平均点数_i − init_point)/1000 + 顺位马[i]) + 4位罚分
 * 其中 levelpoint/buchang/init_point 取自 config/data.json 的 desktop.matchmode，
 * 4位罚分取 level_definition 的 rankpt1（东场）/ rankpt2（南场）。
 *
 * 安定段位闭式解（仅四麻「玉南=12」「王南=16」，与牌谱屋判定一致）：
 *   E[PT] = Σ PT_i × 顺位率_i        （不计 4 位罚分）
 *   value = E[PT] / (15 × 4位率) − 10
 *   value ≥ 4 → 雀圣(value−3)；否则 → 雀豪(value)
 *   即 1.00~3.00 为雀豪一~三星，4.00~6.00 为雀圣一~三星，正好对应玉之间的段位区间。
 *
 * 越界时（value 超出该房间可表达区间）回退到逐级试探 estimateStableLevel，
 * 与牌谱屋行为一致——闭式解只是玉/王座房间的快速路径，逐级试探才是通用解法。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let _cfg = null
function loadCfg () {
  if (!_cfg) _cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'data.json'), 'utf8'))
  return _cfg
}

// 闭式解适用房间：仅四麻/三麻的「玉南 / 王南」。
// 金之间不在牌谱屋 estimateStableLevel2 的白名单里（其判定为房间 ∈ {玉, 王座}），
// 走通用逐级试探 estimateStableLevel —— 同样能得出安定段位，只是格式带 +/- 后缀。
const CLOSED_FORM_ROOMS = new Set([12, 16, 24, 26])

// 各房间允许的段位 major。
// 依据用户给出的房间准入区间（已与 matchmode 的 level_limit/level_limit_ceil 核对）：
//   铜之间  初心一星 ~ 雀士三星
//   银之间  雀士一星 ~ 雀杰三星
//   金之间  雀杰一星 ~ 雀豪三星
//   玉之间  雀豪一星 ~ 雀圣三星
//   王座间  雀圣一星 ~ 魂天
//
// ⚠️ 初心段位 rankpt1=rankpt2=0 且 can_degrade=0 —— 无掉段罚分，
// value=|P|/15−10 会得到 −10，安定段位**数学上无定义**，
// 故初心玩家必定返回 null（显示「—」），这是规则限制而非数据不足。
const ALLOWED_MAJORS = {
  2: [1, 2], 3: [1, 2],            // 铜之间（东/南）    → 初心、雀士
  5: [2, 3], 6: [2, 3],            // 银之间（东/南）    → 雀士、雀杰
  8: [3, 4], 9: [3, 4],            // 金之间（东/南）    → 雀杰、雀豪
  11: [4, 5], 12: [4, 5],          // 玉之间（东/南）    → 雀豪、雀圣
  15: [5, 6, 7], 16: [5, 6, 7],    // 王座间（东/南）    → 雀圣、魂天
  17: [1, 2], 18: [1, 2],          // 三麻铜之间（东/南）
  19: [2, 3], 20: [2, 3],          // 三麻银之间（东/南）
  21: [3, 4], 22: [3, 4],          // 三麻金之间（东/南）
  23: [4, 5], 24: [4, 5],          // 三麻玉之间（东/南）
  25: [5, 6, 7], 26: [5, 6, 7]     // 三麻王座间（东/南）
}

// 各房间的玩家数（三麻 rank_rates 只有 3 项，末位罚分在 index 2）
const ROOM_PLAYERS = {
  2: 4, 3: 4, 5: 4, 6: 4, 8: 4, 9: 4, 11: 4, 12: 4, 15: 4, 16: 4,
  17: 3, 18: 3, 19: 3, 20: 3, 21: 3, 22: 3, 23: 3, 24: 3, 25: 3, 26: 3
}

// 各房间，按**房间等级从高到低**排列（王座 > 玉 > 金 > 银 > 铜），东场与南场分开。
//
// 各房间准入段位（取自 matchmode 的 level_limit / level_limit_ceil，已核对）：
//   铜之间  初心一星 ~ 雀士三星
//   银之间  雀士一星 ~ 雀杰三星
//   金之间  雀杰一星 ~ 雀豪三星
//   玉之间  雀豪一星 ~ 雀圣三星
//   王座间  雀圣一星 ~ 魂天
//
// 注：铜(3/18)、银(6/20) 之间**牌谱屋不返回数据**（实测恒为 404），
// 其玩家（初心/低段雀士）要走本地 API 兜底；牌谱屋放开后可自动生效。
const ROOMS_BY_MODE = {
  4: {
    south: [16, 12, 9, 6, 3],   // 王南、玉南、金南、银南、铜南
    east: [15, 11, 8, 5, 2]     // 王东、玉东、金东、银东、铜东
  },
  3: {
    south: [26, 24, 22, 20, 18], // 三王南、三玉南、三金南、三银南、三铜南
    east: [25, 23, 21, 19, 17]   // 三王东、三玉东、三金东、三银东、三铜东
  }
}

/** 房间 id → 是否为东场（东风战）。东/南的 PT 表与段位价值标尺都不同。 */
const isEastRoom = roomId => (ROOMS_BY_MODE[3].east.includes(Number(roomId)) || ROOMS_BY_MODE[4].east.includes(Number(roomId)))

/**
 * 段位价值标尺：把「罚分」换算成连续段位值 value。
 *
 * 段位表的 4 位罚分在 value 轴上**线性**：|pen(v)| = a + b·v，
 * 其中 v 满足 豪1=1.00 / 豪2=2.00 / 豪3=3.00 / 圣1=4.00 / 圣2=5.00 / 圣3=6.00。
 * 于是反解 v = (|pen| − a) / b，而 E[PT] 与 value 的换算为：
 *   value = base + E[PT] / (b × 末位率)
 *
 * ⚠️ **a 与 b 随模式与场次而变**，不能写死：
 *     四麻南 b=15 (165→180)、四麻东 b=10 (80→90)
 *     三麻南 b=25 (165→190)、三麻东 b=15 (80→95)
 * 此前代码把 b 写死为 15、base 写死为 |rankpt2|/15−10，对四麻南正确，
 * 但三麻南会偏（实测 三麻玉南 偏 +0.64 星），东场更是完全错（量纲差 1.5 倍）。
 *
 * @param {number} mode 4 或 3
 * @param {boolean} east 是否东场
 * @returns {{a:number, b:number}} 罚分直线参数
 */
function scaleOf (mode, east) {
  const prefix = String(mode) === '3' ? 2 : 1
  const map = loadCfg().level_definition.level_definition.map_
  const pen = id => {
    const d = map[String(prefix * 10000 + id)]
    if (!d) return null
    return Math.abs((east ? d.rankpt1 : d.rankpt2) || 0)
  }
  const p1 = pen(401), p2 = pen(402)
  if (p1 == null || p2 == null || p2 === p1) {
    // 兜底：四麻南的历史常量，保证不崩
    return { a: 150, b: 15 }
  }
  const b = p2 - p1
  return { a: p1 - b, b }
}

/** 段位序号 → value（豪1=1、豪2=2、豪3=3、圣1=4…），按模式与场次取真实罚分反解 */
function levelValueIn (mode, east, major, minor) {
  // 杰(3) 也要支持：杰区间的 value 基准随模式/场次不同（四麻南 杰3=−2.00、
  // 三麻南 −0.80、四麻东 −1.00），格式化与罚分曲线都要用它做锚点。
  // 雀士及以下 rankpt=0，无法反解 value，故从杰1 起。
  if (major < 3) return null
  const prefix = String(mode) === '3' ? 2 : 1
  const d = loadCfg().level_definition.level_definition.map_[String(prefix * 10000 + major * 100 + minor)]
  if (!d) return null
  const p = Math.abs((east ? d.rankpt1 : d.rankpt2) || 0)
  if (!p) return null
  const { a, b } = scaleOf(mode, east)
  return (p - a) / b
}

/**
 * **规范 value 轴**上的罚分曲线（用于跨房间按局数加权）。
 *
 * 东场与南场的罚分表不同，且两者只在豪/圣区间共用同一套 value 基准；
 * 杰区间的基准并不一致（四麻南 杰3=−2.00 而 四麻东 杰3=−1.00）。
 * 因此跨房间加权时必须先把两个场次的罚分都映射到**同一条 value 轴**上，
 * 这里统一采用**南场口径**（`levelValueIn(mode,false,…)`）作为规范轴。
 *
 * 实现：把段位表的杰1~圣3 逐星建成 (规范value, 该场次罚分) 锚点，
 * 再对任意 value 线性插值。这样 pen(v) 在规范轴上连续，且两端做常数外推。
 *
 * @param {number} mode 4 或 3
 * @param {boolean} east 取东场罚分还是南场罚分
 * @returns {(v:number)=>number} value → 罚分（负值）
 */
function penaltyCurve (mode, east) {
  const prefix = String(mode) === '3' ? 2 : 1
  const map = loadCfg().level_definition.level_definition.map_
  const anchors = []
  for (const [major, minor] of [[3, 1], [3, 2], [3, 3], [4, 1], [4, 2], [4, 3], [5, 1], [5, 2], [5, 3]]) {
    const d = map[String(prefix * 10000 + major * 100 + minor)]
    if (!d) continue
    // 规范 value 一律按南场口径（保证东/南锚点落在同一根轴上）
    const vS = levelValueIn(mode, false, major, minor)
    const pen = (east ? d.rankpt1 : d.rankpt2) || 0
    if (vS == null) continue
    anchors.push({ v: vS, pen })
  }
  anchors.sort((x, y) => x.v - y.v)
  return v => {
    if (!anchors.length) return 0
    if (v <= anchors[0].v) return anchors[0].pen
    if (v >= anchors[anchors.length - 1].v) return anchors[anchors.length - 1].pen
    for (let i = 0; i < anchors.length - 1; i++) {
      const lo = anchors[i], hi = anchors[i + 1]
      if (v >= lo.v && v <= hi.v) {
        if (hi.v === lo.v) return lo.pen
        return lo.pen + (hi.pen - lo.pen) * (v - lo.v) / (hi.v - lo.v)
      }
    }
    return anchors[anchors.length - 1].pen
  }
}

/**
 * 魂天 rating（魂珠）制的单局变化表 —— **与房间 PT 表无关**，只由顺位决定。
 *
 * 规则（用户提供）：
 *   四麻  东风战 1/2/3/4 位 → +0.3/+0.1/−0.1/−0.3；半庄（南场）→ +0.5/+0.2/−0.2/−0.5
 *   三麻  东风战 1/2/3   位 → +0.3/ 0.0/−0.3   ；半庄（南场）→ +0.5/ 0.0/−0.5
 * 各表之和为 0（零和），与魂珠总量守恒一致。
 */
const KONTEN_RATING_DELTA = {
  4: {
    east: [0.3, 0.1, -0.1, -0.3],
    south: [0.5, 0.2, -0.2, -0.5]
  },
  3: {
    east: [0.3, 0, -0.3],
    south: [0.5, 0, -0.5]
  }
}

/**
 * 魂天魂珠刻度（用户提供）：
 *   进入魂天时 10 魂珠，攒到 20 魂珠升段（下一级重新从 10 起）。
 *   魂花 3 朵，阈值 5 / 10 / 15 珠 —— 跌到阈值以下即掉一朵花
 *   （如 15 珠有 3 朵花，掉到 14.9 即掉第 3 朵）。
 *   魂天1 跌破 0 珠 → 掉回雀圣3（与 PlayerLevel._adjustRankAndScore 一致）。
 */
const KONTEN_START_BEADS = 10
const KONTEN_PROMOTE_BEADS = 20
const KONTEN_FLOWER_BEADS = [15, 10, 5]   // 由高到低，用于找「下一个掉花点」

/**
 * 该模式候选房间，按房间等级从高到低（王座 → 玉 → 金 → 银 → 铜）。
 *
 * ⚠️ 必须配合 `stableRankEligibleRooms` 使用：仅按等级排序会导致
 * 雀豪玩家去查王南——其 633 场是**过去在雀圣时期打的**，用那段数据算出的
 * 安定段位与其当前水平无关（实测产出「雀杰3.99」这类荒谬值）。
 *
 * @param {number|string} mode 4 或 3
 * @param {boolean} [east] 是否要东场房间；默认 false（南场）
 * @returns {number[]} 候选房间 id，从高到低
 */
export function stableRankRoomCandidates (mode, east = false) {
  const m = String(mode) === '3' ? 3 : 4
  const set = ROOMS_BY_MODE[m]
  return [...((east ? set.east : set.south) || [])]
}

/**
 * 该模式的**全部**候选房间（东场 + 南场），按房间等级从高到低。
 *
 * 安定段位按局数加权各房间时用这个：同一等级下东、南各算一份，
 * 再按该玩家在两个房间的实际局数加权。
 *
 * @param {number|string} mode 4 或 3
 * @returns {number[]} 房间 id，从高到低（同等级内南在前）
 */
export function stableRankAllRooms (mode) {
  const m = String(mode) === '3' ? 3 : 4
  const { south, east } = ROOMS_BY_MODE[m]
  // 按等级交错：王南、王东、玉南、玉东… 保证「先高等级」的顺序
  const out = []
  for (let i = 0; i < south.length; i++) {
    out.push(south[i])
    if (east[i] != null) out.push(east[i])
  }
  return out
}

/** 段位 id → 可比较的序号（major*100+minor，魂天归一为 6xx） */
function levelOrdinal (levelId) {
  const realId = Number(levelId) % 10000
  let major = Math.floor(realId / 100)
  const minor = realId % 100
  if (major === 7) major = 6
  return major * 100 + minor
}

/**
 * 从一组房间 id 中挑出可用于安定段位计算的房间（房间筛选用）。
 *
 * 房间筛选传入的是「东+南」两个 id（如 玉之间 = [11, 12]，11 玉东、12 玉南）。
 * 东场与南场**都能算**（各用各的标尺，见 scaleOf），故两个都返回 ——
 * 由调用方按该玩家在两个房间的局数加权，而不是丢弃东场。
 *
 * @param {number|string} mode 4 或 3
 * @param {number[]} roomIds 候选房间 id（东+南）
 * @returns {number[]} 可用的房间 id（保持传入顺序）
 */
export function stableRankSouthRoom (mode, roomIds) {
  const m = String(mode) === '3' ? 3 : 4
  const all = [...ROOMS_BY_MODE[m].south, ...ROOMS_BY_MODE[m].east]
  const out = []
  for (const id of (roomIds || [])) {
    const n = Number(id)
    if (all.includes(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * 按**当前段位**过滤出该玩家可准入的房间，保持高→低顺序。
 *
 * 依据 matchmode 的 level_limit / level_limit_ceil（房间准入段位区间）：
 *   王座 雀圣一星~魂天、玉 雀豪一星~雀圣三星、金 雀杰一星~雀豪三星
 * 若传入的段位无法解析，则退回全部候选（由调用方逐个尝试）。
 *
 * @param {number|string} mode 4 或 3
 * @param {number|null} levelId 当前段位 id（含模式位，如 10401）
 * @param {boolean} [east] 是否要东场房间；默认 false（南场）
 * @returns {number[]} 准入房间 id，从高到低
 */
export function stableRankEligibleRooms (mode, levelId, east = false) {
  const all = stableRankRoomCandidates(mode, east)
  if (levelId == null) return all
  const cur = levelOrdinal(levelId)
  if (!isFinite(cur) || cur <= 0) return all

  const cfg = loadCfg().desktop.matchmode.map_
  const hit = all.filter(id => {
    const room = cfg[String(id)]
    if (!room || !room.level_limit || !room.level_limit_ceil) return true
    const lo = levelOrdinal(room.level_limit)
    const hi = levelOrdinal(room.level_limit_ceil)
    return cur >= lo && cur <= hi
  })
  // 全部不符时（如魂天/异常段位）退回全部，避免无结果
  return hit.length ? hit : all
}

const isKonten = lv => lv.major >= 6
const sameLevel = (a, b) => a.major === b.major && a.minor === b.minor

function nextLevel (lv) {
  let major = lv.major, minor = lv.minor + 1
  if (minor > 3 && !isKonten(lv)) { major++; minor = 1 }
  if (major === 6) major = 7
  return { major, minor }
}
function prevLevel (lv) {
  if (lv.major === 1 && lv.minor === 1) return { ...lv }
  let major = lv.major, minor = lv.minor - 1
  if (minor < 1) { major--; minor = 3 }
  if (major === 6) major = 5
  return { major, minor }
}
function allowed (lv, roomId) {
  return (ALLOWED_MAJORS[roomId] || []).includes(lv.major)
}

// 4 位罚分（负值）；魂天无罚分。
// ⚠️ 段位表按模式分前缀：四麻 1xxxx、三麻 2xxxx（三麻罚分数值不同），
// 不能硬编码 10000 —— 否则三麻会查到四麻的段位表，罚分取错。
function penaltyOf (lv, room) {
  if (isKonten(lv)) return 0
  const prefix = ROOM_PLAYERS[room.id] === 3 ? 2 : 1
  const def = loadCfg().level_definition.level_definition.map_[String(prefix * 10000 + lv.major * 100 + lv.minor)]
  if (!def) return 0
  const isEast = room.mode === 1 || room.mode === 11
  return isEast ? (def.rankpt1 || 0) : (def.rankpt2 || 0)
}

/**
 * E[PT]：给定段位下的期望顺位点
 * @param {boolean} applyPenalty 是否计入 4 位罚分（闭式解不计，逐级试探计）
 */
function expectedPT (stats, room, lv, applyPenalty) {
  const uma = room.buchang
  const lp = [room.levelpoint1, room.levelpoint2, room.levelpoint3, room.levelpoint4]
  const init = room.init_point
  const n = stats.rank_rates.length
  let e = 0
  for (let i = 0; i < n; i++) {
    let pt = Math.ceil((stats.rank_avg_score[i] - init) / 1000 + uma[i]) + lp[i]
    if (i === n - 1 && applyPenalty) pt += penaltyOf(lv, room)
    e += pt * stats.rank_rates[i]
  }
  return e
}

/**
 * 期望魂珠变化/局（rating 制）。
 *
 * 魂天单局魂珠变化**只由顺位决定**（与打点、房间 PT 表无关），故用顺位率直接加权：
 *   e = Σ KONTEN_RATING_DELTA[n][east|south][i] × rank_rates[i]
 * 各表之和为 0（零和），因此 e 的符号即「稳定涨/跌」方向。
 *
 * @param {object} stats 牌谱屋 player_stats（需 rank_rates）
 * @param {object} room matchmode 条目（需 mode 判定东/南场）
 * @param {number} n 玩家数（4 或 3）
 * @returns {number|null}
 */
function kontenBeadsRate (stats, room, n) {
  const table = KONTEN_RATING_DELTA[n]
  if (!table) return null
  const isEast = room.mode === 1 || room.mode === 11
  const deltas = table[isEast ? 'east' : 'south']
  const rates = stats.rank_rates
  if (!Array.isArray(rates) || rates.length < n) return null
  let e = 0
  for (let i = 0; i < n; i++) {
    if (typeof rates[i] !== 'number' || !isFinite(rates[i])) return null
    e += deltas[i] * rates[i]
  }
  // 零和顺位率的浮点误差会算出 −1.4e−17，取整到 2 位后再判符号，
  // 避免出现「−0.00」这种既无信息又难看的值。
  return Math.round(e * 100) / 100
}

/**
 * 期望魂珠变化 → 展示文本，形如「+0.35珠」（±0.00 时为「±0.00珠」）。
 *
 * 省略「/局」：该文本要挤进仅 248px 宽的安定段位格（还需容下右侧的「约N战升段」），
 * 而安定段位本身就是「每局期望」量，省略单位不损失信息。
 *
 * @param {number} e 期望魂珠变化/局
 */
function formatBeadsRate (e) {
  const sign = e > 0 ? '+' : (e < 0 ? '−' : '±')
  return `${sign}${Math.abs(e).toFixed(2)}珠`
}

/**
 * 把连续 value 格式化为段位文字。
 *
 * value 的定义与场次无关（豪1=1.00、豪2=2.00、豪3=3.00、圣1=4.00…），
 * 由 `levelValueIn` 按模式/场次的真实罚分反解保证一致，故本函数只需按
 * 段位表分段插值，不需知道是东场还是南场。
 *
 * 豪/圣区间每星恰好 1.00，与牌谱屋 formatStableLevel2 的原式一致：
 *   value ≥ 4 → 雀圣(value−3)；否则 → 雀豪(value)
 * 杰区间每星不是 1.00（四麻南约 1.33、三麻南约 0.80），故按段位表算实际步长。
 *
 * @param {number} value 规范 value（统一南场标尺，见 levelValueIn）
 * @param {number|string} mode 4 或 3（三麻段位表 major 同为 1~6）
 * @returns {string|null}
 */
export function formatStableRank (value, mode = 4) {
  if (!isFinite(value)) return null

  // 豪/圣区间每星恰好 1.00（东场、南场都是），直接沿用牌谱屋原式（避免跨段位边界被误判）
  if (value >= 1) {
    if (value >= 6) return '雀圣3.00'          // 雀圣三星封顶
    return value >= 4
      ? `雀圣${(value - 3).toFixed(2)}`
      : `雀豪${value.toFixed(2)}`
  }

  // 杰区间：以杰3 为锚点，每星步长由段位表算出（杰1→杰2→杰3 的 value 间距）。
  // 锚点取**规范轴**（南场口径），与 levelValueIn 保持一致。
  // 低于杰1 则落入雀士，夹到雀士三星。
  const v3 = levelValueIn(mode, false, 3, 3), v1 = levelValueIn(mode, false, 3, 1)
  const JIE_ANCHOR = v3 != null ? v3 : -2.0
  const JIE_STEP = (v3 != null && v1 != null && v3 !== v1) ? (v3 - v1) / 2 : 40 / 30
  const starFloat = 3 + (value - JIE_ANCHOR) / JIE_STEP
  // 容差：段位表的值本身带浮点误差，直接比较会误判边界
  if (starFloat < 1 - 1e-6) return '雀士3.00'
  return `雀杰${Math.min(3.99, Math.max(1, starFloat)).toFixed(2)}`
}

/**
 * 升段 / 掉段预计战数
 *
 * ⚠️ 注意：**这不是牌谱屋的功能**。牌谱屋只提供安定段位（estimateStableLevel2），
 * 其 bundle 中没有任何「预计 N 战升段」的实现（已搜索中英文关键词确认）。
 * 本函数是按同一套 PT 期望模型自行推导的：
 *
 *   需要 PT = 目标段位 end_point − 当前 score（升段）
 *             或 当前 score − 0（掉段，掉段线为 0 分；init_point 是起始分而非掉段线）
 *   预计战数 = ceil(需要 PT / E[PT])，E[PT] 用**当前段位**的 4 位罚分计算
 *
 * 推导依据（已用参考样本交叉验证）：
 *   安定段位值 = |4位罚分|/15 − 10，即 E[PT]=0 的盈亏平衡段位
 *   （豪1 −165→1.00、豪2 −180→2.00、豪3 −195→3.00、圣1 −210→4.00，完全一致）
 *   参考样本「豪3 1251/3600 → 预计 562 战」隐含 E[PT]≈4.18，
 *   本模型用玉南豪3参数复算得 E[PT]≈4.20 → 560 战，与之一致。
 *
 * 局限：E[PT] 由当前顺位率/平均点数外推，属于**线性预测**，不含运气波动与段位
 * 升降带来的参数变化（升段后 4 位罚分加重，实际会变慢）。场次越多越接近真实。
 *
 * @param {object} stats 牌谱屋 player_stats（需 rank_rates / rank_avg_score / level）
 * @param {number|string} roomId 房间 id
 * @param {number} currentScore 当前段位分（PT 制为 score；魂天为 rating×100 的内部 pt）
 * @returns {{promote:number|null, demote:number|null, flower?:number|null, ept:number}|null}
 *          promote/demote/flower 为预计战数，不适用时为 null；
 *          flower 仅魂天有值（掉下一朵魂花所需战数）
 */
export function estimateGamesToRankChange (stats, roomId, currentScore) {
  const rid = Number(roomId)
  const room = loadCfg().desktop.matchmode.map_[String(rid)]
  if (!room || !stats || typeof currentScore !== 'number') return null

  const n = ROOM_PLAYERS[rid] || 4
  const rates = stats.rank_rates
  const avg = stats.rank_avg_score
  if (!Array.isArray(rates) || !Array.isArray(avg) || rates.length < n || !rates[n - 1]) return null
  for (let i = 0; i < n; i++) {
    if (typeof rates[i] !== 'number' || !isFinite(rates[i])) return null
    if (typeof avg[i] !== 'number' || !isFinite(avg[i])) return null
  }

  const raw = stats.level?.id
  if (raw == null) return null
  const realId = raw % 10000
  let major = Math.floor(realId / 100)
  const minor = realId % 100
  if (major === 7) major = 6
  if (major < 1 || major > 6) return null
  // 魂天：rating（魂珠）制，与 PT 制完全不同，需单独处理。
  // 单局 rating 变化**只由顺位决定**（与平均点数、房间 PT 表无关）：
  //   四麻  东风 1/2/3/4 位 → +0.3/+0.1/−0.1/−0.3；半庄 → +0.5/+0.2/−0.2/−0.5
  //   三麻  东风 1/2/3   位 → +0.3/ 0.0/−0.3   ；半庄 → +0.5/ 0.0/−0.5
  //
  // 刻度（与 PlayerLevel._adjustRankAndScore 一致）：每级魂珠区间 [0, 20)，
  // 进入时 10 珠、攒到 20 珠升段并重置为 10 珠（代码：>=20 时 minor++ 且 score-=10）；
  // 跌破 0 珠则降级（代码：<0 时 minor-- 且 score+=10；魂天1 跌破 0 掉回雀圣3）。
  // 魂花 3 朵（阈值 15/10/5 珠），跌到阈值以下掉一朵 —— 魂天玩家关心的是掉花，
  // 故掉花预测单列 flower 字段（掉回上一级才是 demote）。
  if (major >= 6) {
    const eDelta = kontenBeadsRate(stats, room, n)
    if (eDelta == null) return null
    const beads = currentScore / 100    // 传入为 pt(0~2000)，显示值 = pt/100
    const lv = Math.max(1, Math.min(20, minor))
    const out = { promote: null, demote: null, flower: null, ept: eDelta }

    if (eDelta > 0.001) {
      // 升段：攒到 20 珠（魂天20 已封顶）
      if (lv < 20) {
        const need = KONTEN_PROMOTE_BEADS - beads
        if (need > 0) out.promote = Math.ceil(need / eDelta)
      }
    } else if (eDelta < -0.001) {
      const loss = Math.abs(eDelta)
      // 掉花：取「当前仍持有的最高阈值」，跌破它即掉一朵。
      // 例：16 珠持有 3 朵（阈值 15），需跌到 <15 → 差 1 珠。
      const held = KONTEN_FLOWER_BEADS.find(t => beads >= t)
      if (held != null) {
        const need = beads - held
        // need 恰为 0 时（如正好 15 珠）仍需再输一局才会跌破，故下限 1 局
        out.flower = need > 0 ? Math.ceil(need / loss) : 1
      } else {
        // 已无花可掉（<5 珠）→ 退化为预测掉回上一级
        const need = beads
        if (need > 0) out.demote = Math.ceil(need / loss)
      }
    }
    return out
  }

  const curLv = { major, minor: Math.max(1, Math.min(3, minor)) }
  // 段位表按模式分前缀（四麻 1xxxx / 三麻 2xxxx），不能硬编码 10000
  const modePrefix = ROOM_PLAYERS[rid] === 3 ? 2 : 1
  const curDef = loadCfg().level_definition.level_definition.map_[String(modePrefix * 10000 + major * 100 + curLv.minor)]
  if (!curDef) return null

  // E[PT]：计入当前段位的 4 位罚分（预测实际涨跌必须算）
  const ept = expectedPT(stats, room, curLv, true)
  const out = { promote: null, demote: null, ept }

  // 升段：需要到本段位的 end_point；已是最高星级时用下一段位起点
  if (ept > 0.01) {
    let target = curDef.end_point
    if (target && target > 0) {
      const need = target - currentScore
      if (need > 0) out.promote = Math.ceil(need / ept)
    }
  }

  // 掉段：段位分跌到 0 即掉段（掉回上一段位）。
  // ⚠️ 掉段线是 0，不是 curDef.init_point —— init_point 是「进入本段位时的起始分」，
  // 不是掉段线。依据：所有段位 end_point 恒等于 2 × init_point，即
  // 「起始分 + 净赚一份起始分 = 升段」，对称地「起始分 − 净亏一份起始分(=0) = 掉段」。
  // 实例：雀杰3 起始分 1000，玩家刚升上来时正好是 1000/2000；
  //       雀杰2 起始分 700，玩家 602 已低于起始分却仍在雀杰2 —— 若 700 是掉段线早已掉段。
  //
  // 注意：此处只处理 major ≤ 5（雀圣及以下）。**魂天同样会掉段** ——
  // PlayerLevel._adjustRankAndScore 中「魂天1 且分数 < 0 → 雀圣3 (4500 分)」，
  // 但魂天用 rating（魂珠）制：内部 pt 为 0~2000、显示值 = pt/100（0.0~20.0），
  // 与段位表的 PT 制不同，故本函数在上方 `major >= 6` 处直接返回 null，
  // 不对魂天做升/掉段战数预测（不是「魂天不降」）。
  if (ept < -0.01 && curDef.can_degrade) {
    const need = currentScore   // 距离掉段线(0 分)还有多少分
    if (need > 0) out.demote = Math.ceil(need / Math.abs(ept))
  }

  return out
}

/**
 * 逐级试探（通用解法，对应牌谱屋 estimateStableLevel）
 *
 * 牌谱屋此路径输出形如「雀豪3+ (0.89)」，其中括号值是**该段位下的 E[PT]**
 * （每局期望 PT 变化），并非段位小数 —— 不能直接拼成「雀豪3.89」。
 *
 * 本实现改为输出与闭式解一致的连续值「雀豪3.34」，换算依据：
 *   value = value_L + E[PT]_含罚分 / (b × 末位率)
 * 其中 value_L 是该段位的序号（豪1=1、豪2=2、豪3=3、圣1=4…），
 * b 取自 scaleOf(mode, east) —— **随模式与场次而变**（四麻南 15、四麻东 10、
 * 三麻南 25、三麻东 15），不能写死。
 *
 * @returns {{text:string, value:number, approximate:true}|null}
 */
function walkStableRank (stats, room, startLevel, mode = 4) {
  const east = isEastRoom(room.id)
  const { b } = scaleOf(mode, east)
  const E = lv => expectedPT(stats, room, lv, true)
  const roomId = room.id
  const n = ROOM_PLAYERS[roomId] || 4
  const lastRate = stats.rank_rates[n - 1]

  // 把「某段位下的 E[PT]」换算为闭式解口径的连续 value
  const toValue = (lv, e) => {
    const base = levelValueIn(mode, east, lv.major, lv.minor)
    if (base == null || !lastRate) return null
    return base + e / (b * lastRate)
  }
  const fmt = (lv, e) => {
    let v = toValue(lv, e)
    if (v == null || !isFinite(v)) return null
    // 夹到合法区间 [雀杰一星, 雀圣三星] = [−4.67, 6.00]。
    // 注意下界**不能取 1**：雀杰区间的 value 本就是负数（杰3 −2.00、杰1 −4.67），
    // 若夹到 1 会把雀杰玩家错报成「雀豪1.00」。
    // 上界取 6（雀圣三星）是因为末位率极低时 E[PT]/(b×末位率) 会发散
    // （实测末位率 5% → value 62，即「雀圣59」这类荒谬值）。
    let clamped = false
    if (v > 6) { v = 6; clamped = true }
    else if (v < -4.67) { v = -4.67; clamped = true }
    // 不显示期望值（E[PT]）：统一格式化为「雀豪3.34」这类段位表达
    const text = formatStableRank(v, mode)
    if (!text) return null
    return { text, value: v, approximate: true, clamped }
  }

  let below = null
  let lv = { ...startLevel }

  for (let guard = 0; guard < 60; guard++) {
    // 魂天必须**最先**判定：PT 制模型对魂天不成立（penaltyOf 对魂天恒为 0，
    // E[PT] 被抬高，其正负与数值都无意义），故不能先看 E[PT] 再决定。
    // 走到这里说明上一级（雀圣3）的 E[PT] ≥ 0 —— 即稳定段位已达魂天（强顺位率的
    // 雀圣3 确实会升魂天），此时改用 rating 制给出同口径结果：期望魂珠变化/局。
    // （此前输出「魂天+63.65」，那个 +63.65 是 PT 量纲的期望值，对魂天无意义。）
    //
    // ⚠️ 两种模型的符号可能不一致：PT 制在雀圣3 用 rankpt=-240 判「够格升魂天」，
    // 而 rating 制在魂天算出的漂移仍可能为负（穷举 22100 组顺位率×6 组均点，王南
    // 四麻有 1519 组如此，最差 −0.19 珠）。这不是 bug：两式量纲不同（PT vs 魂珠），
    // 且魂天无 4 位罚分、rating 只由顺位决定。此时以 rating 为准 —— 前缀「魂天」给出
    // 稳定段位，后缀负号给出「虽在魂天但正在掉珠」，两个信息都是对的、都该展示。
    if (isKonten(lv)) {
      const beads = kontenBeadsRate(stats, room, n)
      if (beads == null) return { text: '魂天', approximate: true }
      return {
        text: `魂天${formatBeadsRate(beads)}`,
        value: beads,
        expBeads: beads,
        konten: true,
        approximate: true
      }
    }
    const e = E(lv)
    if (Math.abs(e) < 0.001) return fmt(lv, 0)
    if (!(e >= 0)) {
      if (below) return fmt(below, E(below))
      break
    }
    below = lv
    const nx = nextLevel(lv)
    if (!allowed(nx, roomId) || sameLevel(nx, below)) {
      // 已达该房间段位上限（如金之间的雀豪三星）
      return fmt(below, e)
    }
    lv = nx
  }

  for (let guard = 0; guard < 60; guard++) {
    const pv = prevLevel(lv)
    if (!allowed(pv, roomId) || sameLevel(pv, lv)) {
      return fmt(lv, E(lv))
    }
    lv = pv
    if (E(lv) > -0.001) return fmt(lv, Math.abs(E(lv)))
  }
  return null
}

/**
 * 段位序号：豪1=1、豪2=2、豪3=3、圣1=4…
 *
 * 保留此函数供内部按四麻南口径调用；需要区分模式/场次时请用 levelValueIn。
 */
function levelValueOf (lv) {
  return levelValueIn(4, false, lv.major, lv.minor)
}

/**
 * 按**局数加权多个房间**计算安定段位（核心解法）。
 *
 * 单一房间只是本函数的特例（entries 只有一项）。之所以要加权，是因为玩家通常
 * 同时在东场与南场、以及不同等级的房间打牌 —— 只取其中一个房间会答非所问。
 *
 * 数学模型：设规范 value 轴为 v（豪1=1.00…圣3=6.00，见 levelValueIn），
 * 每局的期望 PT 变化为
 *   E(v) = Σ_r  w_r × [ E_r[PT]不含罚分 + pen_r(v) × 末位率_r ]
 * 其中 w_r 是房间 r 的局数占比，E_r 用房间 r 自己的 PT 表（levelpoint/buchang/
 * init_point），pen_r 用房间 r 自己的罚分表（东 rankpt1 / 南 rankpt2）。
 * 安定段位即 E(v) = 0 的根 —— 在该段位下期望涨跌为零。
 *
 * 关键点：**罚分必须按房间各自的表**，不能把东+南的统计池化后喂单表。
 * 两表的量纲不同（四麻东每星 10 PT、南每星 15 PT），池化相当于把两种量纲
 * 加权平均（实测平均偏 0.26 星、最大 1.56 星）。
 *
 * @param {Array<{roomId:number, stats:object, count:number}>} entries 各房间的数据
 * @param {number|string} mode 4 或 3
 * @returns {{text:string, value:number, expPT?:number, approximate?:boolean, konten?:boolean}|null}
 */
export function computeStableRankWeighted (entries, mode) {
  if (!Array.isArray(entries) || !entries.length) return null
  const m = mode != null ? (String(mode) === '3' ? 3 : 4) : 4
  const n = m === 3 ? 3 : 4

  // 只保留有局数、结构合法的房间
  const rooms = []
  for (const e of entries) {
    const rid = Number(e?.roomId)
    const room = loadCfg().desktop.matchmode.map_[String(rid)]
    const st = e?.stats
    if (!room || !st) continue
    const cnt = Number(e.count)
    if (!isFinite(cnt) || cnt <= 0) continue
    const rates = st.rank_rates, avg = st.rank_avg_score
    if (!Array.isArray(rates) || !Array.isArray(avg)) continue
    if (rates.length < n || avg.length < n) continue
    // 校验只针对**实际会参与加权**的顺位：某个顺位率为 0 时该项贡献恒为 0，
    // 其平均点数缺失（本地 API 会给 null）不应导致整个房间被丢弃。
    // 例：某房间 5 场全 2 位 → rank_avg_score=[null,31020,null,null]，
    // 顺位率=[0,1,0,0]；只有 2 位的平均点数有意义，其余为 null 是正常的。
    // 此前要求 n 项全部为数，会把这 5 场从权重里剔除（实测偏 0.08 星）。
    let ok = true
    for (let i = 0; i < n; i++) {
      if (typeof rates[i] !== 'number' || !isFinite(rates[i])) { ok = false; break }
      if (rates[i] > 0 && (typeof avg[i] !== 'number' || !isFinite(avg[i]))) { ok = false; break }
    }
    if (!ok) continue
    rooms.push({ rid, room, stats: st, count: cnt, east: isEastRoom(rid) })
  }
  if (!rooms.length) return null
  const total = rooms.reduce((s, r) => s + r.count, 0)

  // 当前段位（各房间共用，取第一个有效的）
  const raw = rooms[0].stats.level?.id
  if (raw == null) return null
  const realId = raw % 10000
  let major = Math.floor(realId / 100)
  const minor = realId % 100
  if (major === 7) major = 6
  if (major < 1 || major > 6) return null
  const startLevel = { major, minor: major >= 6 ? Math.max(1, Math.min(20, minor)) : Math.max(1, Math.min(3, minor)) }

  // 魂天：rating（魂珠）制，与 PT 表无关，按局数加权各房间的魂珠漂移即可
  if (isKonten(startLevel)) {
    let acc = 0
    for (const r of rooms) {
      const e = kontenBeadsRate(r.stats, r.room, n)
      if (e == null) continue
      acc += e * r.count
    }
    const beads = Math.round(acc / total * 100) / 100
    const text = `魂天${formatBeadsRate(beads)}`
    return { text, value: beads, expBeads: beads, konten: true, approximate: true }
  }

  // E[PT]不含罚分（用房间自己的 PT 表）。
  // 顺位率为 0 的项直接跳过：其贡献恒为 0，且本地 API 对这类顺位不给平均点数（null）。
  const eptNoPen = r => {
    const lp = [r.room.levelpoint1, r.room.levelpoint2, r.room.levelpoint3, r.room.levelpoint4]
    let e = 0
    for (let i = 0; i < n; i++) {
      const rate = r.stats.rank_rates[i]
      if (!(rate > 0)) continue
      const pt = Math.ceil((r.stats.rank_avg_score[i] - r.room.init_point) / 1000 + r.room.buchang[i]) + lp[i]
      e += pt * rate
    }
    return e
  }
  for (const r of rooms) {
    r.ept0 = eptNoPen(r)
    // 末位率：样本里没拿过末位时为 0，此时罚分项恒为 0（乘 0），是正确结果
    const lr = r.stats.rank_rates[n - 1]
    r.lastRate = (typeof lr === 'number' && isFinite(lr)) ? lr : 0
    r.pen = penaltyCurve(m, r.east)
  }

  // E(v)：加权总期望 PT 变化
  const E = v => {
    let e = 0
    for (const r of rooms) e += (r.count / total) * (r.ept0 + r.pen(v) * r.lastRate)
    return e
  }

  // 段位上限：取所有参与房间允许的最高 major，换算成 value 作为上界
  let maxMajor = 1
  for (const r of rooms) {
    const al = ALLOWED_MAJORS[r.rid] || []
    for (const mm of al) if (mm <= 5 && mm > maxMajor) maxMajor = mm
  }
  const V_MIN = -4.67
  let vMax = 6
  if (maxMajor < 5) {
    const lv = levelValueIn(m, false, maxMajor, 3)
    if (lv != null) vMax = Math.min(vMax, lv + 0.99)   // 该段位三星
  }

  // 扫描找 E(v)=0 的根（E 关于 v 单调递减：v 越高罚分越重）
  const step = 0.002
  let root = null
  let prev = null
  for (let v = V_MIN; v <= vMax + 1e-9; v += step) {
    const e = E(v)
    if (prev && prev.e >= 0 && e < 0) {
      let lo = prev.v, hi = v
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2
        if (E(mid) >= 0) lo = mid; else hi = mid
      }
      root = (lo + hi) / 2
      break
    }
    prev = { v, e }
  }

  if (root == null) {
    // 全程 E > 0：连最高可表达段位（雀圣3）都是净赚 → 稳定段位已达魂天。
    // ⚠️ 但只有当参与的房间**允许魂天**（王座间）时才能这么报 —— 玉之间准入
    // 只到雀圣三星，玩家在玉之间再强也升不到魂天，应夹在雀圣3.00。
    // 此时 PT 制失效（魂天无 4 位罚分），改用 rating 制给出魂珠漂移，
    // 与 walkStableRank 的魂天分支保持一致。
    const allowsKonten = rooms.some(r => (ALLOWED_MAJORS[r.rid] || []).some(mm => mm >= 6))
    if (E(vMax) >= 0 && vMax >= 6 && allowsKonten) {
      let acc = 0
      for (const r of rooms) {
        const e = kontenBeadsRate(r.stats, r.room, n)
        if (e == null) continue
        acc += e * r.count
      }
      const beads = Math.round(acc / total * 100) / 100
      return { text: `魂天${formatBeadsRate(beads)}`, value: beads, expBeads: beads, konten: true, approximate: true }
    }
    // 其余越界：夹到区间端点（雀圣3.00 或 雀杰1.00）
    root = E(vMax) >= 0 ? vMax : V_MIN
  }
  const text = formatStableRank(root, m)
  if (!text) return null
  const out = { text, value: root, approximate: true }
  if (root === V_MIN || root === vMax) out.clamped = true
  // 单一房间时保留 expPT（与历史返回结构兼容）
  if (rooms.length === 1) out.expPT = rooms[0].ept0
  return out
}

/**
 * 计算安定段位
 * @param {object} stats 牌谱屋 player_stats，需含 rank_rates / rank_avg_score / level
 * @param {number|string} roomId 房间 matchmode id（四麻 9/12/16，三麻 22/24/26）
 * @param {number|string} [mode] 4 或 3，用于选择段位表；默认按房间 id 推断
 * @returns {{text:string, value?:number, expPT?:number, approximate?:boolean}|null}
 */
export function computeStableRank (stats, roomId, mode) {
  const rid = Number(roomId)
  if (!stats || !ALLOWED_MAJORS[rid]) return null
  // 未显式传入时按房间 id 推断模式（三麻房间 id ≥ 21）
  const m = mode != null ? (String(mode) === '3' ? 3 : 4) : (rid >= 21 ? 3 : 4)

  const n = ROOM_PLAYERS[rid] || 4
  const rates = stats.rank_rates
  const avg = stats.rank_avg_score
  if (!Array.isArray(rates) || !Array.isArray(avg) || rates.length < n) return null
  // 末位率（四麻 4 位 / 三麻 3 位）为 0 时除数为零，无法计算
  if (!rates[n - 1]) return null
  // 注意：三麻场次少时 rank_avg_score 会出现 null（如 n=1 → [43800, null, null]），
  // 必须显式排除，否则会在运算中静默变成 NaN 或 0。
  for (let i = 0; i < n; i++) {
    if (typeof rates[i] !== 'number' || !isFinite(rates[i])) return null
    if (typeof avg[i] !== 'number' || !isFinite(avg[i])) return null
  }

  const room = loadCfg().desktop.matchmode.map_[String(rid)]
  if (!room) return null

  const raw = stats.level?.id
  if (raw == null) return null
  const realId = raw % 10000
  let major = Math.floor(realId / 100)
  const minor = realId % 100
  if (major === 7) major = 6
  if (major < 1 || major > 6) return null
  const startLevel = { major, minor: major >= 6 ? Math.max(1, Math.min(20, minor)) : Math.max(1, Math.min(3, minor)) }

  // 魂天：rating（魂珠）制，PT 制的安定段位模型不适用。
  // 单局魂珠变化只由顺位决定（与打点、房间 PT 表无关），故不能用 expectedPT 外推；
  // 此前 walkStableRank 会把 E[PT]（PT 量纲，十几~几十）直接拼成「魂天+54.55」，
  // 而魂天真实变化量是 ±0.3/±0.5 魂珠，两者无换算关系（÷100 只是数值巧合）。
  //
  // 文案统一带「魂天」前缀（与逐级试探路径一致）：安定段位回答的是「会稳定在哪个
  // 段位」，前缀给出段位名，后缀给出该段位下的魂珠漂移方向与速率。
  if (isKonten(startLevel)) {
    const e = kontenBeadsRate(stats, room, n)
    if (e == null) return null
    const text = `魂天${formatBeadsRate(e)}`
    return { text, value: e, expBeads: e, konten: true, approximate: true }
  }

  // 闭式解（仅「玉南 / 王南」这类南场快速路径）。三麻同样适用：末位率取 rank_rates[n-1]。
  //
  // 推导：4 位罚分只在拿到 4 位时生效，故每局的**期望**罚分是 pen(v) × 末位率。
  // 均衡段位 v* 满足  E[PT]不含罚分 + pen(v*) × 末位率 = 0，
  // 代入 pen(v) = −(a + b·v)（a、b 由 scaleOf 给出）解得：
  //   v* = E[PT] / (b × 末位率) − a / b
  // 四麻南 a=150 b=15 → a/b=10，即历史公式 E[PT]/(15×末位率) − 10（完全一致）；
  // 三麻南 a=140 b=25 → a/b=5.6；四麻东 a=70 b=10 → a/b=7。
  // 此前把 b 写死 15、a/b 写死 10，对四麻南正确但三麻南偏大（实测 三麻玉南 偏 +0.64 星）。
  if (CLOSED_FORM_ROOMS.has(rid) && !isKonten(startLevel)) {
    const east = isEastRoom(rid)
    const { a, b } = scaleOf(m, east)
    const expPT = expectedPT(stats, room, startLevel, false)
    const value = expPT / (b * rates[n - 1]) - a / b
    // 有效区间：雀豪一星(1.00) ~ 雀圣三星(6.00)。
    // 上界用 6 而非牌谱屋的 7：value > 6 已超出雀圣三星，继续按公式外推会产出
    // 「雀圣59.07」这类荒谬值（末位率过低时尤甚，实测末位率 5% → value 62）。
    // 越界一律回退逐级试探，其结果受房间段位上限约束，不会发散。
    // 下界用雀杰一星（−4.67）：玉/王座房间也可能算出低于雀豪的值（如 0.65）。
    if (isFinite(value) && value >= -4.67 && value <= 6) {
      const text = formatStableRank(value, m)
      if (text) return { text, value, expPT }
    }
    // 越界 → 回退逐级试探，与牌谱屋一致
    const walked = walkStableRank(stats, room, startLevel, m)
    return walked || null
  }

  // 东场 / 魂天 → 逐级试探
  return walkStableRank(stats, room, startLevel, m)
}
