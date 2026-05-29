const PLAYER_RANKS = "初士杰豪圣魂"
const PLAYER_RANKS_DETAIL = ["初心", "雀士", "雀杰", "雀豪", "雀圣", "魂天"]
const LEVEL_KONTEN = 7
const LEVEL_MAX_POINT_KONTEN = 2000

export class PlayerLevel {
  constructor(levelId, score = 0) {
    this.id = levelId
    const realId = levelId % 10000
    this.score = score
    this.realId = realId
    
    // 正确解析段位ID
    // 段位ID格式: 101=初心1, 201=雀士1, 301=雀杰1, 401=雀豪1, 501=雀圣1, 601=魂天
    let majorRank = Math.floor(realId / 100)
    let minorRank = realId % 100
    
    // 防御性处理：确保段位在有效范围内
    if (majorRank < 1 || majorRank > PLAYER_RANKS_DETAIL.length) {
      majorRank = 1
    }
    if (minorRank < 1 || minorRank > 3) {
      minorRank = 1
    }
    
    this._majorRank = majorRank
    this._minorRank = minorRank
    this._numPlayerId = Math.floor(levelId / 10000)

    this.major_rank = this.getFullTag()
    this.minor_rank = this._minorRank
    
    if (this.isTenhou()) {
      this.full_tag = this.major_rank
    } else {
      this.full_tag = `${this.major_rank}${this._minorRank}`
    }

    this.real_score = this.getVersionAdjustedScore(score)
    this.real_display_score = this.formatAdjustedScore(score)
  }
  
  isTenhou() {
    return this.getFullTag() === '魂天'
  }

  isKonten() {
    return this._majorRank >= LEVEL_KONTEN - 1
  }

  getVersionAdjustedScore(score) {
    if (this._majorRank === LEVEL_KONTEN - 1) {
      return Math.floor(score / 100) * 10 + 200
    }
    return score
  }

  getScoreDisplay(score) {
    let s = this.getVersionAdjustedScore(score)
    if (this.isKonten()) {
      return (s / 100).toFixed(1)
    }
    return String(s)
  }

  getMaxPoint() {
    if (this.isKonten()) {
      if (this._minorRank === 20) return 0
      return LEVEL_MAX_POINT_KONTEN
    }
    const LEVEL_MAX_POINTS = [20, 80, 200, 600, 800, 1000, 1200, 1400, 2000, 2800, 3200, 3600, 4000, 6000, 9000]
    return LEVEL_MAX_POINTS[(this._majorRank - 1) * 3 + this._minorRank - 1] || 0
  }

  getMaxPointScoreDisplay() {
    let maxPoint = this.getMaxPoint()
    if (this.isKonten()) {
      return (maxPoint / 100).toFixed(1)
    }
    return String(maxPoint)
  }

  formatAdjustedScore(score) {
    if (this.isTenhou()) {
      return String(score)
    }
    let scoreDisplay = this.getScoreDisplay(score)
    if (!this.getMaxPoint()) {
      return scoreDisplay
    }
    return `${scoreDisplay}/${this.getMaxPointScoreDisplay()}`
  }

  getFullTag() {
    if (this._majorRank <= 0) {
      return PLAYER_RANKS_DETAIL[0]
    }
    
    let rankIndex = this.isKonten() ? LEVEL_KONTEN - 2 : this._majorRank - 1
    
    if (!this.isKonten() && this._majorRank <= PLAYER_RANKS_DETAIL.length) {
      const maxPoint = this.getMaxPoint()
      // 只有当分数在合理范围内（不超过10000）时才进行升级检查
      // 避免对局点数（如36100）被错误当作段位分数处理
      if (maxPoint > 0 && this.score >= maxPoint && this.score <= 10000) {
        if (rankIndex + 1 < PLAYER_RANKS_DETAIL.length) {
          rankIndex++
        }
      }
    }
    
    return PLAYER_RANKS_DETAIL[rankIndex] || PLAYER_RANKS_DETAIL[this._majorRank - 1] || PLAYER_RANKS_DETAIL[0]
  }

  getTag() {
    return this.full_tag
  }
}

export const playerStatsZero = {
  count: 0,
  level: { id: 10101, score: 0, delta: 0 },
  max_level: { id: 10101, score: 0, delta: 0 },
  rank_rates: [0, 0, 0, 0],
  rank_avg_score: [0, 0, 0, 0],
  avg_rank: 4,
  negative_rate: 0,
  id: 0,
  nickname: "Player",
  played_modes: [12, 11, 8, 9]
}

export const playerExtendZero = {
  count: 0,
  "和牌率": 0, "自摸率": 0, "默听率": 0, "放铳率": 0, "副露率": 0, "立直率": 0,
  "平均打点": 0, "最大连庄": 0, "和了巡数": 0, "平均铳点": 0, "流局率": 0,
  "流听率": 0, "一发率": 0, "里宝率": 0, "被炸率": 0, "平均被炸点数": 0,
  "放铳时立直率": 0, "放铳时副露率": 0, "立直后放铳率": 0, "立直后非瞬间放铳率": 0,
  "副露后放铳率": 0, "立直后和牌率": 0, "副露后和牌率": 0, "立直后流局率": 0,
  "副露后流局率": 0, "放铳至立直": 0, "放铳至副露": 0, "放铳至默听": 0,
  "立直和了": 0, "副露和了": 0, "默听和了": 0, "立直巡目": 0, "立直收支": 0,
  "立直收入": 0, "立直支出": 0, "先制率": 0, "追立率": 0, "被追率": 0,
  "振听立直率": 0, "立直好型": 0, "立直多面": 0, "立直好型2": 0, "最大累计番数": 0,
  "W立直": 0, "打点效率": 0, "铳点损失": 0, "净打点效率": 0, "平均起手向听": 0,
  "平均起手向听亲": 0, "平均起手向听子": 0,
  "最近大铳": { id: "", start_time: 0, fans: [] },
  id: 0, played_modes: [9, 11, 8, 12]
}

export const ROOM_LEVEL_MAP_4P = {
  1: '铜之间',
  2: '铜之间 · 四人东',
  3: '铜之间 · 四人南',
  4: '银之间',
  5: '银之间 · 四人东',
  6: '银之间 · 四人南',
  7: '金之间',
  8: '金之间 · 四人东',
  9: '金之间 · 四人南',
  10: '玉之间',
  11: '玉之间 · 四人东',
  12: '玉之间 · 四人南',
  15: '王座间 · 四人东',
  16: '王座间 · 四人南'
};

export const ROOM_LEVEL_MAP_3P = {
  17: '铜之间 · 三人东',
  18: '铜之间 · 三人南',
  19: '银之间 · 三人东',
  20: '银之间 · 三人南',
  21: '金之间 · 三人东',
  22: '金之间 · 三人南',
  23: '玉之间 · 三人东',
  24: '玉之间 · 三人南',
  25: '王座间 · 三人东',
  26: '王座间 · 三人南'
};

export function getRoomName(modeId) {
  if (ROOM_LEVEL_MAP_4P[modeId]) {
    return ROOM_LEVEL_MAP_4P[modeId];
  }
  if (ROOM_LEVEL_MAP_3P[modeId]) {
    return ROOM_LEVEL_MAP_3P[modeId];
  }
  return `房间${modeId}`;
}

export function isThreePlayerMode(modeId) {
  return !!ROOM_LEVEL_MAP_3P[modeId];
}