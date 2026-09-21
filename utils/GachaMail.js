// plugins/Majsoul-Plugin/utils/GachaMail.js
// 奖励邮件：管理员向全群发放奖励邮件（任意奖励组合，仅当前群可领，30 天过期）
// 存储：SQLite majsoul_mails + majsoul_mail_claims（永久持久化，读取时惰性清理过期邮件）
// 兼容结构：rewards 仍为 {货币key: 数量} 对象，claimed 为领取用户 id 数组

import { getDatabase } from './MajsoulDatabase.js';
import { NAME_TO_KEY } from './GachaWallet.js';

const MAIL_TTL_DAYS = 30;
const MAX_MAILS = 50; // 每群最多保留邮件数（超出丢弃最旧）

// rewards 对象与固定货币列的映射
const CURRENCY_KEYS = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith'];

export default class GachaMail {
  // 读取某群的全部邮件（新→旧）并惰性清理过期邮件，附带领取记录
  _load(groupId) {
    const db = getDatabase();
    const now = Date.now();
    db.prepare('DELETE FROM majsoul_mails WHERE chat_id = ? AND expire_at <= ?').run(String(groupId), now);
    const rows = db.prepare(
      'SELECT * FROM majsoul_mails WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC'
    ).all(String(groupId));
    const claims = db.prepare(
      'SELECT c.mail_id, c.user_id FROM majsoul_mail_claims c ' +
      'JOIN majsoul_mails m ON m.id = c.mail_id WHERE m.chat_id = ?'
    ).all(String(groupId));
    const claimedMap = new Map();
    for (const c of claims) {
      if (!claimedMap.has(c.mail_id)) claimedMap.set(c.mail_id, []);
      claimedMap.get(c.mail_id).push(String(c.user_id));
    }
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      rewards: this._rewardsFromRow(r),
      createdAt: r.created_at,
      expireAt: r.expire_at,
      claimed: claimedMap.get(r.id) || []
    }));
  }

  // 数据行 → rewards 对象（只含非零货币）
  _rewardsFromRow(row) {
    const rewards = {};
    for (const key of CURRENCY_KEYS) {
      if (row[key] > 0) rewards[key] = row[key];
    }
    return rewards;
  }

  // rewards 对象 → 插入参数
  _rewardParams(rewards) {
    const r = rewards || {};
    return CURRENCY_KEYS.map(key => Math.max(0, Math.floor(Number(r[key]) || 0)));
  }

  // 读取并惰性清理过期邮件
  async list(groupId) {
    try {
      return this._load(groupId);
    } catch (error) {
      logger.error(`[GachaMail] 读取邮件失败 groupId=${groupId}:`, error);
      return [];
    }
  }

  /**
   * 发送奖励邮件（覆盖式追加，最旧的超出上限时丢弃）
   * @param {string|number} groupId
   * @param {object} rewards 各货币数量，如 { dust: 5, ticket: 1 }
   * @param {string} title 邮件标题
   * @returns {object} 创建的邮件条目
   */
  async send(groupId, rewards, title) {
    const now = Date.now();
    const mail = {
      id: `${String(groupId)}:${now.toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      title: title || '奖励邮件',
      rewards,
      createdAt: now,
      expireAt: now + MAIL_TTL_DAYS * 86400 * 1000,
      claimed: []
    };
    const db = getDatabase();
    db.prepare(
      'INSERT INTO majsoul_mails (id, chat_id, title, jade, ticket, ticket10, dust, stone, wish, faith, expire_at, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(mail.id, String(groupId), mail.title, ...this._rewardParams(rewards), mail.expireAt, mail.createdAt);
    // 超出上限丢弃最旧（领取记录随外键级联删除）
    db.prepare(
      'DELETE FROM majsoul_mails WHERE chat_id = ? AND id NOT IN ' +
      '(SELECT id FROM majsoul_mails WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)'
    ).run(String(groupId), String(groupId), MAX_MAILS);
    return mail;
  }

  /**
   * 领取全部未领邮件奖励（事务内标记领取，防重复领取）
   * @param {string|number} groupId
   * @param {string|number} userId
   * @returns {{ mails: Array<{title, rewards}>, totals: object }} totals 为合计奖励
   */
  async claimAll(groupId, userId) {
    const mails = await this.list(groupId);
    const mailsOut = [];
    const totals = {};
    try {
      const db = getDatabase();
      const hasClaim = db.prepare('SELECT 1 FROM majsoul_mail_claims WHERE mail_id = ? AND user_id = ?');
      const markClaim = db.prepare('INSERT INTO majsoul_mail_claims (mail_id, user_id, claimed_at) VALUES (?, ?, ?)');
      const uid = String(userId);
      const tx = db.transaction(() => {
        for (const mail of mails) {
          if (hasClaim.get(mail.id, uid)) continue;
          markClaim.run(mail.id, uid, Date.now());
          mailsOut.push({ title: mail.title, rewards: mail.rewards });
          for (const [key, value] of Object.entries(mail.rewards || {})) {
            totals[key] = (totals[key] || 0) + (Number(value) || 0);
          }
        }
      });
      tx();
    } catch (error) {
      logger.error(`[GachaMail] 保存领取状态失败 groupId=${groupId}:`, error);
    }
    return { mails: mailsOut, totals };
  }

  /**
   * 删除邮件（master）
   * @param {string|number} groupId
   * @param {string} target 序号（1 开始，按列出顺序）或 "all"
   * @returns {{ ok: boolean, reason?: string, removed?: number, mail?: object }}
   */
  async remove(groupId, target) {
    const mails = await this.list(groupId);
    if (mails.length === 0) return { ok: false, reason: '当前没有邮件' };

    if (String(target).trim().toLowerCase() === 'all' || String(target).trim() === '全部') {
      getDatabase().prepare('DELETE FROM majsoul_mails WHERE chat_id = ?').run(String(groupId));
      return { ok: true, removed: mails.length };
    }

    const idx = parseInt(target);
    if (!idx || idx < 1 || idx > mails.length) {
      return { ok: false, reason: `序号无效，有效范围 1-${mails.length}` };
    }
    const [mail] = mails.splice(idx - 1, 1);
    getDatabase().prepare('DELETE FROM majsoul_mails WHERE id = ?').run(mail.id);
    return { ok: true, removed: 1, mail };
  }

  /**
   * 解析奖励文本为货币数量（如"星之粉尘5 寻觅卷轴1"、"辉玉x200"）
   * 非货币的剩余文字作为邮件标题返回（如"新春活动 辉玉100000"→ 标题"新春活动"）
   * @param {string} text
   * @returns {{ rewards: object, title: string }|null} 无有效奖励返回 null
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
    if (Object.keys(rewards).length === 0) return null;
    // 剩余文字清理后作为标题（去掉分隔符、截断过长内容）
    const rest = working.replace(/^[\s,，、/|丨-]+|[\s,，、/|丨-]+$/g, '').slice(0, 20).trim();
    return { rewards, title: rest || '奖励邮件' };
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
