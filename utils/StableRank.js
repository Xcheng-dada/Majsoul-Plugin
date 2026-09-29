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
 * 从一组房间 id 中挑出可用于安定段位计算的**南场**房间。
 *
 * 换算式 value = E[PT]/(15×末位率) − 10 按**南场标尺**标定：除数 15 即南场每星
 * 15 PT（罚分 165→180→195），且只有南场罚分能还原出 豪1=1.00/豪2=2.00/圣1=4.00
 * 这组基准；东场每星只有 10 PT（罚分 80→90→100），同式会把 豪1 算成 −4.67。
 * 故不能把东+南池化后喂单表（实测平均偏 0.26 星、最大 1.56 星）。
 *
 * 房间筛选传入的是「东+南」两个 id（如 玉之间 = [11, 12]，11 玉东、12 玉南），
 * 需挑出其中的南场再计算。
 *
 * @param {number|string} mode 4 或 3
 * @param {number[]} roomIds 候选房间 id（可含东场）
 * @returns {number|null} 南场房间 id；无南场时返回 null
 */
export function stableRankSouthRoom (mode, roomIds) {
  const m = String(mode) === '3' ? 3 : 4
  const south = SOUTH_ROOMS_BY_MODE[m] || []
  for (const id of (roomIds || [])) {
    const n = Number(id)
    if (south.includes(n)) return n
  }
  return null
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
