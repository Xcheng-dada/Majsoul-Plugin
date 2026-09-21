// plugins/Majsoul-Plugin/utils/PoolSchedule.js
// 卡池排期：每个卡池独立的自动开启/结束时间，到点自动执行（静默，仅日志）
// - 自动开启：卡池加入可用列表；若当前全局池为常驻/为空、或全局池本身由调度器设置（globalpool:auto 标记），则接管为全局默认池
// - 自动关闭：下架卡池（自定义池删除条目、联动池移除开放标记）；全局池指向该池时退回樱花之路，并精准清理指向该池的个人选择
// 持久化：SQLite majsoul_pool_schedules 表（pool_id、start_at、end_at，均为 epoch ms，NULL=未设置）
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from './MajsoulDatabase.js';
import { getSetting, setSetting, delSetting, getSettingsByPrefix } from './SettingsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'pool_schedule.json'); // 旧版单一关闭时间文件，启动后一次性迁移

const RETREAT_POOL = 'female';     // 卡池关闭后的退回池：樱花之路
const AUTO_FLAG = 'globalpool:auto'; // '1' = 当前全局池由调度器设置（master 手动设置时清除）

// Yunzai 运行环境提供全局 logger；独立运行（测试）时回退到 console
const logger = global.logger || { mark: (...a) => console.log(...a), error: (...a) => console.error(...a), debug: () => {} };

// 排期表 prepared statements（惰性初始化，等 getDatabase 就绪后再编译）
const STMT = {};
function stmt(name) {
  if (!STMT[name]) {
    const db = getDatabase();
    STMT[name] = {
      get: db.prepare('SELECT pool_id, start_at, end_at FROM majsoul_pool_schedules WHERE pool_id = ?'),
      all: db.prepare('SELECT pool_id, start_at, end_at FROM majsoul_pool_schedules ORDER BY pool_id'),
      upsert: db.prepare(
        'INSERT INTO majsoul_pool_schedules (pool_id, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(pool_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, updated_at = excluded.updated_at'
      ),
      del: db.prepare('DELETE FROM majsoul_pool_schedules WHERE pool_id = ?'),
      clearStart: db.prepare('UPDATE majsoul_pool_schedules SET start_at = NULL, updated_at = ? WHERE pool_id = ?')
    }[name];
  }
  return STMT[name];
}

// "YYYY-MM-DD HH:mm" → epoch ms（非法返回 null）
function parseTime(str) {
  const t = new Date(String(str).replace('-', '/')).getTime();
  return isNaN(t) ? null : t;
}

export default class PoolSchedule {
  constructor(gachaCore) {
    this.gachaCore = gachaCore;
    this._legacyMigrated = false;
  }

  // 旧版 data/pool_schedule.json 一次性迁移：endAt 落到当前全局池名下，然后删除旧文件
  async _migrateLegacy() {
    if (this._legacyMigrated) return;
    this._legacyMigrated = true;
    try {
      const data = JSON.parse(await fs.readFile(LEGACY_FILE, 'utf-8'));
      await fs.unlink(LEGACY_FILE).catch(() => {});
      const ms = data?.endAt ? parseTime(data.endAt) : null;
      const globalPool = getSetting('globalpool');
      if (ms != null && globalPool && globalPool !== 'male' && globalPool !== 'female') {
        if (ms > Date.now()) {
          const row = stmt('get').get(globalPool);
          stmt('upsert').run(globalPool, row?.start_at ?? null, ms, Date.now(), Date.now());
          logger.mark(`[PoolSchedule] 已迁移旧版关闭时间到卡池「${this.gachaCore.getPoolName(globalPool)}」`);
        } else {
          logger.mark('[PoolSchedule] 旧版关闭时间已过期，跳过迁移');
        }
      }
    } catch { /* 文件不存在等，忽略 */ }
  }

  /**
   * 读取单个池的排期
   * @returns {{ startAt: number|null, endAt: number|null }|null} epoch ms
   */
  async get(poolId) {
    const row = stmt('get').get(String(poolId || '').trim());
    return row ? { startAt: row.start_at ?? null, endAt: row.end_at ?? null } : null;
  }

  /** 全部排期（按池名排序） */
  async getAll() {
    return stmt('all').all().map(r => ({ poolId: r.pool_id, startAt: r.start_at ?? null, endAt: r.end_at ?? null }));
  }

  /**
   * 设置排期（只传其一时保留另一项的已有值）
   * @param {string} poolId custom:<池名> 或联动主题池ID
   * @param {{ startAt?: string|null, endAt?: string|null }} times "YYYY-MM-DD HH:mm"
   * @returns {{ ok: boolean, reason?: string }}
   */
  async set(poolId, { startAt = null, endAt = null } = {}) {
    poolId = String(poolId || '').trim();
    if (!poolId) return { ok: false, reason: '缺少池名' };
    let startMs = null;
    let endMs = null;
    if (startAt) {
      startMs = parseTime(startAt);
      if (startMs == null) return { ok: false, reason: '开启时间格式不对，请使用 YYYY-MM-DD HH:mm' };
      if (startMs <= Date.now()) return { ok: false, reason: '开启时间必须晚于当前时间' };
    }
    if (endAt) {
      endMs = parseTime(endAt);
      if (endMs == null) return { ok: false, reason: '关闭时间格式不对，请使用 YYYY-MM-DD HH:mm' };
      if (endMs <= Date.now()) return { ok: false, reason: '关闭时间必须晚于当前时间' };
    }
    // 合并已有排期：本次未设置的一侧沿用旧值
    const row = stmt('get').get(poolId);
    if (startMs == null && row?.start_at != null) startMs = row.start_at;
    if (endMs == null && row?.end_at != null) endMs = row.end_at;
    if (startMs != null && endMs != null && startMs >= endMs) {
      return { ok: false, reason: '开启时间必须早于结束时间' };
    }
    try {
      stmt('upsert').run(poolId, startMs, endMs, Date.now(), Date.now());
      return { ok: true };
    } catch (error) {
      logger.error('[PoolSchedule] 保存卡池排期失败:', error);
      return { ok: false, reason: '保存失败，系统异常' };
    }
  }

  /**
   * 取消排期
   * @param {string} poolId
   * @param {'start'|'end'|undefined} [which] 不传=整条删除
   */
  async cancel(poolId, which) {
    poolId = String(poolId || '').trim();
    const row = stmt('get').get(poolId);
    if (!row) return { ok: false, reason: '该池没有排期' };
    let start = row.start_at;
    let end = row.end_at;
    if (which === 'start') start = null;
    else if (which === 'end') end = null;
    else { start = null; end = null; }
    try {
      if (start == null && end == null) stmt('del').run(poolId);
      else stmt('upsert').run(poolId, start, end, Date.now(), Date.now());
      return { ok: true };
    } catch (error) {
      logger.error('[PoolSchedule] 取消卡池排期失败:', error);
      return { ok: false, reason: '操作失败，系统异常' };
    }
  }

  /** 删除排期（解散UP池/关闭联动时同步清理） */
  async remove(poolId) {
    try { stmt('del').run(String(poolId || '').trim()); } catch (error) {
      logger.error('[PoolSchedule] 删除卡池排期失败:', error);
    }
  }

  /**
   * 开启卡池：加入可用列表；满足条件时接管全局默认池
   * @returns {{ ok: boolean, takenOver?: boolean }}
   */
  async open(poolId) {
    const isCustom = String(poolId).startsWith('custom:');
    try {
      if (isCustom) {
        const custom = await this.gachaCore.customPoolLoader();
        const name = poolId.slice('custom:'.length);
        if (!custom || !custom[name]) {
          logger.mark(`[PoolSchedule] UP池「${name}」不存在（可能已解散），排期作废`);
          return { ok: false };
        }
      } else {
        const data = await this.gachaCore.gachaLoader();
        if (!data[poolId]) {
          logger.mark(`[PoolSchedule] 联动池「${this.gachaCore.getPoolName(poolId)}」不存在，排期作废`);
          return { ok: false };
        }
        setSetting(`collabopen:${poolId}`, '1'); // 联动开放标记：支持多个联动池同时开放
      }
    } catch (error) {
      logger.error('[PoolSchedule] 开启卡池失败:', error);
      return { ok: false };
    }
    // 接管判定：全局池为空/常驻池，或全局池本身由调度器设置 → 接管；master 手动指定的全局池不抢
    let takenOver = false;
    try {
      const globalPool = getSetting('globalpool');
      if (!globalPool || globalPool === 'male' || globalPool === 'female' || getSetting(AUTO_FLAG) === '1') {
        setSetting('globalpool', poolId);
        setSetting(AUTO_FLAG, '1');
        takenOver = true;
      }
    } catch (error) {
      logger.error('[PoolSchedule] 设置全局池失败:', error);
    }
    logger.mark(`[PoolSchedule] 卡池「${this.gachaCore.getPoolName(poolId)}」已自动开启` +
      (takenOver ? '并设为全局默认池' : '（已加入可用池，全局默认池保持不变）'));
    return { ok: true, takenOver };
  }

  /**
   * 关闭卡池：下架 + 全局池退回 + 精准清理指向该池的个人选择
   */
  async close(poolId) {
    const isCustom = String(poolId).startsWith('custom:');
    try {
      if (isCustom) {
        const name = poolId.slice('custom:'.length);
        const custom = await this.gachaCore.customPoolLoader();
        if (custom && custom[name]) {
          delete custom[name];
          if (Object.keys(custom).length === 0) await this.gachaCore.removeCustomPool();
          else await this.gachaCore.saveCustomPool(custom);
          logger.mark(`[PoolSchedule] UP池「${name}」已到点下架`);
        }
      } else {
        delSetting(`collabopen:${poolId}`);
        logger.mark(`[PoolSchedule] 联动池「${this.gachaCore.getPoolName(poolId)}」已到点关闭`);
      }
    } catch (error) {
      logger.error('[PoolSchedule] 下架卡池失败:', error);
    }
    // 全局池指向该池 → 退回樱花之路
    try {
      if (getSetting('globalpool') === poolId) {
        setSetting('globalpool', RETREAT_POOL);
        setSetting(AUTO_FLAG, '1'); // 退回动作由调度器执行，后续自动开启仍可接管
        logger.mark('[PoolSchedule] 全局池退回樱花之路');
      }
    } catch (error) {
      logger.error('[PoolSchedule] 清理全局卡池失败:', error);
    }
    // 精准清理：仅删除指向该池（含联动变体 <id>|female / <id>|male）的个人选择
    let userAffected = 0;
    try {
      for (const { key, value } of getSettingsByPrefix('userpool:')) {
        if (value === poolId || String(value).startsWith(`${poolId}|`)) {
          delSetting(key);
          userAffected++;
        }
      }
    } catch (error) {
      logger.error('[PoolSchedule] 清理个人卡池选择失败:', error);
    }
    if (userAffected > 0) {
      logger.mark(`[PoolSchedule] ${userAffected} 位群友的个人卡池选择已重置`);
    }
  }

  /**
   * 每分钟检查（由 index.js 定时器调用，幂等）：
   * - 已过结束时间 → 关闭并删排期（先于开启判断：离线跨过整个窗口时直接按已结束处理）
   * - 已到开启时间 → 开启后清除 start_at（若结束时间也未设则删排期）
   * @returns {Promise<{ opened: number, closed: number }|null>} 有动作时返回统计
   */
  async check() {
    await this._migrateLegacy();
    let opened = 0;
    let closed = 0;
    for (const row of stmt('all').all()) {
      const now = Date.now();
      try {
        if (row.end_at != null && now >= row.end_at) {
          await this.close(row.pool_id);
          stmt('del').run(row.pool_id);
          closed++;
        } else if (row.start_at != null && now >= row.start_at) {
          const result = await this.open(row.pool_id);
          if (result.ok) {
            if (row.end_at != null) stmt('clearStart').run(Date.now(), row.pool_id);
            else stmt('del').run(row.pool_id);
            opened++;
          } else {
            stmt('del').run(row.pool_id); // 池已不存在，排期作废
          }
        }
      } catch (error) {
        logger.error(`[PoolSchedule] 处理卡池排期失败 pool=${row.pool_id}:`, error);
      }
    }
    return opened + closed > 0 ? { opened, closed } : null;
  }
}
