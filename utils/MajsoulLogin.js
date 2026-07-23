import fs from 'fs'
import path from 'path'

const pluginRoot = path.resolve('./plugins/Majsoul-Plugin')
const loginConfigPath = path.join(pluginRoot, 'data', 'login.json')

// 默认指向同机的 MajsoulUID-plugin 数据库，作为无本插件登录态时的兜底
const DEFAULT_MAJSOUL_DB = 'f:/桌面/BOT/MajsoulUID-plugin/data/majsoul.db'

function readLoginConfig() {
  try {
    if (!fs.existsSync(loginConfigPath)) return {}
    return JSON.parse(fs.readFileSync(loginConfigPath, 'utf8'))
  } catch {
    return {}
  }
}

// 获取雀魂 access_token，优先级：
// 1) 本插件 data/login.json 的 token（用户自行 #雀魂登录 写入，最优先）
// 2) 回退到 MajsoulUID-plugin 的 majsoul.db（复用其登录态）
async function getMajsoulDbToken() {
  const cfg = readLoginConfig()
  const dbPath = cfg.majsoulDbPath || DEFAULT_MAJSOUL_DB
  try {
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare("SELECT token FROM MajsUser WHERE token IS NOT NULL AND token != '' ORDER BY id DESC LIMIT 1").get()
    db.close()
    if (row && row.token) return row.token
  } catch (err) {
    if (typeof logger !== 'undefined') logger.warn(`[Majsoul-Plugin] 从 majsoul.db 读取 token 失败，回退配置: ${err.message}`)
  }
  return null
}

export async function getMajsoulToken() {
  const cfg = readLoginConfig()
  // 本插件自己的登录态优先
  if (cfg.token && String(cfg.token).trim()) return String(cfg.token).trim()
  // 兜底：MajsoulUID-plugin 的登录态
  return await getMajsoulDbToken()
}

export function getMajsoulDeviceId() {
  const cfg = readLoginConfig()
  return cfg.deviceId || ''
}

export function getMajsoulAccount() {
  const cfg = readLoginConfig()
  return cfg.account || ''
}

export function getMajsoulPassword() {
  const cfg = readLoginConfig()
  return cfg.password || ''
}

// 保存登录结果到本插件 data/login.json（token 失效时可自动续期）
export function saveLoginResult({ token, deviceId, account, username, password } = {}) {
  const cfg = readLoginConfig()
  const next = { ...cfg }
  if (token) next.token = token
  if (deviceId) next.deviceId = deviceId
  if (typeof account !== 'undefined') next.account = account
  if (typeof username !== 'undefined') next.username = username
  if (typeof password !== 'undefined') next.password = password
  try {
    fs.writeFileSync(loginConfigPath, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    if (typeof logger !== 'undefined') logger.error(`[Majsoul-Plugin] 保存登录态失败: ${err.message}`)
  }
}
