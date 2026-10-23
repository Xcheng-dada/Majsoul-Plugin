/**
 * 雀魂纯 JS 协议客户端（不需要本地 exe，也不需要浏览器）
 *
 * 目标：M3 集成版。在插件内置 protobufjs 编解码（utils/Codec.js，官方 liqi.json）
 * 之上实现完整的雀魂网关客户端：登录（账密 / token 续登）、会话保活、自动重连，
 * 以及插件消费的全部数据 RPC（牌谱 / 玩家简报 / 统计 / 搜索），输出与旧 exe REST
 * 形状一致的 DTO，供上层（MajsoulReview / MajsoulInfo / MajsoulUser / render）无感使用。
 *
 * 版本链（官方公开资源，2026-10-20 实测复现）：
 *   1. https://game.maj-soul.com/1/version.json               → version 0.11.252.w
 *   2. Codec.init() 从 /1/resversion{ver}.json 拉取 res/proto/liqi.json
 *   3. https://route-*.maj-soul.com/api/clientgate/routes      → 网关路由列表
 *   4. wss://route-*.maj-soul.com/gateway                      → 网关连接
 *   5. 登录版本串（WebGL_2022-0.16.x）不走上面任何一环，而是 Unity 客户端的
 *      majset 资源链（复刻自兔协议开发者逆向的版本发现方法，全链 2026-10-20 实测）：
 *        /assetbundles/DXT/bundle_info_so.majset        → UnityFS+LZ4 解包
 *          → bundle 清单表 [count][len,name,size]*   + 资产容器 [len,assetPath,pad,bundleIdx]*
 *          → MyAssets/docs_version/version.json 资产 → 目标 bundle 名
 *        /assetbundles/DXT/<目标>.majset（当前为 u6v_td1…）  → UnityFS+LZ4 解包
 *          → TextAsset {"version":"0.16.283","platform":"WebGL"}
 *      client_version_string = WebGL_2022-<version>（官方 exe 内亦含 WebGL_2022 常量与
 *      同款错误文案 "Cannot resolve MyAssets/docs_version/version.json in bundle_info_so.majset"）
 *
 * 线格式（官方协议，社区基准 mjsoul 2.3.0 docs/protocol.md 一致）：
 *   请求  = [0x02][序号 2 字节 little-endian][protobuf lq.Wrapper{name,data}]
 *   响应  = [0x03][序号 2 字节][Wrapper]
 *   通知  = [0x01][Wrapper]
 *
 * 密码登录：`.lq.Lobby.login` ReqLogin{account, password}
 *   password = HMAC-SHA256(key="lailai", utf8 明文密码) 的 hex
 * token 登录：`.lq.Lobby.oauth2Login` ReqOauth2Login{type:10, access_token}
 *
 * 登录前必须完成两步会话握手（缺了服务器报 error.code=151）：
 *   .lq.Route.requestConnection → .lq.Route.heartbeat
 *
 * 模式约定（config/majsoul-protocol.json 的 "mode" 字段）：
 *   "js"    → 本文件（纯 JS，默认）
 *   "local" → 本地 API 通道（MajsoulProtocolClient.js 原路径，Windows/Linux 均有程序）
 */

import WebSocket from 'ws'
import { pathToFileURL } from 'url'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Codec from './Codec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_PATH = path.join(__dirname, '../data/majsoul-js-session.json')

const logger = globalThis.logger || console

const MSG = { notify: 0x01, req: 0x02, res: 0x03 }
const MAX_SEQ = 60007
const HEARTBEAT_MS = 15_000
const LOGIN_BEAT_MS = 12 * 60 * 1000
const DEFAULT_RPC_TIMEOUT = 30_000

// 官方 index.html 的 productVersion 是登录版本串的【兜底】来源（exe 内嵌同款 fallback 正则）
// version.json 的 0.11.252.w 只是资源版本；真正的登录版本串走下面的 majset 资源链
const INDEX_URL = 'https://game.maj-soul.com/1/index.html'

// WebGL 客户端 majset 资源链常量（官方 exe 与浏览器实测同款 URL，均为只读资源）
const BUNDLE_BASE_URL = 'https://game.maj-soul.com/assetbundles/'
const BUNDLE_TEX_FMT = 'DXT' // 桌面 WebGL 客户端实测纹理格式目录（浏览器首启即拉 DXT/bundle_hash.txt）
const MAJSET_INFO_SO = 'bundle_info_so.majset'
const MAJSET_VER_ASSET = 'MyAssets/docs_version/version.json'
const WEBGL_VER_RE = /\{\s*"version"\s*:\s*"([^"]+)"\s*,\s*"platform"\s*:\s*"WebGL"\s*\}/
const VERSION_CACHE_PATH = path.join(__dirname, '../data/majsoul-webgl-version.json')
const VERSION_CACHE_TTL = 6 * 60 * 60 * 1000 // 官方该 TextAsset 变更频率低；缓存期内不再整链探测
const randvHex = () => crypto.randomBytes(16).toString('hex')

// 官方 Web 客户端登录设备信息（社区基准 4n3u/majsoul-monthTicket-auto 的 DEFAULT_DEVICE）
const CLIENT_DEVICE = {
  platform: 'pc',
  hardware: 'pc',
  os: 'Windows',
  os_version: 'Windows 10',
  is_browser: true,
  software: 'Chrome',
  sale_platform: 'web',
  hardware_vendor: 'Google Inc.',
  model_number: 'Chrome',
  screen_width: 1920,
  screen_height: 1080,
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  screen_type: 2
}
// CN 服登录固定参数（社区基准，daily GitHub Actions 已验证可用）
const CN_CURRENCY_PLATFORMS = [1, 2, 5, 6, 8, 10, 11]
const CN_TAG = 'cn'
const CN_LOGIN_TYPE = 0

// ---------------------------------------------------------------------------
// protobuf wire 基础（仅握手/登录这类最核心消息用手写编解码，字段来自官方 liqi.desc）
// ---------------------------------------------------------------------------

function wVarint (n) {
  n = BigInt(n)
  const out = []
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b) } while (n)
  return Buffer.from(out)
}

class PbWriter {
  constructor () { this.bufs = [] }
  key (field, wt) { this.bufs.push(wVarint((BigInt(field) << 3n) | BigInt(wt))) }
  uint32 (field, v) { if (v === undefined || v === null) return; this.key(field, 0); this.bufs.push(wVarint(v)) }
  string (field, s) { if (s === undefined || s === null) return; const b = Buffer.from(String(s), 'utf8'); this.key(field, 2); this.bufs.push(wVarint(b.length), b) }
  bytes (field, b) { if (b === undefined || b === null) return; this.key(field, 2); this.bufs.push(wVarint(b.length), b) }
  toBuffer () { return Buffer.concat(this.bufs) }
}

function pbRead (buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    let k = 0, sh = 0, b
    do { b = buf[pos++]; k |= (b & 0x7f) << sh; sh += 7 } while (b & 0x80)
    const field = k >> 3, wt = k & 7
    if (wt === 0) {
      let v = 0n; sh = 0
      do { b = buf[pos++]; v |= BigInt(b & 0x7f) << BigInt(sh); sh += 7 } while (b & 0x80)
      out.push({ field, wire: 0, value: v })
    } else if (wt === 2) {
      let n = 0; sh = 0
      do { b = buf[pos++]; n |= (b & 0x7f) << sh; sh += 7 } while (b & 0x80)
      n = Number(n)
      out.push({ field, wire: 2, value: buf.slice(pos, pos + n) })
      pos += n
    } else if (wt === 1) { out.push({ field, wire: 1, value: buf.slice(pos, pos + 8) }); pos += 8
    } else if (wt === 5) { out.push({ field, wire: 5, value: buf.slice(pos, pos + 4) }); pos += 4
    } else throw new Error(`不支持的 wire type ${wt} (field ${field})`)
  }
  return out
}

const s2str = (b) => b.toString('utf8')

/** lq.Error{1:code, 4:json_param, 6:message} */
function parseLqError (buf) {
  const e = { code: null }
  for (const f of pbRead(buf)) {
    if (f.field === 1 && f.wire === 0) e.code = Number(f.value)
    else if (f.field === 4 && f.wire === 2) e.jsonParam = s2str(f.value)
    else if (f.field === 6 && f.wire === 2) e.message = s2str(f.value)
  }
  return e
}

/** lq.Wrapper{1:name, 2:data} */
export function encodeWrapper (name, data) {
  const w = new PbWriter()
  w.string(1, name)
  w.bytes(2, data)
  return w.toBuffer()
}

export function decodeWrapper (buf) {
  const r = { name: null, data: null }
  for (const f of pbRead(buf)) {
    if (f.field === 1 && f.wire === 2) r.name = s2str(f.value)
    else if (f.field === 2 && f.wire === 2) r.data = f.value
  }
  return r
}

/** lq.ReqLogin{1:account, 2:password, 11:client_version_string} */
export function encodeReqLogin (o = {}) {
  const w = new PbWriter()
  w.string(1, o.account)
  w.string(2, o.password)
  w.string(11, o.clientVersionString)
  return w.toBuffer()
}

/** lq.ReqOauth2Login{1:type, 2:access_token, 10:client_version_string} */
export function encodeReqOauth2Login (o = {}) {
  const w = new PbWriter()
  w.uint32(1, o.type)
  w.string(2, o.accessToken)
  w.string(10, o.clientVersionString)
  return w.toBuffer()
}

/** lq.ReqRequestConnection{2:type, 3:route_id, 4:timestamp, 6:platform(新版 string)} */
export function encodeReqRequestConnection (o = {}) {
  const w = new PbWriter()
  w.uint32(2, o.type)           // 官方客户端发 1
  w.string(3, o.routeId)
  if (o.timestamp !== undefined && o.timestamp !== null) { w.key(4, 0); w.bufs.push(wVarint(o.timestamp)) }
  w.string(6, o.platform)       // 'Web'
  return w.toBuffer()
}

/** lq.ReqHeartbeat{1:delay, 2:no_operation_counter, 3:platform, 4:network_quality} */
export function encodeReqHeartbeat (o = {}) {
  const w = new PbWriter()
  w.uint32(1, o.delay ?? 0)
  w.uint32(2, o.noOperationCounter ?? 0)
  w.uint32(3, o.platform ?? 11)        // 官方客户端用 11（Web）
  w.uint32(4, o.networkQuality ?? 0)
  return w.toBuffer()
}

/** lq.ReqLoginBeat{1:contract}（官方客户端填 'cat'） */
export function encodeReqLoginBeat (contract = 'cat') {
  const w = new PbWriter()
  w.string(1, contract)
  return w.toBuffer()
}

/** .lq.ResRequestConnection{1:error, 2:timestamp, 3:result} */
export function parseResRequestConnection (buf) {
  const r = {}
  for (const f of pbRead(buf)) {
    if (f.field === 1 && f.wire === 2) r.error = parseLqError(f.value)
    else if (f.field === 2 && f.wire === 0) r.timestamp = f.value.toString()
    else if (f.field === 3 && f.wire === 0) r.result = Number(f.value)
  }
  return r
}

/** .lq.ResHeartbeat{1:error} */
export function parseResHeartbeat (buf) {
  const r = {}
  for (const f of pbRead(buf)) {
    if (f.field === 1 && f.wire === 2) r.error = parseLqError(f.value)
  }
  return r
}

/** .lq.ResLogin{1:error, 2:account_id, 3:account, 6:access_token} */
export function parseResLogin (buf) {
  const r = { error: null, accountId: null, accessToken: null }
  for (const f of pbRead(buf)) {
    if (f.field === 1 && f.wire === 2) r.error = parseLqError(f.value)
    else if (f.field === 2 && f.wire === 0) r.accountId = Number(f.value)
    else if (f.field === 6 && f.wire === 2) r.accessToken = s2str(f.value)
  }
  return r
}

/** 官方密码预处理：HMAC-SHA256(key="lailai")，与官方客户端行为一致 */
export function hashPassword (plain) {
  return crypto.createHmac('sha256', 'lailai').update(plain, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 版本链 & 网关发现（纯 HTTP）
// ---------------------------------------------------------------------------

const VERSION_URL = 'https://game.maj-soul.com/1/version.json'
const CLIENTGATE_HOSTS = ['https://route-2.maj-soul.com', 'https://route-3.maj-soul.com', 'https://route-4.maj-soul.com', 'https://route-5.maj-soul.com', 'https://route-6.maj-soul.com']

export async function fetchVersion () {
  const r = await fetch(VERSION_URL)
  if (!r.ok) throw new Error(`version.json HTTP ${r.status}`)
  const j = await r.json()
  return { version: j.version, forceVersion: j.force_version, codePath: j.code }
}

export async function fetchRoutes (version) {
  const v = (typeof version === 'string' || version == null) ? await fetchVersion() : version
  let lastErr = null
  for (const base of CLIENTGATE_HOSTS) {
    try {
      const r = await fetch(`${base}/api/clientgate/routes?platform=Web&version=${encodeURIComponent(v.version || version)}`)
      if (!r.ok) { lastErr = `${base} HTTP ${r.status}`; continue }
      const j = await r.json()
      const routes = (j && j.routes) || (j && j.data && j.data.routes) || []
      return routes
        .map(x => ({
          id: x.id,
          domain: x.domain,
          ssl: !!x.ssl,
          state: x.state,
          order: x.order,
          webSocket: `${x.ssl ? 'wss' : 'ws'}://${x.domain.split(':')[0]}/gateway`
        }))
    } catch (e) { lastErr = `${base}: ${e.message}` }
  }
  throw new Error('clientgate 全部域名失败：' + lastErr)
}

// ---------------------------------------------------------------------------
// majset 版本链：UnityFS(+LZ4/LZ4HC) 纯 JS 解包 + bundle 清单/资产映射解析
// ---------------------------------------------------------------------------

/** LZ4 块级解码（LZ4 与 LZ4HC 采用同一块格式；fd 分区与官方 lz4.block.decompress 语义一致） */
function lz4BlockDecompress (src, destLen) {
  const dst = Buffer.alloc(destLen)
  let s = 0, d = 0
  while (s < src.length && d < destLen) {
    const token = src[s++]
    let litLen = token >> 4
    if (litLen === 15) { let add; do { add = src[s++]; litLen += add } while (add === 255) }
    if (litLen) { src.copy(dst, d, s, s + litLen); s += litLen; d += litLen }
    if (s >= src.length) break
    const off = src[s] | (src[s + 1] << 8); s += 2
    let matchLen = (token & 15) + 4
    if ((token & 15) === 15) { let add; do { add = src[s++]; matchLen += add } while (add === 255) }
    let from = d - off
    if (from < 0) throw new Error(`LZ4 块解码非法引用 offset=${off} d=${d}`)
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[from++] // 支持重叠拷贝
  }
  return dst
}

function beU64 (buf, off) { return buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4) }

function readCStr (buf, p) { let e = p; while (e < buf.length && buf[e] !== 0) e++; return { s: buf.slice(p, e).toString('latin1'), end: e } }

/** UnityFS/UnityWeb 容器解包：返回拼好的块数据（含 Unity SerializedFile 本体） */
export function unpackUnityFS (buf) {
  let p = 0
  const sig = readCStr(buf, 0); p = sig.end + 1
  if (sig.s !== 'UnityFS' && sig.s !== 'UnityWeb' && sig.s !== 'UnityRaw') throw new Error('非 UnityFS 签名: ' + sig.s)
  const version = buf.readUInt32BE(p); p += 4
  const uv = readCStr(buf, p); p = uv.end + 1
  const ur = readCStr(buf, p); p = ur.end + 1
  if (version >= 6) p += 8 // fileSize u64 BE
  const compInfoSize = buf.readUInt32BE(p); p += 4
  const rawInfoSize = buf.readUInt32BE(p); p += 4
  const flags = buf.readUInt32BE(p); p += 4
  const infoAtEnd = (flags & 0x80) !== 0
  const needAlign = (flags & 0x200) !== 0
  const method = flags & 0x3F
  let infoOff = p
  if (needAlign) infoOff = Math.ceil(infoOff / 16) * 16 // v7+: BlockInfoNeedPaddingAtStart
  const infoBuf = infoAtEnd ? buf.slice(buf.length - compInfoSize) : buf.slice(infoOff, infoOff + compInfoSize)
  let info
  if (method === 0) info = Buffer.from(infoBuf)
  else if (method === 1) throw new Error('BlocksInfo 为 LZMA 压缩，暂不支持')
  else info = lz4BlockDecompress(infoBuf, rawInfoSize)

  // 结构（UnityPy 规格）：hash16 + u32 块数 + [u32 un, u32 comp, u16 flags](v9+ 追加 u64 offset) + u32 节点数 + 节点[]
  let q = 16
  const blockCount = info.readUInt32BE(q); q += 4
  const blocks = []
  for (let i = 0; i < blockCount; i++) {
    const un = info.readUInt32BE(q), comp = info.readUInt32BE(q + 4), fl = info.readUInt16BE(q + 8)
    q += 10
    if (version >= 9) q += 8
    blocks.push({ un, comp, fl })
  }
  const nodeCount = info.readUInt32BE(q); q += 4
  const nodes = []
  for (let i = 0; i < nodeCount; i++) {
    const off = beU64(info, q); q += 8
    const size = beU64(info, q); q += 8
    q += 4 // nodeFlags
    const nm = readCStr(info, q); q = nm.end + 1
    nodes.push({ name: nm.s, offset: off, size })
  }
  let dataBase = infoOff + compInfoSize
  if (needAlign) dataBase = Math.ceil(dataBase / 16) * 16
  if (infoAtEnd) dataBase = 0
  const out = []
  let pos = dataBase
  for (const b of blocks) {
    const m = b.fl & 0x3F
    if (m === 1) throw new Error('数据块为 LZMA 压缩，暂不支持')
    if (m === 0) out.push(Buffer.from(buf.slice(pos, pos + b.comp)))
    else out.push(lz4BlockDecompress(buf.slice(pos, pos + b.comp), b.un))
    pos += b.comp
  }
  return { sig: sig.s, version, unityRevision: ur.s, nodes, data: Buffer.concat(out) }
}

/** 解析 bundle_info_so.majset 内的 bundle 清单表：[u32 count][u32 len, name, i32 size]*（带 pad 探测） */
function parseBundleTable (data) {
  const limit = Math.min(data.length, 20000) - 12
  for (let p = 4; p < limit; p++) {
    const count = data.readUInt32LE(p)
    if (!(count >= 50 && count <= 500000)) continue
    let len = data.readUInt32LE(p + 4)
    if (!(len >= 6 && len < 500)) continue
    let name = data.slice(p + 8, p + 8 + len).toString('latin1')
    if (!name.endsWith('.majset')) continue
    const bundles = []
    let q = p + 4
    let ok = true
    for (let i = 0; i < count; i++) {
      len = data.readUInt32LE(q)
      if (len < 6 || len > 500 || q + 4 + len + 4 > data.length) { ok = false; break }
      name = data.slice(q + 4, q + 4 + len).toString('latin1')
      if (!name.endsWith('.majset')) { ok = false; break }
      bundles.push(name)
      let adv = 4 + len + 4
      for (const ex of [0, 1, 2, 3]) {
        const nl = data.readUInt32LE(q + adv + ex)
        if (nl >= 6 && nl < 500) { adv += ex; break }
      }
      q += adv
    }
    if (ok) return { count, bundles }
  }
  throw new Error('bundle 清单表未定位（bundle_info_so 结构变更?）')
}

/** 在资产容器里定位 assetPath → bundle 下标（记录格式 [u32 len][path][pad][i32 idx]） */
function assetBundleIndex (data, assetPath, bundleCount) {
  let from = 0
  while (true) {
    const i = data.indexOf(assetPath, from)
    if (i < 0) break
    const e = i + assetPath.length
    const pad = (4 - (e % 4)) % 4
    if (e + pad + 4 <= data.length) {
      const idx = data.readInt32LE(e + pad)
      if (idx >= 0 && idx < bundleCount) return idx
    }
    from = i + 1
  }
  throw new Error('资产未定位: ' + assetPath)
}

/**
 * majset 版本发现（复刻兔协议开发者的逆向链，2026-10-20 全链实测 = 0.16.283）：
 * bundle_info_so.majset → docs_version/version.json 资产的 bundle → 其 TextAsset 里的版本 JSON
 */
export async function discoverWebglVersion () {
  const qv = `?randv=${randvHex()}`
  const info = await fetch(`${BUNDLE_BASE_URL}${BUNDLE_TEX_FMT}/${MAJSET_INFO_SO}${qv}`)
  if (!info.ok) throw new Error(`bundle_info_so HTTP ${info.status}`)
  const { data } = unpackUnityFS(Buffer.from(await info.arrayBuffer()))
  const table = parseBundleTable(data)
  const idx = assetBundleIndex(data, MAJSET_VER_ASSET, table.count)
  const bundleName = table.bundles[idx]
  if (!bundleName) throw new Error('bundle 下标越界')
  logger.info(`[majsoul-js] 版本链定位 ${MAJSET_VER_ASSET} → bundle[${idx}] ${bundleName}`)
  const ver = await fetch(`${BUNDLE_BASE_URL}${BUNDLE_TEX_FMT}/${bundleName}${qv}`)
  if (!ver.ok) throw new Error(`${bundleName} HTTP ${ver.status}`)
  const { data: d2 } = unpackUnityFS(Buffer.from(await ver.arrayBuffer()))
  const m = d2.toString('latin1').match(WEBGL_VER_RE)
  if (!m || !m[1]) throw new Error('版本 TextAsset 未命中（客户端版本 JSON 结构变更?）')
  return { version: m[1], bundleName }
}

// ---------------------------------------------------------------------------
// WSS 网关帧层（帧首字节 + 序号规则见文件头注释）
// ---------------------------------------------------------------------------

export class MajsoulGateway {
  constructor (url, { origin = 'https://game.maj-soul.com' } = {}) {
    this.url = url
    this.origin = origin
    this.ws = null
    this.connected = false
    this.index = 0
    this.pending = new Map()   // 序号 → { rpc, resolve }
    this.notifies = new Map()  // 通知名 → Set(fn)
    this.closeHandlers = []
  }

  connect () {
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url, { headers: { Origin: this.origin } })
      this.ws = ws
      ws.on('message', (data) => { try { this._onMessage(Buffer.from(data)) } catch (e) { logger.error(`[majsoul-js] 帧处理异常: ${e.message}`) } })
      ws.on('close', () => {
        this.connected = false
        for (const [idx, p] of this.pending) { try { p.reject(new Error(`网关已断开（${this.url}）`)) } catch {} }
        this.pending.clear()
        for (const fn of this.closeHandlers) { try { fn() } catch {} }
      })
      ws.on('error', (e) => {
        if (!settled) { settled = true; reject(e) } else { logger.error(`[majsoul-js] ${this.url} 连接异常：${e.message}`) }
      })
      ws.once('open', () => {
        this.connected = true
        settled = true
        resolve(this)
      })
    })
  }

  _onMessage (data) {
    const type = data[0]
    if (type === MSG.notify) {
      const w = decodeWrapper(data.slice(1))
      const set = this.notifies.get(w.name)
      if (set) for (const fn of set) { try { fn(w) } catch (e) { logger.error(`[majsoul-js] 通知回调异常: ${e.stack || e.message}`) } }
      return
    }
    if (type === MSG.res) {
      if (data.length < 4) return
      const idx = data[1] | (data[2] << 8)
      const p = this.pending.get(idx)
      if (p) {
        this.pending.delete(idx)
        p.resolve({ rpc: p.rpc, wrapper: decodeWrapper(data.slice(3)) })
      }
    }
  }

  /** 发送原始 protobuf data（已 encode），resolve 为 {rpc, wrapper}，超时抛错 */
  send (name, data, timeout = DEFAULT_RPC_TIMEOUT) {
    if (!this.ws || !this.connected) throw new Error('网关未连接')
    const idx = this.index % MAX_SEQ
    const head = Buffer.from([MSG.req, idx & 0xff, (idx >> 8) & 0xff])
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(idx); reject(new Error(`等待 ${name} 响应超时（seq ${idx}）`)) }, timeout)
      this.pending.set(idx, {
        rpc: name,
        reject: (e) => { clearTimeout(t); reject(e) },
        resolve: (v) => { clearTimeout(t); resolve(v) }
      })
      // 序号可能回绕复用，覆盖同 key 旧条目
      try { this.ws.send(Buffer.concat([head, encodeWrapper(name, data)])) } catch (e) { this.pending.delete(idx); clearTimeout(t); reject(e) }
      this.index++
    })
  }

  on (notifyName, fn) {
    if (!this.notifies.has(notifyName)) this.notifies.set(notifyName, new Set())
    this.notifies.get(notifyName).add(fn)
  }

  close () {
    try { this.ws.close() } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// 雀魂客户端（登录 + 保活 + 数据 RPC）
// ---------------------------------------------------------------------------

/** 服务器错误（lq.Error）→ 可读异常 */
export class MajsoulLqError extends Error {
  constructor (err) {
    const code = err?.code ?? 0
    // 已知错误码的直白语义（方便上层直接给用户可读提示）
    const known = {
      109: '登录凭证已过期',
      151: '客户端版本校验失败',
      540: '牌谱读取过于频繁，请稍后重试',
      // 541 官方弹窗：「沒有此牌譜的檢視權限」→ **权限**问题，与频率无关。
      // 含义：当前登录账号无权查看该牌谱（属于他人且未对该账号开放）。
      // 等待无用；需换账号 / 让牌谱主人重新分享。
      541: '当前登录账号还没有查看该牌谱的权限（账号信任度不足）',
      1203: '牌谱不存在或不可访问'
    }
    const hint = known[code] ? `（${known[code]}）` : ''
    super(`雀魂服务器错误 code=${code}${hint}${err?.message ? ' ' + err.message : ''}`)
    this.name = 'MajsoulLqError'
    this.code = code
    this.err = err
    // lq.Error 全量字段：u32_params(2)/str_params(3)/json_param(4)/level(5)/message(6)/args(7)
    // 部分错误码 message 为空、细节在 json_param/args 里，全部透出便于排查
    this.jsonParam = err?.json_param || null
    this.args = err?.args || null
    const detailParts = []
    if (err?.json_param) detailParts.push(`json_param=${err.json_param}`)
    if (err?.args) detailParts.push(`args=${err.args}`)
    if (err?.str_params?.length) detailParts.push(`str_params=${JSON.stringify(err.str_params)}`)
    if (err?.u32_params?.length) detailParts.push(`u32_params=${JSON.stringify(err.u32_params)}`)
    if (detailParts.length) {
      this.detail = detailParts.join(' ')
      logger.warn(`[majsoul-js] 服务器错误详情 code=${code}: ${this.detail}`)
    }
  }
}

function dtoOfBrief (p) {
  // PlayerBaseView → 旧 exe REST 的 PlayerBriefDto 形状
  if (!p) return null
  return {
    accountId: p.account_id,
    nickname: p.nickname || '',
    avatarId: p.avatar_id || 0,
    title: p.title || 0,
    level: { id: p.level?.id ?? 0, score: p.level?.score ?? 0 },
    level3: { id: p.level3?.id ?? 0, score: p.level3?.score ?? 0 },
    avatarFrame: p.avatar_frame || 0,
    verified: p.verified || 0,
    isBanned: p.is_banned || 0
  }
}

export class MajsoulJsClient {
  constructor () {
    this.gw = null
    this.version = null
    this.productVersion = null
    this.webglVersion = null // majset 链解出的 {"version":"0.16.x","platform":"WebGL"}
    this.loggedIn = false
    this.auth = this.loadSession() // {accountId, nickname, avatarId, accessToken, savedAt}
    this.handshakeRoute = null
    this._connecting = null
    this._timers = []
    this._lastRelogin = 0
  }

  clientVersionString () {
    const v = this.webglVersion || this.productVersion || this.version || '4.0.47'
    return `WebGL_2022-${v}`
  }

  // ---- majset 版本链与缓存 ----

  loadVersionCache () {
    try {
      const j = JSON.parse(fs.readFileSync(VERSION_CACHE_PATH, 'utf8'))
      if (j && j.version) return j
    } catch { /* 无缓存 */ }
    return null
  }

  saveVersionCache (info) {
    try {
      const dir = path.dirname(VERSION_CACHE_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = VERSION_CACHE_PATH + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ ...info, fetchedAt: Date.now() }, null, 2))
      fs.renameSync(tmp, VERSION_CACHE_PATH)
    } catch (e) {
      logger.warn(`[majsoul-js] 版本缓存写入失败: ${e.message}`)
    }
  }

  /**
   * 登录版本串的版本号来源（majet 链 → 磁盘缓存 → index.html productVersion 兜底）。
   * 成功（true 用 majset 链实时取到）通过 resolve 值指示；null 表示全部失败。
   */
  async fetchWebglVersion () {
    if (this.webglVersion) return this.webglVersion
    const cached = this.loadVersionCache()
    try {
      const info = await discoverWebglVersion()
      this.webglVersion = info.version
      this.saveVersionCache(info)
      logger.info(`[majsoul-js] majset 版本链成功: {"version":"${info.version}","platform":"WebGL"}（bundle=${info.bundleName}）`)
      return info.version
    } catch (e) {
      logger.warn(`[majsoul-js] majset 版本链失败，回退缓存/兜底: ${e.message}`)
    }
    if (cached && cached.version) {
      const age = Date.now() - (cached.fetchedAt || 0)
      this.webglVersion = cached.version
      logger.info(`[majsoul-js] 使用版本缓存 ${cached.version}（${age > VERSION_CACHE_TTL ? '已过期仍兜底' : '有效'}）`)
      return cached.version
    }
    // exe 内嵌兜底：index.html 的 Unity productVersion（151 重试场景的传统手段）
    await this.fetchProductVersion()
    return null
  }

  /** 从官方 index.html 解析 Unity productVersion（兜底用，带缓存） */
  async fetchProductVersion () {
    if (this.productVersion) return this.productVersion
    try {
      const r = await fetch(`${INDEX_URL}?randv=${Math.random()}`)
      if (r.ok) {
        const html = await r.text()
        const m = html.match(/productVersion\s*:\s*["']([^"']+)["']/)
        if (m && m[1]) {
          this.productVersion = m[1]
          return this.productVersion
        }
      }
    } catch { /* 解析失败走 version.json 兜底 */ }
    this.productVersion = null
    return null
  }

  // ---- 会话持久化（存 access_token；绝不写日志/聊天输出） ----

  loadSession () {
    try {
      const j = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))
      if (j && j.accessToken) return j
    } catch { /* 无会话文件 */ }
    return null
  }

  saveSession () {
    if (!this.auth || !this.auth.accessToken) return
    try {
      const dir = path.dirname(SESSION_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = SESSION_PATH + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.auth, null, 2))
      fs.renameSync(tmp, SESSION_PATH)
      logger.info('[majsoul-js] 登录态已保存（token 续登可用）')
    } catch (e) {
      logger.warn(`[majsoul-js] 保存登录态失败: ${e.message}（不影响本次登录）`)
    }
  }

  clearSession () {
    this.auth = null
    this.loggedIn = false
    try { fs.rmSync(SESSION_PATH, { force: true }) } catch { /* noop */ }
  }

  // ---- 底层连接（互斥并发） ----

  async ensureGateway () {
    if (this.gw && this.gw.connected) return this.gw
    if (this._connecting) return this._connecting
    this._connecting = (async () => {
      try {
        await Codec.init() // liqi.json（官方版本链，含自动更新）
        if (!this.version) {
          this.version = Codec.version || (await fetchVersion()).version
          logger.info(`[majsoul-js] 雀魂资源版本 ${this.version}`)
        }
        // 登录版本串（WebGL_2022-0.16.x）来自 Unity 客户端的 majset 资源链
        // （bundle_info_so.majset 实时解包；资源版本/productVersion 都不能冒充它——151 ERR_CLIENT_VERSION 的根源）
        const wv = await this.fetchWebglVersion()
        logger.info(`[majsoul-js] 客户端版本 ${this.clientVersionString()}${wv ? '' : '（majset 链失败，使用兜底版本）' }`)
        const routes = await fetchRoutes(this.version)
        const usable = routes.filter(r => r.ssl && r.state === 'idle')
        let lastErr = null
        for (const route of usable.length ? usable : routes) {
          const gw = new MajsoulGateway(route.webSocket)
          try {
            await gw.connect()
            // 两步会话握手（缺了服务器 error.code=151）
            const conn = await gw.send('.lq.Route.requestConnection', encodeReqRequestConnection({
              type: 1, routeId: route.id != null ? String(route.id) : '1', timestamp: Date.now(), platform: 'Web'
            }), 15_000)
            const connRes = conn?.wrapper?.data ? parseResRequestConnection(conn.wrapper.data) : {}
            if (connRes.error && connRes.error.code) throw new MajsoulLqError(connRes.error)
            const hb = await gw.send('.lq.Route.heartbeat', encodeReqHeartbeat({ delay: 0, noOperationCounter: 0, platform: 11, networkQuality: 0 }), 15_000)
            const hbRes = hb?.wrapper?.data ? parseResHeartbeat(hb.wrapper.data) : {}
            if (hbRes.error && hbRes.error.code) throw new MajsoulLqError(hbRes.error)

            this.gw = gw
            this.gw.index = 1
            this.handshakeRoute = route
            this._startTimers()
            logger.info(`[majsoul-js] 已连接 ${route.webSocket}（version=${this.version}）`)
            return gw
          } catch (e) {
            lastErr = e
            try { gw.close() } catch { /* noop */ }
          }
        }
        throw new Error(`雀魂网关连接失败（已尝试 ${routes.length || 0} 条路由）: ${lastErr?.message || lastErr}；请检查服务器网络`)
      } finally {
        this._connecting = null
      }
    })()
    return this._connecting
  }

  _startTimers () {
    this._clearTimers()
    // Route.heartbeat 保活
    const hb = setInterval(() => {
      if (!this.gw || !this.gw.connected) return
      this.gw.send('.lq.Route.heartbeat', encodeReqHeartbeat({ delay: 0, noOperationCounter: 0, platform: 11, networkQuality: 0 }), 10_000)
        .catch(() => { /* 心跳失败交给断线处理 */ })
    }, HEARTBEAT_MS)
    // Lobby.loginBeat 会话保活
    const lb = setInterval(() => {
      if (!this.loggedIn || !this.gw || !this.gw.connected) return
      this.gw.send('.lq.Lobby.loginBeat', encodeReqLoginBeat('cat'), 15_000).catch(() => {})
    }, LOGIN_BEAT_MS)
    this._timers.push(hb, lb)
  }

  _clearTimers () {
    for (const t of this._timers) { try { clearInterval(t) } catch { /* noop */ } }
    this._timers = []
  }

  // ---- 通用 RPC（protobufjs 编解码，响应 error 字段统一抛异常） ----

  _methodTypes (methodPath) {
    const parts = methodPath.split('.')
    const service = Codec.root.lookupService(`lq.${parts[2]}`)
    if (!service) throw new Error(`未知服务 lq.${parts[2]}`)
    const m = service.methods[parts[3]]
    if (!m) throw new Error(`未知 RPC ${methodPath}`)
    return { ReqType: Codec.root.lookupType(m.requestType), ResType: Codec.root.lookupType(m.responseType) }
  }

  async request (methodPath, payload = {}, timeout = DEFAULT_RPC_TIMEOUT) {
    let gw = await this.ensureGateway()
    const { ReqType, ResType } = this._methodTypes(methodPath)
    const data = ReqType.encode(ReqType.create(payload)).finish()
    let out
    try {
      out = await gw.send(methodPath, data, timeout)
    } catch (e) {
      // 断线重试一次：重建连接再发
      logger.warn(`[majsoul-js] ${methodPath} 发送失败，重建网关重试: ${e.message}`)
      try { gw.close() } catch { /* noop */ }
      this.gw = null
      gw = await this.ensureGateway()
      out = await gw.send(methodPath, ReqType.encode(ReqType.create(payload)).finish(), timeout)
    }
    let decoded = this._decodeResponse(out, ResType)

    // 1004 = 会话未登录/已失效（服务端踢掉了 Lobby 会话，常见于长时间空闲后
    // loginBeat 保活失败）。exe 通道遇到它会自动重连一次并成功取谱（实测日志：
    // "Majsoul session ... became unusable during FetchRecordAsync; reconnecting once"），
    // JS 通道此前没有这个逻辑，直接把 1004 抛给用户 → 表现为"莫名其妙失败一次"。
    // 这里补上等价的「重连 + 重登 + 重发一次」，且只针对 1004（避免其他错误码陷入重试）。
    if (decoded?.__lqError?.code === 1004 && methodPath !== '.lq.Lobby.login' && methodPath !== '.lq.Lobby.oauth2Login') {
      logger.warn(`[majsoul-js] ${methodPath} 返回 1004（会话失效），重建网关并重登后重发一次`)
      try { gw.close() } catch { /* noop */ }
      this.gw = null
      this.loggedIn = false
      gw = await this.ensureGateway()
      // 用已保存的 access_token 重新完成 Lobby 登录
      try {
        await this._doRequireLogin()
      } catch (e) {
        logger.warn(`[majsoul-js] 1004 重登失败: ${e.message || e}`)
        throw decoded.__lqError
      }
      gw = await this.ensureGateway()
      out = await gw.send(methodPath, ReqType.encode(ReqType.create(payload)).finish(), timeout)
      decoded = this._decodeResponse(out, ResType)
    }

    if (decoded?.__lqError) throw decoded.__lqError
    return decoded
  }

  /** 解包一次 RPC 响应：成功返回对象；失败把 MajsoulLqError 挂在 __lqError 上（便于上层决定是否重试） */
  _decodeResponse (out, ResType) {
    const wdata = out?.wrapper?.data
    if (!wdata || !wdata.length) return {}
    const msg = ResType.decode(wdata)
    const decoded = ResType.toObject(msg, { defaults: false })
    if (decoded && decoded.error && (decoded.error.code || 0) !== 0) {
      return { __lqError: new MajsoulLqError(decoded.error) }
    }
    return decoded
  }

  // ---- 登录 ----

  async _acceptResLogin (dec, creds = null) {
    this.loggedIn = true
    // 凭据延续规则：显式传入 > 上一次 this.auth 里已存的（token 续登时不传，需保留）
    const prev = this.auth || {}
    this.auth = {
      accountId: dec.account_id,
      accessToken: dec.access_token || null,
      nickname: dec.account?.nickname || null,
      avatarId: dec.account?.avatar_id || null,
      account: creds?.account ?? prev.account ?? null,
      // 注意：存的是 HMAC-SHA256(password, "lailai") 处理后的口令散列，
      // 与官方登录接口要求的字段完全一致，可直接用于自动重登；原始密码不落盘。
      passwordHash: creds?.passwordHash ?? prev.passwordHash ?? null,
      savedAt: Date.now(),
      savedAtText: new Date().toISOString()
    }
    this.saveSession()
    this._hookLogoutNotify()
    // 拉自己的简报补全昵称/头像（粗略，失败不影响登录）
    try {
      const brief = await this.getPlayerBrief(this.auth.accountId)
      if (brief) {
        this.auth.nickname = brief.nickname
        this.auth.avatarId = brief.avatarId
        this.auth.level = brief.level
        this.auth.level3 = brief.level3
        this.saveSession()
      }
    } catch { /* 昵称补全失败不影响登录 */ }
    return {
      accountId: this.auth.accountId,
      nickname: this.auth.nickname || '',
      avatarId: this.auth.avatarId || 0
    }
  }

  /** 官方同款完整设备信息（ReqLogin.device） */
  _device () { return CLIENT_DEVICE }

  /** CN 服登录公共字段（完整字段与官方 Web 客户端/兔协议基准一致） */
  _clientVersionFields () {
    // 151 校验核心：与 client_version_string 同源的 majset 版本号（0.16.x），兜底 productVersion
    const cv = this.webglVersion || this.productVersion || this.version || '4.0.47'
    return {
      reconnect: false,
      device: this._device(),
      random_key: crypto.randomUUID(),
      client_version: { resource: cv, package: cv },
      client_version_string: this.clientVersionString(),
      currency_platforms: CN_CURRENCY_PLATFORMS,
      tag: CN_TAG
    }
  }

  /** 账密登录（密码 = HMAC-SHA256("lailai")，与官方客户端一致；完整字段与官方 Web 客户端对齐） */
  async login (account, password) {
    if (!account || !password) throw new Error('账号或密码为空')
    await this.ensureGateway()
    const passwordHash = hashPassword(password)
    const dec = await this.request('.lq.Lobby.login', {
      account,
      password: passwordHash,
      ...this._clientVersionFields(),
      gen_access_token: true,
      type: CN_LOGIN_TYPE
    }, DEFAULT_RPC_TIMEOUT)
    // 账密登录成功后把凭据（散列态）一并存档，token 失效时可用它自动重登
    return this._acceptResLogin(dec, { account, passwordHash })
  }

  /** token 续登（oauth2Login type=10 官方统一 token） */
  async loginByToken (token) {
    if (!token) throw new Error('access_token 为空')
    await this.ensureGateway()
    const dec = await this.request('.lq.Lobby.oauth2Login', {
      type: 10,
      access_token: token,
      ...this._clientVersionFields()
    }, DEFAULT_RPC_TIMEOUT)
    return this._acceptResLogin(dec)
  }

  /**
   * 确保已登录：已登录直接返回；有存档 token 则尝试续登；否则抛需要登录的错误。
   * 并发调用合并为一次（多个数据 RPC 同时触发时只会登录一次）。
   */
  requireLogin () {
    if (this.loggedIn && this.auth?.accessToken) return Promise.resolve()
    if (this._loginPromise) return this._loginPromise
    this._loginPromise = this._doRequireLogin().finally(() => { this._loginPromise = null })
    return this._loginPromise
  }

  async _doRequireLogin () {
    if (this.auth?.accessToken) {
      await this.ensureGateway()
      try {
        await this.loginByToken(this.auth.accessToken)
        logger.info(`[majsoul-js] token 续登成功（${this.auth.nickname || this.auth.accountId}）`)
        return
      } catch (e) {
        this.loggedIn = false
        logger.warn(`[majsoul-js] token 续登失败: ${e.message}`)
        // 雀魂 token 单活：在别处登录（游戏客户端/网页/上次运行）会作废旧 token（109）。
        // 与 exe 通道对齐：只要存档里有账密凭据（passwordHash 形态），直接自动重登，
        // 不再要求用户手动发「雀魂登录」。
        if (e instanceof MajsoulLqError && (e.code === 109 || e.code === 1004)) {
          const { account, passwordHash } = this.auth
          if (account && passwordHash) {
            logger.info('[majsoul-js] 使用存档凭据自动重登…')
            try {
              const dec = await this.request('.lq.Lobby.login', {
                account,
                password: passwordHash,
                ...this._clientVersionFields(),
                gen_access_token: true,
                type: CN_LOGIN_TYPE
              }, DEFAULT_RPC_TIMEOUT)
              await this._acceptResLogin(dec, { account, passwordHash })
              logger.info(`[majsoul-js] 凭据自动重登成功（${this.auth.nickname || this.auth.accountId}）`)
              return
            } catch (e2) {
              logger.warn(`[majsoul-js] 凭据自动重登失败: ${e2.message}`)
              // 密码被改 / 账号被封等：清掉存档避免反复尝试
              this.clearSession()
              throw new Error('登录凭证已过期且自动重登失败，请由主人私聊发送 → 雀魂登录 账号 密码')
            }
          }
          this.clearSession()
          logger.warn('[majsoul-js] 已清除过期登录态，等待重新账密登录')
          throw new Error('登录凭证已过期，请由主人私聊发送 → 雀魂登录 账号 密码')
        }
      }
    }
    // 无 token 但有凭据存档（极端情况：token 字段丢失）：也尝试账密自动登
    const { account, passwordHash } = this.auth || {}
    if (account && passwordHash) {
      await this.ensureGateway()
      const dec = await this.request('.lq.Lobby.login', {
        account,
        password: passwordHash,
        ...this._clientVersionFields(),
        gen_access_token: true,
        type: CN_LOGIN_TYPE
      }, DEFAULT_RPC_TIMEOUT)
      await this._acceptResLogin(dec, { account, passwordHash })
      logger.info(`[majsoul-js] 凭据自动登录成功（${this.auth.nickname || this.auth.accountId}）`)
      return
    }
    throw new Error('JS 协议通道未登录：请由主人私聊发送 [雀魂登录 账号 密码] 完成登录')
  }

  _hookLogoutNotify () {
    if (!this.gw || this._hookedOn === this.gw) return
    this._hookedOn = this.gw
    this.gw.on('NotifyAccountLogout', () => {
      logger.warn('[majsoul-js] 服务器通知账号下线（NotifyAccountLogout）')
      this.loggedIn = false
      this._autoRelogin()
    })
  }

  /**
   * 断线/下线后的自动重登（带 60s 节流）：优先 token 续登。
   * 失败不抛（保活是尽力而为，下次数据请求会再触发 requireLogin）。
   */
  _autoRelogin () {
    if (!this.auth || !this.auth.accessToken) return
    const now = Date.now()
    if (now - this._lastRelogin < 60_000) return
    this._lastRelogin = now
    setTimeout(() => {
      this.requireLogin().catch(e => {
        logger.warn(`[majsoul-js] 自动重登失败: ${e.message}`)
      })
    }, 5_000).unref?.()
  }

  // ---- 数据 RPC（输出与旧 exe REST DTO 形状一致） ----

  /** 玩家简报（旧 /api/players/{id}）；失败返回 null */
  async getPlayerBrief (accountId) {
    if (accountId == null || accountId === '') return null
    await this.requireLogin()
    const dec = await this.request('.lq.Lobby.fetchMultiAccountBrief', {
      account_id_list: [Number(accountId)]
    })
    const p = (dec.players || [])[0]
    if (!p) return null
    return dtoOfBrief(p)
  }

  /**
   * 玩家在线状态（对应旧 exe /api/players/states）。
   * fetchAccountState → ResAccountStates{ states: AccountActiveState[] }
   *   AccountActiveState{ account_id, login_time, logout_time, is_online, playing{game_uuid,category} }
   * 返回 { online: boolean, playing: boolean, gameUuid, category } 或 null（失败/未登录时静默返回 null）。
   * 注：雀魂对"查状态"有限制，别人可能查不到；调用方一律按空值降级处理。
   */
  async getPlayerState (accountId) {
    if (accountId == null || accountId === '') return null
    try {
      await this.requireLogin()
      const dec = await this.request('.lq.Lobby.fetchAccountState', {
        account_id_list: [Number(accountId)]
      }, 15_000)
      const st = (dec.states || [])[0]
      if (!st) return null
      const playing = !!(st.playing && st.playing.game_uuid)
      return {
        accountId: Number(st.account_id) || Number(accountId),
        online: !!st.is_online,
        playing,
        gameUuid: playing ? st.playing.game_uuid : null,
        category: playing ? (st.playing.category ?? 0) : 0,
        loginTime: st.login_time || 0,
        logoutTime: st.logout_time || 0
      }
    } catch (e) {
      logger.debug?.(`[majsoul-js] 查询在线状态失败(${accountId}): ${e.code ?? e.message}`)
      return null
    }
  }

  /** 好友码 → 玩家简报（旧 /api/players/resolve?friendId=）；失败返回 null */
  async resolveFriendId (friendId) {
    if (friendId == null || friendId === '') return null
    await this.requireLogin()
    const dec = await this.request('.lq.Lobby.searchAccountByPattern', {
      pattern: String(friendId).trim(),
      search_next: false
    })
    let id = null
    if ((dec.match_accounts || []).length) id = dec.match_accounts[0]
    else if (dec.decode_id) id = dec.decode_id
    if (!id) return null
    return this.getPlayerBrief(id)
  }

  /** fetchGameRecord 单次调用（ResGameRecord） */
  async _fetchGameRecord (gameUuid) {
    // 必须先建立网关：ensureGateway 内部才会走 majset 版本链填充 this.webglVersion，
    // 否则下面 clientVersionString() 会退化成硬编码兜底版本（WebGL_2022-4.0.47），
    // 旧版本串会被服务器视为客户端过旧而拒绝（实测 fetchGameRecord 返回 540）。
    // login() 早就用 await ensureGateway() 规避了同一问题，这里此前漏了。
    await this.ensureGateway()
    return this.request('.lq.Lobby.fetchGameRecord', {
      game_uuid: gameUuid,
      client_version_string: this.clientVersionString()
    }, 60_000)
  }

  /**
   * 主视角账号解析（exe 通道 reference.targetAccountId 的 JS 等价物）。
   *
   * 牌谱 URL 尾缀 `_a<digits>` 是雀魂的 **match_id**，它由玩家 account_id 经
   * 固定公式编码而来，反解即可得到主视角账号：
   *
   *   acc2match(acc) = ((7 * acc + 1117113) ^ 86216345) + 1358437
   *   mat2account(m) = (((m - 1358437) ^ 86216345) - 1117113) / 7
   *
   * 三个 ID 的关系（雀魂官方实现）：
   *   friend_id ←→ account_id ←→ match_id（牌谱尾缀）
   * 知道任意一个即可推出另外两个。
   *
   * 实测验证（4/4 全部命中）：
   *   16371840 → 64678917    9564862  → 21093079
   *   10054337 → 24523774    93990214 → 578846879
   *
   * 注意：尾缀也可能带 `_2` 之类的后缀（匿名牌谱），正则只取 `_a` 后的数字段。
   */
  _resolveTargetAccountId (paipuId, players) {
    const ids = players.map(p => Number(p.accountId)).filter(n => n > 0)
    const m = String(paipuId).match(/_[aA](\d{4,})/)
    if (m) {
      const matchId = Number(m[1])
      // 1) 先按 match_id → account_id 解码（官方算法）
      if (Number.isSafeInteger(matchId) && matchId > 0) {
        const acc = MajsoulJsClient.mat2account(matchId)
        if (acc > 0 && ids.includes(acc)) return acc
        // 解码结果不在谱内（尾缀属于旁观者/已注销账号）时继续往下兜底
        logger.debug?.(`[majsoul-js] 尾缀 ${matchId} 解出 account=${acc}，但不在本谱玩家内`)
      }
      // 2) 尾缀本身就是谱内某人的 account_id（部分旧链接）
      if (ids.includes(matchId)) return matchId
    }
    // 3) 兜底：登录账号若在谱内，即为主视角
    const me = Number(this.auth?.accountId || 0)
    if (me > 0 && ids.includes(me)) return me
    return null
  }

  /** account_id → match_id（牌谱 URL 尾缀）。雀魂官方编码公式。 */
  static acc2match (accountId) {
    const OFFSET_A = 1117113
    const OFFSET_B = 1358437
    const XOR_CODE = 86216345
    // JS 位运算按 32 位有符号处理，用 >>> 0 转回无符号
    return (((7 * Number(accountId) + OFFSET_A) ^ XOR_CODE) >>> 0) + OFFSET_B
  }

  /** match_id（牌谱 URL 尾缀）→ account_id。acc2match 的逆运算。 */
  static mat2account (matchId) {
    const OFFSET_A = 1117113
    const OFFSET_B = 1358437
    const XOR_CODE = 86216345
    const v = ((Number(matchId) - OFFSET_B) >>> 0) ^ XOR_CODE
    return Math.floor((v - OFFSET_A) / 7)
  }

  /**
   * 取完整牌谱（旧 POST /api/records/fetch 的 DTO 形状）。
   * fetchGameRecord → ResGameRecord{error, head:RecordGame, data:bytes(GameDetailRecords), data_url}
   * data 为空时回退 data_url 下载（官方 CDN 原始回放数据）。
   */
  async getRecordDetail (paipu) {
    if (!paipu) throw new Error('牌谱 ID 为空')
    await this.requireLogin()
    const id = String(paipu)
    // game_uuid 字段按官方语义应传裸 UUID（分享链接的 _a<尾缀> 是视角标记）。
    // 但服务器对带尾缀的形态也能处理（exe 通道一直原样透传并成功），故：
    // 先按裸 uuid 取，若报 1203（查无此谱，个别记录按带尾缀形态索引）再回退原串。
    const bareMatch = id.match(/^(\d{6}-[0-9a-fA-F-]+)_[a-zA-Z]?\d+$/)
    const bareId = bareMatch ? bareMatch[1] : id
    let dec
    try {
      dec = await this._fetchGameRecord(bareId)
    } catch (e) {
      if (e instanceof MajsoulLqError && e.code === 1203 && bareId !== id) {
        logger.warn(`[majsoul-js] fetchGameRecord 裸 uuid 1203，回退试带尾缀原串: ${id}`)
        dec = await this._fetchGameRecord(id)
      } else if (e instanceof MajsoulLqError && e.code === 541) {
        // 541 = 官方「沒有此牌譜的檢視權限」：权限问题，不是频率问题。
        logger.warn(`[majsoul-js] fetchGameRecord 541：当前账号无此牌谱查看权限，uuid=${bareId}`)
        // 实测：雀魂对"从未对局过"的新账号有读谱限制（官方文案：「沒有此牌譜的檢視權限」）。
        // 当前账号打过若干局、信任度提升后，这个 541 会自然消失（同账号前后对比已确认）。
        const noPerm = new Error('当前登录账号还读不了这条牌谱（code=541，雀魂的读谱权限限制）。\n' +
          '常见原因：该账号对局太少、账号信任度不足（打过若干局后可查看他人牌谱）。\n' +
          '可先用自己的账号打几局，或在命令末尾指定座位读取本地缓存。')
        noPerm.code = 541
        noPerm.cause = e
        throw noPerm
      } else if (e instanceof MajsoulLqError && e.code === 540) {
        // 540 = 官方「超過牌譜讀取限制」：短时间取谱过多，冷却即恢复。
        // 不要再重试（重试只会延长冷却窗口），直接透出可读提示。
        logger.warn(`[majsoul-js] fetchGameRecord ${e.code}：牌谱读取过于频繁/受限（服务器限流），uuid=${bareId}`)
        const tooFrequent = new Error(`雀魂提示：牌谱读取过于频繁/受限（code=${e.code}），请稍后再试`)
        tooFrequent.code = e.code
        tooFrequent.cause = e
        throw tooFrequent
      } else {
        throw e
      }
    }
    const head = dec.head || {}
    let dataBase64 = null
    if (dec.data && dec.data.length) {
      dataBase64 = Buffer.from(dec.data).toString('base64')
    } else if (dec.data_url) {
      const r = await fetch(dec.data_url)
      if (r.ok) dataBase64 = Buffer.from(await r.arrayBuffer()).toString('base64')
    }
    if (!dataBase64) throw new Error(`雀魂服务器未返回牌谱数据（data/data_url 均缺失, ${paipu}）`)
    const players = (head.accounts || []).map(a => ({
      seat: a.seat ?? 0,
      accountId: a.account_id,
      nickname: a.nickname || '',
      avatarId: a.avatar_id || 0,
      characterId: a.character ? (a.character.charid ?? 0) : 0,
      level: { id: a.level?.id ?? 0, score: a.level?.score ?? 0 },
      level3: { id: a.level3?.id ?? 0, score: a.level3?.score ?? 0 }
    }))
    return {
      uuid: head.uuid || String(paipu),
      endTime: head.end_time ? new Date(head.end_time * 1000).toISOString() : null,
      standardRule: head.standard_rule || 0,
      players,
      dataBase64,
      // 主视角：尾缀解码 → match_id → account_id；命中谱内玩家即为主视角
      targetAccountId: this._resolveTargetAccountId(id, players)
    }
  }

  /**
   * 玩家对局统计（旧 GET /api/players/{id}/statistics 的 DTO 形状）。
   * 数据源：fetchAccountStatisticInfo → ResAccountStatisticInfo{statistic_data, detail_data}
   *   - statistic_data 完整：顺位分布 / 近期胜率 / 近 10 场结果（官方当前筛选类别）
   *   - detail_data 按 亲友/段位 聚合：AccountDetailStatistic.game_mode[] 每模式
   *     game_final_position（顺位数组）按顺位累加为 finalPositionCounts
   * 返回 {accountId, entries}；失败返回 null。
   */
  async getPlayerStatistics (accountId) {
    if (accountId == null || accountId === '') return null
    await this.requireLogin()
    const dec = await this.request('.lq.Lobby.fetchAccountStatisticInfo', {
      account_id: Number(accountId)
    })
    const entries = []
    const rateOf = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 1000 : 0)

    // 1) statistic_data（官方"当前筛选类别"，字段最全）
    //    ⚠️ liqi.json 里该字段是 **repeated**（AccountStatisticData 数组），不是单个对象。
    //    旧写法 `const sd = dec.statistic_data; if (sd && sd.statistic)` 对数组取 .statistic
    //    恒为 undefined，整段被静默跳过 —— 顺位分布/和牌率/放铳率/近 10 场全部丢失，
    //    上层 render.js 只能拿到 detail_data 的裸顺位计数（没有 recentGames，走势图空白）。
    //    与 exe 基准（/api/players/{id}/statistics 返回 7 条 entry，含 gt=1 与 gt=100）对齐后改为遍历。
    const sdList = Array.isArray(dec.statistic_data)
      ? dec.statistic_data
      : (dec.statistic_data ? [dec.statistic_data] : [])
    for (const sd of sdList) {
      if (!sd || !sd.statistic) continue
      const ams = sd.statistic
      const rr = ams.recent_round || {}
      const fpc = (ams.final_position_counts || []).map(x => x || 0)
      const total = rr.total_count || 0
      entries.push({
        mahjongCategory: sd.mahjong_category || 1,
        gameCategory: sd.game_category || 2,
        gameType: sd.game_type || 1,
        finalPositionCounts: fpc,
        roundCount: total,
        ronRate: rateOf(rr.rong_count || 0, total),
        tsumoRate: rateOf(rr.zimo_count || 0, total),
        dealInRate: rateOf(rr.fangchong_count || 0, total),
        winRate: rateOf((rr.rong_count || 0) + (rr.zimo_count || 0), total),
        recentGames: (ams.recent_10_game_result || []).map(g => ({ rank: g.rank, finalPoint: g.final_point }))
      })
    }

    // 2) detail_data 聚合（友人 gc=1 / 段位 gc=2 / 比赛 gc=4）
    //    AccountDetailStatisticV2 的字段语义（liqi.json）：
    //      friend_room_statistic    → 友人场   ⇒ gameCategory = 1
    //      rank_statistic           → 段位场   ⇒ gameCategory = 2
    //      leisure_match_statistic  → **比赛场** ⇒ gameCategory = 4
    //    ⚠️ 旧代码把 leisure_match_statistic 也标成 1，会和友人场撞车：
    //       render.js 的 pickLocalEntry 用 find() 取第一条，结果「比赛场」页面
    //       显示的是友人场数据，而真正的比赛场条目永远取不到。
    //       对照 exe 基准（majsoul-api 输出含 mj=1/gc=4 与 mj=2/gc=4 两条）已修正为 4。
    const dd = dec.detail_data
    const pushModes = (modes, gameCategory, mahjongGuess) => {
      const byMc = new Map()
      for (const gm of modes || []) {
        const pos = gm.game_final_position || []
        // 三麻判断：整组顺位最大值 ≤3 → 三麻；否则四麻
        const maxPos = pos.reduce((m, x) => Math.max(m, x || 0), 0)
        const mc = pos.length > 0 && maxPos <= 3 ? 2 : (mahjongGuess || 1)
        if (!byMc.has(mc)) byMc.set(mc, [])
        byMc.get(mc).push(pos)
      }
      for (const [mc, posList] of byMc) {
        const flat = posList.flat()
        const n = 4 // 渲染层索引到第 4 位；三麻第 4 位为 0
        const fpc = new Array(n).fill(0)
        for (const p of flat) { if (p >= 1 && p <= n) fpc[p - 1]++ }
        const games = flat.length
        if (!games) continue
        entries.push({
          mahjongCategory: mc,
          gameCategory,
          gameType: 1,
          finalPositionCounts: fpc,
          roundCount: games,
          games
        })
      }
    }
    if (dd) {
      if (dd.friend_room_statistic) pushModes(dd.friend_room_statistic.game_mode, 1, 1)
      const rank = dd.rank_statistic
      if (rank && rank.total_statistic && rank.total_statistic.all_level_statistic) {
        pushModes(rank.total_statistic.all_level_statistic.game_mode, 2, 1)
      }
      if (dd.leisure_match_statistic) pushModes(dd.leisure_match_statistic.game_mode, 4, 1)
    }

    return { accountId: Number(accountId), entries }
  }

  close () {
    this._clearTimers()
    if (this.gw) { try { this.gw.close() } catch { /* noop */ } this.gw = null }
  }
}

// 插件内使用的进程级单例
const jsClient = new MajsoulJsClient()
export default jsClient

// ---------------------------------------------------------------------------
// 连通性自检（不使用真实凭据，预期服务器返回 code=1002 ERR_ACC_NOT_SIGN_UP，
// 与旧 exe /api/smoke-test 的结果同源等价）
// ---------------------------------------------------------------------------

export async function probeGateway ({ account = 'js_probe', password = 'js_probe' } = {}) {
  const ver = Codec.version || (await fetchVersion()).version
  logger.info(`[majsoul-js] probe: version=${ver}`)
  let outcome = { ok: true }
  try {
    await jsClient.login(account, password)
    // 意外地登录成功（说明该账号真实存在），也算连通性 OK
    outcome = { ok: true, loggedIn: true }
  } catch (e) {
    if (e instanceof MajsoulLqError) {
      // 服务器已把请求送达业务层：链路完全打通（如 1002 ERR_ACC_NOT_SIGN_UP）
      outcome = { ok: true, serverError: { code: e.code, message: e.err?.message || '' } }
    } else {
      jsClient.close()
      throw e
    }
  }
  jsClient.close()
  return outcome
}

// 直接运行时执行连通性自检（TRSS-Yunzai 加载插件时不会触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeGateway().then(r => {
    logger.info(`[majsoul-js] probe 完成: ${JSON.stringify(r)}`)
    process.exit(0)
  }).catch(e => {
    logger.error(`[majsoul-js] probe 失败: ${e.stack || e.message}`)
    process.exit(1)
  })
}
