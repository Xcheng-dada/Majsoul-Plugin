// plugins/Majsoul-Plugin/utils/GachaRedpacket.js
// 辉玉红包：master 印钞群发，群友拼手气抢，5 分钟过期
// 存储：SQLite majsoul_redpackets / majsoul_redpacket_shares / majsoul_redpacket_claims / majsoul_redpools
// 进行中的红包一群最多一个（chat_id 主键），新红包覆盖旧红包
// 公共红包池：过期/被覆盖红包未领完的辉玉进入池子，下一次发红包时自动注入本包一起发放
// 抢红包/结算使用 better-sqlite3 同步事务，单进程内天然原子（替代旧 Redis Lua 脚本）

import { getDatabase } from './MajsoulDatabase.js';

const EXPIRE_SECONDS = 300;

export default class GachaRedpacket {
  /**
   * 创建红包（一群一个，新红包覆盖旧红包）
   * 旧红包未领完的剩余 + 公共红包池累计，自动注入本包一起发放
   * @param {string|number} groupId
   * @param {string|number} owner 发红包人
   * @param {number} total 总辉玉（不含公共池注入部分）
   * @param {number} count 份数
   * @returns {{ ok: boolean, amounts?: number[], poolBonus?: number, total?: number, reason?: string }}
   */
  async create(groupId, owner, total, count) {
    total = Math.floor(Number(total));
    count = Math.floor(Number(count));
    if (!total || total <= 0 || !count || count <= 0) {
      return { ok: false, reason: '金额和数量必须为正整数' };
    }
    if (count > 100) {
      return { ok: false, reason: '红包数量最多 100 份' };
    }
    if (total < count) {
      return { ok: false, reason: '总金额需不小于份数（每份至少 1 辉玉）' };
    }

    // 结算公共红包池：旧红包未领完剩余 + 池子累计，随本包发放
    const db = getDatabase();
    const gid = String(groupId);
    let poolBonus = 0;
    try {
      const tx = db.transaction(() => {
        // 旧红包剩余份额（新红包覆盖旧红包，领取记录与份额随外键级联删除）
        const oldShares = db.prepare(
          'SELECT s.amount FROM majsoul_redpacket_shares s JOIN majsoul_redpackets p ON p.chat_id = s.packet_id WHERE p.chat_id = ?'
        ).all(gid);
        for (const s of oldShares) poolBonus += s.amount || 0;
        db.prepare('DELETE FROM majsoul_redpackets WHERE chat_id = ?').run(gid);
        // 公共池累计并清零
        const pool = db.prepare('SELECT amount FROM majsoul_redpools WHERE chat_id = ?').get(gid);
        if (pool) {
          poolBonus += pool.amount || 0;
          db.prepare('UPDATE majsoul_redpools SET amount = 0, updated_at = ? WHERE chat_id = ?').run(Date.now(), gid);
        }
      });
      tx();
    } catch (error) {
      logger.error('[GachaRedpacket] 结算公共红包池失败:', error);
      poolBonus = 0;
    }

    const effectiveTotal = total + poolBonus;

    // 二倍均值法预拆分
    const amounts = [];
    let remaining = effectiveTotal;
    let slots = count;
    for (let i = 0; i < count - 1; i++) {
      const avg = remaining / slots;
      let amount = 1 + Math.floor(Math.random() * (2 * avg - 1));
      if (amount > remaining - (slots - 1)) amount = remaining - (slots - 1);
      amounts.push(amount);
      remaining -= amount;
      slots--;
    }
    amounts.push(remaining);

    try {
      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          'INSERT INTO majsoul_redpackets (chat_id, owner, total, count, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(gid, String(owner), effectiveTotal, count, now + EXPIRE_SECONDS * 1000, now);
        const insertShare = db.prepare(
          'INSERT INTO majsoul_redpacket_shares (packet_id, seq, amount) VALUES (?, ?, ?)'
        );
        amounts.forEach((amount, seq) => insertShare.run(gid, seq, amount));
      });
      tx();
      // 到期定时结算：向群里播报进入公共池的金额（与抢红包结算互为原子，谁先到谁结算）
      this._scheduleSettle(gid);
      return { ok: true, amounts, poolBonus, total: effectiveTotal };
    } catch (error) {
      logger.error('[GachaRedpacket] 创建红包失败:', error);
      return { ok: false, reason: '创建红包失败，系统异常' };
    }
  }

  /** 红包到期后结算剩余入公共池，并向群里播报 */
  _scheduleSettle(groupId) {
    const timer = setTimeout(async () => {
      try {
        const leftover = await this.settleExpired(groupId);
        if (leftover > 0 && typeof Bot !== 'undefined' && Bot?.pickGroup) {
          const group = Bot.pickGroup(String(groupId));
          await group?.sendMsg?.(`本群红包已过期，${leftover} 辉玉进入公共红包池，将随下一次发红包一起发放`);
        }
      } catch (error) {
        logger.error('[GachaRedpacket] 红包过期结算失败:', error);
      }
    }, EXPIRE_SECONDS * 1000 + 3000);
    timer.unref?.();
  }

  /**
   * 结算已过期红包：剩余金额注入公共池并删除红包，返回结算金额（未过期/不存在返回 0）
   */
  async settleExpired(groupId) {
    try {
      const db = getDatabase();
      const gid = String(groupId);
      let leftover = 0;
      const tx = db.transaction(() => {
        const packet = db.prepare('SELECT expire_at FROM majsoul_redpackets WHERE chat_id = ?').get(gid);
        if (!packet || Date.now() <= packet.expire_at) return;
        const rows = db.prepare(
          'SELECT amount FROM majsoul_redpacket_shares WHERE packet_id = ?'
        ).all(gid);
        for (const r of rows) leftover += r.amount || 0;
        // 红包删除后剩余份额与领取记录随外键级联清除
        db.prepare('DELETE FROM majsoul_redpackets WHERE chat_id = ?').run(gid);
        if (leftover > 0) {
          db.prepare(
            'INSERT INTO majsoul_redpools (chat_id, amount, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(chat_id) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at'
          ).run(gid, leftover, Date.now());
        }
      });
      tx();
      return leftover;
    } catch (error) {
      logger.error('[GachaRedpacket] 过期结算失败:', error);
      return 0;
    }
  }

  /**
   * 抢红包（事务原子；过期时剩余自动注入公共红包池）
   * @returns {{ ok: boolean, amount?: number, reason?: string }}
   */
  async grab(groupId, userId) {
    try {
      const db = getDatabase();
      const gid = String(groupId);
      const uid = String(userId);
      const now = Date.now();
      let result = null;
      const tx = db.transaction(() => {
        const packet = db.prepare('SELECT expire_at FROM majsoul_redpackets WHERE chat_id = ?').get(gid);
        if (!packet) {
          result = { ok: false, reason: '红包已过期或不存在' };
          return;
        }
        // 已过期：剩余注入公共池后删除，返回过期码
        if (now > packet.expire_at) {
          const rows = db.prepare('SELECT amount FROM majsoul_redpacket_shares WHERE packet_id = ?').all(gid);
          let leftover = 0;
          for (const r of rows) leftover += r.amount || 0;
          db.prepare('DELETE FROM majsoul_redpackets WHERE chat_id = ?').run(gid);
          if (leftover > 0) {
            db.prepare(
              'INSERT INTO majsoul_redpools (chat_id, amount, updated_at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(chat_id) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at'
            ).run(gid, leftover, now);
          }
          result = { ok: false, reason: '红包已过期或不存在' };
          return;
        }
        // 领取记录主键 (packet_id, user_id) 拒绝重复领取
        if (db.prepare('SELECT 1 FROM majsoul_redpacket_claims WHERE packet_id = ? AND user_id = ?').get(gid, uid)) {
          result = { ok: false, reason: '你已经抢过这个红包啦' };
          return;
        }
        // 取最大 seq 的剩余份额（与旧版"从数组尾部取出"一致）
        const share = db.prepare(
          'SELECT seq, amount FROM majsoul_redpacket_shares WHERE packet_id = ? ORDER BY seq DESC LIMIT 1'
        ).get(gid);
        if (!share) {
          result = { ok: false, reason: '手慢了，红包已被抢完' };
          return;
        }
        db.prepare('DELETE FROM majsoul_redpacket_shares WHERE packet_id = ? AND seq = ?').run(gid, share.seq);
        db.prepare(
          'INSERT INTO majsoul_redpacket_claims (packet_id, user_id, amount, claimed_at) VALUES (?, ?, ?, ?)'
        ).run(gid, uid, share.amount, now);
        result = { ok: true, amount: share.amount };
      });
      tx();
      return result;
    } catch (error) {
      logger.error('[GachaRedpacket] 抢红包失败:', error);
      return { ok: false, reason: '抢红包失败，系统异常' };
    }
  }
}
