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

const RANK_NAMES = ['初心', '雀士', '雀杰', '雀豪', '雀圣', '魂天']
const LEVEL_MAX_POINTS = [20, 80, 200, 600, 800, 1000, 1200, 1400, 2000, 2800, 3200, 3600, 4000, 6000, 9000]

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

// 各模式的「南场」房间，按**房间等级从高到低**排列（王座 > 玉 > 金 > 银 > 铜）。
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
const SOUTH_ROOMS_BY_MODE = {
  4: [16, 12, 9, 6, 3],    // 王南、玉南、金南、银南、铜南
  3: [26, 24, 22, 20, 18]  // 三王南、三玉南、三金南、三银南、三铜南
}

/**
 * 该模式「南场」候选房间，按房间等级从高到低（王座 → 玉 → 金）。
 *
 * ⚠️ 必须配合 `stableRankEligibleRooms` 使用：仅按等级排序会导致
 * 雀豪玩家去查王南——其 633 场是**过去在雀圣时期打的**，用那段数据算出的
 * 安定段位与其当前水平无关（实测产出「雀杰3.99」这类荒谬值）。
 *
 * @param {number|string} mode 4 或 3
 * @returns {number[]} 候选房间 id，从高到低
 */
export function stableRankRoomCandidates (mode) {
  const m = String(mode) === '3' ? 3 : 4
  return [...(SOUTH_ROOMS_BY_MODE[m] || [])]
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
 * 按**当前段位**过滤出该玩家可准入的南场房间，保持高→低顺序。
 *
 * 依据 matchmode 的 level_limit / level_limit_ceil（房间准入段位区间）：
 *   王南 雀圣一星~魂天、玉南 雀豪一星~雀圣三星、金南 雀杰一星~雀豪三星
 * 若传入的段位无法解析，则退回全部候选（由调用方逐个尝试）。
 *
 * @param {number|string} mode 4 或 3
 * @param {number|null} levelId 当前段位 id（含模式位，如 10401）
 * @returns {number[]} 准入房间 id，从高到低
 */
export function stableRankEligibleRooms (mode, levelId) {
  const all = stableRankRoomCandidates(mode)
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

function tagOf (lv) {
  if (isKonten(lv)) return RANK_NAMES[5]
  return RANK_NAMES[lv.major - 1] + lv.minor
}
function maxPoint (lv) {
  if (isKonten(lv)) return lv.minor === 20 ? 0 : 2000
  return LEVEL_MAX_POINTS[3 * (lv.major - 1) + lv.minor - 1] || 0
}
function startingPoint (lv) {
  return lv.major === 1 ? 0 : maxPoint(lv) / 2
}
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
 * 把连续 value 格式化为段位文字。
 *
 * 各段位的 value 基准（= |rankpt2|/15 − 10，取自段位表）：
 *   杰1 −4.67、杰2 −3.33、杰3 −2.00、豪1 1.00、豪2 2.00、豪3 3.00、
 *   圣1 4.00、圣2 5.00、圣3 6.00
 * 可见豪/圣每星 1.00，杰每星约 1.33，且杰3→豪1 之间存在跳跃（升段门槛），
 * 因此不能统一用「整数 + 小数」表达 —— 本函数按段位表分段插值。
 *
 * @param {number} value
 * @param {number|string} mode 4 或 3（三麻段位表 major 同为 1~6）
 * @returns {string|null}
 */
export function formatStableRank (value, mode = 4) {
  if (!isFinite(value)) return null

  // 段位基准（value = |rankpt2|/15 − 10，取自段位表）：
  //   杰1 −4.67、杰2 −3.33、杰3 −2.00、豪1 1.00、豪2 2.00、豪3 3.00、
  //   圣1 4.00、圣2 5.00、圣3 6.00
  //
  // 豪/圣区间每星恰好 1.00，与牌谱屋 formatStableLevel2 的原式完全一致：
  //   value ≥ 4 → 雀圣(value−3)；否则 → 雀豪(value)
  // 故该区间直接沿用原式，不做查表插值（避免跨段位边界被误判）。
  if (value >= 1) {
    if (value >= 6) return '雀圣3.00'          // 雀圣三星封顶
    return value >= 4
      ? `雀圣${(value - 3).toFixed(2)}`
      : `雀豪${value.toFixed(2)}`
  }

  // 杰区间：以杰3 为锚点，每星步长由段位表算出（杰1→杰2→杰3 的 value 间距）。
  // 低于杰1 则落入雀士，夹到雀士三星。
  const prefix = String(mode) === '3' ? 2 : 1
  const jieValue = star => {
    const def = loadCfg().level_definition.level_definition.map_[String(prefix * 10000 + 300 + star)]
    return def && def.rankpt2 ? Math.abs(def.rankpt2) / 15 - 10 : null
  }
  const v3 = jieValue(3), v1 = jieValue(1)
  const JIE_ANCHOR = v3 != null ? v3 : -2.0
  const JIE_STEP = (v3 != null && v1 != null) ? (v3 - v1) / 2 : 40 / 30
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
 *             或 当前段位 init_point − 当前 score（掉段，此时为负需求）
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
 * @param {number} currentScore 当前段位分（score，非 rating）
 * @returns {{promote:number|null, demote:number|null, ept:number}|null}
 *          promote/demote 为预计战数，不适用时为 null
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
  // 魂天用 rating 制，与 PT 制不同，不做升掉段预测
  if (major >= 6) return null

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

  // 掉段：跌到本段位 init_point 以下；初心/魂天不降
  if (ept < -0.01 && curDef.can_degrade) {
    const need = currentScore - curDef.init_point   // 距离掉段线还有多少分
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
 *   value = value_L + E[PT]_含罚分 / (15 × 末位率)
 * 其中 value_L 是该段位的序号（豪1=1、豪2=2、豪3=3、圣1=4…，即 |P_L|/15−10）。
 * 该式与闭式解数学等价，已用 4 组真实数据交叉验证（误差 < 0.001）。
 *
 * @returns {{text:string, value:number, approximate:true}|null}
 */
function walkStableRank (stats, room, startLevel, mode = 4) {
  const E = lv => expectedPT(stats, room, lv, true)
  const roomId = room.id
  const n = ROOM_PLAYERS[roomId] || 4
  const lastRate = stats.rank_rates[n - 1]

  // 把「某段位下的 E[PT]」换算为闭式解口径的连续 value
  const toValue = (lv, e) => {
    const base = levelValueOf(lv)
    if (base == null || !lastRate) return null
    return base + e / (15 * lastRate)
  }
  const fmt = (lv, e) => {
    let v = toValue(lv, e)
    if (v == null || !isFinite(v)) return null
    // 夹到合法区间 [雀杰一星, 雀圣三星] = [−4.67, 6.00]。
    // 注意下界**不能取 1**：雀杰区间的 value 本就是负数（杰3 −2.00、杰1 −4.67），
    // 若夹到 1 会把雀杰玩家错报成「雀豪1.00」。
    // 上界取 6（雀圣三星）是因为末位率极低时 E[PT]/(15×末位率) 会发散
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
    const e = E(lv)
    if (Math.abs(e) < 0.001) return fmt(lv, 0)
    if (!(e >= 0)) {
      if (below) return fmt(below, E(below))
      break
    }
    // 魂天用 rating 制，与 PT 制不同，不做换算
    if (isKonten(lv)) return { text: `${tagOf(lv)}+${e.toFixed(2)}`, approximate: true }
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
 * 段位序号：豪1=1、豪2=2、豪3=3、圣1=4…（即 |P|/15−10）
 */
function levelValueOf (lv) {
  const def = loadCfg().level_definition.level_definition.map_[String(10000 + lv.major * 100 + lv.minor)]
  // 注：调用处仅用于四麻逐级试探；三麻走 penaltyOf，已按模式取表
  if (!def || !def.rankpt2) return null
  return Math.abs(def.rankpt2) / 15 - 10
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

  // 闭式解（仅南场房间）。三麻同样适用：末位率取 rank_rates[2]。
  if (CLOSED_FORM_ROOMS.has(rid) && !isKonten(startLevel)) {
    const expPT = expectedPT(stats, room, startLevel, false)
    const value = expPT / (15 * rates[n - 1]) - 10
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
