// plugins/Majsoul-Plugin/utils/MajsoulBindings.js
// QQ ↔ 雀魂 UID 绑定关系服务层（SQLite 持久化，原 Redis majsoul:user:* 键已迁移）
// 行为与旧版保持一致：
// - 一个 QQ 可绑定多个 UID，绑定顺序即展示顺序（最早绑定排最前）
// - 主 UID 用 is_main=1 标记；未设置时回退第一个绑定
// - 第一个绑定自动成为主 UID；删除主 UID 后自动把剩余第一个设为主 UID，全部删除则无主 UID
// 调用方：apps/MajsoulUser.js（增删改查）、apps/MajsoulRecords.js / apps/MajsoulInfo.js（查主 UID）

import { getDatabase } from './MajsoulDatabase.js';

// 预编译语句按连接实例缓存（测试关闭重开后自动重建）
const stmtCache = new WeakMap();

function getStmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    // 绑定列表：创建时间升序，同一毫秒按插入顺序，复现旧版数组顺序语义
    list: db.prepare(`SELECT uid, nickname, is_main FROM majsoul_user_bindings WHERE qq_id = ? ORDER BY created_at ASC, rowid ASC`),
    get: db.prepare(`SELECT is_main FROM majsoul_user_bindings WHERE qq_id = ? AND uid = ?`),
    ins: db.prepare(`INSERT INTO majsoul_user_bindings (qq_id, uid, nickname, is_main, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`),
    del: db.prepare(`DELETE FROM majsoul_user_bindings WHERE qq_id = ? AND uid = ?`),
    delAll: db.prepare(`DELETE FROM majsoul_user_bindings WHERE qq_id = ?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM majsoul_user_bindings WHERE qq_id = ?`),
    first: db.prepare(`SELECT uid FROM majsoul_user_bindings WHERE qq_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`),
    clearMain: db.prepare(`UPDATE majsoul_user_bindings SET is_main = 0, updated_at = ? WHERE qq_id = ? AND is_main = 1`),
    setMain: db.prepare(`UPDATE majsoul_user_bindings SET is_main = 1, updated_at = ? WHERE qq_id = ? AND uid = ?`),
    main: db.prepare(`SELECT uid FROM majsoul_user_bindings WHERE qq_id = ? AND is_main = 1 LIMIT 1`)
  };
  stmtCache.set(db, s);
  return s;
}

/**
 * 获取用户所有绑定 UID（数组，顺序=绑定顺序）
 * @param {string|number} qid QQ号
 * @returns {Promise<string[]>}
 */
export async function getUserBindings(qid) {
  try {
    const rows = getStmts(getDatabase()).list.all(String(qid));
    return rows.map(r => r.uid);
  } catch (error) {
    logger.error('[MajsoulBindings] 获取用户绑定失败:', error);
    return [];
  }
}

/**
 * 添加绑定（已存在时不做任何修改，与旧版一致）
 * @param {string|number} qid QQ号
 * @param {string} uid 雀魂UID
 * @param {string} [nickname] 昵称（可选）
 * @returns {Promise<boolean>} 是否成功（已存在也返回 true）
 */
export async function addUserBinding(qid, uid, nickname = '') {
  try {
    const db = getDatabase();
    const s = getStmts(db);
    const qq = String(qid);
    const id = String(uid);
    db.transaction(() => {
      if (s.get.get(qq, id)) return; // 已绑定：旧版不更新昵称，保持一致
      const now = Date.now();
      s.ins.run(qq, id, nickname || null, now, now);
      // 第一个绑定自动成为主 UID
      if (s.count.get(qq).n === 1) {
        s.setMain.run(now, qq, id);
      }
    })();
    return true;
  } catch (error) {
    logger.error('[MajsoulBindings] 添加绑定失败:', error);
    return false;
  }
}

/**
 * 移除绑定（若是主 UID 则自动把剩余第一个设为主 UID）
 * @param {string|number} qid
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
export async function removeUserBinding(qid, uid) {
  try {
    const db = getDatabase();
    const s = getStmts(db);
    const qq = String(qid);
    const id = String(uid);
    db.transaction(() => {
      const row = s.get.get(qq, id);
      if (!row) return; // 未绑定：与旧版一致，静默成功
      s.del.run(qq, id);
      // 删除的是主 UID 且还有剩余绑定：把第一个剩余设为主 UID
      if (row.is_main && s.count.get(qq).n > 0) {
        const first = s.first.get(qq);
        if (first) s.setMain.run(Date.now(), qq, first.uid);
      }
    })();
    return true;
  } catch (error) {
    logger.error('[MajsoulBindings] 移除绑定失败:', error);
    return false;
  }
}

/**
 * 清除用户所有绑定
 * @param {string|number} qid
 * @returns {Promise<boolean>}
 */
export async function clearUserBindings(qid) {
  try {
    getStmts(getDatabase()).delAll.run(String(qid));
    return true;
  } catch (error) {
    logger.error('[MajsoulBindings] 清除绑定失败:', error);
    return false;
  }
}

/**
 * 设置主 UID（仅当该 UID 已绑定时生效）
 * @param {string|number} qid
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
export async function setMainUid(qid, uid) {
  try {
    const db = getDatabase();
    const s = getStmts(db);
    const qq = String(qid);
    const id = String(uid);
    db.transaction(() => {
      if (!s.get.get(qq, id)) return; // 未绑定：不设置
      const now = Date.now();
      s.clearMain.run(now, qq);
      s.setMain.run(now, qq, id);
    })();
    return true;
  } catch (error) {
    logger.error('[MajsoulBindings] 设置主UID失败:', error);
    return false;
  }
}

/**
 * 获取主绑定 UID：优先 is_main=1，否则回退第一个绑定，无绑定返回 null
 * @param {string|number} qid
 * @returns {Promise<string|null>}
 */
export async function getMainUid(qid) {
  try {
    const s = getStmts(getDatabase());
    const qq = String(qid);
    const main = s.main.get(qq);
    if (main) return main.uid;
    const first = s.first.get(qq);
    return first ? first.uid : null;
  } catch (error) {
    logger.error('[MajsoulBindings] 获取主绑定UID失败:', error);
    return null;
  }
}
