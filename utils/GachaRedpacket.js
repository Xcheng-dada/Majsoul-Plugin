// plugins/Majsoul-Plugin/utils/GachaRedpacket.js
// 辉玉红包：master 印钞群发，群友拼手气抢，5 分钟过期
// 数据结构 Yunzai:majsoul_gacha:redpacket:{groupId}（EX 300）：
// { owner, total, count, amounts: [剩余金额...], claimed: [{userId, amount}] }

const REDIS_PREFIX = 'Yunzai:majsoul_gacha:redpacket:';
const EXPIRE_SECONDS = 300;

// 抢红包 Lua 脚本：校验存在 → 未领过 → 取金额 → 写回，全程原子
const GRAB_SCRIPT = `
local data = redis.call('GET', KEYS[1])
if not data then return '-1' end
local ok, packet = pcall(cjson.decode, data)
if not ok or not packet then return '-1' end
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
if ttl < 1 then ttl = ${EXPIRE_SECONDS} end
redis.call('SET', KEYS[1], cjson.encode(packet), 'EX', ttl)
return tostring(amount)
`;

export default class GachaRedpacket {
  _key(groupId) {
    return `${REDIS_PREFIX}${groupId}`;
  }

  /**
   * 创建红包（一群一个，新红包覆盖旧红包）
   * @param {string|number} groupId
   * @param {string|number} owner 发红包人
   * @param {number} total 总辉玉
   * @param {number} count 份数
   * @returns {{ ok: boolean, amounts?: number[], reason?: string }}
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

    // 二倍均值法预拆分
    const amounts = [];
    let remaining = total;
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
      total,
      count,
      amounts,
      claimed: []
    };
    try {
      // node-redis 的过期参数为 { EX: 秒 }
      await redis.set(this._key(groupId), JSON.stringify(packet), { EX: EXPIRE_SECONDS });
      return { ok: true, amounts };
    } catch (error) {
      logger.error('[GachaRedpacket] 创建红包失败:', error);
      return { ok: false, reason: '创建红包失败，系统异常' };
    }
  }

  /**
   * 抢红包（Lua 原子）
   * @returns {{ ok: boolean, amount?: number, reason?: string }}
   */
  async grab(groupId, userId) {
    try {
      // TRSS-Yunzai 使用 node-redis（@redis/client），eval 签名为 { keys, arguments }
      const result = await redis.eval(GRAB_SCRIPT, {
        keys: [this._key(groupId)],
        arguments: [String(userId)]
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
