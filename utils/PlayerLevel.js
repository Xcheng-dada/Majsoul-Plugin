// plugins/Majsoul-Plugin/utils/PlayerLevel.js

// 段位常量
const PLAYER_RANKS = "初士杰豪圣魂";
const PLAYER_RANKS_DETAIL = ["初心", "雀士", "雀杰", "雀豪", "雀圣", "魂天"];
const LEVEL_KONTEN = 7; // 魂天
const LEVEL_MAX_POINT_KONTEN = 2000;

// 段位最大分数
const LEVEL_MAX_POINTS = [
    20, 80, 200, 600, 800, 1000, 1200, 1400, 2000,
    2800, 3200, 3600, 4000, 6000, 9000
];

export default class PlayerLevel {
    constructor(levelId, score = 0) {
        this.id = levelId;
        this.score = score;
        
        // 计算真实的等级ID（去掉玩家编号部分）
        const realId = levelId % 10000;
        this.realId = realId;
        
        // 主段位（前两位）
        this._majorRank = Math.floor(realId / 100);
        
        // 子段位（后两位）
        this._minorRank = realId % 100;
        
        // 玩家编号（前几位）
        this._numPlayerId = Math.floor(levelId / 10000);
        
        // 预计算常用属性
        this.major_rank = this.getFullTag();
        this.minor_rank = this._minorRank;
        this.full_tag = `${this.major_rank}${this.minor_rank}`;
        this.real_score = this.getVersionAdjustedScore(score);
        this.real_display_score = this.formatAdjustedScore(score);
        this.real_level_tag_with_score = this.formatAdjustedScoreWithTag(score);
    }
    
    // 获取段位标签（如"雀士1"）
    getTag() {
        const label = PLAYER_RANKS[this.isKonten() ? LEVEL_KONTEN - 2 : this._majorRank - 1];
        
        if (this._majorRank === LEVEL_KONTEN - 1) {
            return label;
        }
        
        if (this._minorRank === 1) return label + "一";
        if (this._minorRank === 2) return label + "二";
        if (this._minorRank === 3) return label + "三";
        
        return label + this._minorRank;
    }
    
    // 获取详细段位标签（如"雀士"）
    getFullTag() {
        return PLAYER_RANKS_DETAIL[this.isKonten() ? LEVEL_KONTEN - 2 : this._majorRank - 1];
    }
    
    // 是否为魂天段位
    isKonten() {
        return this._majorRank >= LEVEL_KONTEN - 1;
    }
    
    // 获取最大分数
    getMaxPoint() {
        if (this.isKonten()) {
            if (this._minorRank === 20) return 0; // 魂天20星无上限
            return LEVEL_MAX_POINT_KONTEN;
        }
        
        const index = (this._majorRank - 1) * 3 + this._minorRank - 1;
        return LEVEL_MAX_POINTS[index] || 0;
    }
    
    // 获取调整后的等级（用于魂天段位特殊处理）
    getVersionAdjustedLevel() {
        if (this._majorRank !== LEVEL_KONTEN - 1) {
            return this;
        }
        return new PlayerLevel(this._numPlayerId * 10000 + LEVEL_KONTEN * 100 + 1);
    }
    
    // 获取调整后的分数
    getVersionAdjustedScore(score) {
        if (this._majorRank === LEVEL_KONTEN - 1) {
            return Math.floor(score / 100) * 10 + 200;
        }
        return score;
    }
    
    // 获取分数显示
    getScoreDisplay(score) {
        const adjustedScore = this.getVersionAdjustedScore(score);
        if (this.isKonten()) {
            return (adjustedScore / 100).toFixed(1);
        }
        return adjustedScore.toString();
    }
    
    // 获取最大分数显示
    getMaxPointScoreDisplay() {
        const maxPoint = this.getMaxPoint();
        if (this.isKonten()) {
            return (maxPoint / 100).toFixed(1);
        }
        return maxPoint.toString();
    }
    
    // 格式化调整后的分数
    formatAdjustedScore(score) {
        const scoreDisplay = this.getScoreDisplay(score);
        const maxPoint = this.getMaxPoint();
        
        if (!maxPoint) {
            return scoreDisplay;
        }
        
        return `${scoreDisplay}/${this.getMaxPointScoreDisplay()}`;
    }
    
    // 格式化带标签的分数
    formatAdjustedScoreWithTag(score) {
        return `${this.getTag()} ${this.formatAdjustedScore(score)}`;
    }
    
    // 获取下一个段位
    getNextLevel() {
        const level = this.getVersionAdjustedLevel();
        let majorRank = level._majorRank;
        let minorRank = level._minorRank + 1;
        
        if (minorRank > 3 && !level.isKonten()) {
            majorRank += 1;
            minorRank = 1;
        }
        
        if (majorRank === LEVEL_KONTEN - 1) {
            majorRank = LEVEL_KONTEN;
        }
        
        return new PlayerLevel(level._numPlayerId * 10000 + majorRank * 100 + minorRank);
    }
    
    // 获取上一个段位
    getPreviousLevel() {
        if (this._majorRank === 1 && this._minorRank === 1) {
            return this;
        }
        
        const level = this.getVersionAdjustedLevel();
        let majorRank = level._majorRank;
        let minorRank = level._minorRank - 1;
        
        if (minorRank < 1) {
            majorRank -= 1;
            minorRank = 3;
        }
        
        if (majorRank === LEVEL_KONTEN - 1) {
            majorRank = LEVEL_KONTEN - 2;
        }
        
        return new PlayerLevel(level._numPlayerId * 10000 + majorRank * 100 + minorRank);
    }
    
    // 根据分数调整段位
    getAdjustedLevel(score) {
        const adjustedScore = this.getVersionAdjustedScore(score);
        const level = this.getVersionAdjustedLevel();
        const maxPoints = level.getMaxPoint();
        
        if (maxPoints && adjustedScore >= maxPoints) {
            const nextLevel = level.getNextLevel();
            nextLevel.score = nextLevel.getStartingPoint();
            return nextLevel;
        }
        
        if (adjustedScore < 0) {
            if (!maxPoints || level._majorRank === 1 || (level._majorRank === 2 && level._minorRank === 1)) {
                level.score = 0;
                return level;
            }
            
            const prevLevel = level.getPreviousLevel();
            prevLevel.score = prevLevel.getStartingPoint();
            return prevLevel;
        }
        
        level.score = adjustedScore;
        return level;
    }
    
    // 获取起始分数
    getStartingPoint() {
        if (this._majorRank === 1) return 0;
        return this.getMaxPoint() / 2;
    }
    
    // 转换为等级ID
    toLevelId() {
        return this._numPlayerId * 10000 + this._majorRank * 100 + this._minorRank;
    }
    
    // 判断是否相同主段位
    isSameMajorRank(other) {
        return this._majorRank === other._majorRank;
    }
    
    // 判断是否相同
    isSame(other) {
        if (this.isKonten() && other.isKonten()) {
            if (this._majorRank === LEVEL_KONTEN - 1 || other._majorRank === LEVEL_KONTEN - 1) {
                return true;
            }
            return this._majorRank === other._majorRank && this._minorRank === other._minorRank;
        }
        return false;
    }
}