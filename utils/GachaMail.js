// plugins/Majsoul-Plugin/utils/GachaMail.js
// 奖励邮件：管理员按雀魂官方兑换码内容群发奖励（仅当前群可领，30 天过期）
// 数据结构 Yunzai:majsoul_gacha:mail:{groupId}（永久 key，条目自带 expireAt，读取时惰性清理）：
// [{ id, title, rewards: {dust:5, ticket:1}, createdAt, expireAt, claimed: [userId] }]

import { NAME_TO_KEY } from './GachaWallet.js';

const REDIS_PREFIX = 'Yunzai:majsoul_gacha:mail:';
const MAIL_TTL_DAYS = 30;
const MAX_MAILS = 50; // 每群最多保留邮件数（超出丢弃最旧）

export default class GachaMail {
  _key(groupId) {
    return `${REDIS_PREFIX}${groupId}`;
  }

  // 读取并惰性清理过期邮件
  async list(groupId) {
    let mails = [];
    try {
      const raw = await redis.get(this._key(groupId));
      mails = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(mails)) mails = [];
    } catch (error) {
      logger.error(`[GachaMail] 读取邮件失败 groupId=${groupId}:`, error);
      return [];
    }

    const now = Date.now();
    const active = mails.filter(m => m && m.expireAt > now);
    if (active.length !== mails.length) {
      try {
        await redis.set(this._key(groupId), JSON.stringify(active));
      } catch { /* 清理失败不影响本次读取 */ }
    }
    return active;
  }

  /**
   * 发送奖励邮件（覆盖式追加，最旧的超出上限时丢弃）
   * @param {string|number} groupId
   * @param {object} rewards 各货币数量，如 { dust: 5, ticket: 1 }
   * @param {string} title 邮件标题
   * @returns {object} 创建的邮件条目
   */
  async send(groupId, rewards, title) {
    const mails = await this.list(groupId);
    const now = Date.now();
    const mail = {
      id: `${now.toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      title: title || '雀魂官方兑换码奖励',
      rewards,
      createdAt: now,
      expireAt: now + MAIL_TTL_DAYS * 86400 * 1000,
      claimed: []
    };
    mails.unshift(mail);
    if (mails.length > MAX_MAILS) mails.length = MAX_MAILS;
    await redis.set(this._key(groupId), JSON.stringify(mails));
    return mail;
  }

  /**
   * 领取全部未领邮件奖励
   * @param {string|number} groupId
   * @param {string|number} userId
   * @returns {{ mails: Array<{title, rewards}>, totals: object }} totals 为合计奖励
   */
  async claimAll(groupId, userId) {
    const mails = await this.list(groupId);
    const mailsOut = [];
    const totals = {};
    let changed = false;

    for (const mail of mails) {
      if (Array.isArray(mail.claimed) && mail.claimed.includes(String(userId))) continue;
      (Array.isArray(mail.claimed) ? mail.claimed : (mail.claimed = [])).push(String(userId));
      changed = true;
      mailsOut.push({ title: mail.title, rewards: mail.rewards });
      for (const [key, value] of Object.entries(mail.rewards || {})) {
        totals[key] = (totals[key] || 0) + (Number(value) || 0);
      }
    }

    if (changed) {
      try {
        await redis.set(this._key(groupId), JSON.stringify(mails));
      } catch (error) {
        logger.error(`[GachaMail] 保存领取状态失败 groupId=${groupId}:`, error);
      }
    }
    return { mails: mailsOut, totals };
  }

  /**
   * 解析奖励文本为货币数量（如"星之粉尘5 寻觅卷轴1"、"辉玉x200"）
   * @param {string} text
   * @returns {object|null} rewards；无法解析返回 null
   */
  static parseRewards(text) {
    if (!text) return null;
    let working = String(text);
    const rewards = {};

    // 长名称优先匹配，避免"寻觅卷轴"误匹配"十连寻觅卷轴"
    const names = Object.keys(NAME_TO_KEY).sort((a, b) => b.length - a.length);
    for (const name of names) {
      const re = new RegExp(`${name}\\s*[xX×]?\\s*(\\d+)`);
      const m = working.match(re);
      if (m) {
        const n = parseInt(m[1]);
        if (n > 0) {
          rewards[NAME_TO_KEY[name]] = (rewards[NAME_TO_KEY[name]] || 0) + n;
          working = working.replace(m[0], ' ');
        }
      }
    }
    return Object.keys(rewards).length > 0 ? rewards : null;
  }

  // 奖励转文字描述（如"星之粉尘x5 寻觅卷轴x1"）
  static formatRewards(rewards) {
    const order = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith'];
    const names = {
      jade: '辉玉', ticket: '寻觅卷轴', ticket10: '十连寻觅卷轴', dust: '星之粉尘',
      stone: '星之石', wish: '许愿石', faith: '信仰'
    };
    return order
      .filter(key => rewards[key])
      .map(key => `${names[key]}x${rewards[key]}`)
      .join(' ');
  }
}
