// plugins/Majsoul-Plugin/utils/GachaStats.js
// 抽卡累计统计：记录每个用户**累计抽了多少次**
//
// 口径（已与用户确认）：
//   - **全局累计**：跨群累加，同一人在不同群抽卡计入同一份数据
//   - **按抽数计**：单抽 +1、十连 +10（反映「抽了多少次」，而非操作了几回）
//   - **仅总抽数**：不记出货明细、不记流水
//
// 持久化：SQLite（majsoul_gacha_stats 表），与钱包/图鉴同一数据源。
// 计数只在**扣费成功后**调用，抽卡失败退还时不计数。

import { getDatabase } from './MajsoulDatabase.js';

// 预编译语句按连接实例缓存（测试关闭重开后自动重建）
const stmtCache = new WeakMap();

function getStmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    sel: db.prepare(`SELECT qq_id, total_pulls FROM majsoul_gacha_stats WHERE qq_id = ?`),
    upsert: db.prepare(`
      INSERT INTO majsoul_gacha_stats (qq_id, total_pulls, created_at, updated_at)
      VALUES (@qq_id, @pulls, @now, @now)
      ON CONFLICT(qq_id) DO UPDATE SET
        total_pulls = total_pulls + @pulls,
        updated_at = excluded.updated_at`)
  };
  stmtCache.set(db, s);
  return s;
}

export default class GachaStats {
  constructor() { }

  /**
   * 累加抽数（原子自增，无需先读后写）
   * @param {string|number} userId
   * @param {number} pulls 本次抽数（单抽 1、十连 10）
   * @returns {Promise<number>} 累加后的总抽数
   *          —— 入参非法或写入失败时返回**当前累计值**（而非 0），
   *             避免调用方把「本次没加」误判成「从没抽过」。
   */
  async add(userId, pulls) {
    const n = Math.floor(Number(pulls) || 0);
    if (!(n > 0)) return this.get(userId);
    try {
      const db = getDatabase();
      const s = getStmts(db);
      db.transaction(() => {
        s.upsert.run({ qq_id: String(userId), pulls: n, now: Date.now() });
      })();
      const row = s.sel.get(String(userId));
      return Math.max(0, Math.floor(Number(row?.total_pulls) || 0));
    } catch (error) {
      // 统计失败不应影响抽卡主流程，仅记日志
      logger.error(`[GachaStats] 累加抽数失败 userId=${userId}:`, error);
      return this.get(userId);
    }
  }

  /**
   * 读取累计抽数
   * @param {string|number} userId
   * @returns {Promise<number>} 总抽数（无记录为 0）
   */
  async get(userId) {
    try {
      const row = getStmts(getDatabase()).sel.get(String(userId));
      return Math.max(0, Math.floor(Number(row?.total_pulls) || 0));
    } catch (error) {
      logger.error(`[GachaStats] 读取抽数失败 userId=${userId}:`, error);
      return 0;
    }
  }
}
