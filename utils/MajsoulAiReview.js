/**
 * 雀魂 AI 复盘（homura 的 majsoul.wget.es 线上 AI 分析引擎）
 *
 * 链路：雀魂原生 record（由外部 API 程序/浏览器桥取得） → MajsoulPaipuParser 转 tenhou
 *      → POST /review?type=Tenhou → 轮询 task → 落盘 ${gameId} - review.json
 *
 * 落盘路径与 reviewMortal 完全一致，渲染逻辑（MajsoulReview.js）零改动。
 *
 * 注意：本文件只负责「本地 API 取谱之后」的分析环节。取牌谱（雀魂登录 + fetchGameRecord）
 * 由外部二进制（当前 Windows 版为 Majsoul.ProtocolLogin.Api-win-x64.exe）完成，不在本文件内 —— 输入直接是雀魂原生 record。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { MajsoulPaipuParser } from './MajsoulPaipuParser.js'

// TRSS-Yunzai 框架注入的全局 logger
const logger = globalThis.logger || console

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REVIEW_API = 'https://majsoul.wget.es'
const REVIEW_PATH = path.join(__dirname, '../data/paipu')

// 可选：作者未来若提供 token，走 Bearer 头。当前 majsoul.wget.es 无 token 机制。
// 注意：此 token 仅用于 majsoul.wget.es，与 amae-koromo 牌谱屋 token 无关，切勿混用。
function getAuthHeaders () {
  const token = process.env.MAJSOUL_WGET_ES_TOKEN || ''
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authentication'] = `Bearer ${token}`
  return headers
}

// 简单休眠
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 主入口：分析一个雀魂牌谱的 record
 * @param {object} record 雀魂原生 record（lq.ResFetchGameRecord 结构）
 * @param {string} gameId 牌谱 ID（用于缓存文件名，如 260805-a7feef02-..._a64678917）
 * @param {string} [paipuUrl] 原始牌谱链接（仅用于错误提示展示）
 * @param {number} [playerId=0] 被分析玩家座号（0~3，整数），传给 AI 服务的 player_id（u8 类型）
 * @returns {Promise<object|string>} 成功返回 {data:{review,player_id}}；失败返回 ❌ 提示字符串
 */
export async function reviewTenhouProtocol (record, gameId, paipuUrl = '', playerId = 0) {
  const reviewPath = path.join(REVIEW_PATH, `${gameId} - review.json`)

  // 1. 三麻拦截（原生 record 玩家数判定）
  const players = record?.head?.result?.players || record?.head?.players || []
  if (players.length === 3) {
    return '❌ 该牌谱是三麻（三人麻将），当前 AI 分析引擎（Mortal）仅支持四麻，无法分析。请提供四麻牌谱。'
  }

  // 2. 本地缓存优先（与 reviewMortal 逻辑一致）
  if (fs.existsSync(reviewPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
      if (cached.review && cached.review.kyokus) {
        // 优先用调用方传入的 playerId（指定座位时刷新主视角），缓存里的 player_id 仅作兜底
        const pid = (Number.isInteger(playerId) && playerId >= 0 && playerId <= 3) ? playerId : (cached.player_id || 0)
        return { data: { review: cached.review, player_id: pid } }
      }
      // 三麻错误响应不缓存
      if (/not a four-player|three-player|三麻/i.test(JSON.stringify(cached))) {
        fs.rmSync(reviewPath, { force: true })
      } else {
        return cached
      }
    } catch (e) {
      logger.warn(`读取缓存失败，重新分析: ${e.message}`)
    }
  }

  // 3. record → tenhou 日志
  let tenhouLog
  try {
    const parser = new MajsoulPaipuParser()
    tenhouLog = parser.handleGameRecord(record)
  } catch (e) {
    logger.error(`牌谱转 tenhou 失败: ${e.message}`)
    return `❌ 牌谱解析失败: ${e.message}`
  }

  // 4. 提交分析（带 429 退避）
  const created = await submitReview(tenhouLog, gameId, playerId)
  if (typeof created === 'string') return created // 错误提示

  const { taskId, token } = created

  // 5. 轮询 task 状态
  const reportData = await pollTask(taskId, token)
  if (typeof reportData === 'string') return reportData // 错误提示

  // 6. 落盘（结构对齐 reviewMortal）
  // 主视角 seat 以调用方解析的 playerId 为准（来自牌谱链接后缀 accountId 匹配），
  // 不依赖 homura 是否回显 player_id，避免渲染主视角错回 seat0。
  const finalPlayerId = Number.isInteger(playerId) && playerId >= 0 && playerId <= 3 ? playerId : (reportData.player_id || 0)
  const saved = { ...reportData, player_id: finalPlayerId }
  // 同步写入 review.player_id，供渲染层 reviewData.player_id 取主视角（避免 actorId 回退 seat0）
  if (saved.review) saved.review.player_id = finalPlayerId
  if (!fs.existsSync(REVIEW_PATH)) fs.mkdirSync(REVIEW_PATH, { recursive: true })
  fs.writeFileSync(reviewPath, JSON.stringify(saved), 'utf8')
  logger.info(`已保存 AI 分析报告到: ${reviewPath} (player_id=${finalPlayerId})`)

  if (saved.review && saved.review.kyokus) {
    return { data: { review: saved.review, player_id: finalPlayerId } }
  }
  return saved
}

/**
 * 提交牌谱分析（CreateReview），含 429 退避重试
 */
async function submitReview (tenhouLog, gameId, playerId = 0) {
  // player_id 为被分析玩家座号（0~3 整数，u8 类型），绝不能是昵称字符串
  const seat = Number.isInteger(playerId) && playerId >= 0 && playerId <= 3 ? playerId : 0
  const payload = {
    type: 'Tenhou',
    player_id: seat,
    data: tenhouLog
  }

  const maxAttempts = 4
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`${REVIEW_API}/review?type=Tenhou`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      })

      if (res.status === 429) {
        const body = await safeJson(res)
        const wait = (body && body.retry_after_secs) || 120
        logger.warn(`提交分析遇 429，等待 ${wait}s 后重试 (${attempt + 1}/${maxAttempts})`)
        await sleep(wait * 1000)
        continue
      }

      if (!res.ok) {
        const txt = await res.text()
        logger.error(`提交分析失败 status=${res.status}: ${txt}`)
        if (/not a four-player|three-player|三麻/i.test(txt)) {
          return '❌ 该牌谱是三麻（三人麻将），当前 AI 分析引擎（Mortal）仅支持四麻，无法分析。请提供四麻牌谱。'
        }
        return `❌ 提交分析失败 (${res.status})，请稍后重试。`
      }

      const data = await res.json()
      if (!data.task_id) {
        logger.error(`提交分析响应缺少 task_id: ${JSON.stringify(data)}`)
        return '❌ 提交分析失败：服务端未返回任务 ID。'
      }
      return { taskId: data.task_id, token: data.token || '' }
    } catch (e) {
      logger.error(`提交分析异常: ${e.message}`)
      await sleep(3000)
    }
  }
  return '❌ 提交分析失败：多次限流，请稍后再试。'
}

/**
 * 轮询 task 完成状态
 */
async function pollTask (taskId, token) {
  const maxPolls = 60
  for (let i = 0; i < maxPolls; i++) {
    await sleep(5000)
    try {
      const url = `${REVIEW_API}/review?task=${encodeURIComponent(taskId)}`
      const res = await fetch(url, { headers: token ? { Authentication: `Bearer ${token}` } : {} })
      if (res.status === 429) {
        const body = await safeJson(res)
        const wait = (body && body.retry_after_secs) || 120
        logger.warn(`轮询遇 429，等待 ${wait}s`)
        await sleep(wait * 1000)
        continue
      }
      if (!res.ok) {
        const txt = await res.text()
        logger.error(`轮询失败 status=${res.status}: ${txt}`)
        if (/not a four-player|three-player|三麻/i.test(txt)) {
          return '❌ 该牌谱是三麻（三人麻将），当前 AI 分析引擎（Mortal）仅支持四麻，无法分析。请提供四麻牌谱。'
        }
        if (i > 10) return `❌ 获取报告失败 (${res.status})，请稍后重试。`
        continue
      }
      const data = await res.json()
      if (data.status === 'done' || data.review) {
        return data
      }
      if (data.status === 'failed' || data.error) {
        return `❌ 分析失败：${data.error || '未知错误'}`
      }
      logger.info(`轮询第 ${i + 1} 次，状态: ${data.status || 'pending'}`)
    } catch (e) {
      logger.error(`轮询异常: ${e.message}`)
    }
  }
  return '❌ 分析超时（超过 5 分钟未返回），请稍后重试。'
}

async function safeJson (res) {
  try { return await res.json() } catch { return null }
}
