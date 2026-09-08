// plugins/Majsoul-Plugin/utils/GachaSign.js
// 雀魂每日签到：随机辉玉 + 寻觅卷轴，暴击、连签第7天送十连寻觅卷轴、首次欢迎礼包
import { getFeatureConfigItem } from './Config.js';

const REDIS_PREFIX = 'Yunzai:majsoul_gacha:sign:';

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return dateStr(new Date());
}

function yesterdayStr() {
  return dateStr(new Date(Date.now() - 86400 * 1000));
}

export default class GachaSign {
  _key(userId) {
    return `${REDIS_PREFIX}${userId}`;
  }

  // 读取签到数据
  async get(userId) {
    try {
      const raw = await redis.get(this._key(userId));
      const data = raw ? JSON.parse(raw) : {};
      return {
        lastDate: data.lastDate || null,
        streak: Math.max(0, Math.floor(Number(data.streak) || 0)),
        totalDays: Math.max(0, Math.floor(Number(data.totalDays) || 0)),
        welcomed: !!data.welcomed
      };
    } catch (error) {
      logger.error(`[GachaSign] 读取签到数据失败 userId=${userId}:`, error);
      return { lastDate: null, streak: 0, totalDays: 0, welcomed: false };
    }
  }

  /**
   * 执行签到
   * @param {string|number} userId
   * @returns {object} { already, streak, totalDays, jade, crit, ticket, ticket10, welcome }
   */
  async sign(userId) {
    const data = await this.get(userId);

    if (data.lastDate === todayStr()) {
      return { already: true, streak: data.streak, totalDays: data.totalDays };
    }

    // 连签判断：昨天签过则 +1，否则重新计数
    const streak = data.lastDate === yesterdayStr() ? data.streak + 1 : 1;

    // 随机辉玉 + 暴击（暴击=直接取当日上限，保证单日不超上限值）
    const min = Math.max(0, Number(getFeatureConfigItem('signJadeMin')) || 150);
    const max = Math.max(min, Number(getFeatureConfigItem('signJadeMax')) || 250);
    let jade = min + Math.floor(Math.random() * (max - min + 1));
    const critRate = Math.min(100, Math.max(0, Number(getFeatureConfigItem('signCritRate')) || 8));
    const crit = Math.random() * 100 < critRate;
    if (crit) jade = max;

    // 基础奖励：1 寻觅卷轴；连签第 7 天加 1 张十连寻觅卷轴
    let ticket = 1;
    let ticket10 = 0;
    if (streak % 7 === 0) ticket10 = 1;

    // 首次签到欢迎礼包
    let welcome = false;
    if (!data.welcomed) {
      jade += 500;
      ticket += 1;
      welcome = true;
    }

    const totalDays = data.totalDays + 1;
    try {
      await redis.set(this._key(userId), JSON.stringify({
        lastDate: todayStr(),
        streak,
        totalDays,
        welcomed: true
      }));
    } catch (error) {
      logger.error(`[GachaSign] 保存签到数据失败 userId=${userId}:`, error);
    }

    return { already: false, streak, totalDays, jade, crit, ticket, ticket10, welcome };
  }
}
