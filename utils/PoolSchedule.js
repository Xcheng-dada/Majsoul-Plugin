// plugins/Majsoul-Plugin/utils/PoolSchedule.js
// UP池定时关闭：到指定时间后，把所有处于限定池（xianding）/自定义UP池的群默认池退回樱花之路（女池）
// 个人选择处于UP池的群友同步重置（回本群默认池）
// 持久化：data/pool_schedule.json = { endAt: "YYYY-MM-DD HH:mm" }（全局一份，新设置覆盖旧设置）
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'pool_schedule.json');

const RETREAT_POOL = 'female'; // UP池关闭后的退回池：樱花之路（女池）
// UP池判定：限定池（贵人）、自定义UP池、已开启的联动池（主题池）等临时池
// （normal 为历史遗留默认值，male/female 为常驻性别池，均不算UP池）
const isUpPool = (poolname) => {
  if (!poolname) return false;
  const p = String(poolname);
  return p !== 'normal' && p !== 'male' && p !== 'female';
};

export default class PoolSchedule {
  constructor(gachaCore) {
    this.gachaCore = gachaCore;
  }

  async _load() {
    try {
      return JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
    } catch {
      return null;
    }
  }

  async _save(data) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 4), 'utf-8');
  }

  async _remove() {
    try {
      await fs.unlink(DATA_FILE);
    } catch {}
  }

  /**
   * 设置UP池关闭时间
   * @param {string} endAtStr "YYYY-MM-DD HH:mm"
   * @returns {{ ok: boolean, reason?: string, endAt?: string }}
   */
  async set(endAtStr) {
    const endAt = new Date(endAtStr.replace('-', '/'));
    if (isNaN(endAt.getTime())) {
      return { ok: false, reason: '时间格式不对，请使用 YYYY-MM-DD HH:mm' };
    }
    if (endAt.getTime() <= Date.now()) {
      return { ok: false, reason: '关闭时间必须晚于当前时间' };
    }
    try {
      await this._save({ endAt: endAtStr });
      return { ok: true, endAt: endAtStr };
    } catch (error) {
      logger.error('[PoolSchedule] 保存UP池关闭时间失败:', error);
      return { ok: false, reason: '保存失败，系统异常' };
    }
  }

  async cancel() {
    await this._remove();
  }

  async get() {
    return this._load();
  }

  /**
   * 每分钟检查：到达关闭时间则把处于UP池的群默认池退回樱花之路（女池）
   * @returns {Promise<{ affected: number, gids: string[] }|null>} 触发时返回受影响群列表，未触发返回 null
   */
  async check() {
    const schedule = await this._load();
    if (!schedule) return null;
    if (Date.now() < new Date(schedule.endAt.replace('-', '/')).getTime()) return null;

    const groupPool = await this.gachaCore.groupPoolLoader();
    let changed = false;
    const gids = [];
    for (const item of groupPool) {
      if (isUpPool(item.poolname)) {
        item.poolname = RETREAT_POOL;
        gids.push(String(item.gid));
        changed = true;
      }
    }
    if (changed) {
      await this.gachaCore.saveGroupPool(groupPool);
      logger.mark(`[PoolSchedule] UP池已关闭，${gids.length} 个群默认池退回樱花之路: ${gids.join(',')}`);
    }

    // 同步清理处于UP池的个人卡池选择（回本群默认池）
    let userAffected = 0;
    try {
      const keys = await redis.keys('Yunzai:majsoul_gacha:userpool:*');
      for (const k of keys) {
        const v = await redis.get(k);
        if (isUpPool(v)) {
          await redis.del(k);
          userAffected++;
        }
      }
    } catch (error) {
      logger.error('[PoolSchedule] 清理个人卡池选择失败:', error);
    }
    if (userAffected > 0) {
      logger.mark(`[PoolSchedule] UP池已关闭，${userAffected} 位群友的个人卡池选择已重置`);
    }

    // 全局池若为UP池（含联动池），退回樱花之路并清理挂靠配置
    try {
      const globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
      if (globalPool && isUpPool(globalPool)) {
        await redis.set('Yunzai:majsoul_gacha:globalpool', RETREAT_POOL);
        await redis.del('Yunzai:majsoul_gacha:globalbase');
        logger.mark(`[PoolSchedule] 全局池退回樱花之路`);
      }
    } catch (error) {
      logger.error('[PoolSchedule] 清理全局卡池失败:', error);
    }

    await this._remove();
    return { affected: gids.length, gids };
  }
}
