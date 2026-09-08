// plugins/Majsoul-Plugin/utils/GachaWallet.js
// 雀魂抽卡经济系统：货币钱包管理 + 自动兑换链
// 七种货币：jade辉玉 / ticket寻觅卷轴 / ticket10十连寻觅卷轴 / dust星之粉尘 / stone星之石 / wish许愿石 / faith信仰

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
// 兼容旧叫法"券"（仅解析输入用，展示一律用"卷轴"）
NAME_TO_KEY['寻觅券'] = 'ticket';
NAME_TO_KEY['十连寻觅券'] = 'ticket10';

// 转化比例（与用户确认的数值，写死为常量）
export const CONVERSION = {
  WISH_TO_DUST: 1,        // 1 许愿石 = 1 星之粉尘
  STONE_PER: 10,          // 每 10 星之石
  STONE_TO_DUST: 5,       // 兑 5 星之粉尘
  DUST_PER_TICKET: 50     // 每 50 星之粉尘兑 1 寻觅卷轴
};

const REDIS_PREFIX = 'Yunzai:majsoul_gacha:wallet:';

const ZERO_WALLET = { jade: 0, ticket: 0, ticket10: 0, dust: 0, stone: 0, wish: 0, faith: 0 };

function sanitizeAmount(n) {
  const num = Math.floor(Number(n) || 0);
  return num > 0 ? num : 0;
}

export default class GachaWallet {
  constructor() { }

  // 钱包 Redis key
  _key(userId) {
    return `${REDIS_PREFIX}${userId}`;
  }

  // 读取钱包（与全 0 默认合并）
  async get(userId) {
    try {
      const raw = await redis.get(this._key(userId));
      const data = raw ? JSON.parse(raw) : {};
      const wallet = { ...ZERO_WALLET };
      for (const key of Object.keys(ZERO_WALLET)) {
        wallet[key] = Math.max(0, Math.floor(Number(data[key]) || 0));
      }
      return wallet;
    } catch (error) {
      logger.error(`[GachaWallet] 读取钱包失败 userId=${userId}:`, error);
      return { ...ZERO_WALLET };
    }
  }

  // 保存钱包
  async _save(userId, wallet) {
    await redis.set(this._key(userId), JSON.stringify(wallet));
  }

  /**
   * 入账并自动执行兑换链（许愿石→粉尘→寻觅卷轴、星之石→粉尘）
   * @param {string|number} userId
   * @param {object} amounts 各货币增量，如 { jade: 200, wish: 150 }
   * @returns {{ wallet: object, converted: string[] }} 转化说明行（已发生转化的描述，如"许愿石 150 → 星之粉尘 150"）
   */
  async add(userId, amounts) {
    const wallet = await this.get(userId);
    for (const [key, value] of Object.entries(amounts || {})) {
      if (!(key in ZERO_WALLET)) continue;
      wallet[key] += sanitizeAmount(value);
    }
    const converted = this._autoConvert(wallet);
    await this._save(userId, wallet);
    return { wallet, converted };
  }

  /**
   * 扣减货币（校验+扣减一次闭环）
   * @param {string|number} userId
   * @param {object} costs 各货币扣减量，如 { ticket: 1 }
   * @returns {{ ok: boolean, wallet: object, lack?: string }} lack 为余额不足的货币中文名
   */
  async spend(userId, costs) {
    const wallet = await this.get(userId);
    for (const [key, value] of Object.entries(costs || {})) {
      if (!(key in ZERO_WALLET)) continue;
      const cost = sanitizeAmount(value);
      if (wallet[key] < cost) {
        return { ok: false, wallet, lack: CURRENCY_NAMES[key] || key };
      }
    }
    for (const [key, value] of Object.entries(costs || {})) {
      if (!(key in ZERO_WALLET)) continue;
      wallet[key] -= sanitizeAmount(value);
    }
    await this._save(userId, wallet);
    return { ok: true, wallet };
  }

  // 管理员直接设置某货币数量
  async set(userId, key, amount) {
    if (!(key in ZERO_WALLET)) return false;
    const wallet = await this.get(userId);
    wallet[key] = Math.max(0, Math.floor(Number(amount) || 0));
    // 设置也可能触发自动兑换（如直接塞入 100 粉尘）
    this._autoConvert(wallet);
    await this._save(userId, wallet);
    return true;
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
