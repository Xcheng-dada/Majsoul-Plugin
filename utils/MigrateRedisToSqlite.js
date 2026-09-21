// plugins/Majsoul-Plugin/utils/MigrateRedisToSqlite.js
// 一次性迁移工具：Redis 持久化业务数据 → SQLite（data/majsoul.db）
// 迁移范围（仅此四类，其余 Redis key 为临时状态/缓存/限次，不迁移）：
//   1. UID绑定  majsoul:user:<qid>:bindings / :main / :<uid>:nickname
//   2. 钱包     Yunzai:majsoul_gacha:wallet:<qid>
//   3. 签到     Yunzai:majsoul_gacha:sign:<qid>
//   4. 图鉴     Yunzai:majsoul_gacha:collection:<qid>
// 迁移策略（安全优先）：
//   - 默认安全模式：只填充 SQLite 中不存在的数据；已存在的记录一律跳过，
//     绝不把 SQLite 中较新的数据覆盖回 Redis 的旧快照。overwritten 恒为 0。
//   - 显式覆盖模式：仅当用户明确传入 --force（或 { force: true }）时，
//     才允许 Redis 数据覆盖 SQLite 同主键旧值。
//   - 幂等：可重复执行。安全模式下第二次执行全部 skipped，SQLite 业务数据零改动。
//   - 绝不删除任何 Redis 原数据。
//   - 失败数据逐条输出 QQ / key / error，不中断整体流程。
// 用法：
//   A. 独立 CLI（推荐先停机器人）：node utils/MigrateRedisToSqlite.js [--force] [--host=..] [--port=..] [--password=..] [--db=0]
//      未传参数时尝试读取 Yunzai 根目录 config/redis.yaml，读不到则用 127.0.0.1:6379 无密码
//   B. 在 Yunzai 运行环境内调用：await migrateRedisToSqlite()（自动复用 global.redis）

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import { getDatabase } from './MajsoulDatabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 旧 Redis key 前缀（与旧版源码一致）
const P_WALLET = 'Yunzai:majsoul_gacha:wallet:';
const P_SIGN = 'Yunzai:majsoul_gacha:sign:';
const P_COLLECTION = 'Yunzai:majsoul_gacha:collection:';
const P_USER = 'majsoul:user:';

const CURRENCY_KEYS = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith'];

// 用 SCAN 渐进遍历（避免 KEYS 阻塞 Redis）
async function scanKeys(client, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0');
  keys.sort();
  return keys;
}

// 从 key 中提取 qid 并校验（防止 * 通配跨段匹配，如 majsoul:user:1:2:bindings）
function extractSegment(key, prefix, suffix = '') {
  let mid = key.slice(prefix.length);
  if (suffix) {
    if (!mid.endsWith(suffix)) return null;
    mid = mid.slice(0, -suffix.length);
  }
  if (!mid || mid.includes(':')) return null;
  return mid;
}

function toInt(n, def = 0) {
  const num = Math.floor(Number(n));
  return Number.isFinite(num) ? num : def;
}

/**
 * 执行迁移（幂等；默认安全模式只填充缺失数据，绝不删除 Redis 数据）
 * @param {object} [redisClient] ioredis 客户端，缺省使用 globalThis.redis
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 覆盖模式：Redis 覆盖 SQLite 已存在的同主键数据（默认 false）
 * @returns {Promise<object>} 统计结果（各实体 inserted/skipped/overwritten/failed）
 */
export async function migrateRedisToSqlite(redisClient, { force = false } = {}) {
  const client = redisClient || globalThis.redis;
  if (!client || typeof client.scan !== 'function') {
    throw new Error('未找到可用的 Redis 客户端。请在 Yunzai 环境内调用，或用 CLI 模式运行：node utils/MigrateRedisToSqlite.js');
  }

  const db = getDatabase();

  // 安全模式：INSERT OR IGNORE（配合前置存在性检查，双重防护）
  // 覆盖模式：ON CONFLICT DO UPDATE
  const stmts = {
    wallet: {
      sel: db.prepare(`SELECT qq_id FROM majsoul_wallets WHERE qq_id = ?`),
      insert: db.prepare(`
        INSERT OR IGNORE INTO majsoul_wallets (qq_id, jade, ticket, ticket10, dust, stone, wish, faith, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      upsert: db.prepare(`
        INSERT INTO majsoul_wallets (qq_id, jade, ticket, ticket10, dust, stone, wish, faith, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(qq_id) DO UPDATE SET
          jade = excluded.jade, ticket = excluded.ticket, ticket10 = excluded.ticket10,
          dust = excluded.dust, stone = excluded.stone, wish = excluded.wish, faith = excluded.faith,
          updated_at = excluded.updated_at`)
    },
    sign: {
      sel: db.prepare(`SELECT qq_id FROM majsoul_signins WHERE qq_id = ?`),
      insert: db.prepare(`
        INSERT OR IGNORE INTO majsoul_signins (qq_id, last_date, streak, total_days, welcomed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      upsert: db.prepare(`
        INSERT INTO majsoul_signins (qq_id, last_date, streak, total_days, welcomed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(qq_id) DO UPDATE SET
          last_date = excluded.last_date, streak = excluded.streak,
          total_days = excluded.total_days, welcomed = excluded.welcomed,
          updated_at = excluded.updated_at`)
    },
    coll: {
      sel: db.prepare(`SELECT item_name FROM majsoul_collections WHERE qq_id = ? AND kind = ? AND item_name = ?`),
      insert: db.prepare(`
        INSERT OR IGNORE INTO majsoul_collections (qq_id, kind, item_name, count, first_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      upsert: db.prepare(`
        INSERT INTO majsoul_collections (qq_id, kind, item_name, count, first_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(qq_id, kind, item_name) DO UPDATE SET
          count = excluded.count, first_date = excluded.first_date, updated_at = excluded.updated_at`)
    },
    binding: {
      sel: db.prepare(`SELECT is_main FROM majsoul_user_bindings WHERE qq_id = ? AND uid = ?`),
      selAnyMain: db.prepare(`SELECT uid FROM majsoul_user_bindings WHERE qq_id = ? AND is_main = 1 LIMIT 1`),
      insert: db.prepare(`
        INSERT OR IGNORE INTO majsoul_user_bindings (qq_id, uid, nickname, is_main, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)`),
      upsert: db.prepare(`
        INSERT INTO majsoul_user_bindings (qq_id, uid, nickname, is_main, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(qq_id, uid) DO UPDATE SET
          nickname = excluded.nickname, created_at = excluded.created_at, updated_at = excluded.updated_at`),
      resetMain: db.prepare(`UPDATE majsoul_user_bindings SET is_main = 0 WHERE qq_id = ?`),
      setMain: db.prepare(`UPDATE majsoul_user_bindings SET is_main = 1 WHERE qq_id = ? AND uid = ?`)
    }
  };

  const newCounts = () => ({ inserted: 0, skipped: 0, overwritten: 0, failed: 0 });
  const stats = {
    mode: force ? 'force' : 'safe',
    bindings: { qids: 0, mains: 0, ...newCounts() },
    wallets: { found: 0, ...newCounts() },
    signs: { found: 0, ...newCounts() },
    collections: { users: 0, ...newCounts() },
    errors: [] // { step, key, qq, error }
  };
  const now = Date.now();

  // ---------- 1. UID绑定 ----------
  // 数组顺序 = 绑定顺序：created_at 按序回退毫秒，保证"第一个绑定"语义可稳定复现
  const bindingKeys = await scanKeys(client, `${P_USER}*:bindings`);
  for (const key of bindingKeys) {
    const qid = extractSegment(key, P_USER, ':bindings');
    if (!qid) continue;
    stats.bindings.qids++;
    try {
      const raw = await client.get(key);
      const list = JSON.parse(raw || '[]');
      if (!Array.isArray(list)) throw new Error('bindings 内容不是数组');
      const base = Date.now();
      const uids = [];
      const insertedUids = new Set(); // 本次运行新插入的 uid（安全模式下主UID只标记新插入的行）
      for (let i = 0; i < list.length; i++) {
        const uid = String(list[i] || '').trim();
        if (!uid) continue;
        uids.push(uid);
        let nickname = null;
        try {
          nickname = await client.get(`${P_USER}${qid}:${uid}:nickname`);
        } catch { /* 昵称缺失不阻塞迁移 */ }
        const values = [qid, uid, nickname || null, base - (list.length - 1 - i) * 1000, now];
        const exists = !!stmts.binding.sel.get(qid, uid);
        if (exists && !force) {
          stats.bindings.skipped++; // 已存在：不覆盖
          continue;
        }
        if (exists && force) {
          stmts.binding.upsert.run(...values);
          stats.bindings.overwritten++;
        } else {
          stmts.binding.insert.run(...values);
          stats.bindings.inserted++;
          insertedUids.add(uid);
        }
      }
      // 主 UID 标记
      const mainRaw = await client.get(`${P_USER}${qid}:main`).catch(() => null);
      if (mainRaw) {
        const mainUid = String(mainRaw).trim();
        if (uids.includes(mainUid)) {
          if (force) {
            // 覆盖模式：完全按 Redis 重设主UID
            stmts.binding.resetMain.run(qid);
            stmts.binding.setMain.run(qid, mainUid);
            stats.bindings.mains++;
          } else if (insertedUids.has(mainUid) && !stmts.binding.selAnyMain.get(qid)) {
            // 安全模式：仅当主UID行是本次新插入、且 SQLite 当前没有任何主UID时才补标记，
            // 绝不改动已存在的主UID（避免覆盖 SQLite 自己的主账号选择，也不会产生双主）
            stmts.binding.setMain.run(qid, mainUid);
            stats.bindings.mains++;
          }
        }
      }
    } catch (error) {
      stats.bindings.failed++;
      stats.errors.push({ step: 'UID绑定', key, qq: qid, error: error.message });
    }
  }

  // ---------- 2. 钱包 ----------
  const walletKeys = await scanKeys(client, `${P_WALLET}*`);
  for (const key of walletKeys) {
    const qid = extractSegment(key, P_WALLET);
    if (!qid) continue;
    stats.wallets.found++;
    try {
      const raw = await client.get(key);
      if (!raw) { stats.wallets.skipped++; continue; }
      const data = JSON.parse(raw);
      const values = [qid, ...CURRENCY_KEYS.map(k => Math.max(0, toInt(data[k]))), now, now];
      const exists = !!stmts.wallet.sel.get(qid);
      if (exists && !force) {
        stats.wallets.skipped++; // 已存在：不覆盖
      } else if (exists && force) {
        stmts.wallet.upsert.run(...values);
        stats.wallets.overwritten++;
      } else {
        stmts.wallet.insert.run(...values);
        stats.wallets.inserted++;
      }
    } catch (error) {
      stats.wallets.failed++;
      stats.errors.push({ step: '钱包', key, qq: qid, error: error.message });
    }
  }

  // ---------- 3. 签到 ----------
  const signKeys = await scanKeys(client, `${P_SIGN}*`);
  for (const key of signKeys) {
    const qid = extractSegment(key, P_SIGN);
    if (!qid) continue;
    stats.signs.found++;
    try {
      const raw = await client.get(key);
      if (!raw) { stats.signs.skipped++; continue; }
      const data = JSON.parse(raw);
      const lastDate = typeof data.lastDate === 'string' && data.lastDate ? data.lastDate : null;
      const values = [
        qid, lastDate,
        Math.max(0, toInt(data.streak)),
        Math.max(0, toInt(data.totalDays)),
        data.welcomed ? 1 : 0,
        now, now
      ];
      const exists = !!stmts.sign.sel.get(qid);
      if (exists && !force) {
        stats.signs.skipped++; // 已存在：不覆盖
      } else if (exists && force) {
        stmts.sign.upsert.run(...values);
        stats.signs.overwritten++;
      } else {
        stmts.sign.insert.run(...values);
        stats.signs.inserted++;
      }
    } catch (error) {
      stats.signs.failed++;
      stats.errors.push({ step: '签到', key, qq: qid, error: error.message });
    }
  }

  // ---------- 4. 图鉴 ----------
  const collKeys = await scanKeys(client, `${P_COLLECTION}*`);
  for (const key of collKeys) {
    const qid = extractSegment(key, P_COLLECTION);
    if (!qid) continue;
    stats.collections.users++;
    try {
      const raw = await client.get(key);
      if (!raw) { stats.collections.skipped++; continue; }
      const data = JSON.parse(raw);
      for (const kind of ['characters', 'decorations']) {
        const map = data[kind];
        if (!map || typeof map !== 'object') continue;
        for (const [name, rec] of Object.entries(map)) {
          if (!name) continue;
          const values = [
            qid, kind, name,
            Math.max(1, toInt(rec && rec.count, 1) || 1),
            rec && typeof rec.first === 'string' && rec.first ? rec.first : null,
            now, now
          ];
          const exists = !!stmts.coll.sel.get(qid, kind, name);
          if (exists && !force) {
            stats.collections.skipped++; // 已存在：不覆盖
          } else if (exists && force) {
            stmts.coll.upsert.run(...values);
            stats.collections.overwritten++;
          } else {
            stmts.coll.insert.run(...values);
            stats.collections.inserted++;
          }
        }
      }
    } catch (error) {
      stats.collections.failed++;
      stats.errors.push({ step: '图鉴', key, qq: qid, error: error.message });
    }
  }

  return stats;
}

/** 输出统计报告（迁移完成后调用） */
export function printMigrationReport(stats) {
  const modeLabel = stats.mode === 'force'
    ? '覆盖模式（--force：Redis 已覆盖 SQLite 同主键旧值）'
    : '安全模式（只填充 SQLite 缺失的数据，已有数据未改动）';
  const fmt = c => `写入 ${c.inserted} / 跳过 ${c.skipped} / 覆盖 ${c.overwritten} / 失败 ${c.failed}`;
  const lines = [
    `========== Redis → SQLite 迁移完成 ==========
模式：${modeLabel}

UID绑定：
发现 ${stats.bindings.qids} 个 QQ
记录：${fmt(stats.bindings)}
标记 ${stats.bindings.mains} 个主UID

钱包：
发现 ${stats.wallets.found} 个钱包：${fmt(stats.wallets)}

签到：
${fmt(stats.signs)}

图鉴：
发现 ${stats.collections.users} 个用户
记录：${fmt(stats.collections)}`
  ];
  if (stats.errors.length > 0) {
    lines.push(`
迁移失败 ${stats.errors.length} 条（数据未写入 SQLite，Redis 原数据未受影响）：`);
    for (const e of stats.errors) {
      lines.push(`  - [${e.step}] QQ=${e.qq} key=${e.key} 原因: ${e.error}`);
    }
  } else {
    lines.push(`
迁移失败：0 条`);
  }
  lines.push(`
未删除任何 Redis 原数据。请核对以上统计与 SQLite 数据后，再自行手动清理旧 Redis 数据。`);
  const text = lines.join(`\n`);
  console.log(text);
  return text;
}

// ---------- CLI 入口 ----------
async function runCli() {
  // 参数解析：--force（无值开关）与 --host= --port= --password= --db=
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/i);
    if (m) args[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
  }
  const force = args.force === true;

  if (force) {
    console.log('[迁移] ⚠️ 已启用 --force 覆盖模式：Redis 数据将覆盖 SQLite 中已存在的同主键数据！');
  } else {
    console.log('[迁移] 安全模式：只填充 SQLite 缺失的数据，已有数据不会被覆盖（需要覆盖请加 --force）');
  }

  let client = globalThis.redis;
  let usingGlobal = !!client;

  if (!client) {
    // 读取 Yunzai 根目录的 config/redis.yaml（utils → 插件根 → plugins → Yunzai 根）
    let cfg = {};
    const cfgPath = path.join(__dirname, '..', '..', '..', 'config', 'redis.yaml');
    try {
      const yaml = await import('yaml');
      const parsed = yaml.parse(fs.readFileSync(cfgPath, 'utf8'));
      const r = (parsed && parsed.redis) ? parsed.redis : (parsed || {});
      cfg = { host: r.host, port: r.port, password: r.password, db: r.db };
      console.log(`[迁移] 已读取 Redis 配置：${cfgPath}`);
    } catch {
      console.log(`[迁移] 未读到 ${cfgPath}，使用默认连接参数 127.0.0.1:6379`);
    }
    const host = args.host || cfg.host || '127.0.0.1';
    const port = parseInt(args.port || cfg.port || 6379, 10);
    const password = args.password !== undefined ? args.password : (cfg.password || undefined);
    const dbIndex = parseInt(args.db || cfg.db || 0, 10);
    const Redis = (await import('ioredis')).default;
    client = new Redis({ host, port, password: password || undefined, db: dbIndex, maxRetriesPerRequest: 2 });
    usingGlobal = false;
    console.log(`[迁移] 连接 Redis：${host}:${port} db=${dbIndex}${password ? '（带密码）' : ''}`);
  }

  try {
    await client.ping();
    const stats = await migrateRedisToSqlite(client, { force });
    printMigrationReport(stats);
    if (stats.errors.length > 0) process.exitCode = 2; // 有失败条目时以非零退出便于脚本感知
  } finally {
    if (!usingGlobal) client.quit();
  }
}

// 直接以 `node utils/MigrateRedisToSqlite.js` 运行时进入 CLI
const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  runCli().catch(error => {
    console.error('[迁移] 执行失败:', error);
    process.exit(1);
  });
}
