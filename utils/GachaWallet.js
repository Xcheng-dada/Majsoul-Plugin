// plugins/Majsoul-Plugin/utils/GachaWallet.js
// 雀魂抽卡经济系统：货币钱包管理 + 自动兑换链
// 七种货币：jade辉玉 / ticket寻觅卷轴 / ticket10十连寻觅卷轴 / dust星之粉尘 / stone星之石 / wish许愿石 / faith信仰
// 持久化：SQLite（majsoul_wallets 表，唯一数据源），add/spend/set/setAll 全部在事务内完成

import { getDatabase } from './MajsoulDatabase.js';

// 货币中文名（用于消息展示与邮件解析）
export const CURRENCY_NAMES = {
  jade: '辉玉',
  ticket: '寻觅卷轴',
  ticket10: '十连寻觅卷轴',
  dust: '星之粉尘',
  stone: '星之石',
  wish: '许愿石',
  faith: '信仰'
};

// 中文名 → 货币key（用于解析邮件奖励文本，如"星之粉尘5"）
export const NAME_TO_KEY = Object.fromEntries(
  Object.entries(CURRENCY_NAMES).map(([key, name]) => [name, key])
);

// 转化比例（与用户确认的数值，写死为常量）
export const CONVERSION = {
  WISH_TO_DUST: 1,        // 1 许愿石 = 1 星之粉尘
  STONE_PER: 10,          // 每 10 星之石
  STONE_TO_DUST: 5,       // 兑 5 星之粉尘
  DUST_PER_TICKET: 50     // 每 50 星之粉尘兑 1 寻觅卷轴
};

const ZERO_WALLET = { jade: 0, ticket: 0, ticket10: 0, dust: 0, stone: 0, wish: 0, faith: 0 };

function sanitizeAmount(n) {
  const num = Math.floor(Number(n) || 0);
  return num > 0 ? num : 0;
}

// 预编译语句按连接实例缓存（测试关闭重开后自动重建）
const stmtCache = new WeakMap();

function getStmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    sel: db.prepare(`SELECT qq_id, jade, ticket, ticket10, dust, stone, wish, faith FROM majsoul_wallets WHERE qq_id = ?`),
    selAll: db.prepare(`SELECT qq_id, jade, ticket, ticket10, dust, stone, wish, faith FROM majsoul_wallets`),
    upsert: db.prepare(`
      INSERT INTO majsoul_wallets (qq_id, jade, ticket, ticket10, dust, stone, wish, faith, created_at, updated_at)
      VALUES (@qq_id, @jade, @ticket, @ticket10, @dust, @stone, @wish, @faith, @now, @now)
      ON CONFLICT(qq_id) DO UPDATE SET
        jade = excluded.jade, ticket = excluded.ticket, ticket10 = excluded.ticket10,
        dust = excluded.dust, stone = excluded.stone, wish = excluded.wish, faith = excluded.faith,
        updated_at = excluded.updated_at`)
  };
  stmtCache.set(db, s);
  return s;
}

// 数据行 → 钱包对象（缺失/异常回退全 0，负数钳为 0，与旧版语义一致）
function rowToWallet(row) {
  const wallet = { ...ZERO_WALLET };
  if (row) {
    for (const key of Object.keys(ZERO_WALLET)) {
      wallet[key] = Math.max(0, Math.floor(Number(row[key]) || 0));
    }
  }
  return wallet;
}

export default class GachaWallet {
  constructor() { }

  // 读取钱包（无记录时返回全 0 默认值）
  async get(userId) {
    try {
      const row = getStmts(getDatabase()).sel.get(String(userId));
      return rowToWallet(row);
    } catch (error) {
      logger.error(`[GachaWallet] 读取钱包失败 userId=${userId}:`, error);
      return { ...ZERO_WALLET };
    }
  }

  /**
   * 入账并自动执行兑换链（许愿石→粉尘→寻觅卷轴、星之石→粉尘）
   * @param {string|number} userId
   * @param {object} amounts 各货币增量，如 { jade: 200, wish: 150 }
   * @returns {{ wallet: object, converted: string[] }} 转化说明行（已发生转化的描述，如"许愿石 150 → 星之粉尘 150"）
   */
  async add(userId, amounts) {
    const db = getDatabase();
    const s = getStmts(db);
    // 同步事务：better-sqlite3 为同步 IO，读-改-写在事件循环内原子完成
    return db.transaction(() => {
      const wallet = rowToWallet(s.sel.get(String(userId)));
      for (const [key, value] of Object.entries(amounts || {})) {
        if (!(key in ZERO_WALLET)) continue;
        wallet[key] += sanitizeAmount(value);
      }
      const converted = this._autoConvert(wallet);
      s.upsert.run({ qq_id: String(userId), now: Date.now(), ...wallet });
      return { wallet, converted };
    })();
  }

  /**
   * 扣减货币（事务内校验+扣减，余额不足整体不写入）
   * @param {string|number} userId
   * @param {object} costs 各货币扣减量，如 { ticket: 1 }
   * @returns {{ ok: boolean, wallet: object, lack?: string }} lack 为余额不足的货币中文名
   */
  async spend(userId, costs) {
    const db = getDatabase();
    const s = getStmts(db);
    return db.transaction(() => {
      const wallet = rowToWallet(s.sel.get(String(userId)));
      for (const [key, value] of Object.entries(costs || {})) {
        if (!(key in ZERO_WALLET)) continue;
        if (wallet[key] < sanitizeAmount(value)) {
          return { ok: false, wallet, lack: CURRENCY_NAMES[key] || key };
        }
      }
      for (const [key, value] of Object.entries(costs || {})) {
        if (!(key in ZERO_WALLET)) continue;
        wallet[key] -= sanitizeAmount(value);
      }
      s.upsert.run({ qq_id: String(userId), now: Date.now(), ...wallet });
      return { ok: true, wallet };
    })();
  }

  // 管理员直接设置某货币数量
  async set(userId, key, amount) {
    if (!(key in ZERO_WALLET)) return false;
    const db = getDatabase();
    const s = getStmts(db);
    return db.transaction(() => {
      const wallet = rowToWallet(s.sel.get(String(userId)));
      wallet[key] = Math.max(0, Math.floor(Number(amount) || 0));
      // 设置也可能触发自动兑换（如直接塞入 100 粉尘）
      this._autoConvert(wallet);
      s.upsert.run({ qq_id: String(userId), now: Date.now(), ...wallet });
      return true;
    })();
  }

  /**
   * 批量把所有已有钱包记录的用户的某一货币设为固定值（master 校正数据用）
   * 仅更新已存在的钱包，不为无记录用户创建（与旧版 redis.keys 行为一致）
   * @param {string} key 货币 key（如 jade）
   * @param {number} amount 目标数值
   * @returns {Promise<number>} 成功设置的钱包数
   */
  async setAll(key, amount) {
    if (!(key in ZERO_WALLET)) return 0;
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    const db = getDatabase();
    const s = getStmts(db);
    try {
      // 单事务批量更新，与旧版逐条改写的差异仅在失败时整体回滚（原子性更强）
      return db.transaction(() => {
        let count = 0;
        for (const row of s.selAll.all()) {
          const wallet = rowToWallet(row);
          wallet[key] = value;
          this._autoConvert(wallet);
          s.upsert.run({ qq_id: row.qq_id, now: Date.now(), ...wallet });
          count++;
        }
        return count;
      })();
    } catch (error) {
      logger.error('[GachaWallet] 批量设置钱包失败:', error);
      return 0;
    }
  }

  // 原路退还（抽卡执行失败时）
  async refund(userId, costs) {
    await this.add(userId, costs);
  }

  /**
   * 自动兑换链：许愿石→粉尘→寻觅卷轴、星之石→粉尘，循环直到无转化
   * @param {object} wallet （原地修改）
   * @returns {string[]} 转化描述
   */
  _autoConvert(wallet) {
    const converted = [];
    let changed = true;
    while (changed) {
      changed = false;

      // 许愿石 → 粉尘（1:1，全部转化）
      if (wallet.wish > 0) {
        converted.push(`许愿石 ${wallet.wish} → 星之粉尘 ${wallet.wish}`);
        wallet.dust += wallet.wish;
        wallet.wish = 0;
        changed = true;
      }

      // 星之石 → 粉尘（每10兑5，余数保留）
      const stoneBatch = Math.floor(wallet.stone / CONVERSION.STONE_PER);
      if (stoneBatch > 0) {
        const dustOut = stoneBatch * CONVERSION.STONE_TO_DUST;
        converted.push(`星之石 ${stoneBatch * CONVERSION.STONE_PER} → 星之粉尘 ${dustOut}`);
        wallet.stone -= stoneBatch * CONVERSION.STONE_PER;
        wallet.dust += dustOut;
        changed = true;
      }

      // 粉尘 → 寻觅卷轴（每50兑1，余数保留）
      const ticketCount = Math.floor(wallet.dust / CONVERSION.DUST_PER_TICKET);
      if (ticketCount > 0) {
        converted.push(`星之粉尘 ${ticketCount * CONVERSION.DUST_PER_TICKET} → 寻觅卷轴 ${ticketCount}`);
        wallet.dust -= ticketCount * CONVERSION.DUST_PER_TICKET;
        wallet.ticket += ticketCount;
        changed = true;
      }
    }
    return converted;
  }
}
