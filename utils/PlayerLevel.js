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
    this._majorRank = Math.floor(realId / 100)
    this._minorRank = realId % 100
    this._numPlayerId = Math.floor(levelId / 10000)

    this.major_rank = this.getFullTag()
    this.minor_rank = this._minorRank
    
    if (this.isTenhou()) {
      this.full_tag = this.major_rank
    } else {
      this.full_tag = `${this.major_rank}${this.minor_rank}`
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
    let rankIndex = this.isKonten() ? LEVEL_KONTEN - 2 : this._majorRank - 1
    
    if (!this.isKonten() && this._majorRank <= PLAYER_RANKS_DETAIL.length) {
      const maxPoint = this.getMaxPoint()
      if (maxPoint > 0 && this.score >= maxPoint) {
        if (rankIndex + 1 < PLAYER_RANKS_DETAIL.length) {
          rankIndex++
        }
      }
    }
    
    return PLAYER_RANKS_DETAIL[rankIndex] || PLAYER_RANKS_DETAIL[this._majorRank - 1]
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
  1: '般',
  2: '般东',
  3: '上',
  4: '上东',
  5: '特',
  6: '特东',
  7: '凤凰',
  8: '银之间',
  9: '金之间',
  10: '玉之间',
  12: '王座之间',
  14: '翡翠之间',
  15: '钻石之间',
  16: '大师之间',
  17: '名人之间'
};

export const ROOM_LEVEL_MAP_3P = {
  1: '般',
  2: '般东',
  3: '上',
  4: '上东',
  5: '特',
  6: '特东',
  7: '凤凰',
  8: '银之间三麻',
  11: '金之间三麻',
  13: '玉之间三麻',
  18: '王座之间三麻',
  19: '翡翠之间三麻',
  20: '钻石之间三麻',
  21: '大师之间三麻',
  22: '名人之间三麻'
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