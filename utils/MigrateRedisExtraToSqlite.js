// plugins/Majsoul-Plugin/utils/MigrateRedisExtraToSqlite.js
// 一次性迁移工具（第二批）：把 Redis 中剩余的业务数据迁移到 SQLite
//
// 迁移范围（跑完上一轮钱包/签到/图鉴/UID迁移后的剩余部分）：
//   1. 群抽卡开关     Yunzai:majsoul_gacha:status:<gid>         → majsoul_settings (gacha_status:<gid>)
//   2. 个人卡池选择   Yunzai:majsoul_gacha:userpool:<gid>:<uid> → majsoul_settings (userpool:<gid>:<uid>)
//   3. 全局卡池       Yunzai:majsoul_gacha:globalpool           → majsoul_settings (globalpool)
//   4. 奖励邮件       Yunzai:majsoul_gacha:mail:<gid>           → majsoul_mails + majsoul_mail_claims
//   5. 进行中的红包   Yunzai:majsoul_gacha:redpacket:<gid>      → majsoul_redpackets + _shares + _claims
//   6. 公共红包池     Yunzai:majsoul_gacha:redpool:<gid>        → majsoul_redpools
//
// 安全模式（默认，不加 --force）：
//   - 只填充 SQLite 中不存在的数据，已存在的一律跳过，绝不覆盖
//   - 覆盖计数恒为 0
//   - 幂等：重复执行结果一致
//   - 绝不删除 Redis 中的任何数据
// 用法：
//   node utils/MigrateRedisExtraToSqlite.js                      # 从 Yunzai config/redis.yaml 读取连接
//   node utils/MigrateRedisExtraToSqlite.js --port=6380          # 覆盖连接参数
//   node utils/MigrateRedisExtraToSqlite.js --force              # 允许 Redis 覆盖 SQLite 已有数据（谨慎）

import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from './MajsoulDatabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YUNZAI_ROOT = path.join(__dirname, '..', '..', '..');

const CURRENCY_KEYS = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith'];

// 统计结构：每类数据独立计数
function newStats() {
  const cat = () => ({ inserted: 0, skipped: 0, overwritten: 0, failed: 0 });
  return {
    settings: cat(),   // 开关/个人池/全局池，按条计
    mails: cat(),      // 按邮件条目计
    mailClaims: cat(), // 按领取记录计
    redpackets: cat(), // 按红包计
    redShares: cat(),  // 按剩余份额计
    redClaims: cat(),  // 按红包领取记录计
    redpools: cat(),   // 按群公共池计
    failures: []       // { category, key, error }
  };
}

function fail(stats, category, key, error) {
  stats[category].failed++;
  stats.failures.push({ category, key, error: error?.message || String(error) });
}

/** 安全模式写入：INSERT OR IGNORE（已存在则跳过，绝不覆盖） */
function insertOrSkip(stmt, stats, category, ...params) {
  const changes = stmt.run(...params).changes;
  if (changes > 0) stats[category].inserted++;
  else stats[category].skipped++;
}

/** 覆盖模式写入：UPSERT */
function upsert(stmt, stats, category, ...params) {
  stmt.run(...params);
  stats[category].overwritten++;
}

/**
 * 执行迁移（不删除 Redis 数据，可在运行环境内直接调用）
 * @param {object} redisClient node-redis / ioredis / Yunzai global.redis 客户端
 * @param {{ force?: boolean }} [opts] force=true 时允许覆盖 SQLite 已有数据
 * @returns {Promise<object>} 统计结果
 */
export async function migrateRedisExtraToSqlite(redisClient, opts = {}) {
  const force = !!opts.force;
  const db = getDatabase();
  const stats = newStats();
  const now = Date.now();

  // 1~3. 设置类（开关/个人池/全局池）：SCAN 前缀 → 映射新 key → 写入
  const settingStmt = force
    ? db.prepare(
        'INSERT INTO majsoul_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    : db.prepare('INSERT OR IGNORE INTO majsoul_settings (key, value, updated_at) VALUES (?, ?, ?)');
  const settingPatterns = [
    { pattern: 'Yunzai:majsoul_gacha:status:*',   map: k => `gacha_status:${k.slice('Yunzai:majsoul_gacha:status:'.length)}` },
    { pattern: 'Yunzai:majsoul_gacha:userpool:*', map: k => `userpool:${k.slice('Yunzai:majsoul_gacha:userpool:'.length)}` },
    { pattern: 'Yunzai:majsoul_gacha:globalpool', map: () => 'globalpool' }
  ];
  for (const { pattern, map } of settingPatterns) {
    try {
      const keys = await scanKeys(redisClient, pattern);
      for (const key of keys) {
        try {
          const value = await redisClient.get(key);
          if (value === null || value === undefined) {
            stats.settings.skipped++;
            continue;
          }
          const newKey = map(key);
          if (force) upsert(settingStmt, stats, 'settings', newKey, String(value), now);
          else insertOrSkip(settingStmt, stats, 'settings', newKey, String(value), now);
        } catch (error) {
          fail(stats, 'settings', key, error);
        }
      }
    } catch (error) {
      fail(stats, 'settings', pattern, error);
    }
  }

  // 4. 奖励邮件（条目幂等：邮件按 id 去重，领取记录按 (mail_id, user_id) 去重）
  const mailStmt = db.prepare(
    'INSERT OR IGNORE INTO majsoul_mails (id, chat_id, title, jade, ticket, ticket10, dust, stone, wish, faith, expire_at, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const mailClaimStmt = db.prepare(
    'INSERT OR IGNORE INTO majsoul_mail_claims (mail_id, user_id, claimed_at) VALUES (?, ?, ?)'
  );
  try {
    const keys = await scanKeys(redisClient, 'Yunzai:majsoul_gacha:mail:*');
    for (const key of keys) {
      try {
        const gid = key.slice('Yunzai:majsoul_gacha:mail:'.length);
        const mails = JSON.parse(await redisClient.get(key) || '[]');
        if (!Array.isArray(mails)) throw new Error('邮件数据不是数组');
        for (const m of mails) {
          try {
            if (!m || !m.id) throw new Error('邮件条目缺少 id');
            const rewards = m.rewards || {};
            const r = CURRENCY_KEYS.map(k => Math.max(0, Math.floor(Number(rewards[k]) || 0)));
            insertOrSkip(mailStmt, stats, 'mails', String(m.id), String(gid), String(m.title || '奖励邮件'),
              ...r, Number(m.expireAt) || now, Number(m.createdAt) || now);
            for (const uid of (Array.isArray(m.claimed) ? m.claimed : [])) {
              insertOrSkip(mailClaimStmt, stats, 'mailClaims', String(m.id), String(uid), Number(m.expireAt) || now);
            }
          } catch (error) {
            fail(stats, 'mails', `${key}#${m?.id ?? '?'}`, error);
          }
        }
      } catch (error) {
        fail(stats, 'mails', key, error);
      }
    }
  } catch (error) {
    fail(stats, 'mails', 'Yunzai:majsoul_gacha:mail:*', error);
  }

  // 5. 进行中的红包（份额/领取记录按主键去重；红包被覆盖过则只补差额）
  const packetStmt = db.prepare(
    'INSERT OR IGNORE INTO majsoul_redpackets (chat_id, owner, total, count, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const shareStmt = db.prepare('INSERT OR IGNORE INTO majsoul_redpacket_shares (packet_id, seq, amount) VALUES (?, ?, ?)');
  const packetClaimStmt = db.prepare(
    'INSERT OR IGNORE INTO majsoul_redpacket_claims (packet_id, user_id, amount, claimed_at) VALUES (?, ?, ?, ?)'
  );
  try {
    const keys = await scanKeys(redisClient, 'Yunzai:majsoul_gacha:redpacket:*');
    for (const key of keys) {
      try {
        const gid = key.slice('Yunzai:majsoul_gacha:redpacket:'.length);
        const p = JSON.parse(await redisClient.get(key) || 'null');
        if (!p || !Array.isArray(p.amounts)) throw new Error('红包数据缺少 amounts');
        const expireAt = Number(p.expireAt) || now;
        insertOrSkip(packetStmt, stats, 'redpackets', String(gid), String(p.owner ?? ''),
          Math.floor(Number(p.total) || 0), Math.floor(Number(p.count) || p.amounts.length), expireAt, now);
        p.amounts.forEach((amount, seq) => {
          insertOrSkip(shareStmt, stats, 'redShares', String(gid), seq, Math.floor(Number(amount) || 0));
        });
        for (const c of (Array.isArray(p.claimed) ? p.claimed : [])) {
          if (!c || c.userId == null) continue;
          insertOrSkip(packetClaimStmt, stats, 'redClaims', String(gid), String(c.userId),
            Math.floor(Number(c.amount) || 0), expireAt);
        }
      } catch (error) {
        fail(stats, 'redpackets', key, error);
      }
    }
  } catch (error) {
    fail(stats, 'redpackets', 'Yunzai:majsoul_gacha:redpacket:*', error);
  }

  // 6. 公共红包池
  const redpoolStmt = db.prepare('INSERT OR IGNORE INTO majsoul_redpools (chat_id, amount, updated_at) VALUES (?, ?, ?)');
  try {
    const keys = await scanKeys(redisClient, 'Yunzai:majsoul_gacha:redpool:*');
    for (const key of keys) {
      try {
        const gid = key.slice('Yunzai:majsoul_gacha:redpool:'.length);
        const amount = Math.max(0, Math.floor(Number(await redisClient.get(key)) || 0));
        insertOrSkip(redpoolStmt, stats, 'redpools', String(gid), amount, now);
      } catch (error) {
        fail(stats, 'redpools', key, error);
      }
    }
  } catch (error) {
    fail(stats, 'redpools', 'Yunzai:majsoul_gacha:redpool:*', error);
  }

  return stats;
}

/** SCAN 渐进遍历（避免 keys() 阻塞；兼容 node-redis 与 ioredis 两种返回形状） */
async function scanKeys(redisClient, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    let res;
    try {
      res = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
    } catch {
      res = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    }
    let next; let batch;
    if (Array.isArray(res)) {
      [next, batch] = res;
    } else {
      next = res.cursor; batch = res.keys;
    }
    cursor = String(next);
    keys.push(...(batch || []));
  } while (cursor !== '0');
  return keys;
}

/** 输出迁移报告 */
export function printMigrationReport(stats) {
  const line = (name, s) => console.log(
    `${name.padEnd(4, '　')}：写入 ${s.inserted}，跳过 ${s.skipped}，覆盖 ${s.overwritten}，失败 ${s.failed}`
  );
  console.log('\n========== Redis → SQLite 迁移报告（第二批） ==========');
  line('设置', stats.settings);
  line('邮件', stats.mails);
  line('邮件领取', stats.mailClaims);
  line('红包', stats.redpackets);
  line('红包份额', stats.redShares);
  line('红包领取', stats.redClaims);
  line('公共池', stats.redpools);
  if (stats.failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of stats.failures) {
      console.log(`  [${f.category}] ${f.key}: ${f.error}`);
    }
  }
  console.log('\nRedis 原数据未做任何删除，请核对 SQLite 数据后自行手动清理。');
}

// CLI 入口：直接 node utils/MigrateRedisExtraToSqlite.js 执行
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const getArg = name => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : undefined;
  };

  let conn = { host: '127.0.0.1', port: 6379, password: undefined, db: 0 };

  // 未显式传参时读取 Yunzai config/redis.yaml
  if (!args.some(a => a.startsWith('--host=') || a.startsWith('--port=') || a.startsWith('--password=') || a.startsWith('--db='))) {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const yaml = require('yaml');
      const fs = await import('fs');
      // TRSS-Yunzai 实际配置位于 config/config/redis.yaml，兼容旧版 config/redis.yaml
      let raw = null;
      for (const p of [path.join(YUNZAI_ROOT, 'config', 'config', 'redis.yaml'), path.join(YUNZAI_ROOT, 'config', 'redis.yaml')]) {
        if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf-8'); break; }
      }
      if (!raw) throw new Error('未找到 redis.yaml');
      const cfg = yaml.parse(raw);
      const r = cfg?.redis || cfg || {};
      conn = {
        host: r.host || '127.0.0.1',
        port: Number(r.port) || 6379,
        password: r.password || undefined,
        db: Number(r.db) || 0
      };
      console.log(`已从 config/redis.yaml 读取连接：${conn.host}:${conn.port} db=${conn.db}`);
    } catch {
      console.log('未找到 config/redis.yaml，使用默认连接 127.0.0.1:6379');
    }
  }
  conn.host = getArg('host') || conn.host;
  conn.port = Number(getArg('port')) || conn.port;
  conn.password = getArg('password') ?? conn.password;
  conn.db = Number(getArg('db')) || conn.db;

  // TRSS-Yunzai 使用 node-redis（redis 包）；旧版 Yunzai 使用 ioredis，两种都支持
  let client;
  let isNodeRedis = true;
  try {
    const { createClient } = await import('redis');
    client = createClient({
      socket: { host: conn.host, port: conn.port, connectTimeout: 5000 },
      password: conn.password,
      database: conn.db,
      reconnectStrategy: false // 一次性任务，连接失败立即报错退出
    });
    client.on('error', () => { /* 连接错误在下方 ping 处统一处理 */ });
  } catch {
    isNodeRedis = false;
    const { default: Redis } = await import('ioredis');
    client = new Redis({ ...conn, retryStrategy: null, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 5000 });
  }

  try {
    await client.connect?.();
    await client.ping();
    if (force) console.log('\n⚠️  --force 覆盖模式：Redis 数据将覆盖 SQLite 中的同名数据！');
    const stats = await migrateRedisExtraToSqlite(client, { force });
    printMigrationReport(stats);
  } catch (error) {
    console.error('迁移失败:', error?.message || error);
    process.exitCode = 1;
  } finally {
    try { isNodeRedis ? await client.disconnect() : client.disconnect(); } catch {}
  }
}
