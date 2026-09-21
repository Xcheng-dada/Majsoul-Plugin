// plugins/Majsoul-Plugin/utils/MajsoulDatabase.js
// SQLite 数据库集中管理：钱包 / 签到 / 图鉴 / UID绑定 的唯一持久化数据源
// 数据文件：plugins/Majsoul-Plugin/data/majsoul.db（data 目录不存在时自动创建）
// 全插件进程共享一个 better-sqlite3 连接，启动时初始化一次，禁止重复 new Database()

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'majsoul.db');

let db = null;

// 表结构：全部使用 IF NOT EXISTS，已存在数据的库不会被覆盖或清空
const SCHEMA = `
-- QQ 用户与雀魂 UID 绑定（一个 QQ 可绑定多个 UID，is_main=1 为主账号）
CREATE TABLE IF NOT EXISTS majsoul_user_bindings (
  qq_id      TEXT NOT NULL,
  uid        TEXT NOT NULL,
  nickname   TEXT,
  is_main    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (qq_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_user_bindings_qq_id ON majsoul_user_bindings (qq_id);
CREATE INDEX IF NOT EXISTS idx_user_bindings_uid ON majsoul_user_bindings (uid);

-- 用户钱包（七种货币，语义与旧版 Redis 存储一致）
CREATE TABLE IF NOT EXISTS majsoul_wallets (
  qq_id      TEXT PRIMARY KEY,
  jade       INTEGER NOT NULL DEFAULT 0,
  ticket     INTEGER NOT NULL DEFAULT 0,
  ticket10   INTEGER NOT NULL DEFAULT 0,
  dust       INTEGER NOT NULL DEFAULT 0,
  stone      INTEGER NOT NULL DEFAULT 0,
  wish       INTEGER NOT NULL DEFAULT 0,
  faith      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用户签到记录（一天一次、连续天数、累计天数、首签礼包标记）
CREATE TABLE IF NOT EXISTS majsoul_signins (
  qq_id      TEXT PRIMARY KEY,
  last_date  TEXT,
  streak     INTEGER NOT NULL DEFAULT 0,
  total_days INTEGER NOT NULL DEFAULT 0,
  welcomed   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用户图鉴（雀士 characters / 装扮 decorations，规范化为逐条记录）
CREATE TABLE IF NOT EXISTS majsoul_collections (
  qq_id      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('characters', 'decorations')),
  item_name  TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  first_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (qq_id, kind, item_name)
);
`;

/**
 * 获取全插件共享的 SQLite 连接（首次调用时初始化，之后直接复用）
 * @param {string} [dbPath] 自定义数据库路径（仅测试使用；进程内首次初始化后不再生效）
 * @returns {import('better-sqlite3').Database}
 */
export function getDatabase(dbPath) {
  if (db) return db;
  const file = dbPath || process.env.MAJSOUL_DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** 关闭连接（仅测试与插件卸载时使用；关闭后下次 getDatabase 会重新初始化） */
export function closeDatabase() {
  if (db) {
    try { db.close(); } catch { /* 忽略关闭异常 */ }
    db = null;
  }
}
