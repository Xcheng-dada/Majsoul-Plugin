/**
 * 雀魂协议客户端（exe 取谱通道）
 *
 * 数据来源：本地雀魂协议抓取 exe（HTTP 服务端，默认 http://127.0.0.1:5088）
 * 鉴权由 exe 自身完成，本类不再做模拟登录/WebSocket。
 *
 * 牌谱格式：exe 返回的 `dataBase64` 是 `lq.GameDetailRecords` 的 protobuf 编码：
 *   - records: 简短元数据（Any 包装，本通道忽略）
 *   - actions: 回放动作流（repeated GameAction）
 *
 * 每个 GameAction.result 是 `lq.RecordCollectedData` 编码（注意 remarks 字段在 liqi 里
 * 声明为 string，但实际塞的是裸二进制）。这里**手动按 wire 解析**，避免 protobufjs 把
 * string 当 utf8 解码破坏二进制：
 *   RecordCollectedData { field1=uuid(string), field2=remarks(raw bytes) }
 * 再用 uuid（去掉 .lq. 前缀）作为类型去解码 remarks → 得到真实的 Record* 事件。
 *
 * 最后重建为网页版 `ResGameRecord` 形状（head + data[]），交给 MajsoulPaipuParser 复用。
 */

import fs from 'fs'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import Codec from './Codec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL_CFG_PATH = path.join(__dirname, '../config/majsoul-protocol.json')

// 只需本进程内缓存 exe 地址，无需落盘
let cachedExeBase = null

// 日志（TRSS 全局 logger 或 console）
const logger = globalThis.logger || console

/**
 * 解析 RecordCollectedData 的裸 bytes，返回 { uuid, remarks }
 * 手动按 protobuf wire 解析，避免 string 字段被 utf8 破坏二进制。
 */
function parseRCD (buf) {
  let pos = 0
  let uuid = null
  let remarks = null
  while (pos < buf.length) {
    const tag = buf[pos++]
    const field = tag >> 3
    const wt = tag & 7
    if (field === 1 && wt === 2) {
      let s = 0, sh = 0, b
      do { b = buf[pos++]; s |= (b & 0x7f) << sh; sh += 7 } while (b & 0x80)
      uuid = buf.slice(pos, pos + s).toString('utf8')
      pos += s
    } else if (field === 2 && wt === 2) {
      let s = 0, sh = 0, b
      do { b = buf[pos++]; s |= (b & 0x7f) << sh; sh += 7 } while (b & 0x80)
      remarks = buf.slice(pos, pos + s)
      pos += s
    } else if (wt === 0) { while (buf[pos] & 0x80) pos++; pos++ } else if (wt === 5) { pos += 4 } else if (wt === 1) { pos += 8 } else break
  }
  return { uuid, remarks }
}

function toBuf (x) {
  if (x && x.type === 'Buffer' && Array.isArray(x.data)) return Buffer.from(x.data)
  if (Buffer.isBuffer(x)) return x
  return Buffer.from(x)
}

/**
 * 把 exe 的 dataBase64 解码并重建为 ResGameRecord 形状
 * @param {string} dataBase64 GameDetailRecords 的 base64
 * @param {object} meta 来自 dto 的元信息 { players, uuid, endTime, standardRule }
 * @returns {{record:object, head:object}}
 */
export async function decodeRecordBase64 (dataBase64, meta = {}) {
  await Codec.init()
  const { players = [], uuid = '', endTime = null, standardRule = 0 } = meta
  const GDR = Codec.lookupMethod('lq.GameDetailRecords')
  const buf = Buffer.from(dataBase64, 'base64')
  const gdr = GDR.toObject(GDR.decode(buf), { enums: String, defaults: true })

  // 1. 重建 data[]：遍历 actions 解每个 Record* 事件
  const data = []
  const actions = gdr.actions || []
  for (const a of actions) {
    if (!a.result) continue
    let rcd
    try { rcd = parseRCD(toBuf(a.result)) } catch { continue }
    if (!rcd.uuid || !rcd.remarks) continue
    const typeName = rcd.uuid.replace(/^\.lq\./, '')
    if (!typeName.startsWith('Record')) continue
    try {
      const Ev = Codec.lookupMethod('lq.' + typeName)
      const obj = Ev.toObject(Ev.decode(rcd.remarks), { enums: String, defaults: true })
      data.push({ name: typeName, data: obj })
    } catch (e) {
      logger.debug(`解码事件 ${typeName} 失败: ${e.message}`)
    }
  }

  // 2. 重建 head
  // 2.1 accounts（来自 dto.players）
  const accounts = (players || []).map(p => ({
    seat: p.seat,
    account_id: p.accountId,
    nickname: p.nickname,
    avatar_id: p.avatarId,
    character: p.characterId,
    level: { id: p.level?.id ?? 0, score: p.level?.score ?? 0 }
  }))

  // 2.2 从 events 推算 mode / 初始分 / 终局分
  const newRounds = data.filter(d => d.name === 'RecordNewRound')
  const firstScores = newRounds.length ? newRounds[0].data.scores : [25000, 25000, 25000, 25000]
  const maxChang = newRounds.reduce((m, d) => Math.max(m, d.data.chang || 0), 0)
  const modeMode = maxChang >= 1 ? 2 : 1 // 有南场=半庄(2)，否则东风(1)

  // 终局分：取最后一个带 scores 的结算事件（RecordHule 含 scores）
  const settleEvents = [
    ...data.filter(d => d.name === 'RecordHule' && Array.isArray(d.data.scores) && d.data.scores.length === 4),
    ...data.filter(d => d.name === 'RecordNoTile' && d.data.scores && d.data.scores.length === 4)
  ]
  const lastScores = settleEvents.length ? settleEvents[settleEvents.length - 1].data.scores : firstScores

  const nplayers = firstScores.length
  const resultPlayers = []
  for (let i = 0; i < nplayers; i++) {
    resultPlayers.push({
      seat: i,
      part_point_1: firstScores[i] ?? 25000,
      total_point: lastScores[i] ?? firstScores[i] ?? 25000
    })
  }

  const end_time = endTime ? Math.floor(Date.parse(endTime) / 1000) : 0

  const head = {
    uuid,
    accounts,
    config: {
      meta: { mode_id: 1 }, // data.json 中存在 key '1'（段位四麻）
      mode: { mode: modeMode }
    },
    result: { players: resultPlayers },
    end_time,
    standard_rule: standardRule
  }

  const record = { uuid, head, data }
  return { record, head }
}

/**
 * 探测本地 exe 服务是否可达
 */
export function discoverExe () {
  const candidates = []
  if (cachedExeBase) candidates.push(cachedExeBase)
  if (process.env.MAJSOUL_EXE_URL) candidates.push(process.env.MAJSOUL_EXE_URL.replace(/\/+$/, ''))
  candidates.push('http://127.0.0.1:5088')
  return candidates
}

/**
 * 在 exeDir 及若干常见位置中查找 exe 可执行文件。
 * exeDir 相对插件根目录（配置项），也可为绝对路径。
 * @returns {string|null} 找到的 exe 绝对路径
 */
export function findExeBinary () {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(PROTOCOL_CFG_PATH, 'utf8')) } catch {}
  const exeDir = cfg.exeDir || 'exe'
  const dirs = []
  // 配置的相对/绝对目录
  dirs.push(path.isAbsolute(exeDir) ? exeDir : path.join(__dirname, '..', exeDir))
  // 插件根目录、上级目录（兼容直接丢在插件根）
  dirs.push(__dirname)
  dirs.push(path.join(__dirname, '..'))
  // 环境变量兜底
  if (process.env.MAJSOUL_EXE_PATH) dirs.push(path.dirname(process.env.MAJSOUL_EXE_PATH))

  for (const d of dirs) {
    try {
      const entries = fs.readdirSync(d)
      const hit = entries.find(f => /\.exe$/i.test(f) && /majsoul|protocol/i.test(f))
      if (hit) return path.join(d, hit)
    } catch {}
  }
  // 环境变量精确指定
  if (process.env.MAJSOUL_EXE_PATH && fs.existsSync(process.env.MAJSOUL_EXE_PATH)) {
    return process.env.MAJSOUL_EXE_PATH
  }
  return null
}

/**
 * 检测 127.0.0.1:5088 是否已有进程在监听
 */
export function isPortAlive (host = '127.0.0.1', port = 5088) {
  return new Promise(resolve => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v) } }
    sock.setTimeout(800)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.once('timeout', () => finish(false))
    try { sock.connect(port, host) } catch { finish(false) }
  })
}

let exeSpawned = false

/**
 * 确保 exe 在运行：Windows 下若端口未监听且配置了 autoLaunch，则 spawn 拉起。
 * 非 Windows 或 autoLaunch=false 时直接跳过（不影响原有回退逻辑）。
 * 登录态由 exe 自身 UI 处理，本函数只负责“拉起进程”，不等待登录完成。
 */
export async function ensureExeRunning () {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(PROTOCOL_CFG_PATH, 'utf8')) } catch {}
  // 仅 enabled 且显式开启 autoLaunch 时才尝试拉起
  if (!cfg.enabled || !cfg.autoLaunch) return false
  if (process.platform !== 'win32') {
    logger.warn('[MajsoulProtocol] autoLaunch 仅支持 Windows，当前平台跳过')
    return false
  }
  if (await isPortAlive()) {
    logger.info('[MajsoulProtocol] exe 已在运行 (5088)')
    return true
  }
  const exePath = findExeBinary()
  if (!exePath) {
    logger.warn('[MajsoulProtocol] 未找到 exe 文件，请在 exeDir 配置目录放置 Majsoul.ProtocolLogin.Api-windows-amd64.exe，或手动启动')
    return false
  }
  if (exeSpawned) return false
  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留窗口，便于用户登录
    })
    child.unref()
    exeSpawned = true
    logger.info(`[MajsoulProtocol] 已 spawn 拉起 exe: ${exePath} (pid=${child.pid})`)
    // 提示：exe 启动后需完成雀魂登录，端口才会就绪
    return true
  } catch (e) {
    logger.error(`[MajsoulProtocol] 拉起 exe 失败: ${e.message}`)
    return false
  }
}

function readProtocolConfig () {
  try {
    return JSON.parse(fs.readFileSync(PROTOCOL_CFG_PATH, 'utf8'))
  } catch { return {} }
}

function isExeEnabled () {
  try {
    const cfg = readProtocolConfig()
    return cfg.enabled === true
  } catch { return false }
}

// 读取请求超时（毫秒），配置缺省时回退 20000
function getTimeoutMs () {
  const cfg = readProtocolConfig()
  const v = Number(cfg.timeoutMs)
  return Number.isFinite(v) && v > 0 ? v : 20000
}

/**
 * 调 exe 拉取牌谱元数据（含 dataBase64）
 */
export async function saveToLocal (paipu, options = {}) {
  const { downloadAvatars = false, exportFiles = false, includeDataBase64 = true } = options
  const bases = discoverExe()
  let lastErr = null
  for (const base of bases) {
    // 未登录的本地 API 调用 /api/records/fetch 会抛未处理异常（刷服务端日志）。
    // 先探测是否有已保存的 profile，没有则直接跳过，避免惹服务端报错。
    let loggedIn = true
    try {
      const p = await fetch(`${base}/api/profiles`, { signal: AbortSignal.timeout(getTimeoutMs()) })
      if (p.ok) {
        const arr = await p.json().catch(() => [])
        loggedIn = Array.isArray(arr) && arr.length > 0
      }
    } catch { /* 探活失败当作未登录，走降级 */ loggedIn = false }
    if (!loggedIn) {
      lastErr = new Error('本地 API 未登录（无可用 profile），跳过取谱')
      continue
    }
    try {
      const res = await fetch(`${base}/api/records/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paipu, downloadAvatars, exportFiles, includeDataBase64 })
      })
      if (!res.ok) {
        // 尝试解析 exe 返回的错误体，给出更明确的提示（尤其是版本过期）
        let hint = `exe 返回 ${res.status}`
        try {
          const errBody = await res.json().catch(() => null)
          if (errBody) {
            const code = errBody?.serverError?.code
            const name = errBody?.serverError?.name
            const detail = errBody?.detail || ''
            if (code === 151 || name === 'ERR_CLIENT_VERSION' ||
                /client version/i.test(detail) || /ERR_CLIENT_VERSION/i.test(detail)) {
              hint = '本地 API（exe）版本已过期，雀魂服务器拒绝了其协议请求（ERR_CLIENT_VERSION）。请前往本插件 Release 页面下载更新版本的 exe 后重试。'
            } else if (detail) {
              hint = `exe 返回 ${res.status}：${detail}`
            }
          }
        } catch { /* 解析失败则保留原始提示 */ }
        lastErr = new Error(hint)
        continue
      }
      const dto = await res.json()
      if (!dto || (!dto.dataBase64 && !dto.reference)) { lastErr = new Error('exe 返回数据无效'); continue }
      cachedExeBase = base
      return dto
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('未找到可用的 exe 服务')
}

/**
 * 取完整牌谱（解码为 ResGameRecord 形状）
 * @param {string} paipu 牌谱 ID（如 260805-xxx_a64678917）
 * @returns {Promise<{record:object, head:object}>}
 */
/**
 * 向本地 exe 发起雀魂登录。登录态由 exe 自身持有，Yunzai 侧不保存 token。
 * @param {string} account 雀魂账号
 * @param {string} password 雀魂密码
 * @param {boolean} [saveProfile=true] 是否让 exe 持久化登录态
 * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
 */
export async function loginToExe (account, password, saveProfile = true) {
  if (!account || !password) return { ok: false, error: '账号或密码为空' }
  for (const base of discoverExe()) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), getTimeoutMs())
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password, saveProfile }),
        signal: ctrl.signal
      })
      clearTimeout(t)
      const text = await r.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      if (r.ok) return { ok: true, data }
      return { ok: false, error: (data && (data.message || data.error)) || `HTTP ${r.status}`, data }
    } catch (e) {
      logger.warn(`[MajsoulProtocol] 登录请求失败 base=${base}: ${e.message}`)
    }
  }
  return { ok: false, error: '未找到可用的 exe 服务（请确认已启用 autoLaunch 或手动启动 exe）' }
}

/**
 * 查询 exe 当前登录账户信息。用于判断是否已登录。
 * @returns {Promise<{ok:boolean, account?:any}>}
 */
export async function getExeAccount () {
  for (const base of discoverExe()) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), getTimeoutMs())
      const r = await fetch(`${base}/api/account`, { signal: ctrl.signal })
      clearTimeout(t)
      if (r.ok) {
        const data = await r.json().catch(() => null)
        return { ok: true, account: data }
      }
    } catch (e) { /* try next */ }
  }
  return { ok: false }
}

/**
 * 查询 exe 已保存的全部登录档案（含昵称/头像）。
 * @returns {Promise<{ok:boolean, profiles?:Array<{nickname?:string, avatarId?:number, accountId?:number}>}>}
 */
export async function getExeProfiles () {
  for (const base of discoverExe()) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), getTimeoutMs())
      const r = await fetch(`${base}/api/profiles`, { signal: ctrl.signal })
      clearTimeout(t)
      if (r.ok) {
        const data = await r.json().catch(() => null)
        if (Array.isArray(data)) return { ok: true, profiles: data }
      }
    } catch (e) { /* try next */ }
  }
  return { ok: false, profiles: [] }
}

export async function fetchFullRecord (paipu) {
  if (!isExeEnabled()) throw new Error('majsoul-protocol 未启用')
  const dto = await saveToLocal(paipu, { includeDataBase64: true })
  if (!dto.dataBase64) throw new Error('exe 未返回 dataBase64，请开启 includeDataBase64')
  return decodeRecordBase64(dto.dataBase64, {
    players: dto.players || [],
    uuid: dto.uuid,
    endTime: dto.endTime,
    standardRule: dto.standardRule
  })
}

/**
 * 仅取 head（复用 fetchFullRecord 的解码结果）
 */
export async function fetchRecordHead (paipu) {
  const { head } = await fetchFullRecord(paipu)
  return { head }
}

// 以下为旧版网页版/模拟登录相关接口的兼容占位，当前走 exe 通道不再需要。
// 保留空实现以避免 MajsoulReview.js 引用时报错（其已优先尝试协议通道）。
export async function checkSession () { return false }
export async function ensureSession () { throw new Error('协议通道由 exe 提供，无需模拟登录') }
export async function getPlayerList () { throw new Error('协议通道由 exe 提供') }
export async function fetchGameRecordByPlayer () { throw new Error('协议通道由 exe 提供') }
export async function fetchGameRecord () { throw new Error('协议通道由 exe 提供') }
export function clearLoginCache () {}
export function getLoginInfo () { return null }
export function getExeCandidates () { return discoverExe() }

/**
 * 协议通道是否启用（供 MajsoulReview 判断取谱入口是否可用）。
 */
export function isEnabled () {
  return isExeEnabled()
}
export function setExeBase (url) { cachedExeBase = url }

/**
 * 返回协议客户端对象（供 MajsoulReview 调用，保持原有 client.xxx() 写法）。
 * 底层方法均为进程内单例，无需持有状态，故每次返回同一组绑定。
 */
export function getProtocolClient () {
  return {
    isEnabled,
    fetchRecordHead,
    fetchFullRecord,
    loginToExe,
    getExeAccount,
    getExeProfiles,
  }
}
