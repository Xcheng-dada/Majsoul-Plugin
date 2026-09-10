// plugins/Majsoul-Plugin/utils/PoolSchedule.js
// UP池定时关闭：到指定时间后，全局池退回樱花之路
// 个人选择处于UP池的群友同步重置（跟随全局池）
// 持久化：data/pool_schedule.json = { endAt: "YYYY-MM-DD HH:mm" }（全局一份，新设置覆盖旧设置）
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data', 'pool_schedule.json');

const RETREAT_POOL = 'female'; // UP池关闭后的退回池：樱花之路
// UP池判定：自定义UP池、已开启的联动池（主题池）等临时池
// （male/female 为常驻性别池，purple_gift 等非池键，均不算UP池）
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
   * 每分钟检查：到达关闭时间则把全局池退回樱花之路
   * @returns {Promise<{ affected: number, gids: string[] }|null>} 触发时返回受影响信息，未触发返回 null
   */
  async check() {
    const schedule = await this._load();
    if (!schedule) return null;
    if (Date.now() < new Date(schedule.endAt.replace('-', '/')).getTime()) return null;

    // 同步清理处于UP池的个人卡池选择（跟随全局池）
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
    let globalRetreated = false;
    try {
      const globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
      if (globalPool && isUpPool(globalPool)) {
        await redis.set('Yunzai:majsoul_gacha:globalpool', RETREAT_POOL);
        await redis.del('Yunzai:majsoul_gacha:globalbase');
        globalRetreated = true;
        logger.mark(`[PoolSchedule] 全局池退回樱花之路`);
      }
    } catch (error) {
      logger.error('[PoolSchedule] 清理全局卡池失败:', error);
    }

    // 限时UP池到点下架：清空自定义UP池（data/custom_up.json），
    // 可用池列表不再显示，#切换卡池 <池名> 也不可再切入（需要时主人重新创建即可）
    try {
      await this.gachaCore.removeCustomPool();
      logger.mark('[PoolSchedule] 限时UP池已下架（可用池已移除全部自定义UP池）');
    } catch (error) {
      logger.error('[PoolSchedule] 下架限时UP池失败:', error);
    }

    await this._remove();
    return { affected: globalRetreated ? 1 : 0, gids: globalRetreated ? ['global'] : [] };
  }
}
