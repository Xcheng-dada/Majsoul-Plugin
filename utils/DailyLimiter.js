// plugins/Majsoul-Plugin/utils/DailyLimiter.js

export default class DailyLimiter {
    constructor(limit) {
        this.limit = limit;
        this.redisPrefix = 'Yunzai:majsoul_gacha:';
    }

    // 计算到第二天0点的剩余秒数
    _getExpireSeconds() {
        try {
            const now = new Date();
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
            const msRemaining = tomorrow.getTime() - now.getTime();
            const secondsRemaining = Math.ceil(msRemaining / 1000);
            return Math.max(1, Math.min(secondsRemaining, 86400));
        } catch (error) {
            logger.error('[DailyLimiter] _getExpireSeconds 错误:', error);
            return 86400; // 默认一天
        }
    }

    // 检查用户今日是否还可抽卡
    async check(userId) {
        try {
            const key = this._getKey(userId);
            const countStr = await redis.get(key);
            const currentCount = countStr ? parseInt(countStr) : 0;
            logger.debug(`[DailyLimiter] 用户 ${userId} 检查: ${currentCount}/${this.limit}`);
            return currentCount < this.limit;
        } catch (error) {
            logger.error('[DailyLimiter] check 错误:', error);
            return true; // 出错时允许抽卡
        }
    }

    // 增加用户今日抽卡次数（每次+1）
    async increase(userId) {
        try {
            const key = this._getKey(userId);
            const expireSeconds = this._getExpireSeconds();
            
            // 使用原子操作增加计数
            const currentCountStr = await redis.get(key);
            let currentCount = currentCountStr ? parseInt(currentCountStr) : 0;
            
            // 抽卡 = 已抽次数 +1
            let newCount = currentCount + 1;
            
            // 边界修正：不能超过每日上限
            if (newCount > this.limit) {
                newCount = this.limit;
            }
            
            // 设置新值并更新过期时间
            await redis.set(key, newCount, 'EX', expireSeconds);
            logger.debug(`[DailyLimiter] 用户 ${userId} 抽卡，已抽次数: ${currentCount} -> ${newCount}`);
            return newCount;
        } catch (error) {
            logger.error('[DailyLimiter] increase 错误:', error);
            return false;
        }
    }

    // 获取用户今日已抽次数
    async getCount(userId) {
        try {
            const key = this._getKey(userId);
            const countStr = await redis.get(key);
            const count = countStr ? parseInt(countStr) : 0;
            logger.debug(`[DailyLimiter] 获取用户 ${userId} 抽卡次数: ${count}`);
            return count;
        } catch (error) {
            logger.error('[DailyLimiter] getCount 错误:', error);
            return 0;
        }
    }

    // 重置指定用户的抽卡次数
    async resetUser(userId) {
        try {
            const key = this._getKey(userId);
            const exists = await redis.exists(key);
            
            if (exists) {
                const deleted = await redis.del(key);
                logger.debug(`[DailyLimiter] 已重置用户 ${userId} 的抽卡记录，删除结果: ${deleted}`);
                return deleted > 0;
            }
            
            logger.debug(`[DailyLimiter] 用户 ${userId} 没有抽卡记录`);
            return false;
        } catch (error) {
            logger.error('[DailyLimiter] resetUser 错误:', error);
            return false;
        }
    }

    // 生成存储键（使用当天日期）
    _getKey(userId) {
        try {
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            return `${this.redisPrefix}${userId}-${dateStr}`;
        } catch (error) {
            logger.error('[DailyLimiter] _getKey 错误:', error);
            return `${this.redisPrefix}${userId}-unknown`;
        }
    }

    // 获取剩余次数
    async getRemaining(userId) {
        try {
            const currentCount = await this.getCount(userId);
            const remaining = Math.max(0, this.limit - currentCount);
            logger.debug(`[DailyLimiter] 用户 ${userId} 剩余次数: ${remaining}`);
            return remaining;
        } catch (error) {
            logger.error('[DailyLimiter] getRemaining 错误:', error);
            return this.limit;
        }
    }

    // 设置特定用户的抽卡次数（管理员功能）
    async setCount(userId, count) {
        try {
            // 验证输入
            if (isNaN(count) || count < 0) {
                logger.error(`[DailyLimiter] setCount 输入无效: userId=${userId}, count=${count}`);
                return false;
            }
            
            const key = this._getKey(userId);
            const safeCount = Math.max(0, Math.min(parseInt(count), this.limit));
            const expireSeconds = this._getExpireSeconds();
            
            logger.debug(`[DailyLimiter] 设置用户 ${userId} 抽卡次数为 ${safeCount}, 过期时间: ${expireSeconds}秒`);
            
            // 设置新值
            await redis.set(key, safeCount, 'EX', expireSeconds);
            return true;
        } catch (error) {
            logger.error('[DailyLimiter] setCount 错误:', error);
            return false;
        }
    }

    // 获取所有用户的抽卡记录（管理员功能）
    async getAllRecords() {
        try {
            const pattern = `${this.redisPrefix}*`;
            logger.debug(`[DailyLimiter] 搜索模式: ${pattern}`);
            
            const keys = await redis.keys(pattern);
            const records = {};
            const todayKey = this._getKey('').replace(this.redisPrefix, '');
            const todayDate = todayKey.split('-').slice(0, 3).join('-');
            
            logger.debug(`[DailyLimiter] 今天日期: ${todayDate}, 找到 ${keys.length} 个key`);

            for (const key of keys) {
                const match = key.match(new RegExp(`${this.redisPrefix}(\\d+)-(\\d{4}-\\d{2}-\\d{2})`));
                if (match) {
                    const userId = match[1];
                    const date = match[2];
                    if (date === todayDate) {
                        const countStr = await redis.get(key);
                        records[userId] = parseInt(countStr) || 0;
                        logger.debug(`[DailyLimiter] 记录: ${userId} = ${records[userId]}`);
                    }
                }
            }
            return records;
        } catch (error) {
            logger.error('[DailyLimiter] getAllRecords 错误:', error);
            return {};
        }
    }

    // 获取距离0点重置的剩余时间
    async getResetTime() {
        try {
            const expireSeconds = this._getExpireSeconds();
            const hours = Math.floor(expireSeconds / 3600);
            const minutes = Math.floor((expireSeconds % 3600) / 60);
            const seconds = expireSeconds % 60;
            return { hours, minutes, seconds, totalSeconds: expireSeconds };
        } catch (error) {
            logger.error('[DailyLimiter] getResetTime 错误:', error);
            return { hours: 0, minutes: 0, seconds: 0, totalSeconds: 0 };
        }
    }

    // 获取格式化的重置时间字符串
    async getFormattedResetTime() {
        try {
            const { hours, minutes, seconds } = await this.getResetTime();
            return `${hours}小时${minutes}分${seconds}秒`;
        } catch (error) {
            logger.error('[DailyLimiter] getFormattedResetTime 错误:', error);
            return "未知时间";
        }
    }
}