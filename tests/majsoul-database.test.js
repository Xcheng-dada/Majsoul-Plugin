// plugins/Majsoul-Plugin/tests/majsoul-database.test.js
// SQLite 数据层最小 smoke test（独立运行：node tests/majsoul-database.test.js）
// 使用系统临时目录中的测试数据库，绝不触碰真实 data/majsoul.db
// 覆盖：建表 → 绑定（增/切主/删/主回退）→ 钱包（入账/自动兑换/扣款）→ 签到（首签/防双签）→ 图鉴（重复计数）→ 重启持久化
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-db-test-'));
const dbFile = path.join(tmpDir, 'test.db');

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

console.log(`[测试] 测试数据库：${dbFile}`);

// Yunzai 运行环境自带全局 logger；独立测试环境补一个 stub（所有插件模块直接引用裸全局 logger）
if (typeof globalThis.logger === 'undefined') {
  globalThis.logger = { mark: () => {}, debug: () => {}, info: () => {}, warn: console.warn, error: console.error };
}

// 必须最先用测试路径初始化单例，后续所有模块共享该连接
const { getDatabase, closeDatabase } = await import('../utils/MajsoulDatabase.js');
const { default: GachaWallet } = await import('../utils/GachaWallet.js');
const { default: GachaSign } = await import('../utils/GachaSign.js');
const { default: GachaCollection } = await import('../utils/GachaCollection.js');
const bindings = await import('../utils/MajsoulBindings.js');

getDatabase(dbFile);

const wallet = new GachaWallet();
const signer = new GachaSign();
// 图鉴测试只需要 add/get，不涉及资源目录，传入最小 stub
const collection = new GachaCollection({ resourcesRoot: '', characterFileMap: new Map() });

const QQ = '10001';

// ---------- 1. UID 绑定 ----------
console.log('[测试] UID 绑定');
await step('绑定两个 UID', async () => {
  assert.equal(await bindings.addUserBinding(QQ, '111111', '小明'), true);
  assert.equal(await bindings.addUserBinding(QQ, '222222'), true);
  assert.deepEqual(await bindings.getUserBindings(QQ), ['111111', '222222']);
});
await step('第一个绑定自动成为主UID', async () => {
  assert.equal(await bindings.getMainUid(QQ), '111111');
});
await step('切换主UID', async () => {
  assert.equal(await bindings.setMainUid(QQ, '222222'), true);
  assert.equal(await bindings.getMainUid(QQ), '222222');
});
await step('删除主UID后自动回退第一个剩余绑定', async () => {
  assert.equal(await bindings.removeUserBinding(QQ, '222222'), true);
  assert.deepEqual(await bindings.getUserBindings(QQ), ['111111']);
  assert.equal(await bindings.getMainUid(QQ), '111111');
});
await step('全部删除后无主UID，重复绑定不生效', async () => {
  assert.equal(await bindings.removeUserBinding(QQ, '111111'), true);
  assert.deepEqual(await bindings.getUserBindings(QQ), []);
  assert.equal(await bindings.getMainUid(QQ), null);
  await bindings.addUserBinding(QQ, '333333', '小红');
  await bindings.addUserBinding(QQ, '333333', '改名也不生效');
  assert.deepEqual(await bindings.getUserBindings(QQ), ['333333']);
  assert.equal(await bindings.getMainUid(QQ), '333333');
});

// ---------- 2. 钱包 ----------
console.log('[测试] 钱包');
await step('入账 + 自动兑换链（许愿石/星之石→粉尘→寻觅卷轴）', async () => {
  const { wallet: w, converted } = await wallet.add(QQ, { jade: 500, wish: 30, stone: 24, dust: 99 });
  // 兑换链：wish30→dust；stone24→20兑10粉尘剩4；dust(99+30+10)=139→2卷轴剩39
  assert.equal(w.jade, 500);
  assert.equal(w.wish, 0);
  assert.equal(w.stone, 4);
  assert.equal(w.dust, 39);
  assert.equal(w.ticket, 2);
  assert.equal(w.faith, 0);
  assert.ok(converted.length >= 3);
});
await step('余额不足拒绝扣款', async () => {
  const r = await wallet.spend(QQ, { jade: 99999 });
  assert.equal(r.ok, false);
  assert.equal(r.lack, '辉玉');
});
await step('正常扣款', async () => {
  const r = await wallet.spend(QQ, { jade: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.wallet.jade, 400);
});
await step('set 直改货币并触发兑换', async () => {
  await wallet.set(QQ, 'dust', 50);
  const w = await wallet.get(QQ);
  assert.equal(w.dust, 0);
  assert.equal(w.ticket, 3); // 原2张 + 50粉尘兑1张
});
await step('setAll 仅影响已有钱包', async () => {
  const n = await wallet.setAll('jade', 77);
  assert.equal(n, 1); // 此刻只有 QQ 一个钱包
  const w = await wallet.get(QQ);
  assert.equal(w.jade, 77);
});

// ---------- 3. 签到 ----------
console.log('[测试] 签到');
await step('首次签到（欢迎礼包）', async () => {
  const before = await signer.get(QQ);
  assert.equal(before.lastDate, null);
  const r = await signer.sign(QQ);
  assert.equal(r.already, false);
  assert.equal(r.welcome, true);
  assert.equal(r.streak, 1);
  assert.equal(r.totalDays, 1);
  assert.ok(r.jade >= 650); // 基础150~250 + 首签500
});
await step('同一天重复签到被拒绝（以 SQLite 为准）', async () => {
  const r = await signer.sign(QQ);
  assert.equal(r.already, true);
  assert.equal(r.totalDays, 1);
});

// ---------- 4. 图鉴 ----------
console.log('[测试] 图鉴');
await step('添加雀士并重复计数', async () => {
  const r1 = await collection.add(QQ, 'characters', '三上千织');
  assert.deepEqual(r1, { isNew: true, count: 1 });
  const r2 = await collection.add(QQ, 'characters', '三上千织');
  assert.deepEqual(r2, { isNew: false, count: 2 });
  const coll = await collection.get(QQ);
  assert.equal(coll.characters['三上千织'].count, 2);
  assert.ok(coll.characters['三上千织'].first); // first 日期存在
  assert.deepEqual(coll.decorations, {});
});
await step('装扮与雀士互不干扰，未知类型被拒绝', async () => {
  await collection.add(QQ, 'decorations', '猫爪抱枕');
  const coll = await collection.get(QQ);
  assert.equal(coll.decorations['猫爪抱枕'].count, 1);
  const bad = await collection.add(QQ, 'unknown', 'x');
  assert.equal(bad.isNew, false);
});

// ---------- 5. 重启持久化（关闭连接后重新打开） ----------
console.log('[测试] 重启持久化');
await step('关闭并重新打开数据库后数据仍在', async () => {
  closeDatabase();
  getDatabase(dbFile); // 模拟重启（模块级单例重置，预编译语句自动重建）
  assert.deepEqual(await bindings.getUserBindings(QQ), ['333333']);
  assert.equal(await bindings.getMainUid(QQ), '333333');
  const w = await wallet.get(QQ);
  assert.equal(w.jade, 77);
  assert.equal(w.ticket, 3);
  const sign = await signer.get(QQ);
  assert.equal(sign.totalDays, 1);
  assert.equal(sign.welcomed, true);
  const coll = await collection.get(QQ);
  assert.equal(coll.characters['三上千织'].count, 2);
  assert.equal(coll.decorations['猫爪抱枕'].count, 1);
});

// ---------- 收尾 ----------
closeDatabase();
const kept = ['test.db', 'test.db-wal', 'test.db-shm'].filter(f => fs.existsSync(path.join(tmpDir, f)));
console.log(`[测试] 生成的数据库文件：${kept.join(', ')}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n[测试] 完成：${passed} 项通过${process.exitCode ? '（存在失败项）' : '，全部通过'}`);
