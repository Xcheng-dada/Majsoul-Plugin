// plugins/Majsoul-Plugin/utils/GachaRedpacket.js
// 辉玉红包：master 印钞群发，群友拼手气抢，5 分钟过期
// 数据结构 Yunzai:majsoul_gacha:redpacket:{groupId}（EX 7 天兜底回收，实际过期看 expireAt）：
// { owner, total, count, amounts: [剩余金额...], claimed: [{userId, amount}], expireAt }
// 公共红包池 Yunzai:majsoul_gacha:redpool:{groupId}：过期/被覆盖红包未领完的辉玉进入池子，
// 下一次发红包时自动注入本包一起发放

const REDIS_PREFIX = 'Yunzai:majsoul_gacha:redpacket:';
const POOL_PREFIX = 'Yunzai:majsoul_gacha:redpool:';
const EXPIRE_SECONDS = 300;
const GC_SECONDS = 604800; // 红包 key 兜底回收时间（过期结算由抢红包脚本惰性完成）

// 抢红包 Lua 脚本：校验存在 → 未领过 → 取金额 → 写回，全程原子
// 已过期红包：剩余金额注入公共池（KEYS[2]）后删除，再返回过期码
const GRAB_SCRIPT = `
local data = redis.call('GET', KEYS[1])
if not data then return '-1' end
local ok, packet = pcall(cjson.decode, data)
if not ok or not packet then return '-1' end
local now = tonumber(ARGV[2])
if packet.expireAt and now > tonumber(packet.expireAt) then
  local leftover = 0
  if packet.amounts then
    for _, a in ipairs(packet.amounts) do leftover = leftover + tonumber(a) end
  end
  if leftover > 0 then redis.call('INCRBY', KEYS[2], tostring(leftover)) end
  redis.call('DEL', KEYS[1])
  return '-1'
end
local uid = ARGV[1]
if packet.claimed then
  for _, c in ipairs(packet.claimed) do
    if c.userId == uid then return '-2' end
  end
end
if not packet.amounts or #packet.amounts == 0 then return '-3' end
local amount = table.remove(packet.amounts)
table.insert(packet.claimed, { userId = uid, amount = amount })
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = ${GC_SECONDS} end
redis.call('SET', KEYS[1], cjson.encode(packet), 'EX', ttl)
return tostring(amount)
`;

// 过期结算 Lua 脚本：红包已过期时，剩余金额原子注入公共池并删除红包，返回结算金额（未过期返回 0）
const SETTLE_SCRIPT = `
local data = redis.call('GET', KEYS[1])
if not data then return '0' end
local ok, packet = pcall(cjson.decode, data)
if not ok or not packet then return '0' end
local now = tonumber(ARGV[1])
if not packet.expireAt or now <= tonumber(packet.expireAt) then return '0' end
local leftover = 0
if packet.amounts then
  for _, a in ipairs(packet.amounts) do leftover = leftover + tonumber(a) end
end
if leftover > 0 then redis.call('INCRBY', KEYS[2], tostring(leftover)) end
redis.call('DEL', KEYS[1])
return tostring(leftover)
`;

export default class GachaRedpacket {
  _key(groupId) {
    return `${REDIS_PREFIX}${groupId}`;
  }

  _poolKey(groupId) {
    return `${POOL_PREFIX}${groupId}`;
  }

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
    let poolBonus = 0;
    try {
      const old = await redis.get(this._key(groupId));
      if (old) {
        try {
          const p = JSON.parse(old);
          if (Array.isArray(p?.amounts)) {
            for (const a of p.amounts) poolBonus += Number(a) || 0;
          }
        } catch {}
        await redis.del(this._key(groupId));
      }
      const poolVal = await redis.get(this._poolKey(groupId));
      poolBonus += Number(poolVal) || 0;
      if (poolBonus > 0) await redis.set(this._poolKey(groupId), '0');
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

    const packet = {
      owner: String(owner),
      total: effectiveTotal,
      count,
      amounts,
      claimed: [],
      expireAt: Date.now() + EXPIRE_SECONDS * 1000
    };
    try {
      // node-redis 的过期参数为 { EX: 秒 }；实际过期判定看 expireAt，EX 仅作兜底回收
      await redis.set(this._key(groupId), JSON.stringify(packet), { EX: GC_SECONDS });
      // 到期定时结算：向群里播报进入公共池的金额（与抢红包脚本互为原子，谁先到谁结算）
      this._scheduleSettle(groupId);
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
   * 结算已过期红包：剩余金额注入公共池，返回结算金额（未过期/不存在返回 0）
   */
  async settleExpired(groupId) {
    try {
      const result = await redis.eval(SETTLE_SCRIPT, {
        keys: [this._key(groupId), this._poolKey(groupId)],
        arguments: [String(Date.now())]
      });
      return parseInt(String(result)) || 0;
    } catch (error) {
      logger.error('[GachaRedpacket] 过期结算失败:', error);
      return 0;
    }
  }

  /**
   * 抢红包（Lua 原子；过期时剩余自动注入公共红包池）
   * @returns {{ ok: boolean, amount?: number, reason?: string }}
   */
  async grab(groupId, userId) {
    try {
      // TRSS-Yunzai 使用 node-redis（@redis/client），eval 签名为 { keys, arguments }
      const result = await redis.eval(GRAB_SCRIPT, {
        keys: [this._key(groupId), this._poolKey(groupId)],
        arguments: [String(userId), String(Date.now())]
      });
      const code = String(result);
      if (code === '-1') return { ok: false, reason: '红包已过期或不存在' };
      if (code === '-2') return { ok: false, reason: '你已经抢过这个红包啦' };
      if (code === '-3') return { ok: false, reason: '手慢了，红包已被抢完' };
      return { ok: true, amount: parseInt(code) };
    } catch (error) {
      logger.error('[GachaRedpacket] 抢红包失败:', error);
      return { ok: false, reason: '抢红包失败，系统异常' };
    }
  }
}
