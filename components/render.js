import { createCanvas } from '@napi-rs/canvas'
import { loadResImage, drawText, drawRoundRect } from './canvas.js'
import MajsoulApi from '../utils/MajsoulApi.js'
import { PlayerLevel, playerStatsZero, playerExtendZero } from '../utils/PlayerLevel.js'
import fs from 'fs'
import path from 'path'

const api = new MajsoulApi()

function getRandomPersonFull() {
  const dirPath = path.join(process.cwd(), 'plugins', 'Majsoul-Plugin', 'resources', 'person_full')
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.png'))
    if (files.length === 0) return null
    const randomIndex = Math.floor(Math.random() * files.length)
    return `person_full/${files[randomIndex]}`
  } catch (e) {
    console.error('[render] 读取person_full目录失败:', e)
    return null
  }
}

function getRate(value) {
  if (!value) return "0.00%"
  return `${(value * 100).toFixed(2)}%`
}

async function getLzBar(title, v1, v2, v3 = null) {
  if (v3 === null) v3 = 1 - v1 - v2
  const bar = await loadResImage(`info_texture/lz_${title}.png`)
  const canvas = createCanvas(bar.width, bar.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bar, 0, 0)
  
  const start = 102
  const y1 = 51, height = 30
  const x2 = start + Math.floor(770 * v1)
  const x3 = x2 + Math.floor(770 * v2) + 10
  const x4 = x3 + Math.floor(770 * v3) + 10

  const c1 = '#9d9dd4'
  const c2 = '#9dd4c0'
  const c3 = '#d49db9'

  drawRoundRect(ctx, start, y1, x2 - start, height, 5, c1)
  drawRoundRect(ctx, x2 + 10, y1, x3 - (x2 + 10), height, 5, c2)
  drawRoundRect(ctx, x3 + 10, y1, x4 - (x3 + 10), height, 5, c3)
  
  // 添加百分比标注
  ctx.font = 'bold 14px "Microsoft YaHei", sans-serif'
  ctx.fillStyle = '#ffffff'
  
  // 立直百分比 - 只有柱形足够宽时才显示
  const width1 = x2 - start
  if (v1 > 0 && width1 > 30) {
    const text1 = `${(v1 * 100).toFixed(1)}%`
    const text1Width = ctx.measureText(text1).width
    if (width1 > text1Width + 8) {
      ctx.fillText(text1, (start + x2) / 2 - text1Width / 2, y1 + 22)
    }
  }
  
  // 副露百分比 - 只有柱形足够宽时才显示
  const width2 = x3 - (x2 + 10)
  if (v2 > 0 && width2 > 30) {
    const text2 = `${(v2 * 100).toFixed(1)}%`
    const text2Width = ctx.measureText(text2).width
    if (width2 > text2Width + 8) {
      ctx.fillText(text2, (x2 + 10 + x3) / 2 - text2Width / 2, y1 + 22)
    }
  }
  
  // 默听百分比 - 只有柱形足够宽时才显示
  const width3 = x4 - (x3 + 10)
  if (v3 > 0 && width3 > 30) {
    const text3 = `${(v3 * 100).toFixed(1)}%`
    const text3Width = ctx.measureText(text3).width
    if (width3 > text3Width + 8) {
      ctx.fillText(text3, (x3 + 10 + x4) / 2 - text3Width / 2, y1 + 22)
    }
  }
  
  return canvas
}

async function getRankImg(majorRank, minorRank, mode = '4', size = 156) {
  const canvas = createCanvas(156, 156)
  const ctx = canvas.getContext('2d')
  
  try {
    const rankIcon = await loadResImage(`info_texture/${majorRank}_${mode}.png`)
    ctx.drawImage(rankIcon, 14, 7, 128, 128)
  } catch(e) {}
  
  if (majorRank !== '魂天') {
    const starFull = await loadResImage(`info_texture/star_full.png`)
    const starEmpty = await loadResImage(`info_texture/star_empty.png`)
    for (let i = 0; i < 3; i++) {
      const star = minorRank > i ? starFull : starEmpty
      ctx.drawImage(star, 26 + i * 38, 118, 32, 32)
    }
  }
  
  if (size !== 156) {
    const resized = createCanvas(size, size)
    const rctx = resized.getContext('2d')
    rctx.drawImage(canvas, 0, 0, size, size)
    return resized
  }
  return canvas
}

async function getRankIcon(level, stats, extended, mode = '4') {
  const rankbg = await loadResImage('info_texture/rank_bg.png')
  const canvas = createCanvas(rankbg.width, rankbg.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(rankbg, 0, 0)
  
  const rankIcon = await getRankImg(level.major_rank, level.minor_rank, mode, 156)
  ctx.drawImage(rankIcon, 51, 28)
  
  const avgRank = stats.avg_rank ? stats.avg_rank.toFixed(2) : "0.00"
  const firstRate = getRate(stats.rank_rates[0])
  const rongRate = getRate(extended["和牌率"])
  const chongRate = getRate(extended["放铳率"])
  
  drawText(ctx, level.full_tag, 296, 78, 44, '#FFFFFF', 'center', 'bold')
  drawText(ctx, level.real_display_score, 460, 78, 28, '#C1C1C1', 'center')
  
  drawText(ctx, String(stats.count), 282, 146, 36, '#FFFFFF', 'left', 'bold')
  drawText(ctx, avgRank, 458, 146, 36, '#FFFFFF', 'left', 'bold')
  
  drawText(ctx, firstRate, 155, 239, 32, '#FFFFFF', 'center', 'bold')
  drawText(ctx, rongRate, 300, 239, 32, '#FFFFFF', 'center', 'bold')
  drawText(ctx, chongRate, 445, 239, 32, '#FFFFFF', 'center', 'bold')
  
  return canvas
}

function parseRankFromText(rankText) {
  const rankMap = {
    '初心': 1, '雀士': 2, '雀杰': 3, '雀豪': 4, '雀圣': 5, '魂天': 6
  };
  
  let majorRank = 1;
  let minorRank = 1;
  
  for (const [name, value] of Object.entries(rankMap)) {
    if (rankText.includes(name)) {
      majorRank = value;
      break;
    }
  }
  
  const numMatch = rankText.match(/([一二三四五])$/);
  if (numMatch) {
    const numMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5 };
    minorRank = numMap[numMatch[1]] || 1;
  }
  
  return { majorRank, minorRank };
}

export async function drawMajsInfoImg(uid, mode = 'auto', realtimePT = null) {
  let data4, data3, extended4, extended3
  
  try {
    // 始终获取两个模式的数据，用于显示段位卡片
    // 使用 Promise.all 并行获取，提高效率
    [data4, data3, extended4, extended3] = await Promise.all([
      api.getPlayerStats(uid, 4).catch(e => {
        console.warn(`[render.js] 获取四麻基础数据失败: ${e.message}`)
        return JSON.parse(JSON.stringify(playerStatsZero))
      }),
      api.getPlayerStats(uid, 3).catch(e => {
        console.warn(`[render.js] 获取三麻基础数据失败: ${e.message}`)
        return JSON.parse(JSON.stringify(playerStatsZero))
      }),
      api.getPlayerExtendedStats(uid, 4).catch(e => {
        console.warn(`[render.js] 获取四麻扩展数据失败: ${e.message}`)
        return JSON.parse(JSON.stringify(playerExtendZero))
      }),
      api.getPlayerExtendedStats(uid, 3).catch(e => {
        console.warn(`[render.js] 获取三麻扩展数据失败: ${e.message}`)
        return JSON.parse(JSON.stringify(playerExtendZero))
      })
    ])
  } catch (e) {
    console.error(`[render.js] 获取玩家数据失败: ${e.message}`)
    return `获取玩家数据失败: ${e.message}\n可能原因：\n1. 网络连接问题\n2. UID不正确\n3. 玩家数据尚未同步到服务器`
  }

  if (!data4 || !data3 || !extended4 || !extended3) {
    return "不存在该ID的玩家数据...\n提示: 需要在金之间有一定数量的对局才能被正确记录！"
  }

  if (data4.retcode) data4 = JSON.parse(JSON.stringify(playerStatsZero))
  if (data3.retcode) data3 = JSON.parse(JSON.stringify(playerStatsZero))
  
  if (extended4.retcode) extended4 = JSON.parse(JSON.stringify(playerExtendZero))
  if (extended3.retcode) extended3 = JSON.parse(JSON.stringify(playerExtendZero))

  let _mode, data, extended, record
  if (mode === "3" || (mode === "auto" && data4.level?.score < data3.level?.score)) {
    _mode = "三麻战绩"
    data = data3
    extended = extended3
    try {
      record = await api.getRecentRecords(uid, 3, 16)
    } catch (e) {
      console.warn(`[render.js] 获取三麻最近对局失败: ${e.message}`)
      record = []
    }
  } else {
    _mode = "四麻战绩"
    data = data4
    extended = extended4
    try {
      record = await api.getRecentRecords(uid, 4, 16)
    } catch (e) {
      console.warn(`[render.js] 获取四麻最近对局失败: ${e.message}`)
      record = []
    }
  }

  for (let s in playerExtendZero) {
    if (extended[s] === undefined) extended[s] = playerExtendZero[s]
  }

  if (record.retcode) record = []

  let level4Score = data4.level?.score + data4.level?.delta || 0
  let level3Score = data3.level?.score + data3.level?.delta || 0

  if (realtimePT) {
    if (realtimePT.fourPlayer) {
      const rank4 = parseRankFromText(realtimePT.fourPlayer.rank);
      const level4Id = rank4.majorRank * 10000 + rank4.majorRank * 100 + rank4.minorRank;
      data4.level = { ...data4.level, id: level4Id };
      level4Score = realtimePT.fourPlayer.score;
    }
    if (realtimePT.threePlayer) {
      const rank3 = parseRankFromText(realtimePT.threePlayer.rank);
      const level3Id = rank3.majorRank * 10000 + rank3.majorRank * 100 + rank3.minorRank;
      data3.level = { ...data3.level, id: level3Id };
      level3Score = realtimePT.threePlayer.score;
    }
  }

  let level4 = new PlayerLevel(data4.level?.id || 10101, level4Score)
  let level3 = new PlayerLevel(data3.level?.id || 10101, level3Score)

  const bg = await loadResImage('utils_texture/bg.jpg')
  const detailBg = await loadResImage('info_texture/detail_bg.png')
  const mid = await loadResImage('info_texture/mid.png')
  const title = await loadResImage('info_texture/title.png')
  
  const canvas = createCanvas(bg.width, bg.height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(bg, 0, 0)
  ctx.drawImage(title, 0, 0)

  drawText(ctx, `${data.nickname} · UID ${uid}`, 504, 435, 30, '#FFFFFF', 'center', 'bold')

  const detailCanvas = createCanvas(detailBg.width, detailBg.height)
  const detailCtx = detailCanvas.getContext('2d')
  detailCtx.drawImage(detailBg, 0, 0)

  const zmRate = getRate(extended["自摸率"])
  const mtRate = getRate(extended["默听率"])
  const ljRate = getRate(extended["流局率"])
  const ltRate = getRate(extended["流听率"])
  const flRate = getRate(extended["副露率"])
  const lzRate = getRate(extended["立直率"])
  const hlNum = extended["和了巡数"]?.toFixed(2) || "0.00"
  const avgScore = String(extended["平均打点"] || 0)
  const avgChong = String(extended["平均铳点"] || 0)
  const bfRate = getRate(data["negative_rate"])
  const yfRate = getRate(extended["一发率"])
  const jddxl = String(extended["净打点效率"] || 0)

  const texts = [zmRate, mtRate, ljRate, ltRate, flRate, lzRate, hlNum, avgScore, avgChong, bfRate, yfRate, jddxl]
  texts.forEach((text, i) => {
    const x = 151 + 138 * (i % 6)
    const y = 65 + 86 * Math.floor(i / 6)
    drawText(detailCtx, text, x, y, 30, '#FFFFFF', 'center', 'bold')
  })
  
  // 生成三个进度条
  const allRong = extended["立直和了"] + extended["副露和了"] + extended["默听和了"]
  const lzRRate = allRong > 0 ? extended["立直和了"] / allRong : 0
  const flRRate = allRong > 0 ? extended["副露和了"] / allRong : 0
  const mtRRate = allRong > 0 ? extended["默听和了"] / allRong : 0

  const lzFRate = extended["放铳时立直率"]
  const flFRate = extended["放铳时副露率"]

  const allChong = extended["放铳至立直"] + extended["放铳至副露"] + extended["放铳至默听"]
  const lzCRate = allChong > 0 ? extended["放铳至立直"] / allChong : 0
  const flCRate = allChong > 0 ? extended["放铳至副露"] / allChong : 0
  const mtCRate = allChong > 0 ? extended["放铳至默听"] / allChong : 0

  const lzRong = await getLzBar("rong", lzRRate, flRRate, mtRRate)
  const lzChong = await getLzBar("chong", lzFRate, flFRate)
  const lzChongz = await getLzBar("chong_to", lzCRate, flCRate, mtCRate)

  detailCtx.drawImage(lzRong, 0, 238)
  detailCtx.drawImage(lzChong, 0, 328)
  detailCtx.drawImage(lzChongz, 0, 418)
  
  // 生成最近对局记录
  const recordBgPath = mode === "3" ? 'info_texture/record_bg_3.png' : 'info_texture/record_bg_4.png'
  const recordBg = await loadResImage(recordBgPath)
  const recordCanvas = createCanvas(recordBg.width, recordBg.height)
  const recordCtx = recordCanvas.getContext('2d')
  recordCtx.drawImage(recordBg, 0, 0)
  
  const RANK_POS_4P = { 4: 316, 3: 237, 2: 155, 1: 73 }
  const RANK_POS_3P = { 3: 316, 2: 199, 1: 73 }
  const RANK_POS = mode === "3" ? RANK_POS_3P : RANK_POS_4P
  let posPrev = null
  
  const revRecords = record.slice().reverse()
  
  // 如果没有对局数据，显示提示文字
  if (revRecords.length === 0) {
    drawText(recordCtx, "暂无对局数据", 500, 200, 36, '#888888', 'center', 'bold')
    drawText(recordCtx, "可能是网络问题或数据尚未同步", 500, 250, 28, '#666666', 'center')
  }
  
  for (let i = 0; i < revRecords.length; i++) {
    const r = revRecords[i]
    let ranks = []
    r.players.forEach(p => ranks.push({ nick: p.nickname, score: p.gradingScore || p.score }))
    ranks.sort((a, b) => b.score - a.score)
    let rankNum = ranks.findIndex(p => p.nick === data.nickname) + 1
    
    if (rankNum === 0) rankNum = mode === "3" ? 3 : 4
    
    const posY = RANK_POS[rankNum]
    const pos = { x: 108 + i * 50, y: posY }
    
    if (posPrev) {
      recordCtx.beginPath()
      recordCtx.moveTo(posPrev.x + 15, posPrev.y + 15)
      recordCtx.lineTo(pos.x + 15, pos.y + 15)
      recordCtx.strokeStyle = '#FFFFFF'
      recordCtx.lineWidth = 3
      recordCtx.stroke()
    }
    
    const rankDot = await loadResImage(`info_texture/rank_${rankNum}.png`)
    recordCtx.drawImage(rankDot, pos.x, pos.y)
    posPrev = pos
  }

  detailCtx.drawImage(recordCanvas, 0, 558)
  drawText(detailCtx, "最近对局记录走势", 500, 590, 34, '#FFFFFF', 'center', 'bold')

  // 拼接整体画面
  ctx.drawImage(detailCanvas, 0, 1188)
  ctx.drawImage(mid, 0, 1161)
  drawText(ctx, _mode, 500, 1161 + 40, 30, '#FFFFFF', 'center', 'bold')
  drawText(ctx, 'Majsoul-Plugin by 小橙c | Data: amae-koromo | Python-to-JS移植: QingFeng', 500, 2151 + 30, 24, '#FFFFFF', 'center', 'bold')

  const rank4Icon = await getRankIcon(level4, data4, extended4, "4")
  const rank3Icon = await getRankIcon(level3, data3, extended3, "3")

  const charBg = await loadResImage('info_texture/char_bg.png')
  const charFg = await loadResImage('info_texture/char_fg.png')
  const charCanvas = createCanvas(charBg.width, charBg.height)
  const charCtx = charCanvas.getContext('2d')
  charCtx.drawImage(charBg, 0, 0)
  try {
    const randomPerson = getRandomPersonFull()
    if (randomPerson) {
      const personImg = await loadResImage(randomPerson)
      const displayWidth = charBg.width - 38 * 2
      const displayHeight = charBg.height - 37 * 2
      const scale = Math.max(displayWidth / personImg.width, displayHeight / personImg.height)
      const scaledWidth = personImg.width * scale
      const scaledHeight = personImg.height * scale
      const sx = (personImg.width - displayWidth / scale) / 2
      const sy = (personImg.height - displayHeight / scale) / 2
      charCtx.drawImage(personImg, sx, sy, displayWidth / scale, displayHeight / scale, 38, 37, displayWidth, displayHeight)
    }
  } catch(e) {}
  charCtx.drawImage(charFg, 0, 0)
  
  ctx.drawImage(charCanvas, 34, 518)
  ctx.drawImage(rank4Icon, 357, 545)
  ctx.drawImage(rank3Icon, 357, 857)

  return canvas.toBuffer('image/jpeg', 85)
}