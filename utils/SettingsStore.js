// plugins/Majsoul-Plugin/utils/SettingsStore.js
// 通用设置 KV 存储（SQLite majsoul_settings 表）：
// - gacha_status:<gid>   群抽卡开关（'true' / 'false'）
// - userpool:<gid>:<uid> 个人卡池选择（池 id）
// - globalpool           master 设置的全局卡池（池 id）
// 这些是单值设置而非业务记录，用 KV 表最贴合；写入即时持久化，重启不丢

import { getDatabase } from './MajsoulDatabase.js';

const STMT = {
  get: () => getDatabase().prepare('SELECT value FROM majsoul_settings WHERE key = ?'),
  upsert: () => getDatabase().prepare(
    'INSERT INTO majsoul_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ),
  del: () => getDatabase().prepare('DELETE FROM majsoul_settings WHERE key = ?'),
  byPrefix: () => getDatabase().prepare(
    "SELECT key, value FROM majsoul_settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
  )
};

/** 读取设置值（无则返回 null） */
export function getSetting(key) {
  const row = STMT.get().get(String(key));
  return row ? row.value : null;
}

/** 写入设置值 */
export function setSetting(key, value) {
  STMT.upsert().run(String(key), value == null ? null : String(value), Date.now());
}

/** 删除设置 */
export function delSetting(key) {
  STMT.del().run(String(key));
}

/**
 * 按前缀扫描设置（替代旧 redis.keys + 逐个 get）
 * @param {string} prefix 如 'userpool:'
 * @returns {Array<{ key: string, value: string }>}
 */
export function getSettingsByPrefix(prefix) {
  // LIKE 通配符转义，防止 key 中出现 %/_ 影响前缀匹配
  const pattern = String(prefix).replace(/[\\%_]/g, c => '\\' + c) + '%';
  return STMT.byPrefix().all(pattern);
}
