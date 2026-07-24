import fs from 'fs'
import path from 'path'
import net from 'net'
import { reviewMortal } from '../components/review.js'
import { drawReviewInfoImg } from '../components/render.js'
import common from '../../../lib/common/common.js'
import { MajsoulBrowserBridge } from '../utils/MajsoulBrowserBridge.js'
import { getMajsoulAccount, getMajsoulPassword, saveLoginResult } from '../utils/MajsoulLogin.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CHROME_PROFILE = path.resolve('./plugins/Majsoul-Plugin/data/chrome-profile')

// 是否已具备登录条件：已存在浏览器登录态（chrome-profile），或已配置账号密码可自动登录。
// 不满足则无法获取主视角真实昵称/头像，牌谱分析应被禁止。
function isLoginAvailable() {
  if (fs.existsSync(CHROME_PROFILE)) return true
  return !!(getMajsoulAccount() && getMajsoulPassword())
}

// 找一个当前空闲的端口，避免 connect() 复用已残留的 Chrome（否则 chromeProcess 为 null，close 无法杀掉）
function findFreePort(start = 9230) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(findFreePort(start + 1)))
    srv.listen(start, () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// 浏览器桥登录核心：用真实 Chrome 登录并持久化登录态到 data/chrome-profile。
// 会自动尝试填充账号密码表单并轮询等待（兼容手动登录/二次验证）。
// 返回登录态对象（含 accessToken/nickname/deviceId），失败返回 null。
async function runBrowserLogin(account, password) {
  const loginPort = await findFreePort()
  const bridge = new MajsoulBrowserBridge({ headless: false, userDataDir: CHROME_PROFILE, port: loginPort })
  try {
    await bridge.connect()
    let state = await bridge.getLoginState().catch(() => null)
    if (!state || !state.accessToken) {
      try {
        const fillScript = `(() => {
          function setNativeValue(el, value) {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
            setter.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
          try {
            const tabs = [...document.querySelectorAll('button,div[role=tab],.tab-item')]
            const accTab = tabs.find(b => /账号|account/i.test(b.textContent || ''))
            if (accTab) accTab.click()
          } catch (e) {}
          try {
            const acc = document.querySelector('input[type=text],input[name=phone],input[placeholder*=账号],input[placeholder*=手机]')
            const pwd = document.querySelector('input[type=password]')
            if (acc && pwd) {
              setNativeValue(acc, ${JSON.stringify(account)})
              setNativeValue(pwd, ${JSON.stringify(password)})
              const btn = [...document.querySelectorAll('button')].find(b => /登录|login|sign/i.test(b.textContent || ''))
              if (btn) btn.click()
              return true
            }
            return false
          } catch (e) { return false }
        })()`
        const filled = await bridge.page.evaluate(fillScript).catch(() => false)
        if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 浏览器自动填充登录表单: ${filled}`)
      } catch (err) {
        if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] 自动填充失败，等待手动登录: ${err.message}`)
      }
      const deadline = Date.now() + 150000
      while (Date.now() < deadline) {
        state = await bridge.getLoginState().catch(() => null)
        if (state && state.accessToken) break
        await sleep(1500)
      }
    }
    if (!state || !state.accessToken) {
      await bridge.close().catch(() => {})
      return null
    }
    saveLoginResult({
      token: state.accessToken,
      deviceId: state.deviceId,
      account: state.account || account,
      username: state.nickname,
      password,
      authMethod: 'browser'
    })
    await bridge.close().catch(() => {})
    return state
  } catch (err) {
    await bridge.close().catch(() => {})
    return null
  }
}

// 通过浏览器桥（真实 Chrome）获取真实玩家信息
async function fetchRealHeadViaBridge(gameId) {
  // 从未登录过（无浏览器配置目录）则直接跳过，避免每次 review 都启动 Chrome
  if (!fs.existsSync(CHROME_PROFILE)) return null
  const headPort = await findFreePort()
  const bridge = new MajsoulBrowserBridge({ headless: true, userDataDir: CHROME_PROFILE, port: headPort })
  try {
    await bridge.connect()
    let state = await bridge.getLoginState().catch(() => null)
    if (!state || !state.accessToken) {
      // 未登录：若已配置账号密码则自动弹出浏览器登录，否则静默跳过（段位/分数不依赖登录）
      const account = getMajsoulAccount()
      const password = getMajsoulPassword()
      if (account && password) {
        if (typeof logger !== 'undefined') logger.info('[MajsoulReview] 浏览器桥未登录，自动触发登录以填充真实昵称/头像')
        const loginState = await runBrowserLogin(account, password)
        if (!loginState) return null
        state = loginState
      } else {
        if (typeof logger !== 'undefined') logger.warn('[MajsoulReview] 浏览器桥未登录且无配置账号，使用占位昵称/头像（段位/分数来自牌谱JSON）')
        return null
      }
    }
    return await bridge.fetchFullRecord(gameId)
  } finally {
    await bridge.close().catch(() => {})
  }
}

// 从 mjai.ekyu.moe 的报告 JSON 中定位段位/段位分/昵称。
// 实际路径在 report.split_logs[0]（牌谱按段拆分的日志，每段含 4 名玩家的 dan/rate/name）。
function pickDanRateFromReport(report) {
  if (report && Array.isArray(report.split_logs) && report.split_logs[0]) {
    const s = report.split_logs[0]
    if (Array.isArray(s.dan) && s.dan.length === 4 && Array.isArray(s.rate) && s.rate.length === 4) {
      return s
    }
  }
  // 回退：递归查找第一个同时含 dan(长度4)/rate(长度4) 的对象
  let found = null
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (Array.isArray(o.dan) && o.dan.length === 4 && Array.isArray(o.rate) && o.rate.length === 4) { found = o; return }
    for (const k of Object.keys(o)) walk(o[k])
  }
  walk(report)
  return found
}

// 拉取真实玩家信息（含 head + data）：仅走浏览器桥
// 返回值约定：
//   null                          —— 未登录/无浏览器配置，属正常情况，调用方用占位名输出牌谱图
//   { __fetchFailed: true, ... }  —— 已登录但拉取超时/失败，调用方不应输出牌谱图（头像/昵称出不来）
//   { head, data }                —— 拉取成功
async function fetchRealHead(gameId) {
  try {
    return await fetchRealHeadViaBridge(gameId)
  } catch (err) {
    if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] 浏览器桥获取牌谱失败: ${err.message}`)
    return { __fetchFailed: true, error: err.message }
  }
}

export class MajsoulReview extends plugin {
  constructor() {
    super({
      name: '雀魂AI牌谱',
      dsc: '雀魂牌谱Review与场况',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#?(牌谱Review|牌谱review|Review|review) (.*)$',
          fnc: 'reviewCommand'
        },
        {
          reg: '^#?(雀魂场况|场况|牌谱详情) (.*)$',
          fnc: 'renderLog'
        }
      ]
    })
  }

  async fetchPaipuFromUrl(url) {
    const paipuDir = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
    
    let gameId = ''
    try {
      const parsedUrl = new URL(url)
      gameId = parsedUrl.searchParams.get('paipu') || ''
    } catch (err) {
      gameId = url
    }

    if (!gameId) return null

    const mortalLog = {
      ref: gameId,
      _originalUrl: url,
      head: { uuid: gameId },
      rule: {},
      name: ['', '', '', ''],
      dan: ['', '', '', ''],
      rate: [0, 0, 0, 0],
      sc: [0, 0, 0, 0, 0, 0, 0, 0],
      title: ['', ''],
      log: []
    }
    return mortalLog
  }

  async reviewCommand(e) {
    const paipuUrl = e.msg.replace(/^#?(牌谱Review|牌谱review|Review|review) /, '').trim()
    
    if (!paipuUrl) return e.reply('❌ 请输入有效的牌谱URL!')

    if (!paipuUrl.startsWith('http')) {
      return e.reply('❌ 请输入完整的牌谱URL!\n例如：https://game.maj-soul.com/1/?paipu=xxx')
    }

    // 未登录（无浏览器登录态且未配置账号密码）时无法获取主视角真实昵称/头像，禁止牌谱分析
    if (!isLoginAvailable()) {
      return e.reply('❌ 未登录雀魂，无法获取主视角昵称/头像，已禁止使用牌谱分析。\n请先登录：#雀魂登录 账号 密码')
    }

    e.reply('⏳ 正在提交牌谱至 Mortal 进行AI分析，请稍候...')

    const mortalLog = await this.fetchPaipuFromUrl(paipuUrl)
    if (!mortalLog) return e.reply('❌ 无法解析牌谱!')

    // 提取牌谱 UUID，用于登录态下按 UUID 拉取真实玩家信息（昵称/头像）
    let gameId = ''
    try {
      const parsedUrl = new URL(paipuUrl)
      gameId = parsedUrl.searchParams.get('paipu') || ''
    } catch (err) {
      gameId = paipuUrl
    }

    const engine = 'Mortal'
    const token = ''

    // 与 AI 分析并行：拉取雀魂真实玩家信息（昵称/头像），失败不影响主流程
    const headPromise = gameId ? fetchRealHead(gameId) : Promise.resolve(null)
    const res = await reviewMortal(mortalLog, token, engine)
    const logs = await headPromise
    if (typeof res === 'string') return e.reply(res)

    // 已登录但拉取真实玩家信息（昵称/头像）超时/失败：头像与昵称出不来，
    // 输出残缺牌谱图无意义，直接提示稍后重试，不输出牌谱图。
    if (logs && logs.__fetchFailed) {
      return e.reply('❌ 获取玩家昵称/头像超时（官方页面无响应），牌谱图暂不输出。\n请稍后重试：#牌谱Review <牌谱URL>')
    }

    const realHead = logs && logs.head
    if (realHead && Array.isArray(realHead.accounts) && realHead.accounts.length) {
      // 桥返回的 head.accounts 数组顺序可能与牌谱座位不对齐（实测上家被安到主视角），
      // 必须按 seat 字段对齐后再用，否则昵称/头像会串位。
      const bySeat = {}
      let seatOk = true
      for (const a of realHead.accounts) {
        const s = typeof a.seat === 'number' ? a.seat
          : (typeof a.seat === 'string' ? parseInt(a.seat, 10) : NaN)
        if (!Number.isInteger(s) || s < 0 || s > 3) { seatOk = false; break }
        bySeat[s] = a
      }
      const list = seatOk ? bySeat : realHead.accounts
      for (let i = 0; i < 4; i++) {
        const a = list[i]
        if (!a) continue
        // avatarId 优先用牌谱自身（parser 已按 seat 对齐）；桥仅兜底缺失座位
        if (!Array.isArray(mortalLog.avatarId)) mortalLog.avatarId = []
        if (!mortalLog.avatarId[i]) mortalLog.avatarId[i] = a.avatar_id
        // 昵称信任牌谱自身（parser/raw 或 review.json 的真实昵称），仅在缺失/占位（A/B/C/D 等）时桥兜底
        const cur = mortalLog.name[i]
        if (!cur || cur === '' || /^[A-D][さんn]?$/.test(cur)) {
          mortalLog.name[i] = a.nickname || cur
        }
      }
    }

    // 段位 / 段位分 / 昵称来自网页端解析并保存的牌谱 JSON（review.json）+ raw 牌谱（parser 解析的真实昵称）。
    // 这是牌谱自身的真实数据，不依赖登录态；昵称优先级最高（桥仅在上一步兜底了缺失/占位名）。
    const paipuDir = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
    const reviewPath = path.resolve(`${paipuDir}/${gameId} - review.json`)
    if (fs.existsSync(reviewPath)) {
      try {
        const reviewJson = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
        const src = pickDanRateFromReport(reviewJson)
        if (src) {
          if (Array.isArray(src.dan) && src.dan.length === 4) mortalLog.dan = src.dan
          if (Array.isArray(src.rate) && src.rate.length === 4) mortalLog.rate = src.rate
          if (Array.isArray(src.name) && src.name.length === 4) {
            for (let i = 0; i < 4; i++) {
              if (!mortalLog.name[i]) mortalLog.name[i] = src.name[i]
            }
          }
          if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 段位命中: dan=${JSON.stringify(mortalLog.dan)} rate=${JSON.stringify(mortalLog.rate)}`)
        } else if (typeof logger !== 'undefined') {
          logger.warn(`[MajsoulReview] review.json 中未找到 dan/rate 数据`)
        }
      } catch (e) {}
    }

    let msg = []
    if (res.data && res.data.review && res.data.review.kyokus) {
      for (let i = 0; i < res.data.review.kyokus.length; i++) {
        const imgBuffer = await drawReviewInfoImg(mortalLog, res, i)
        if (typeof imgBuffer === 'string') {
          msg.push(imgBuffer)
        } else {
          msg.push(segment.image(imgBuffer))
        }
      }
    } else if (res.kyokus) {
      const adaptRes = {
        data: {
          review: res,
          player_id: res.player_id || 0
        }
      }
      for (let i = 0; i < res.kyokus.length; i++) {
        const imgBuffer = await drawReviewInfoImg(mortalLog, adaptRes, i)
        if (typeof imgBuffer === 'string') {
          msg.push(imgBuffer)
        } else {
          msg.push(segment.image(imgBuffer))
        }
      }
    }
    
    if (msg.length === 0) {
      return e.reply('❌ 未生成任何分析图片!')
    }
    
    // 显式构造转发节点，使用 BOT 的 user_id（决定昵称与头像）避免匿名转发。
    // adapter 的 makeForwardMsg 接收 {message, user_id, nickname} 数组，返回单个 node 对象（data 为节点数组），
    // 直接交给 e.reply 即可（与 common.makeForwardMsg 返回结构一致，无需再包一层）。
    const fwdUid = (e.bot && e.bot.uin) || e.self_id || e.user_id || 0
    const fwdName = (e.bot && (e.bot.nickname || (e.bot.info && e.bot.info.nickname))) || String(fwdUid)
    const forwardMsg = msg.map(m => ({ message: m, user_id: fwdUid, nickname: fwdName }))
    const target = e.group || e.friend
    const forwardNode = target ? await target.makeForwardMsg(forwardMsg) : await common.makeForwardMsg(e, msg)
    await e.reply(forwardNode)
  }

  async renderLog(e) {
    let et = e.msg.replace(/^#?(雀魂场况|场况|牌谱详情) /, '').trim().replace(/，/g, ',').replace(/,/g, ' ')
    let args = et.split(' ').filter(Boolean)
    if (args.length < 2 || args.length > 3) {
      return e.reply('❌ 请输入有效的格式!\n例如：雀魂场况 <牌谱链接或ID> <局数> [巡数]\n提示：局数、巡数均从 1 开始，巡数可省略（展示整局）')
    }

    let [paipuArg, kyokuArg, meguruArg] = args
    // 支持直接粘贴牌谱链接（自动提取 paipu 参数），无需记忆长串牌谱ID
    const m = paipuArg.match(/[?&]paipu=([^&\s]+)/)
    if (m) paipuArg = m[1]
    let kyokuId = parseInt(kyokuArg) - 1  // 用户输入为 1-based，内部转 0-based 索引
    let meguruId = meguruArg ? parseInt(meguruArg) : 0  // 0 表示整局

    if (isNaN(kyokuId) || kyokuId < 0) {
      return e.reply('❌ 局数无效，请输入大于等于 1 的整数!')
    }

    // 牌谱分析（含场况查看）需先登录雀魂，以获取真实昵称/头像，与 #牌谱Review 保持一致
    if (!isLoginAvailable()) {
      return e.reply('❌ 未登录雀魂，无法获取真实昵称/头像，已禁止使用牌谱场况。\n请先登录：#雀魂登录 账号 密码')
    }

    const paipuDir = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
    if (!fs.existsSync(paipuDir)) return e.reply('❌ 未找到有效牌谱!\n请先使用[牌谱Review <URL>]')

    let matchedId = null
    const files = fs.readdirSync(paipuDir)
    for (let file of files) {
      // 匹配 #牌谱Review 实际落盘的 review.json
      if (file.startsWith(paipuArg) && file.endsWith(' - review.json')) {
        matchedId = file.replace(' - review.json', '').trim()
        break
      }
    }

    if (!matchedId) return e.reply('❌ 未找到有效牌谱!\n请先使用[牌谱Review <URL>]')

    // 从 review.json 的 split_logs 重建绘图所需的昵称/段位/头像（下方登录态下再用浏览器桥拉真实数据覆盖占位名）
    const rj = JSON.parse(fs.readFileSync(path.resolve(`${paipuDir}/${matchedId} - review.json`), 'utf8'))
    const split0 = (rj.split_logs && rj.split_logs[0]) || {}
    const mortalLog = {
      name: split0.name || (rj.review && rj.review.name) || ['', '', '', ''],
      dan: split0.dan || (rj.review && rj.review.dan) || [],
      rate: split0.rate || (rj.review && rj.review.rate) || [],
      avatarId: split0.avatarId || (rj.review && rj.review.avatarId) || []
    }

    // 与 #牌谱Review 一致：登录态下按牌谱 UUID 拉取真实昵称/头像，覆盖 review.json 的占位名（A/B/C/Dさん）
    try {
      const logs = isLoginAvailable() ? await fetchRealHead(matchedId) : null
      // 已登录但拉取超时/失败：昵称/头像出不来，不输出残缺场况图，提示稍后重试
      if (logs && logs.__fetchFailed) {
        return e.reply('❌ 获取玩家昵称/头像超时（官方页面无响应），场况图暂不输出。\n请稍后重试：#雀魂场况 <牌谱ID> <局数> <巡数>')
      }
      const realHead = logs && logs.head
      if (realHead && Array.isArray(realHead.accounts) && realHead.accounts.length) {
        // 桥返回的 head.accounts 数组顺序可能与牌谱座位不对齐（实测上家被安到主视角），
        // 必须按 seat 字段对齐后再用，否则昵称/头像会串位。
        const bySeat = {}
        let seatOk = true
        for (const a of realHead.accounts) {
          const s = typeof a.seat === 'number' ? a.seat
            : (typeof a.seat === 'string' ? parseInt(a.seat, 10) : NaN)
          if (!Number.isInteger(s) || s < 0 || s > 3) { seatOk = false; break }
          bySeat[s] = a
        }
        const list = seatOk ? bySeat : realHead.accounts
        for (let i = 0; i < 4; i++) {
          const a = list[i]
          if (!a) continue
          if (!Array.isArray(mortalLog.avatarId)) mortalLog.avatarId = []
          if (!mortalLog.avatarId[i]) mortalLog.avatarId[i] = a.avatar_id
          const cur = mortalLog.name[i]
          if (!cur || cur === '' || /^[A-D](?:さん|n)?$/.test(cur)) {
            mortalLog.name[i] = a.nickname || cur
          }
        }
      }
    } catch (err) {
      if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] #场况 获取真实昵称/头像失败: ${err.message}`)
    }

    const reviewPath = path.resolve(`${paipuDir}/${matchedId} - review.json`)
    if (!fs.existsSync(reviewPath)) {
      return e.reply('❌ 该对局尚未经过AI打分! 请先使用[牌谱Review <URL>]生成打分。')
    }

    const res = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
    const adaptRes = { data: { review: res.review, player_id: res.player_id } }
    if (kyokuId >= (adaptRes.data.review.kyokus || []).length) {
      return e.reply(`❌ 局数超出范围! 该牌谱共 ${(adaptRes.data.review.kyokus || []).length} 局（从 1 开始编号）`)
    }
    const imgBuffer = await drawReviewInfoImg(mortalLog, adaptRes, kyokuId, meguruId)
    
    if (typeof imgBuffer === 'string') return e.reply(imgBuffer)
    e.reply(segment.image(imgBuffer))
  }

  // 雀魂登录：#雀魂登录 账号 密码
  // 用浏览器桥（真实 Chrome）登录；
  // 登录态持久化在浏览器配置 data/chrome-profile 中，token 也会存入 data/login.json（供浏览器桥复用）。
  // 注意：出于自动续期需要，密码会以明文存入 data/login.json，请妥善保管该文件权限。
  async loginCommand(e) {
    const m = e.msg.match(/^#?雀魂登录\s+(\S+)\s+(.+)$/)
    if (!m) return e.reply('❌ 格式：雀魂登录 账号 密码')
    const account = m[1]
    const password = m[2].trim()

    await e.reply('⏳ 正在启动浏览器桥并登录雀魂（若自动登录失败，请在弹出的浏览器窗口中手动登录）...')

    const state = await runBrowserLogin(account, password)
    if (!state) {
      return e.reply('❌ 登录失败或超时：请确认账号密码，或手动在弹出的浏览器窗口中完成雀魂登录。登录态会保存在浏览器配置中，下次无需重复。')
    }
    await e.reply(
      `✅ 雀魂登录成功（浏览器桥）！\n` +
      `昵称：${state.nickname || '(见牌谱)'}\n` +
      `登录态已保存在浏览器配置（data/chrome-profile）中，token 失效时会自动通过浏览器桥获取真实昵称/头像。\n` +
      `⚠️ data/login.json 含明文密码，请注意文件权限安全。`
    )
  }
}