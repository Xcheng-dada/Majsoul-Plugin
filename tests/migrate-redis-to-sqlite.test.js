// plugins/Majsoul-Plugin/tests/migrate-redis-to-sqlite.test.js
// 迁移安全策略测试（独立运行：node tests/migrate-redis-to-sqlite.test.js）
// 验证：
//   1. 默认安全模式只填充缺失数据：SQLite 已存在记录一律跳过，绝不回退成 Redis 旧快照
//   2. 幂等：第二次安全迁移全部 skipped，SQLite 业务数据零改动
//   3. --force 覆盖模式：仅显式传入时才允许 Redis 覆盖 SQLite
//   4. Redis 原数据全程不被删除/修改
// 使用 mock Redis 客户端 + 系统临时目录数据库，绝不触碰真实 data/majsoul.db
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-mig-safe-'));
process.env.MAJSOUL_DB_PATH = path.join(tmpDir, 'mig-safe.db');

let passed = 0;
function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✔ ${name}`); })
    .catch(error => {
      console.error(`  ✘ ${name}`);
      console.error(error && error.stack || error);
      process.exitCode = 1;
    });
}

// Yunzai 运行环境自带全局 logger；独立测试环境补一个 stub
if (typeof globalThis.logger === 'undefined') {
  globalThis.logger = { mark: () => {}, debug: () => {}, info: () => {}, warn: console.warn, error: console.error };
}

console.log(`[测试] 测试数据库：${process.env.MAJSOUL_DB_PATH}`);

const { migrateRedisToSqlite, printMigrationReport } = await import('../utils/MigrateRedisToSqlite.js');
const { getDatabase, closeDatabase } = await import('../utils/MajsoulDatabase.js');

const db = getDatabase(); // 读取 MAJSOUL_DB_PATH

const W1 = '60001'; // 钱包测试 QQ
const Q1 = '70001'; // 绑定/签到/图鉴测试 QQ

// ---------- 预置 SQLite"较新"数据（模拟迁移前用户已在 SQLite 上产生的数据） ----------
db.prepare(`INSERT INTO majsoul_wallets (qq_id, jade, ticket, created_at, updated_at) VALUES (?, 200, 1, 1, 1)`).run(W1);
db.prepare(`INSERT INTO majsoul_user_bindings (qq_id, uid, nickname, is_main, created_at, updated_at) VALUES (?, '111', 'SQLite里的昵称', 1, 1, 1)`).run(Q1);
db.prepare(`INSERT INTO majsoul_signins (qq_id, last_date, streak, total_days, welcomed, created_at, updated_at) VALUES (?, '2026-09-21', 5, 5, 1, 1, 1)`).run(Q1);
db.prepare(`INSERT INTO majsoul_collections (qq_id, kind, item_name, count, first_date, created_at, updated_at) VALUES (?, 'characters', '旧雀士', 3, '2026-09-21', 1, 1)`).run(Q1);

// ---------- mock Redis"旧快照"数据 ----------
const REDIS_WALLET_W1 = '{"jade":100,"ticket":0,"ticket10":0,"dust":0,"stone":0,"wish":0,"faith":0}';
const REDIS_SIGN_Q1 = '{"lastDate":"2026-09-01","streak":1,"totalDays":99,"welcomed":false}';
const REDIS_COLL_Q1 = '{"characters":{"旧雀士":{"count":9,"first":"2026-09-01"},"新雀士":{"count":1,"first":"2026-09-01"}},"decorations":{}}';
const store = {
  [`Yunzai:majsoul_gacha:wallet:${W1}`]: REDIS_WALLET_W1,
  [`Yunzai:majsoul_gacha:sign:${Q1}`]: REDIS_SIGN_Q1,
  [`Yunzai:majsoul_gacha:collection:${Q1}`]: REDIS_COLL_Q1,
  [`majsoul:user:${Q1}:bindings`]: '["111","222"]',
  [`majsoul:user:${Q1}:main`]: '222',
  [`majsoul:user:${Q1}:111:nickname`]: 'Redis旧昵称',
  // 干扰项：跨段 key，不应被误认为绑定列表
  [`majsoul:user:${Q1}:111:bindings`]: '["999"]'
};
const mockClient = {
  async scan(cursor, cmd, pattern) {
    assert.equal(cmd, 'MATCH');
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, ch => ch === '*' ? '.*' : '\\' + ch) + '$');
    return ['0', Object.keys(store).filter(k => re.test(k))];
  },
  async get(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; }
};

const qWallet = () => db.prepare(`SELECT jade, ticket FROM majsoul_wallets WHERE qq_id = ?`).get(W1);
const qBindings = () => db.prepare(`SELECT uid, nickname, is_main FROM majsoul_user_bindings WHERE qq_id = ? ORDER BY created_at, rowid`).all(Q1);
const qSign = () => db.prepare(`SELECT last_date, streak, total_days, welcomed FROM majsoul_signins WHERE qq_id = ?`).get(Q1);
const qColl = name => db.prepare(`SELECT count, first_date FROM majsoul_collections WHERE qq_id = ? AND kind = 'characters' AND item_name = ?`).get(Q1, name);

// ---------- 1. 默认安全模式：只填充缺失数据 ----------
console.log('[测试] 安全模式（默认）');
await step('钱包已存在 → 跳过，SQLite 仍为 200（不回退成 Redis 的 100）', async () => {
  const s = await migrateRedisToSqlite(mockClient);
  assert.deepEqual({ inserted: s.wallets.inserted, skipped: s.wallets.skipped, overwritten: s.wallets.overwritten, failed: s.wallets.failed },
    { inserted: 0, skipped: 1, overwritten: 0, failed: 0 });
  assert.equal(qWallet().jade, 200);
  assert.equal(s.mode, 'safe');
});
await step('UID绑定：已有 uid 跳过且昵称/主UID不被覆盖，缺失 uid 补充', async () => {
  // 上一 step 已跑过一次迁移，这里校验结果
  const rows = qBindings();
  assert.deepEqual(rows.map(r => r.uid), ['111', '222']);
  assert.equal(rows[0].nickname, 'SQLite里的昵称'); // 未被 Redis 旧昵称覆盖
  assert.equal(rows[0].is_main, 1);                // SQLite 自己的主UID保留
  assert.equal(rows[1].is_main, 0);                // 新补充的 uid 不抢主（避免双主）
});
await step('签到已存在 → 跳过，SQLite 仍为 total_days=5（不回退成 99）', async () => {
  const sign = qSign();
  assert.equal(sign.total_days, 5);
  assert.equal(sign.streak, 5);
  assert.equal(sign.last_date, '2026-09-21');
});
await step('图鉴：已有雀士跳过（count 仍为 3），缺失雀士补充（count=1）', async () => {
  assert.equal(qColl('旧雀士').count, 3);
  assert.equal(qColl('新雀士').count, 1);
  assert.equal(qColl('新雀士').first_date, '2026-09-01'); // 新增记录的 first 来自 Redis
});
await step('跨段干扰 key 未被误迁移', async () => {
  const rogue = db.prepare(`SELECT COUNT(*) AS n FROM majsoul_user_bindings WHERE uid = '999'`).get();
  assert.equal(rogue.n, 0);
});
await step('Redis 原数据未被删除/修改', async () => {
  assert.equal(store[`Yunzai:majsoul_gacha:wallet:${W1}`], REDIS_WALLET_W1);
  assert.equal(store[`Yunzai:majsoul_gacha:sign:${Q1}`], REDIS_SIGN_Q1);
  assert.equal(store[`Yunzai:majsoul_gacha:collection:${Q1}`], REDIS_COLL_Q1);
  assert.equal(store[`majsoul:user:${Q1}:bindings`], '["111","222"]');
  assert.equal(store[`majsoul:user:${Q1}:main`], '222');
});

// ---------- 2. 幂等：第二次安全迁移零改动 ----------
console.log('[测试] 幂等性');
await step('第二次安全迁移：全部 skipped，数据零改动', async () => {
  const s = await migrateRedisToSqlite(mockClient);
  assert.equal(s.wallets.inserted, 0); assert.equal(s.wallets.overwritten, 0); assert.equal(s.wallets.skipped, 1);
  assert.equal(s.signs.inserted, 0); assert.equal(s.signs.overwritten, 0); assert.equal(s.signs.skipped, 1);
  assert.equal(s.bindings.inserted, 0); assert.equal(s.bindings.overwritten, 0); assert.equal(s.bindings.skipped, 2);
  assert.equal(s.collections.inserted, 0); assert.equal(s.collections.overwritten, 0); assert.equal(s.collections.skipped, 2);
  assert.equal(qWallet().jade, 200);
  assert.equal(qSign().total_days, 5);
  assert.equal(qColl('旧雀士').count, 3);
  assert.equal(qBindings().length, 2);
});

// ---------- 3. --force 覆盖模式 ----------
console.log('[测试] 覆盖模式（--force）');
await step('force：钱包被 Redis 的 100 覆盖', async () => {
  const s = await migrateRedisToSqlite(mockClient, { force: true });
  assert.equal(s.mode, 'force');
  assert.equal(s.wallets.overwritten, 1);
  assert.equal(s.wallets.skipped, 0);
  assert.equal(qWallet().jade, 100);
});
await step('force：UID绑定被覆盖，主UID按 Redis 重设为 222', async () => {
  const s = await migrateRedisToSqlite(mockClient, { force: true });
  assert.equal(s.bindings.overwritten, 2);
  assert.equal(s.bindings.mains, 1);
  const rows = qBindings();
  assert.equal(rows.find(r => r.uid === '111').nickname, 'Redis旧昵称'); // 昵称被 Redis 覆盖
  assert.equal(rows.filter(r => r.is_main === 1).map(r => r.uid).join(','), '222'); // 主UID重设，无双主
});
await step('force：签到与图鉴被 Redis 旧快照覆盖', async () => {
  const s = await migrateRedisToSqlite(mockClient, { force: true });
  assert.equal(s.signs.overwritten, 1);
  assert.equal(qSign().total_days, 99);
  assert.equal(qSign().last_date, '2026-09-01');
  assert.equal(s.collections.overwritten, 2); // 旧雀士 + 新雀士 都已存在，均被覆盖
  assert.equal(qColl('旧雀士').count, 9);
  assert.equal(qColl('旧雀士').first_date, '2026-09-01');
});
await step('force 迁移后 Redis 原数据依然原样保留', async () => {
  assert.equal(store[`Yunzai:majsoul_gacha:wallet:${W1}`], REDIS_WALLET_W1);
  assert.equal(store[`majsoul:user:${Q1}:main`], '222');
});

// ---------- 报告输出示例 ----------
console.log('\n===== 安全模式报告输出示例 =====');
printMigrationReport(await migrateRedisToSqlite(mockClient));

// ---------- 收尾 ----------
closeDatabase();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n[测试] 完成：${passed} 项通过${process.exitCode ? '（存在失败项）' : '，全部通过'}`);
