// plugins/Majsoul-Plugin/utils/GachaSign.js
// 雀魂每日签到：随机辉玉 + 寻觅卷轴，暴击、连签第7天送十连寻觅卷轴、首次欢迎礼包
// 持久化：SQLite（majsoul_signins 表，唯一数据源），"今天是否已签"以数据库为准
import { getDatabase } from './MajsoulDatabase.js';
import { getFeatureConfigItem } from './Config.js';

const stmtCache = new WeakMap();

function getStmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    sel: db.prepare(`SELECT last_date, streak, total_days, welcomed FROM majsoul_signins WHERE qq_id = ?`),
    upsert: db.prepare(`
      INSERT INTO majsoul_signins (qq_id, last_date, streak, total_days, welcomed, created_at, updated_at)
      VALUES (@qq_id, @last_date, @streak, @total_days, @welcomed, @now, @now)
      ON CONFLICT(qq_id) DO UPDATE SET
        last_date = excluded.last_date, streak = excluded.streak,
        total_days = excluded.total_days, welcomed = excluded.welcomed,
        updated_at = excluded.updated_at`)
  };
  stmtCache.set(db, s);
  return s;
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() {
  return dateStr(new Date());
}

function yesterdayStr() {
  return dateStr(new Date(Date.now() - 86400 * 1000));
}

// 数据行 → 签到数据（与旧版 Redis JSON 字段一一对应）
function rowToData(row) {
  return {
    lastDate: (row && row.last_date) || null,
    streak: Math.max(0, Math.floor(Number(row && row.streak) || 0)),
    totalDays: Math.max(0, Math.floor(Number(row && row.total_days) || 0)),
    welcomed: !!(row && row.welcomed)
  };
}

export default class GachaSign {
  // 读取签到数据
  async get(userId) {
    try {
      const row = getStmts(getDatabase()).sel.get(String(userId));
      return rowToData(row);
    } catch (error) {
      logger.error(`[GachaSign] 读取签到数据失败 userId=${userId}:`, error);
      return { lastDate: null, streak: 0, totalDays: 0, welcomed: false };
    }
  }

  /**
   * 执行签到（事务内校验"今天是否已签"，防止并发双签）
   * @param {string|number} userId
   * @returns {object} { already, streak, totalDays, jade, crit, ticket, ticket10, welcome }
   */
  async sign(userId) {
    const db = getDatabase();
    const s = getStmts(db);
    return db.transaction(() => {
      const data = rowToData(s.sel.get(String(userId)));

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
      if (crit) jade *= 2;

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
      s.upsert.run({
        qq_id: String(userId),
        last_date: todayStr(),
        streak,
        total_days: totalDays,
        welcomed: 1,
        now: Date.now()
      });

      return { already: false, streak, totalDays, jade, crit, ticket, ticket10, welcome };
    })();
  }
}
