import fs from 'fs'
import path from 'path'
import net from 'net'
import { drawReviewInfoImg } from '../components/render.js'
import common from '../../../lib/common/common.js'
import { getProtocolClient } from '../utils/MajsoulProtocolClient.js'
import { reviewTenhouProtocol } from '../utils/MajsoulAiReview.js'
import { MajsoulPaipuParser } from '../utils/MajsoulPaipuParser.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

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

// 纯 exe（协议）模式：所有取谱均走本地 Majsoul.ProtocolLogin.exe。
// 浏览器桥（真实 Chrome）已彻底弃用，相关代码不再保留。
// 登录态由 exe 自身持有，Yunzai 侧不保存 token/密码（#雀魂登录 直接把账号密码交给 exe）。

// 通过协议客户端（exe）获取牌谱真实 head（含玩家昵称/头像/段位）。
// 返回：
//   { head }                —— 成功
//   { __fetchFailed:true }  —— exe 未运行/未登录/取谱失败，调用方据此提示
async function fetchRealHead(gameId) {
  const client = getProtocolClient()
  if (!client.isEnabled()) {
    return { __fetchFailed: true, error: 'majsoul-protocol 未启用（请配置 config/majsoul-protocol.json 的 enabled=true）' }
  }
  try {
    const head = await client.fetchRecordHead(gameId)
    if (head && head.head && Array.isArray(head.head.accounts) && head.head.accounts.length) {
      if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 协议取牌谱成功 paipu=${gameId}`)
      return head
    }
    if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] 协议取牌谱为空 paipu=${gameId}`)
  } catch (err) {
    if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] 协议取牌谱异常: ${err.message}`)
  }
  return { __fetchFailed: true, error: '本地 API 取谱失败（请确认本地 API 已启动并完成雀魂登录）' }
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

// 拉取真实玩家信息（含 head）：纯走 exe（协议）通道
// 返回值约定：
//   { head }                      —— 拉取成功
//   { __fetchFailed: true, ... }  —— exe 未运行/未登录/拉取失败，调用方提示用户先启动并登录 exe

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
        },
        {
          reg: '^#?(雀魂登录|雀魂login|majsoulLogin) (.+)$',
          fnc: 'loginCommand'
        }
      ]
    })
  }

  async reviewCommand(e) {
    const raw = e.msg.replace(/^#?(牌谱Review|牌谱review|Review|review) /, '').trim()
    if (!raw) return e.reply('❌ 请输入有效的牌谱URL!')

    // 纯协议取谱（对接本地 exe，不再走网页/浏览器桥）
    const paipuUrl = raw

    if (!paipuUrl.startsWith('http')) {
      return e.reply('❌ 请输入完整的牌谱URL!\n例如：https://game.maj-soul.com/1/?paipu=xxx')
    }

    // 提取牌谱 UUID，用于协议取谱
    let gameId = ''
    try {
      const parsedUrl = new URL(paipuUrl)
      gameId = parsedUrl.searchParams.get('paipu') || ''
    } catch (err) {
      gameId = paipuUrl
    }

    const client = getProtocolClient()
    if (!client.isEnabled()) {
      return e.reply('❌ 未启用本地取谱（config/majsoul-protocol.json 的 enabled 不为 true）。\n请先本地运行 Majsoul.ProtocolLogin.Api 对应平台程序（Windows 为 Majsoul.ProtocolLogin.Api-win-x64.exe，Linux 为 Majsoul.ProtocolLogin.Api-linux-x64）并在配置中开启 enabled。')
    }

    e.reply('⏳ 正在提交牌谱至 Mortal 进行 AI 分析，请稍候...')

    let full
    try {
      full = await client.fetchFullRecord(gameId)
    } catch (err) {
      // 取谱阶段失败（如本地 API 版本过期、上游拒绝、exe 未启动等），
      // 直接把底层提示回给用户，避免只打印裸 Error 到日志。
      return e.reply(`❌ 取谱失败：${err.message || err}`)
    }
    if (!full || !full.record) {
      // 区分「未登录」与「其他取谱失败」：未登录时本地 API 无 profile，
      // 牌谱分析依赖登录态取真实昵称/头像，必须先登录。
      let notLoggedIn = false
      try {
        const { ok, profiles } = await client.getExeProfiles()
        notLoggedIn = ok && (!profiles || profiles.length === 0)
      } catch { /* 忽略探测错误 */ }

      if (notLoggedIn) {
        return e.reply('⚠️ 当前未登录，无法进行牌谱分析。请先发送「#雀魂登录 <账号> <密码>」完成登录后再试。')
      }
      return e.reply('❌ 取谱失败（本地 API 未启动 / 取不到牌谱 / 解码失败）。\n请确认本地 API 程序（Majsoul.ProtocolLogin.Api-win-x64.exe / Majsoul.ProtocolLogin.Api-linux-x64）已在 127.0.0.1:5088 运行。')
    }

    // 真实昵称/头像由协议直接返回，无需再走网页或桥
    const realHead = (full.head && Array.isArray(full.head.accounts) && full.head.accounts.length)
      ? full.head
      : null

    // 渲染输出容器（name/avatarId/dan/rate），统一从此汇聚协议与本地缓存数据
    const mortalLog = { name: [], avatarId: [], dan: [], rate: [] }

    // 先用牌谱自身解析出权威的 昵称 / 头像 / 段位 / 段位分（按 seat 对齐），
    // 不依赖 homura 返回或登录态；后续 realHead、review.json 仅做兜底。
    try {
      const parsed = new MajsoulPaipuParser().handleGameRecord(full.record)
      if (parsed && Array.isArray(parsed.name)) {
        for (let i = 0; i < 4; i++) {
          const s = parsed.name[i]
          if (typeof s === 'string' && s) mortalLog.name[i] = s
          const av = parsed.avatarId?.[i]
          if (av) mortalLog.avatarId[i] = av
          if (typeof parsed.dan?.[i] === 'string' && parsed.dan[i]) mortalLog.dan[i] = parsed.dan[i]
          if (typeof parsed.rate?.[i] === 'number') mortalLog.rate[i] = parsed.rate[i]
        }
      }
    } catch (err) {
      if (typeof logger !== 'undefined') logger.warn('[MajsoulReview] 牌谱自身解析段位失败，将依赖兜底源：' + (err?.message || err))
    }
    if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 段位主源(牌谱自身解析): dan=${JSON.stringify(mortalLog.dan)} rate=${JSON.stringify(mortalLog.rate)}`)

    const res = await reviewTenhouProtocol(full.record, gameId, paipuUrl)
    if (typeof res === 'string') return e.reply(res)

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
        if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 座位${i} avatar_id=${a.avatar_id} nickname=${a.nickname || ''}`)
        // 昵称信任牌谱自身（parser/raw 或 review.json 的真实昵称），仅在缺失/占位（A/B/C/D 等）时桥兜底
        const cur = mortalLog.name[i]
        if (!cur || cur === '' || /^[A-D][さんn]?$/.test(cur)) {
          mortalLog.name[i] = a.nickname || cur
        }
      }
    }

    // 段位 / 段位分 / 昵称兜底：牌谱自身（parser）已作为主源填入；这里仅当主源缺失时才用 review.json 补。
    const paipuDir = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
    const reviewPath = path.resolve(`${paipuDir}/${gameId} - review.json`)
    if (fs.existsSync(reviewPath)) {
      try {
        const reviewJson = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
        const src = pickDanRateFromReport(reviewJson)
        if (src) {
          if (Array.isArray(src.dan)) {
            for (let i = 0; i < 4; i++) {
              if (!mortalLog.dan[i] && typeof src.dan[i] === 'string' && src.dan[i]) mortalLog.dan[i] = src.dan[i]
            }
          }
          if (Array.isArray(src.rate)) {
            for (let i = 0; i < 4; i++) {
              if (typeof mortalLog.rate[i] !== 'number' && typeof src.rate[i] === 'number') mortalLog.rate[i] = src.rate[i]
            }
          }
          if (Array.isArray(src.name) && src.name.length === 4) {
            for (let i = 0; i < 4; i++) {
              if (!mortalLog.name[i]) mortalLog.name[i] = src.name[i]
            }
          }
          if (typeof logger !== 'undefined') logger.info(`[MajsoulReview] 段位命中: dan=${JSON.stringify(mortalLog.dan)} rate=${JSON.stringify(mortalLog.rate)}`)
        } else if (typeof logger !== 'undefined') {
          // homura 返回的报告不含 dan/rate 属预期内（段位走牌谱自身解析主源），仅作 debug 提示
          logger.debug(`[MajsoulReview] review.json 中未找到 dan/rate 数据（已走牌谱自身解析主源，忽略）`)
        }
      } catch (e) {}
    }

    let msg = []
    // 东场检测提示：四人东（mode===1）使用 Mortal 模型时，质量可能不佳
    // （Mortal 本身适用四麻半庄，东场表现未经充分验证）
    try {
      const mode = full?.record?.head?.config?.mode?.mode
      const players = full?.record?.head?.result?.players || full?.record?.head?.players || []
      if (players.length === 4 && mode === 1) {
        msg.push('⚠️ 检测到本牌谱为四人东（东风战）。当前 AI 分析引擎固定为 Mortal，其训练数据以四麻半庄为主，东场表现未经充分验证，分析结果可能存在质量偏差，仅供参考。')
      }
    } catch (e) {}
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
      return e.reply('❌ 请输入有效的格式!\n例如：雀魂场况 <牌谱链接> <局数> [巡数]\n提示：局数、巡数均从 1 开始，巡数可省略（展示整局）')
    }

    let [paipuArg, kyokuArg, meguruArg] = args
    // 仅支持牌谱链接，自动提取 paipu 参数；不接受裸牌谱ID
    const m = paipuArg.match(/[?&]paipu=([^&\s]+)/)
    if (m) {
      paipuArg = m[1]
    } else {
      return e.reply('❌ 请输入完整的牌谱链接!\n例如：#雀魂场况 https://game.maj-soul.net/1/?paipu=xxx <局数> [巡数]')
    }
    let kyokuId = parseInt(kyokuArg) - 1  // 用户输入为 1-based，内部转 0-based 索引
    let meguruId = meguruArg ? parseInt(meguruArg) : 0  // 0 表示整局

    if (isNaN(kyokuId) || kyokuId < 0) {
      return e.reply('❌ 局数无效，请输入大于等于 1 的整数!')
    }

    // 场况查看依赖已落盘的 review.json（必须先 #牌谱Review 分析过该牌谱），
    // 昵称/头像优先用 review.json 缓存，已登录本地 API 则尝试拉取真实数据覆盖缓存（失败仅用缓存）。

    const paipuDir = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
    if (!fs.existsSync(paipuDir)) return e.reply('❌ 未找到已分析的牌谱!\n请先使用 [#牌谱Review <URL>] 分析该牌谱后再查看场况')

    let matchedId = null
    const files = fs.readdirSync(paipuDir)
    for (let file of files) {
      // 匹配 #牌谱Review 实际落盘的 review.json
      if (file.startsWith(paipuArg) && file.endsWith(' - review.json')) {
        matchedId = file.replace(' - review.json', '').trim()
        break
      }
    }

    if (!matchedId) return e.reply('❌ 未找到已分析的牌谱!\n请先使用 [#牌谱Review <URL>] 分析该牌谱后再查看场况')

    // 从 review.json 的 split_logs 重建绘图所需的昵称/段位/头像（下方按牌谱 UUID 拉取真实昵称/头像，覆盖占位名）
    const rj = JSON.parse(fs.readFileSync(path.resolve(`${paipuDir}/${matchedId} - review.json`), 'utf8'))
    const split0 = (rj.split_logs && rj.split_logs[0]) || {}
    const mortalLog = {
      name: split0.name || (rj.review && rj.review.name) || ['', '', '', ''],
      dan: split0.dan || (rj.review && rj.review.dan) || [],
      rate: split0.rate || (rj.review && rj.review.rate) || [],
      avatarId: split0.avatarId || (rj.review && rj.review.avatarId) || []
    }

    // 与 #牌谱Review 一致：尝试通过 exe（协议）按牌谱 UUID 拉取真实昵称/头像，覆盖 review.json 的占位名（A/B/C/Dさん）
    try {
      const logs = await fetchRealHead(matchedId)
      // 拉取失败（exe 未运行/未登录）：不报错，降级使用 review.json 缓存中的昵称/头像继续出图
      if (logs && logs.__fetchFailed) {
        if (typeof logger !== 'undefined') logger.warn(`[MajsoulReview] 场况拉取真实昵称失败，降级用缓存: ${logs.error}`)
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
  // 纯协议模式：账号密码直接交给本地 Majsoul.ProtocolLogin.Api 对应平台程序完成登录，
  // 登录态由 exe 自身持有，Yunzai 侧不保存 token/密码。
  // 需先启用 majsoul-protocol（enabled=true）且 exe 已在运行（或已开启 autoLaunch）。
  async loginCommand(e) {
    const m = e.msg.match(/^#?雀魂登录\s+(\S+)\s+(.+)$/)
    if (!m) return e.reply('❌ 格式：雀魂登录 账号 密码')
    const account = m[1]
    const password = m[2].trim()

    const client = getProtocolClient()
    if (!client || !client.isEnabled || !client.isEnabled()) {
      return e.reply('❌ majsoul-protocol 未启用：请先在 config/majsoul-protocol.json 中将 enabled 设为 true，并确保本地 API 已运行（或开启 autoLaunch）。')
    }

    await e.reply('⏳ 正在通过本地 API 发起雀魂登录（账号密码将发送给本地 API，由它完成登录并持有登录态）...')

    const res = await client.loginToExe(account, password, true)
    if (!res.ok) {
      return e.reply(`❌ 登录失败：${res.error || '未知错误'}\n请确认本地 API 已运行、账号密码正确。`)
    }

    let nick = ''
    try {
      const { ok, profiles } = await client.getExeProfiles()
      if (ok && Array.isArray(profiles) && profiles.length) {
        const loginId = res.data && (res.data.accountId || (res.data.account && res.data.account.accountId))
        const hit = loginId ? profiles.find(p => String(p.accountId) === String(loginId)) : null
        nick = (hit || profiles[0]).nickname || ''
      }
    } catch { /* 昵称获取失败不影响登录结果 */ }

    await e.reply(nick
      ? `✅ 雀魂登录成功（${nick}，登录态由本地 API 持有）！`
      : '✅ 雀魂登录成功（登录态由本地 API 持有）！')
  }
}