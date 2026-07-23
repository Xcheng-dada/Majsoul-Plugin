import fs from 'fs'
import net from 'net'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import WebSocket from 'ws'
import codec from './Codec.js'

function decodeAccountId2(id) {
  return Math.trunc((((id - 1358437) ^ 86216345) - 1117113) / 7)
}

function parsePaipuId(paipuId) {
  const parts = paipuId.split('_')
  let logId = parts[0]
  let targetId = null

  if (parts.length >= 3 && parts[2] === '2') {
    logId = decodeLogId(logId)
  }

  if (parts.length >= 2 && parts[1]) {
    if (parts[1].startsWith('a')) {
      targetId = decodeAccountId2(Number(parts[1].slice(1)))
    } else if (/^\d+$/.test(parts[1])) {
      targetId = Number(parts[1])
    }
  }

  return { logId, targetId }
}

function decodeLogId(logId) {
  const zero = '0'.charCodeAt(0)
  const alpha = 'a'.charCodeAt(0)
  let ret = ''

  for (let i = 0; i < logId.length; i++) {
    const code = logId.charCodeAt(i)
    let o = null

    if (zero <= code && code < zero + 10) {
      o = code - zero
    } else if (alpha <= code && code < alpha + 26) {
      o = code - alpha + 10
    }

    if (o === null) {
      ret += logId[i]
      continue
    }

    o = (o + 55 - i) % 36
    ret += o < 10 ? String.fromCharCode(o + zero) : String.fromCharCode(o + alpha - 10)
  }

  return ret
}

const DEFAULT_PORT = 9222
const GAME_URL = 'https://game.maj-soul.com/1/'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toBuffer(value) {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (Array.isArray(value)) return Buffer.from(value)
  if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data)
  }
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  throw new Error('Unsupported bytes payload')
}

function decodeBrowserRequest(frame) {
  const buf = Buffer.from(frame.data || [])
  if (buf[0] !== codec.REQUEST) return null

  const reqIndex = buf[1] | (buf[2] << 8)
  const msg = codec.unwrap(buf.slice(3))
  const methodName = msg.name
  const parts = methodName.split('.')
  const service = parts[2]
  const rpc = parts[3]
  const protoService = codec.root.lookupService(`lq.${service}`)
  const protoMethod = protoService.methods[rpc]
  const RequestType = codec.lookupMethod(protoMethod.requestType)
  const ResponseType = codec.lookupMethod(protoMethod.responseType)
  const payload = RequestType.toObject(RequestType.decode(msg.data), { enums: String, defaults: true })

  return {
    reqIndex,
    methodName,
    responseType: ResponseType,
    payload
  }
}

function decodeBrowserResponse(frame, requestInfo) {
  const buf = Buffer.from(frame.data || [])
  if (buf[0] !== codec.RESPONSE) return null

  const reqIndex = buf[1] | (buf[2] << 8)
  if (reqIndex !== requestInfo.reqIndex) return null

  codec.inflightRequests.set(reqIndex, {
    methodName: requestInfo.methodName,
    responseType: requestInfo.responseType
  })
  return codec.decodeMessage(buf).payload
}

function cdpRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      timeout: 5000
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Chrome CDP HTTP ${res.statusCode}: ${body}`))
          return
        }

        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (err) {
          reject(new Error(`Chrome CDP JSON parse failed: ${err.message}`))
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('Chrome CDP HTTP timeout')))
    req.on('error', reject)
    req.end()
  })
}

async function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findFreePort(start = DEFAULT_PORT) {
  for (let port = start; port < start + 20; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error('找不到可用的 Chrome 调试端口')
}

function chromeCandidates() {
  const candidates = []
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)

  if (process.platform === 'win32') {
    const envs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    for (const base of envs.filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    candidates.push('/usr/bin/google-chrome')
    candidates.push('/usr/bin/chromium')
    candidates.push('/usr/bin/chromium-browser')
    candidates.push('/usr/bin/microsoft-edge')
  }

  return [...new Set(candidates)].filter(Boolean)
}

function findChromeExecutable() {
  const candidates = chromeCandidates()
  const found = candidates.find(item => fs.existsSync(item))
  if (!found) {
    throw new Error(`找不到 Chrome/Edge，可设置环境变量 CHROME_PATH。已尝试: ${candidates.join(', ')}`)
  }
  return found
}

async function waitForCdp(port, timeoutMs = 15000) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try {
      return await cdpRequest(port, '/json/version')
    } catch (err) {
      lastError = err
      await sleep(500)
    }
  }
  throw new Error(`Chrome 调试端口未就绪: ${lastError?.message || 'timeout'}`)
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.ws = new WebSocket(this.wsUrl)

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome CDP WebSocket timeout')), 10000)
      this.ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    this.ws.on('message', (raw) => {
      let msg = null
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (!msg.id || !this.pending.has(msg.id)) return
      const { resolve, reject, timer } = this.pending.get(msg.id)
      clearTimeout(timer)
      this.pending.delete(msg.id)

      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`))
      else resolve(msg.result)
    })

    this.ws.on('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('Chrome CDP WebSocket closed'))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome CDP WebSocket is not connected'))
    }

    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome CDP command timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(payload, (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, timeoutMs)

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(detail || 'Chrome Runtime.evaluate failed')
    }

    return result.result?.value
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }
}

export class MajsoulBrowserBridge {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.MAJSOUL_CHROME_PORT || DEFAULT_PORT)
    this.userDataDir = options.userDataDir || path.resolve('./plugins/Majsoul-Plugin/data/chrome-profile')
    this.url = options.url || GAME_URL
    this.headless = options.headless !== false // 默认无头；登录时传 false 显示窗口
    this.page = null
    this.chromeProcess = null
    this.version = null
    this.clientVersionString = ''
  }

  async connect() {
    let version = null
    try {
      version = await cdpRequest(this.port, '/json/version')
    } catch {
      const portFree = await isPortFree(this.port)
      if (!portFree) this.port = await findFreePort(this.port + 1)
      await this.launchChrome()
      version = await waitForCdp(this.port)
    }

    const target = await this.findOrCreateGameTarget()
    this.page = new CdpPage(target.webSocketDebuggerUrl)
    await this.page.connect()
    await this.page.send('Runtime.enable')
    await this.page.send('Page.enable')
    await this.loadVersion()
    await codec.init('https://game.maj-soul.com/', this.version)

    const state = await this.getLoginState().catch(() => null)
    if (typeof logger !== 'undefined') {
      logger.info(`[Majsoul-Plugin] 浏览器桥已连接 Chrome ${version.Browser || ''}，页面: ${state?.href || target.url}`)
    }
  }

  async launchChrome() {
    const chrome = findChromeExecutable()
    fs.mkdirSync(this.userDataDir, { recursive: true })

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]
    if (this.headless) args.push('--headless=new')
    args.push(this.url)

    this.chromeProcess = spawn(chrome, args, {
      detached: true,
      stdio: 'ignore'
    })
    this.chromeProcess.unref()

    if (typeof logger !== 'undefined') {
      logger.info(`[Majsoul-Plugin] 已启动浏览器桥 Chrome: ${chrome} (headless=${this.headless})`)
    }
  }

  async loadVersion() {
    const res = await fetch(`https://game.maj-soul.com/1/version.json?randv=${Math.random()}`)
    const versionInfo = await res.json()
    this.version = versionInfo.version
    this.clientVersionString = `web-${this.version.replace('.w', '')}`
  }

  async findOrCreateGameTarget() {
    const targets = await cdpRequest(this.port, '/json/list')
    const gameTarget = targets.find(item => item.type === 'page' && item.url?.includes('game.maj-soul.com'))
    if (gameTarget?.webSocketDebuggerUrl) return gameTarget

    return await cdpRequest(this.port, `/json/new?${encodeURIComponent(this.url)}`, 'PUT')
  }

  async reattachGameTarget() {
    await this.page?.close().catch(() => {})
    const target = await this.findOrCreateGameTarget()
    this.page = new CdpPage(target.webSocketDebuggerUrl)
    await this.page.connect()
    await this.page.send('Runtime.enable')
    await this.page.send('Page.enable')
    return target
  }

  async getLoginState() {
    if (!this.page) throw new Error('浏览器桥未连接')

    return await this.page.evaluate(`(() => {
      const pick = (obj, keys) => {
        if (!obj) return null
        for (const key of keys) {
          if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key]
        }
        return null
      }
      const ls = {}
      for (const key of ['access_token', 'device_id', 'account', 'language', 'login_type_index']) {
        try { ls[key] = localStorage.getItem(key) || '' } catch (_) { ls[key] = '' }
      }
      const managers = [
        globalThis.GameMgr && globalThis.GameMgr.Inst,
        globalThis.game && globalThis.game.GameMgr && globalThis.game.GameMgr.Inst
      ].filter(Boolean)
      let accountId = null
      let nickname = ''
      let logined = false
      for (const mgr of managers) {
        accountId = accountId || pick(mgr, ['account_id', 'accountId', 'uid'])
        nickname = nickname || pick(mgr, ['nick_name', 'nickname'])
        logined = logined || !!pick(mgr, ['logined', 'isLogin', 'is_logined'])
        const account = pick(mgr, ['account'])
        if (account && typeof account === 'object') {
          accountId = accountId || pick(account, ['account_id', 'accountId', 'uid'])
          nickname = nickname || pick(account, ['nickname', 'nick_name'])
        }
      }
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        accessToken: ls.access_token,
        deviceId: ls.device_id,
        account: ls.account,
        accountId,
        nickname,
        logined,
        cookie: document.cookie || ''
      }
    })()`)
  }

  async waitForLoginState(timeoutMs = 90000) {
    const start = Date.now()
    let lastState = null

    while (Date.now() - start < timeoutMs) {
      lastState = await this.getLoginState()
      if (lastState.accessToken && lastState.deviceId) return lastState
      await sleep(1500)
    }

    throw new Error(`浏览器尚未登录或未写入登录态。当前页面: ${lastState?.href || 'unknown'}`)
  }

  async installWebSocketBridge() {
    if (!this.page) throw new Error('浏览器桥未连接')

    const source = `(() => {
      if (globalThis.__MajsoulRawWsBridgeVersion === 2) return
      globalThis.__MajsoulRawWsBridgeInstalled = true
      globalThis.__MajsoulRawWsBridgeVersion = 2

      const NativeWebSocket = globalThis.WebSocket
      const sockets = []

      function bytesFromData(data, cb) {
        try {
          if (data instanceof ArrayBuffer) {
            cb(Array.from(new Uint8Array(data)))
          } else if (ArrayBuffer.isView(data)) {
            cb(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
          } else if (data instanceof Blob) {
            data.arrayBuffer().then(buf => cb(Array.from(new Uint8Array(buf)))).catch(() => {})
          }
        } catch (_) {}
      }

      function findGateway() {
        const open = sockets.filter(item => item.ws && item.ws.readyState === NativeWebSocket.OPEN)
        return open.find(item => String(item.url).includes('/gateway')) || open[open.length - 1] || null
      }

      function WrappedWebSocket(...args) {
        const ws = new NativeWebSocket(...args)
        const record = {
          id: sockets.length,
          url: String(args[0] || ''),
          ws,
          frames: [],
          createdAt: Date.now()
        }
        sockets.push(record)

        const nativeSend = ws.send.bind(ws)
        ws.send = function(data) {
          bytesFromData(data, bytes => {
            record.frames.push({ direction: 'out', time: Date.now(), data: bytes })
            if (record.frames.length > 500) record.frames.splice(0, record.frames.length - 500)
          })
          return nativeSend(data)
        }

        ws.addEventListener('message', event => {
          bytesFromData(event.data, bytes => {
            record.frames.push({ direction: 'in', time: Date.now(), data: bytes })
            if (record.frames.length > 500) record.frames.splice(0, record.frames.length - 500)
          })
        })
        return ws
      }

      Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket)
      WrappedWebSocket.prototype = NativeWebSocket.prototype
      globalThis.WebSocket = WrappedWebSocket

      globalThis.__MajsoulRawWsBridge = {
        list() {
          return sockets.map(item => ({
            id: item.id,
            url: item.url,
            readyState: item.ws ? item.ws.readyState : -1,
            bufferedAmount: item.ws ? item.ws.bufferedAmount : 0,
            frameCount: item.frames.length,
            createdAt: item.createdAt,
            bridgeVersion: globalThis.__MajsoulRawWsBridgeVersion || 0
          }))
        },
        clearGatewayFrames() {
          const gw = findGateway()
          if (!gw) return false
          gw.frames.splice(0, gw.frames.length)
          return true
        },
        drainGatewayFrames() {
          const gw = findGateway()
          if (!gw) return []
          const frames = gw.frames.splice(0, gw.frames.length)
          return frames
        },
        sendGateway(bytes) {
          const gw = findGateway()
          if (!gw) throw new Error('未捕获到打开状态的雀魂 gateway WebSocket')
          gw.ws.send(new Uint8Array(bytes))
          return { id: gw.id, url: gw.url }
        }
      }
    })()`

    await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source })
    await this.page.evaluate(source)
    return this.listWebSockets()
  }

  async listWebSockets() {
    if (!this.page) throw new Error('浏览器桥未连接')
    return await this.page.evaluate(`(() => {
      if (!globalThis.__MajsoulRawWsBridge) return []
      return globalThis.__MajsoulRawWsBridge.list()
    })()`)
  }

  async drainGatewayFramesSafe() {
    if (!this.page) throw new Error('浏览器桥未连接')
    try {
      return await this.page.evaluate(`(() => {
        if (!globalThis.__MajsoulRawWsBridge) return []
        return globalThis.__MajsoulRawWsBridge.drainGatewayFrames()
      })()`, 5000)
    } catch (err) {
      if (/navigated|closed|context|Cannot find context/i.test(err.message)) {
        await sleep(500)
        return []
      }
      throw err
    }
  }

  async ensureGatewaySocket(timeoutMs = 45000) {
    await this.installWebSocketBridge()

    const hasGateway = async () => {
      const sockets = await this.listWebSockets().catch(() => [])
      return sockets.find(item => item.readyState === 1 && String(item.url).includes('/gateway'))
    }

    let gateway = await hasGateway()
    if (gateway) return gateway

    await this.page.send('Page.reload', { ignoreCache: false })
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      gateway = await hasGateway()
      if (gateway) return gateway
      await sleep(1000)
    }

    const sockets = await this.listWebSockets().catch(() => [])
    throw new Error(`未捕获到 gateway WebSocket，请确认浏览器页面已加载雀魂。当前捕获: ${JSON.stringify(sockets)}`)
  }

  async rpcCall(methodName, payload) {
    if (!this.page) throw new Error('浏览器桥未连接')

    await this.ensureGatewaySocket()

    if (codec.index < 40000 || codec.index > 65000) {
      codec.index = 40000 + Math.floor(Math.random() * 20000)
    }

    const reqBuffer = codec.encodeRequest(methodName, payload)
    const idx = codec.index - 1
    const bytes = Array.from(reqBuffer)

    await this.page.evaluate(`globalThis.__MajsoulRawWsBridge.clearGatewayFrames()`)
    await this.page.evaluate(`globalThis.__MajsoulRawWsBridge.sendGateway(${JSON.stringify(bytes)})`)

    const start = Date.now()
    while (Date.now() - start < 30000) {
      const frames = await this.page.evaluate(`globalThis.__MajsoulRawWsBridge.drainGatewayFrames()`, 5000)
      for (const frame of frames || []) {
        try {
          const decoded = codec.decodeMessage(Buffer.from(frame.data))
          if (decoded.msgType === codec.RESPONSE && decoded.reqIndex === idx) {
            return decoded.payload
          }
        } catch {
          // Ignore page traffic for requests owned by the game client.
        }
      }
      await sleep(100)
    }

    throw new Error(`浏览器 WebSocket RPC 超时: ${methodName}`)
  }

  // 按完整牌谱 UUID 拉取对局记录（含 head + data）。
  // 浏览器内直连 WS 常因风控失败（code 1004），直接走官方页面流程更稳更快，且不再刷 WARN。
  async fetchFullRecord(paipuId) {
    const { logId } = parsePaipuId(paipuId)
    const state = await this.getLoginState()
    if (!state.accessToken) {
      throw new Error('浏览器桥未检测到登录态，请先使用 #雀魂登录 在浏览器中完成登录')
    }
    const logs = await this.fetchGameRecordByOfficialPage(paipuId, logId)
    if (logs?.error && logs.error.code) {
      throw new Error(`fetchGameRecord failed (code ${logs.error.code})`)
    }
    return logs
  }

  // 兼容旧调用：仅返回 head（含 4 名玩家真实 nickname / avatar_id / account_id）
  async fetchRecordHead(paipuId) {
    const logs = await this.fetchFullRecord(paipuId)
    return logs ? logs.head : null
  }

  async fetchGameRecordByOfficialPage(paipuId, logId, timeoutMs = 90000) {
    await this.installWebSocketBridge()
    await this.page.evaluate(`globalThis.__MajsoulRawWsBridge && globalThis.__MajsoulRawWsBridge.clearGatewayFrames()`)
    const paipuUrl = `https://game.maj-soul.com/1/?paipu=${encodeURIComponent(paipuId)}`
    await this.page.send('Page.navigate', { url: paipuUrl })

    const requests = new Map()
    const start = Date.now()
    let lastError = null

    while (Date.now() - start < timeoutMs) {
      const frames = await this.drainGatewayFramesSafe()

      for (const frame of frames || []) {
        try {
          if (frame.direction === 'out') {
            const requestInfo = decodeBrowserRequest(frame)
            if (requestInfo?.methodName === '.lq.Lobby.fetchGameRecord') {
              requests.set(requestInfo.reqIndex, requestInfo)
              if (typeof logger !== 'undefined') {
                logger.info(`[Majsoul-Plugin] 捕获官方 fetchGameRecord: req=${requestInfo.reqIndex}, uuid=${requestInfo.payload?.game_uuid}`)
              }
            }
          } else if (frame.direction === 'in') {
            for (const requestInfo of requests.values()) {
              const response = decodeBrowserResponse(frame, requestInfo)
              if (!response) continue
              if (response.error && response.error.code) {
                lastError = `官方页面 fetchGameRecord 返回 code ${response.error.code}`
                continue
              }
              if (requestInfo.payload?.game_uuid && requestInfo.payload.game_uuid !== logId) {
                continue
              }
              return response
            }
          }
        } catch (err) {
          lastError = err.message
        }
      }

      await sleep(200)
    }

    throw new Error(lastError || '等待官方页面 fetchGameRecord 响应超时')
  }

  async close() {
    try { await this.page?.close() } catch {}
    this.page = null
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close() } catch {}
    }
    // 彻底关闭 Chrome 进程，避免捕获头像/昵称后浏览器一直挂在后台
    if (this.chromeProcess) {
      try {
        if (process.platform === 'win32') {
          // 连子进程一起杀，否则 chrome 常驻
          spawn('taskkill', ['/pid', String(this.chromeProcess.pid), '/f', '/t'], { windowsHide: true })
        } else {
          this.chromeProcess.kill('SIGKILL')
        }
      } catch {}
      this.chromeProcess = null
    }
  }
}
