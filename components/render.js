import { createCanvas, loadImage } from '@napi-rs/canvas'
import { loadResImage, drawText, drawRoundRect, applyMask } from './canvas.js'
import MajsoulApi from '../utils/MajsoulApi.js'
import { PlayerLevel, playerStatsZero, playerExtendZero } from '../utils/PlayerLevel.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ---- 头像渲染（移植自 MajsoulUID-plugin）：avatar_id → lqc.json 路径 → CDN 下载 bighead.png ----
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
const avatarCacheRoot = path.join(pluginRoot, 'data', 'charactor')
let avatarConfigCache = null

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function loadAvatarConfig() {
  if (avatarConfigCache) return avatarConfigCache
  const lqcPaths = [
    path.join(pluginRoot, 'data', 'lqc.json'), // 优先使用自动更新生成的（与 liqi 对称）
    path.join(pluginRoot, 'config', 'lqc.json') // 静态兜底
  ]
  for (const lqcPath of lqcPaths) {
    const lqc = readJsonIfExists(lqcPath)
    if (!lqc) continue
    const extendRes = readJsonIfExists(path.join(path.dirname(lqcPath), 'extendRes.json')) || {}
    avatarConfigCache = { lqc, extendRes }
    return avatarConfigCache
  }
  avatarConfigCache = { lqc: {}, extendRes: {} }
  return avatarConfigCache
}

function isSupportedImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return true
  return false
}

function xorMajsoulImageBuffer(buffer) {
  const decoded = Buffer.alloc(buffer.length)
  for (let i = 0; i < buffer.length; i++) decoded[i] = buffer[i] ^ 73
  return decoded
}

function normalizeMajsoulImageBuffer(buffer) {
  if (isSupportedImageBuffer(buffer)) return buffer
  const decoded = xorMajsoulImageBuffer(buffer)
  return isSupportedImageBuffer(decoded) ? decoded : buffer
}

async function fetchImageToFile(url, filePath) {
  const fetchImpl = globalThis.fetch || (await import('node-fetch')).default
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = normalizeMajsoulImageBuffer(Buffer.from(await res.arrayBuffer()))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buffer)
}

// 角色头像资源在 CDN 上的真实 key 带语言前缀（lang/base/、jp/、cn/ 等），且前缀随版本变化，
// 不能写死。这里用后缀匹配自动带上 locale 前缀并返回真实前缀，避免 404 / 旧前缀。
function findKeyBySuffix(source, suffix) {
  if (!source) return null
  if (source[suffix]) return suffix
  const normalized = suffix.replace(/\\/g, '/')
  return Object.keys(source).find(k => k === normalized || k.endsWith(`/${normalized}`)) || null
}

let resversionCache = null
async function getResversionManifest() {
  if (resversionCache) return resversionCache
  try {
    const fetchImpl = globalThis.fetch || (await import('node-fetch')).default
    const vRes = await fetchImpl(`https://game.maj-soul.com/1/version.json?randv=${Math.random()}`)
    if (!vRes.ok) throw new Error(`HTTP ${vRes.status}`)
    const { version } = await vRes.json()
    const rvRes = await fetchImpl(`https://game.maj-soul.com/1/resversion${version}.json`)
    if (!rvRes.ok) throw new Error(`HTTP ${rvRes.status}`)
    const rv = await rvRes.json()
    resversionCache = rv.res || rv
    return resversionCache
  } catch (e) {
    if (typeof logger !== 'undefined') logger.warn(`[render.js] 获取 resversion 清单失败: ${e.message}`)
    return null
  }
}

const avatarAssetCache = new Map()

// 占位头像：从 resources/person 随机抽取（按座位固定，保证同一座位始终同一张）
const personDir = path.join(pluginRoot, 'resources', 'person')
let personFilesCache = null
function getPersonFiles() {
  if (!personFilesCache) {
    try {
      personFilesCache = fs.readdirSync(personDir).filter(f => /\.(png|jpe?g)$/i.test(f))
    } catch {
      personFilesCache = []
    }
  }
  return personFilesCache
}

async function getPlaceholderAvatar(seat) {
  const files = getPersonFiles()
  if (!files.length) return null
  // 用座位号做稳定索引（取模），同座位恒为同一张，避免每次出图头像乱跳
  const idx = ((Number(seat) || 0) % files.length + files.length) % files.length
  try {
    return await loadResImage(`person/${files[idx]}`)
  } catch (err) {
    if (typeof logger !== 'undefined') logger.warn(`[render.js] 占位头像加载失败 ${files[idx]}: ${err.message}`)
    return null
  }
}

async function resolveAvatarAsset(infoPath, extendRes) {
  const suffix = `${infoPath}/bighead.png` // 形如 extendRes/charactor/jinwu/bighead.png
  if (avatarAssetCache.has(suffix)) return avatarAssetCache.get(suffix)
  let result
  // 1) 本地 extendRes.json（可能带 lang/base/ 等前缀，值即前缀字符串）
  const localKey = findKeyBySuffix(extendRes, suffix)
  if (localKey) {
    result = { assetPath: localKey, prefix: extendRes[localKey] }
  } else {
    // 2) 线上 resversion 清单（权威，按后缀匹配，含正确 locale 前缀与版本前缀）
    let rvKey = null
    let rvPrefix = null
    try {
      const rv = await getResversionManifest()
      rvKey = findKeyBySuffix(rv, suffix)
      if (rvKey && rv[rvKey] && rv[rvKey].prefix) rvPrefix = rv[rvKey].prefix
    } catch (e) {}
    if (rvKey && rvPrefix) {
      result = { assetPath: rvKey, prefix: rvPrefix }
    } else {
      // 3) 兜底：假定 jp/ 前缀（多数情况），前缀回退 v0.11.14.w
      result = { assetPath: `jp/${suffix}`, prefix: 'v0.11.14.w' }
    }
  }
  avatarAssetCache.set(suffix, result)
  return result
}

async function loadImageFromCache(filePath) {
  const original = fs.readFileSync(filePath)
  const normalized = normalizeMajsoulImageBuffer(original)
  if (normalized !== original) fs.writeFileSync(filePath, normalized)
  return loadImage(normalized)
}

async function loadAvatarImage(avatarId) {
  const { lqc, extendRes } = loadAvatarConfig()
  const avatarInfo = lqc[String(avatarId)]
  if (!avatarInfo) {
    if (typeof logger !== 'undefined') logger.warn(`[render.js] avatar_id=${avatarId} 不在 lqc.json 中，无法获取角色路径，回退默认头像`)
  }
  const info = avatarInfo || lqc['400000']
  if (!info?.path) return null

  const charDirName = path.basename(info.path)
  const localPath = path.join(avatarCacheRoot, charDirName, 'bighead.png')
  if (fs.existsSync(localPath)) {
    try {
      return await loadImageFromCache(localPath)
    } catch (err) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 本地头像缓存不可用 ${avatarId}: ${err.message}`)
    }
  }

  // 解析真实资源路径（含 locale 前缀）与版本前缀，避免写死导致 404
  const { assetPath, prefix } = await resolveAvatarAsset(info.path, extendRes)
  const url = `https://game.maj-soul.com/1/${prefix}/${assetPath}`

  try {
    await fetchImageToFile(url, localPath)
    return await loadImageFromCache(localPath)
  } catch (err) {
    if (typeof logger !== 'undefined') logger.warn(`[render.js] 头像加载失败 ${avatarId}: ${url} -> ${err.message}`)
    return null
  }
}

// 将 @napi-rs/canvas Image 转成 Canvas（便于 applyMask 抠图）
async function getAvatarCanvas(avatarId) {
  const img = await loadAvatarImage(avatarId)
  if (!img) return null
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return c
}

// 牌谱分析渲染相关函数
const typeMap = {
  dahai: "打", ankan: "暗杠", tsumo: "自摸", ron: "荣和",
  reach: "立直", ronpinfu: "荣和", daburi: "切", hora: "和", none: "跳过",
  chi: "吃", pon: "碰", kan: "杠", kakan: "加杠"
}

// 牌名显示映射：雀魂内部记法 -> 日麻标准记法
// 红宝牌 5mr/5pr/5sr -> 0m/0p/0s；字牌 E/S/W/N/P/F/C -> 1z~7z
function formatTileName(tile) {
  if (!tile) return tile
  const map = {
    '5mr': '0m', '5pr': '0p', '5sr': '0s',
    'E': '1z', 'S': '2z', 'W': '3z', 'N': '4z', 'P': '5z', 'F': '6z', 'C': '7z'
  }
  return map[tile] || tile
}

// 同花色牌连写时省略重复后缀，仅保留最后一个后缀（日麻标准记法：11z / 00p / 234m）
function formatTileGroup(tiles) {
  if (!Array.isArray(tiles) || tiles.length === 0) return ""
  const groups = {}
  for (const t of tiles.map(formatTileName)) {
    const suit = t.slice(-1)
    const num = t.slice(0, -1)
    if (!groups[suit]) groups[suit] = []
    groups[suit].push(num)
  }
  return Object.keys(groups).map(suit => groups[suit].join('') + suit).join('')
}

const targetMap = { 1: "上家", 2: "对家", 3: "下家" }

function getDiff(a, b) {
  if (a < 0 || b < 0 || a === undefined || b === undefined) return "未知"
  if (a === b) return "自己"
  let diff = 0
  while (a !== b && diff < 4) {
    a = (a - 1 + 4) % 4
    diff++
  }
  return targetMap[diff] || "未知"
}

// 加杠(kakan) 中两张横置牌（原碰“来自对手的那张”=claimed，加杠新增的那张=added）
// 在 pais 数组里的下标。
// 约定（待真实牌谱校准）：解析器产出 pais = [加杠新增牌(fuuro.pai), ...原碰3张(fuuro.consumed)]，
// 原碰“来自对手的那张”位于 consumed 子组中由 rotate 决定的位置（与 pon 一致）。
// 若实际牌谱里 pais 顺序不同，只需在此处调整 addedIdx/claimedIdx 的映射即可。
function kakanIndices(fuuro, pais, rotate) {
  const addedIdx = fuuro.pai ? 0 : -1
  const consumedBase = fuuro.pai ? 1 : 0
  const rotInGroup = rotate === 3 ? 2 : rotate === 1 ? 0 : rotate === 2 ? 1 : 0
  const claimedIdx = consumedBase + rotInGroup
  return { addedIdx, claimedIdx }
}

function getColor(rate) {
  if (rate <= 0.65) return '#FF0000'
  if (rate <= 0.75) return '#FFA100'
  if (rate >= 0.86) return '#4AFF00'
  return '#FFFFFF'
}

function kyokuToString(kyoku) {
  const rounds = ["东", "南", "西", "北"]
  const wind = Math.floor(kyoku / 4)
  const number = (kyoku % 4) + 1
  return `${rounds[wind]}${number}局`
}

async function drawEnBg(en, index, _actorId) {
  const tehai = en.state.tehai || []
  const fuuros = en.state.fuuros || []
  const ai = en.expected
  const actual = en.actual
  const nowPai = en.tile
  const lastActor = en.last_actor
  const isEqual = en.is_equal

  const actorId = actual.actor !== undefined ? actual.actor : _actorId

  const actualType = actual.type
  const aiType = ai.type

  // 立直(actual 无 pai)时，从 details 里同 actor 的 dahai 推导真正的立直打牌
  function getReachDiscardPai(act, actor) {
    if (act && act.pai) return act.pai
    for (const det of (en.details || [])) {
      const a = det && det.action
      if (a && a.type === 'dahai' && a.actor === actor && a.pai) return a.pai
    }
    return null
  }
  const reachPai = actualType === 'reach' ? getReachDiscardPai(actual, actorId) : null
  const aiReachPai = aiType === 'reach' ? getReachDiscardPai(ai, actorId) : null
  // dahai 用 actual.pai；reach 用推导出的立直打牌
  const discardPai = actualType === 'reach' ? reachPai : (actual.pai || null)
  const aiDiscardPai = aiType === 'reach' ? aiReachPai : (ai.pai || null)
  // 摸切：打出的牌 == 刚摸到的牌（tsumogiri 或 立直打牌==摸牌）
  const isTsumogiri = actualType === 'dahai'
    ? (actual.tsumogiri === true)
    : (actualType === 'reach' ? (discardPai === nowPai) : false)
  const isTsumogiriAi = aiType === 'dahai'
    ? (ai.tsumogiri === true)
    : (aiType === 'reach' ? (aiDiscardPai === nowPai) : false)

function getActionText(action) {
  if (!action || !action.type) return '未知'
  // 自摸（target 指向自己）显示“自摸”以区分；荣和仍显示“和”
  if (action.type === "hora") {
    if (typeof action.target === 'number' && action.actor === action.target) return "自摸"
    return "和"
  }
  return typeMap[action.type] || '未知'
}

  function formatAction(action, fallbackPai) {
    if (!action) return ""
    const consumed = action.consumed && action.consumed.length ? formatTileGroup(action.consumed) : ""
    if (consumed) {
      return `${formatTileName(action.pai || "")}(${consumed})`
    }
    return formatTileName(action.pai || fallbackPai || "")
  }

  const aiDehai = formatAction(ai, aiDiscardPai)
  const actualDehai = formatAction(actual, discardPai)

  const aiStr = `AI选择: ${getActionText(ai)} ${aiDehai}`
  const actualStr = `你选择: ${getActionText(actual)} ${actualDehai}`
  const condStr = `${aiStr}  |  ${actualStr}`

  let frameName = ''
  let frameStr = ''

  // 是否“摸到牌”的回合（摸牌后打牌/立直/暗杠）。
  // 判定依据：摸到的牌在手里(en.tile ∈ tehai)，或摸切(tsumogiri)为真。
  // 碰/吃后的打牌属于“不摸牌”回合：en.tile 是别人打出的牌（不在手里），
  // 且此时 at_self_chi_pon 为真，需排除，避免把别人的牌误判成自己摸到。
  let isSelfDraw = false
  if (actualType === 'dahai' || actualType === 'reach') {
    isSelfDraw = !en.at_self_chi_pon && (tehai.includes(nowPai) || isTsumogiri)
  } else if (actualType === 'ankan') {
    isSelfDraw = true
  }

  // 自摸（和牌且 target 指向自己）：自摸的牌只显示在右侧，左手不放入
  const isTsumo = actualType === 'hora' && actual.actor === actual.target

  if (actualType === "hora") {
    frameName = 'hora.png'
    if (actual.actor === actual.target) {
      frameStr = "自摸"
    } else {
      // 荣和需标明来源（上家/对家/下家），否则看不出荣和谁
      frameStr = `荣和${getDiff(actual.actor, actual.target)}`
    }
  } else if (isSelfDraw) {
    // 摸牌后打牌（含摸切与非摸切，只要本轮摸到牌），显示"自己摸到"
    frameName = 'mo.png'
    frameStr = "自己摸到"
  } else if (actualType === "dahai" || actualType === "reach") {
    // 碰/吃后的打牌，不显示"出牌"，因为上边已经显示了操作类型
    frameName = ''
    frameStr = ''
  } else if (actualType !== "ankan") {
    // 碰/吃/杠等反应操作，显示"xxx出牌"
    frameName = 'action.png'
    const targetStr = getDiff(actorId, lastActor)
    frameStr = `${targetStr}出牌`
  } else {
    // 暗杠，不显示出牌
    frameName = ''
    frameStr = ''
  }

  let bgName = ''
  if (isEqual) bgName = 'yes.png'
  else {
    let warning = false
    for (let proba of (en.details || [])) {
      if (proba.action === en.actual && proba.prob >= 0.3) { warning = true; break }
    }
    bgName = warning ? 'warning.png' : 'no.png'
  }

  const enBg = await loadResImage(`review_texture/${bgName}`)
  const canvas = createCanvas(enBg.width, enBg.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(enBg, 0, 0)

  drawText(ctx, condStr, 232, 27, 24, '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')
  drawText(ctx, `【第${index}巡】`, 111, 27, 24, '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')

  let actualPais = []
  if (actualType === "ankan") actualPais = actual.consumed || []
  else if (actualType === "hora") {
    // 荣和/自摸的牌来自牌河或刚摸进，不在自己手牌里，因此不在手中抬起高亮
    actualPais = []
  } else if (actualType === "reach") {
    // 立直打牌：actual 无 pai 时用推导出的 discardPai；摸切(打出==摸到)时左手不抬
    actualPais = isTsumogiri ? [] : (discardPai ? [discardPai] : (tehai.length > 0 ? [tehai[0]] : []))
  } else if (['chi', 'pon', 'kan', 'kakan'].includes(actualType)) {
    // 碰/吃/杠：高亮抬起的是手上被消耗的牌（做副露动作），而非对方打出的那一张
    if (actual.consumed && actual.consumed.length > 0) {
      actualPais = actual.consumed
    } else if (nowPai) {
      actualPais = [nowPai]
    } else {
      actualPais = actual.pai ? [actual.pai] : []
    }
  } else if (actualType !== "none") {
    // dahai：摸切(打出==摸到)时打出的牌已显示在右侧，左手不抬；否则抬打出的牌
    if (isTsumogiri) actualPais = []
    else if (actual.consumed && actual.consumed.length > 0) actualPais = actual.consumed
    else actualPais = actual.pai ? [actual.pai] : []
  }

  let aiPais = []
  if (aiType === "ankan") aiPais = ai.consumed || []
  else if (aiType === "hora") aiPais = []
  else if (aiType === "reach") {
    // 同上：立直打牌用推导出的 aiDiscardPai；摸切时左手不抬
    aiPais = isTsumogiriAi ? [] : (aiDiscardPai ? [aiDiscardPai] : (tehai.length > 0 ? [tehai[0]] : []))
  } else if (aiType !== "none") {
    if (isTsumogiriAi) aiPais = []
    else if (ai.consumed && ai.consumed.length > 0) aiPais = ai.consumed
    else aiPais = ai.pai ? [ai.pai] : []
  }

  function countOccurrences(arr) {
    const counts = {}
    for (const item of arr) {
      counts[item] = (counts[item] || 0) + 1
    }
    return counts
  }

  const actualPaiCounts = countOccurrences(actualPais)
  const aiPaiCounts = countOccurrences(aiPais)
  const highlightedCounts = {}

  let xTile = 0
  const aiFrame = await loadResImage(`review_texture/ai.png`)

  // 自摸/摸牌回合：本巡摸到的牌(nowPai)不放入左手，改放右侧高亮显示。
  // 仅跳过“最后一张”等于 nowPai 的牌（即刚摸到的那张），保留手牌中原本的同号牌在其原位，
  // 避免把原本手牌的同号牌误移到最右侧（如摸到2p时，手牌原有2p应留在原位置）。
  const drawnActive = isSelfDraw || isTsumo
  const drawnTotal = drawnActive ? tehai.filter(h => h === nowPai).length : 0
  let drawnCount = 0

  for (let hai of tehai) {
    if (drawnActive && hai === nowPai) {
      drawnCount++
      if (drawnCount === drawnTotal) continue  // 跳过最后一张（刚摸到的牌）
    }
    let y = 83
    let haiImg
    try { haiImg = await loadResImage(`review_texture/pai/${hai}.png`) } catch(e) { continue }
    
    const key = `${hai}-${(highlightedCounts[hai] || 0)}`
    const actualCount = actualPaiCounts[hai] || 0
    const aiCount = aiPaiCounts[hai] || 0
    const currentIndex = highlightedCounts[hai] || 0
    
    if (currentIndex < actualCount) {
      y -= 28
      drawText(ctx, "▲ 你", 128 + xTile, 236, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
      highlightedCounts[hai] = (highlightedCounts[hai] || 0) + 1
    }
    
    if (currentIndex < aiCount) {
      const hc = createCanvas(haiImg.width, haiImg.height)
      const hctx = hc.getContext('2d')
      hctx.drawImage(haiImg, 0, 0)
      hctx.drawImage(aiFrame, 0, 0)
      haiImg = hc
      if (!isEqual && currentIndex >= (actualPaiCounts[hai] || 0)) {
        drawText(ctx, "▲ AI", 128 + xTile, 236, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
      }
      if (currentIndex >= (highlightedCounts[hai] || 0)) {
        highlightedCounts[hai] = (highlightedCounts[hai] || 0) + 1
      }
    }
    
    ctx.drawImage(haiImg, 88 + xTile, y)
    xTile += 81
  }

  // 副露起始位置：手牌按 81px/张直绘（未缩放），副露牌为 57px 宽，
  // 固定 1170 向左排会侵入手牌区造成遮挡，故按手牌实际宽度动态右移。
  const handRightEdge = 88 + tehai.length * 81
  // 先统计副露总宽度（含组内牌宽与组间间隔），用于从右向左排布
  let fuuroTotalWidth = 0
  for (let fuuro of fuuros) {
    let pais = []
    if (fuuro.pai) pais.push(fuuro.pai)
    if (fuuro.consumed) pais.push(...fuuro.consumed)
    const isKakan = fuuro.type === 'kakan'
    const rotate = fuuro.target !== undefined ? (fuuro.target + 4 - actorId) % 4 : 0
    let addedIdx = -1, claimedIdx = -1
    if (isKakan) ({ addedIdx, claimedIdx } = kakanIndices(fuuro, pais, rotate))
    for (let pindex = 0; pindex < pais.length; pindex++) {
      if (isKakan && pindex === addedIdx) continue // 加杠新增牌叠在横置牌上方，不占额外列宽
      const isRot = isKakan
        ? (pindex === claimedIdx)
        : ((rotate === 3 && pindex === pais.length - 1) ||
           (rotate === 1 && pindex === 0) ||
           (rotate === 2 && pindex === 1))
      fuuroTotalWidth += isRot ? 91 : 57
    }
    fuuroTotalWidth += 10
  }
  xTile = Math.max(1170, handRightEdge + 30 + fuuroTotalWidth)

  for (let fuuro of fuuros) {
    let pais = []
    if (fuuro.pai) pais.push(fuuro.pai)
    if (fuuro.consumed) pais.push(...fuuro.consumed)

    const isKakan = fuuro.type === 'kakan'
    const rotate = fuuro.target !== undefined ? (fuuro.target + 4 - actorId) % 4 : 0
    let addedIdx = -1, claimedIdx = -1
    if (isKakan) ({ addedIdx, claimedIdx } = kakanIndices(fuuro, pais, rotate))

    for (let pindex = 0; pindex < pais.length; pindex++) {
      // 加杠新增牌：不单独成列，稍后叠在原碰横置牌正上方绘制
      if (isKakan && pindex === addedIdx) continue

      let _fuuroPai = pais[pindex]
      let pimg
      try { pimg = await loadResImage(`review_texture/pai/${_fuuroPai}.png`) } catch(e) { continue }

      const pc = createCanvas(57, 91)
      const pctx = pc.getContext('2d')
      pctx.drawImage(pimg, 0, 0, 57, 91)
      pimg = pc

      const isRotated = isKakan
        ? (pindex === claimedIdx)
        : ((rotate === 3 && pindex === pais.length - 1) ||
           (rotate === 1 && pindex === 0) ||
           (rotate === 2 && pindex === 1))

      if (isRotated) {
        const rc = createCanvas(91, 57)
        const rctx = rc.getContext('2d')
        rctx.translate(45.5, 28.5)
        rctx.rotate(90 * Math.PI / 180)
        rctx.drawImage(pimg, -28.5, -45.5)
        pimg = rc
        // 横置牌与竖牌底部平齐（竖牌底=121+91=212，横置牌高57 → y=155）
        xTile -= 91
        ctx.drawImage(pimg, xTile, 155)
        // 加杠(kakan)：在“原碰横置牌”正上方再叠一张横置的加杠牌（同一 x，上移 34px）
        if (isKakan && pindex === claimedIdx && addedIdx >= 0) {
          let aImg
          try { aImg = await loadResImage(`review_texture/pai/${pais[addedIdx]}.png`) } catch(e) { aImg = null }
          if (aImg) {
            const ac = createCanvas(57, 91)
            const actx = ac.getContext('2d')
            actx.drawImage(aImg, 0, 0, 57, 91)
            const arc = createCanvas(91, 57)
            const arctx = arc.getContext('2d')
            arctx.translate(45.5, 28.5)
            arctx.rotate(90 * Math.PI / 180)
            arctx.drawImage(ac, -28.5, -45.5)
            ctx.drawImage(arc, xTile, 155 - 34)
          }
        }
      } else {
        xTile -= 57
        ctx.drawImage(pimg, xTile, 121)
      }
    }
    xTile -= 10
  }

  let nowHaiImg
  // 仅当右侧牌是"摸到/吃碰来源的牌"时才绘制：
  // 1. 自摸打牌显示摸到的牌
  // 2. 碰/吃/杠显示获得的牌
  // 3. 荣和显示荣和的牌（对方打出的牌）
  // 碰/吃后的打牌其 tile 是副露牌，不应再画在右侧。
  // none（上家打牌、玩家跳过）时也把上家打出的牌显示在右侧；
  // 自摸打牌（isSelfDraw）显示"自己摸到"；碰/吃/杠显示获得的牌；荣和显示荣和的牌。
  if (nowPai && (isSelfDraw || ['pon', 'chi', 'kan', 'kakan', 'hora', 'none'].includes(actualType))) {
    try { 
      nowHaiImg = await loadResImage(`review_texture/pai/${nowPai}.png`) 
      const frameImg = await loadResImage(`review_texture/${frameName}`)
      const ncanvas = createCanvas(nowHaiImg.width, nowHaiImg.height)
      const nctx = ncanvas.getContext('2d')
      nctx.drawImage(nowHaiImg, 0, 0)
      nctx.drawImage(frameImg, 0, 0)
      // 摸切（打出==摸到）：右侧同样向上抬起 28px 以强调动作
      const raiseY = isTsumogiri ? 28 : 0
      ctx.drawImage(ncanvas, 1265, 83 - raiseY)
    } catch(e) {}
  }

  drawText(ctx, frameStr, 1307, 236, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')

  return { canvas, actorId }
}

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
  
  let bar;
  try {
    bar = await loadResImage(`info_texture/lz_${title}.png`)
  } catch(e) {
    try {
      bar = await loadResImage(`info_texture/lz_bar.png`)
    } catch(e2) {
      const canvas = createCanvas(872, 132)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#1c2128'
      ctx.fillRect(0, 0, 872, 132)
      ctx.strokeStyle = '#30363d'
      ctx.lineWidth = 1
      ctx.strokeRect(1, 1, 870, 130)
      ctx.fillStyle = '#6e7681'
      ctx.font = '14px "Microsoft YaHei", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('暂无数据', 436, 66)
      return canvas
    }
  }
  
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

export async function getRankImg(majorRank, minorRank, mode = '4', size = 156, score = 0) {
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
  } else {
    const flowerFull = await loadResImage(`info_texture/flower_full.png`)
    const flowerEmpty = await loadResImage(`info_texture/flower_empty.png`)
    let flowerCount = 0
    if (score >= 5 && score < 10) flowerCount = 1
    else if (score >= 10 && score < 15) flowerCount = 2
    else if (score >= 15) flowerCount = 3
    for (let i = 0; i < 3; i++) {
      const flower = flowerCount > i ? flowerFull : flowerEmpty
      ctx.drawImage(flower, 38 + i * 30, 118, 28, 28)
    }
    // 魂天等级：使用等级图片素材（info_texture/Lv{minorRank}.png），画在图标内部左下角，避免遮挡花朵
    // 素材尚未齐全（Lv1~19 缺失），暂时统一不显示 Lv，等素材补齐后取消下方注释即可恢复
    // try {
    //   const lvImg = await loadResImage(`info_texture/Lv${minorRank}.png`)
    //   ctx.drawImage(lvImg, 16, 92, 56, 24)
    // } catch (_) {
    //   // 等级图片素材不存在时静默跳过（仅显示段位图标+花朵）
    // }
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
  
  const rankIcon = await getRankImg(level.major_rank, level.minor_rank, mode, 156, level._adjustedScore)
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
  
  const arabicMatch = rankText.match(/魂天(\d+)/);
  if (arabicMatch) {
    minorRank = parseInt(arabicMatch[1]) || 1;
  }
  
  return { majorRank, minorRank };
}

export async function drawMajsInfoImg(uid, mode = '4', realtimePT = null, roomFilter = null, playerName = null) {
  let data4, data3, extended4, extended3
  
  const fetchStats = async (m) => api.getPlayerStats(uid, m).catch(e => {
    console.warn(`[render.js] 获取${m === 3 ? '三麻' : '四麻'}基础数据失败: ${e.message}`)
    // 404 等资源未找到：标记 retcode，避免后续继续发起必 404 的扩展/对局请求
    if (e.message.includes('404') || e.message.includes('资源未找到')) return { ...JSON.parse(JSON.stringify(playerStatsZero)), retcode: -404 }
    return JSON.parse(JSON.stringify(playerStatsZero))
  })
  const fetchExt = async (m) => api.getPlayerExtendedStats(uid, m).catch(e => {
    console.warn(`[render.js] 获取${m === 3 ? '三麻' : '四麻'}扩展数据失败: ${e.message}`)
    return JSON.parse(JSON.stringify(playerExtendZero))
  })

  // 指令只查主模式（三麻或四麻），不存在 auto
  const mainMode = mode === '3' ? 3 : 4

  try {
    if (!api.token) {
      if (mainMode === 3) {
        data3 = JSON.parse(JSON.stringify(playerStatsZero))
        extended3 = JSON.parse(JSON.stringify(playerExtendZero))
        data4 = JSON.parse(JSON.stringify(playerStatsZero))
        extended4 = JSON.parse(JSON.stringify(playerExtendZero))
      } else {
        data4 = JSON.parse(JSON.stringify(playerStatsZero))
        extended4 = JSON.parse(JSON.stringify(playerExtendZero))
        data3 = JSON.parse(JSON.stringify(playerStatsZero))
        extended3 = JSON.parse(JSON.stringify(playerExtendZero))
      }
    } else {
      if (mainMode === 3) {
        data3 = await fetchStats(3)
        extended3 = data3.retcode ? JSON.parse(JSON.stringify(playerExtendZero)) : await fetchExt(3)
        // 四麻仅用于段位 PT 展示，缺失不影响主查询（带 retcode 标记，保持与 fetchStats 返回格式一致）
        data4 = await fetchStats(4).catch(() => ({ ...JSON.parse(JSON.stringify(playerStatsZero)), retcode: -404 }))
        extended4 = data4.retcode ? JSON.parse(JSON.stringify(playerExtendZero)) : await fetchExt(4)
      } else {
        data4 = await fetchStats(4)
        extended4 = data4.retcode ? JSON.parse(JSON.stringify(playerExtendZero)) : await fetchExt(4)
        // 三麻仅用于段位 PT 展示，缺失不影响主查询（带 retcode 标记，保持与 fetchStats 返回格式一致）
        data3 = await fetchStats(3).catch(() => ({ ...JSON.parse(JSON.stringify(playerStatsZero)), retcode: -404 }))
        extended3 = data3.retcode ? JSON.parse(JSON.stringify(playerExtendZero)) : await fetchExt(3)
      }
    }
  } catch (e) {
    console.error(`[render.js] 获取玩家数据失败: ${e.message}`)
    return `获取玩家数据失败: ${e.message}\n可能原因：\n1. 网络连接问题\n2. UID不正确\n3. 玩家数据尚未同步到服务器`
  }

  // 主模式 404（该模式金之间无对局）：补查另一模式，判断是否「两个模式都没数据」
  let otherData = null
  if ((mainMode === 3 && data3.retcode) || (mainMode === 4 && data4.retcode)) {
    const otherMode = mainMode === 3 ? 4 : 3
    try {
      otherData = await fetchStats(otherMode)
    } catch {
      otherData = null
    }
    // 另一模式也 404 → 两个模式都没打过金之间，返回文字
    if (!otherData || otherData.retcode) {
      return "未查找到该玩家...\n提示：该玩家可能尚未在金之间进行对局"
    }
  }

  // 先记录主模式是否有有效数据（retcode 会被下方抹掉，后续判断需依赖此标记）
  const data4Valid = data4 && !data4.retcode
  const data3Valid = data3 && !data3.retcode

  // 主模式 404 时，把数据替换为零对象（统计为 0）；替换后再用真实昵称兜底，避免被 "Player" 覆盖
  // 注意：零对象无 retcode，必须先取好真实昵称再替换，否则替换后 if(retcode) 判断会失效导致兜底不执行
  if (data4.retcode) {
    const realName = playerName || data3.nickname || otherData?.nickname || String(uid)
    data4 = JSON.parse(JSON.stringify(playerStatsZero))
    data4.nickname = realName
  }
  if (data3.retcode) {
    const realName = playerName || data4.nickname || otherData?.nickname || String(uid)
    data3 = JSON.parse(JSON.stringify(playerStatsZero))
    data3.nickname = realName
  }
  

  if (extended4.retcode) extended4 = JSON.parse(JSON.stringify(playerExtendZero))
  if (extended3.retcode) extended3 = JSON.parse(JSON.stringify(playerExtendZero))

  let _mode, data, extended, record
  if (mode === "3") {
    _mode = "三麻战绩"
    data = data3
    extended = extended3
    if (data3Valid) {
      try {
        record = await api.getRecentRecords(uid, 3, 16)
      } catch (e) {
        console.warn(`[render.js] 获取三麻最近对局失败: ${e.message}`)
        record = []
      }
    } else {
      record = []
    }
      if (roomFilter && data3Valid) {
        const mp = (roomFilter.ids[3] || []).join(',')
        let rdOk = false
        try {
          const rd = await api.getPlayerStats(uid, 3, mp)
          if (rd && !rd.retcode) { data = rd; rdOk = true }
        } catch (e) {}
        if (!rdOk) data = JSON.parse(JSON.stringify(playerStatsZero))
        try {
          const re = await api.getPlayerExtendedStats(uid, 3, mp)
          if (re && !re.retcode) extended = re
          else extended = JSON.parse(JSON.stringify(playerExtendZero))
        } catch (e) { extended = JSON.parse(JSON.stringify(playerExtendZero)) }
        try {
          const rr = await api.getRecentRecords(uid, 3, 16, mp)
          if (rr && !rr.retcode && Array.isArray(rr) && rr.length) record = rr
          else record = []
        } catch (e) { record = [] }
      }
  } else {
    _mode = "四麻战绩"
    data = data4
    extended = extended4
    if (data4Valid) {
      try {
        record = await api.getRecentRecords(uid, 4, 16)
      } catch (e) {
        console.warn(`[render.js] 获取四麻最近对局失败: ${e.message}`)
        record = []
      }
    } else {
      record = []
    }
    if (roomFilter && data4Valid) {
      const mp = (roomFilter.ids[4] || []).join(',')
      let rdOk = false
      try {
        const rd = await api.getPlayerStats(uid, 4, mp)
        if (rd && !rd.retcode) { data = rd; rdOk = true }
      } catch (e) {}
      if (!rdOk) data = JSON.parse(JSON.stringify(playerStatsZero))
      try {
        const re = await api.getPlayerExtendedStats(uid, 4, mp)
        if (re && !re.retcode) extended = re
        else extended = JSON.parse(JSON.stringify(playerExtendZero))
      } catch (e) { extended = JSON.parse(JSON.stringify(playerExtendZero)) }
      try {
        const rr = await api.getRecentRecords(uid, 4, 16, mp)
        if (rr && !rr.retcode && Array.isArray(rr) && rr.length) record = rr
        else record = []
      } catch (e) { record = [] }
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
      const level4Id = 1 * 10000 + rank4.majorRank * 100 + rank4.minorRank;
      data4.level = { ...data4.level, id: level4Id };
      if (realtimePT.fourPlayer.useApiScore && data4.level) {
        const apiScore = data4.level.score + (data4.level.delta || 0);
        const level4Obj = new PlayerLevel(data4.level.id, 0);
        if (level4Obj.isTenhou()) {
          level4Score = apiScore / 100;
        } else {
          level4Score = apiScore;
        }
      } else {
        level4Score = realtimePT.fourPlayer.score;
      }
    }
    if (realtimePT.threePlayer) {
      const rank3 = parseRankFromText(realtimePT.threePlayer.rank);
      const level3Id = 2 * 10000 + rank3.majorRank * 100 + rank3.minorRank;
      data3.level = { ...data3.level, id: level3Id };
      if (realtimePT.threePlayer.useApiScore && data3.level) {
        const apiScore = data3.level.score + (data3.level.delta || 0);
        const level3Obj = new PlayerLevel(data3.level.id, 0);
        if (level3Obj.isTenhou()) {
          level3Score = apiScore / 100;
        } else {
          level3Score = apiScore;
        }
      } else {
        level3Score = realtimePT.threePlayer.score;
      }
    }
  }

  // 牌谱屋（非实时）返回的魂天段位 score 为 pt 值，需除 100；实时路径已在上方处理
  const fixTenhouScore = (score, levelId, realtimePlayer) => {
    if (score == null || realtimePlayer) return score
    const tmp = new PlayerLevel(levelId || 10101, 0)
    return tmp.isTenhou() ? score / 100 : score
  }
  level4Score = fixTenhouScore(level4Score, data4.level?.id, realtimePT?.fourPlayer)
  level3Score = fixTenhouScore(level3Score, data3.level?.id, realtimePT?.threePlayer)

  let level4 = new PlayerLevel(data4.level?.id || 10101, level4Score)
  let level3 = new PlayerLevel(data3.level?.id || 10101, level3Score)

  const bg = await loadResImage('bg.jpg')
  const detailBg = await loadResImage('info_texture/detail_bg.png')
  const mid = await loadResImage('info_texture/mid.png')
  const title = await loadResImage('info_texture/title.png')
  
  const canvas = createCanvas(bg.width, bg.height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(bg, 0, 0)
  ctx.drawImage(title, 0, 0)

  const subTitle = roomFilter ? roomFilter.name : `UID ${uid}`
  drawText(ctx, `${data.nickname} · ${subTitle}`, 504, 435, 30, '#FFFFFF', 'center', 'bold')

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

  const allChong = extended["放铳至立直"] + extended["放铳至副露"] + extended["放铳至默听"]
  const lzFRate = allChong > 0 ? (extended["放铳时立直率"] || 0) : 0
  const flFRate = allChong > 0 ? (extended["放铳时副露率"] || 0) : 0
  const lzCRate = allChong > 0 ? extended["放铳至立直"] / allChong : 0
  const flCRate = allChong > 0 ? extended["放铳至副露"] / allChong : 0
  const mtCRate = allChong > 0 ? extended["放铳至默听"] / allChong : 0

  const lzRong = await getLzBar("rong", lzRRate, flRRate, mtRRate)
  const lzChong = await getLzBar("chong", lzFRate, flFRate, allChong > 0 ? Math.max(0, 1 - lzFRate - flFRate) : 0)
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
  const recordTitle = roomFilter ? `${roomFilter.name}最近16场对局记录走势` : '最近16场对局记录走势'
  drawText(detailCtx, recordTitle, 500, 590, 34, '#FFFFFF', 'center', 'bold')

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
      const targetWidth = 289
      const targetHeight = 617
      const scale = Math.max(targetWidth / personImg.width, targetHeight / personImg.height)
      const sx = (personImg.width - targetWidth / scale) / 2
      const sy = (personImg.height - targetHeight / scale) / 2
      charCtx.drawImage(personImg, sx, sy, targetWidth / scale, targetHeight / scale, 38, 37, targetWidth, targetHeight)
    }
  } catch(e) {}
  charCtx.drawImage(charFg, 0, 0)
  
  ctx.drawImage(charCanvas, 34, 518)
  ctx.drawImage(rank4Icon, 357, 545)
  ctx.drawImage(rank3Icon, 357, 857)

  return canvas.toBuffer('image/jpeg', 85)
}

function formatTimestamp(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

export async function drawSearchResultImg(players, realtimeData = {}) {
  const bg = await loadResImage('bg.jpg')
  
  const PLAYER_CARD_HEIGHT = 230
  const PADDING = 15
  const CARD_GAP = 20
  const FOOTER_HEIGHT = 40
  
  let titleImage = null
  let HEADER_HEIGHT = 80
  try {
    titleImage = await loadResImage('info_texture/title.png')
    const titleScale = 650 / titleImage.width
    const titleHeight = titleImage.height * titleScale
    const CROP_BOTTOM = 14
    HEADER_HEIGHT = titleHeight - CROP_BOTTOM
  } catch(e) {}
  
  const width = 650
  const height = HEADER_HEIGHT + players.length * (PLAYER_CARD_HEIGHT + CARD_GAP) + FOOTER_HEIGHT
  
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  
  const bgScale = Math.max(width / bg.width, height / bg.height)
  const bgX = (width - bg.width * bgScale) / 2
  const bgY = (height - bg.height * bgScale) / 2
  ctx.drawImage(bg, bgX, bgY, bg.width * bgScale, bg.height * bgScale)
  
  if (titleImage) {
    const titleWidth = width
    const titleScale = titleWidth / titleImage.width
    const titleHeight = titleImage.height * titleScale
    ctx.drawImage(titleImage, 0, 0, titleWidth, titleHeight)
    drawText(ctx, '搜索结果', width / 2, HEADER_HEIGHT - 62, 20, '#ffffff', 'center', 'bold')
  } else {
    drawText(ctx, '搜索结果', width / 2, HEADER_HEIGHT / 2, 36, '#FFD700', 'center', 'bold')
  }
  
  let y = HEADER_HEIGHT + 10
  
  for (let i = 0; i < players.length; i++) {
    const player = players[i]
    
    drawRoundRect(ctx, PADDING, y, width - PADDING * 2, PLAYER_CARD_HEIGHT, 20, 'rgba(255, 255, 255, 0.1)')
    
    const uid = player.id.toString()
    const realtime = realtimeData[uid]
    
    drawText(ctx, `${i + 1}. ${player.nickname}`, PADDING + 25, y + 35, 28, '#FFFFFF', 'left', 'bold')
    
    drawText(ctx, `UID: ${player.id}`, PADDING + 25, y + 65, 18, '#999999', 'left')
    
    const has4 = player.level4 || (realtime && realtime.fourPlayer)
    const has3 = player.level3 || (realtime && realtime.threePlayer)
    
    let level4, level3
    
    if (realtime && realtime.fourPlayer) {
      const rank = parseRankFromText(realtime.fourPlayer.rank)
      const levelId = rank.majorRank * 10000 + rank.majorRank * 100 + rank.minorRank
      let score = realtime.fourPlayer.score
      if (realtime.fourPlayer.useApiScore && player.level4) {
        const apiScore = player.level4.score + (player.level4.delta || 0)
        const tempLevel = new PlayerLevel(levelId, 0)
        if (tempLevel.isTenhou()) {
          score = apiScore / 100
        } else {
          score = apiScore
        }
      }
      level4 = new PlayerLevel(levelId, score)
    } else if (player.level4) {
      const level4Score = player.level4.score + (player.level4.delta || 0)
      level4 = new PlayerLevel(player.level4.id, level4Score)
    }
    
    if (realtime && realtime.threePlayer) {
      const rank = parseRankFromText(realtime.threePlayer.rank)
      const levelId = rank.majorRank * 10000 + rank.majorRank * 100 + rank.minorRank
      let score = realtime.threePlayer.score
      if (realtime.threePlayer.useApiScore && player.level3) {
        const apiScore = player.level3.score + (player.level3.delta || 0)
        const tempLevel = new PlayerLevel(levelId, 0)
        if (tempLevel.isTenhou()) {
          score = apiScore / 100
        } else {
          score = apiScore
        }
      }
      level3 = new PlayerLevel(levelId, score)
    } else if (player.level3) {
      const level3Score = player.level3.score + (player.level3.delta || 0)
      level3 = new PlayerLevel(player.level3.id, level3Score)
    }
    
    const iconSize = 70
    const halfWidth = (width - PADDING * 2) / 2
    
    if (has4) {
      let rankIcon4
      try {
        rankIcon4 = await getRankImg(level4.major_rank, level4.minor_rank, '4', iconSize, level4._adjustedScore)
      } catch (e) {}
      
      const iconX4 = PADDING + 25
      const iconY4 = y + 85
      if (rankIcon4) {
        ctx.drawImage(rankIcon4, iconX4, iconY4)
      }
      
      const textX4 = iconX4 + iconSize + 20
      drawText(ctx, '四麻', textX4, iconY4 + 18, 16, '#CCCCCC', 'left')
      drawText(ctx, level4.getTag(), textX4, iconY4 + 42, 20, '#FFFFFF', 'left', 'bold')
      drawText(ctx, level4.formatAdjustedScore(), textX4, iconY4 + 65, 16, '#FFD700', 'left')
      
      if (realtime && realtime.fourPlayer && realtime.isRealTime) {
        drawText(ctx, '实时', iconX4 + iconSize / 2, iconY4 + iconSize + 18, 12, '#00FF00', 'center', 'bold')
      }
    } else {
      drawText(ctx, '四麻', PADDING + 25, y + 105, 16, '#666666', 'left')
      drawText(ctx, '暂未查询到数据', PADDING + 25, y + 128, 14, '#888888', 'left')
      drawText(ctx, '可单独查询获取', PADDING + 25, y + 145, 12, '#666666', 'left')
    }
    
    if (has3) {
      let rankIcon3
      try {
        rankIcon3 = await getRankImg(level3.major_rank, level3.minor_rank, '3', iconSize, level3._adjustedScore)
      } catch (e) {}
      
      const iconX3 = PADDING + halfWidth + 25
      const iconY3 = y + 85
      if (rankIcon3) {
        ctx.drawImage(rankIcon3, iconX3, iconY3)
      }
      
      const textX3 = iconX3 + iconSize + 20
      drawText(ctx, '三麻', textX3, iconY3 + 18, 16, '#CCCCCC', 'left')
      drawText(ctx, level3.getTag(), textX3, iconY3 + 42, 20, '#FFFFFF', 'left', 'bold')
      drawText(ctx, level3.formatAdjustedScore(), textX3, iconY3 + 65, 16, '#FFD700', 'left')
      
      if (realtime && realtime.threePlayer && realtime.isRealTime) {
        drawText(ctx, '实时', iconX3 + iconSize / 2, iconY3 + iconSize + 18, 12, '#00FF00', 'center', 'bold')
      }
    } else {
      drawText(ctx, '三麻', PADDING + halfWidth + 25, y + 105, 16, '#666666', 'left')
      drawText(ctx, '暂未查询到数据', PADDING + halfWidth + 25, y + 128, 14, '#888888', 'left')
      drawText(ctx, '可单独查询获取', PADDING + halfWidth + 25, y + 145, 12, '#666666', 'left')
    }
    
    const lastActive = formatTimestamp(player.latest_timestamp)
    if (lastActive) {
      drawText(ctx, '最后活跃: ' + lastActive, width / 2, y + PLAYER_CARD_HEIGHT - 20, 14, '#666666', 'center')
    }
    
    y += PLAYER_CARD_HEIGHT + CARD_GAP
  }
  
  drawText(ctx, 'Majsoul-Plugin by 小橙c | Data: amae-koromo', width / 2, height - 12, 12, '#ffffff', 'center', 'bold')
  
  return canvas.toBuffer('image/jpeg', 85)
}

export async function drawReviewInfoImg(mortalLog, data, kyokuId = 0, meguruId = 0) {
  const reviewData = data.data.review
  if (!reviewData.kyokus || kyokuId >= reviewData.kyokus.length || kyokuId < 0) return "该Game未存在该局ID"
  
  const kyokus = reviewData.kyokus[kyokuId]
  
  const kh = `${kyokuToString(kyokus.kyoku)} ${kyokus.honba}本场`
  
  // meguruId>0 时只渲染到第 N 手（1-based），否则渲染整局
  const limit = meguruId > 0 ? Math.min(meguruId, kyokus.entries.length) : kyokus.entries.length
  
  const w = 2800
  const hNum = Math.floor((limit - 1) / 2) + 1
  
  const bg = await loadResImage('bg.jpg')
  const title = await loadResImage('review_texture/title.png')
  const actorFile = await loadResImage('review_texture/actor_file.png')
  const spliter = await loadResImage('review_texture/spliter.png')
  const reviewInfo = await loadResImage('review_texture/review_info.png')
  const barImg = await loadResImage('review_texture/bar.png')
  let maskImg = null
  try { maskImg = await loadResImage('review_texture/mask.png') } catch(e) {}
  
  const titleHeight = title.height || 396
  const reviewInfoHeight = reviewInfo.height || 350
  const footerHeight = 50
  
  const spliterY = titleHeight + reviewInfoHeight
  const h = spliterY + spliter.height + hNum * 255 + footerHeight
  
  const finalCanvas = createCanvas(w, h)
  const finalCtx = finalCanvas.getContext('2d')
  
  for(let i = 0; i < w; i += bg.width) {
    for(let j = 0; j < h; j += bg.height) {
      finalCtx.drawImage(bg, i, j)
    }
  }
  
  finalCtx.drawImage(title, 0, 0)
  
  // ---- 玩家信息条（依据 MajsoulUID draw_bar 的坐标实现）----
  // reviewData.player_id 即被分析玩家的座号（0~3）
  const seat = (data && data.data && data.data.player_id) ||
               (data && data.player_id) || 0

  // 名字优先用 raw 注入的真实昵称（mortalLog.name，由 review 命令从雀魂公开 API 获取），
  // 其次 review.json 的占位名（A/B/C/D），最后兜底
  // 雀魂对未授权玩家返回 Aさん/Bさん/Cさん/Dさん 这类占位名，统一替换为主视角标识。
  const rawName = (mortalLog && mortalLog.name && mortalLog.name[seat]) ||
                  (reviewData.name && reviewData.name[seat]) || ''
  // 命中占位名模式（A桑/B桑/C桑/D桑 或其简写 A/B/C/D）时显示「主视角」，否则用真实昵称/兜底
  const isPlaceholder = /^[A-D](?:さん|n)?$/i.test(rawName.trim())
  const name = (rawName && !isPlaceholder) ? rawName : '主视角'
  // 段位名 / 段位分直接用牌谱自身数据（mortalLog.dan / mortalLog.rate，对应牌谱 split_logs[0]）
  const rawDan = ((mortalLog && mortalLog.dan && mortalLog.dan[seat]) ||
                  (reviewData.dan && reviewData.dan[seat]) || '')
  // 由牌谱 dan 字符串解析 major/minor（繁体→简体统一），供段位图 / 简体段位名 / 升段分使用
  let danMajor = 1, danMinor = 1
  const m = /^([一-龥]+)★?(\d*)$/.exec(rawDan)
  if (m) {
    const majorMap = { '初心': 1, '雀士': 2, '雀傑': 3, '雀豪': 4, '雀聖': 5, '魂天': 6 }
    danMajor = majorMap[m[1]] || 1
    danMinor = m[2] ? parseInt(m[2], 10) : 1
  }
  // 简体段位名映射（雀魂原始为繁体「雀聖★2」，统一显示简体「雀圣2」）
  const SIMPLE_RANKS = { 1: '初心', 2: '雀士', 3: '雀杰', 4: '雀豪', 5: '雀圣', 6: '魂天' }
  // 雀魂原始段位文本一星省略星标（如「雀聖」对应雀圣一星），故 minor 恒显星数，
  // 避免雀圣一星只显示「雀圣」而丢「1」（二/三星原本就正常）
  const danText = `${SIMPLE_RANKS[danMajor] || '初心'}${danMinor || ''}`
  // 段位分：当前 rating / 升段所需分。升段阈值取自 PlayerLevel._getMaxPoint（如 雀圣3 → 9000）
  let rateText = ''
  if (mortalLog && mortalLog.rate && mortalLog.rate[seat] != null) {
    const rateVal = mortalLog.rate[seat]
    if (danMajor < 6) {
      try {
        const danLevel = new PlayerLevel(danMajor * 100 + danMinor, 0)
        const maxPoint = danLevel.getMaxPoint()
        rateText = maxPoint > 0 ? `${rateVal}/${maxPoint}` : String(rateVal)
      } catch (e) {
        rateText = String(rateVal)
      }
    } else {
      // 魂天段位计分特殊（/100 制），仅显示当前 rating
      rateText = String(rateVal)
    }
  } else if (reviewData.rate && reviewData.rate[seat] != null) {
    rateText = String(reviewData.rate[seat])
  }
  const avatarId = (mortalLog && mortalLog.avatarId && mortalLog.avatarId[seat])

  const actorCanvas = createCanvas(actorFile.width, actorFile.height)
  const actorCtx = actorCanvas.getContext('2d')
  actorCtx.drawImage(actorFile, 0, 0)

  // 在独立的 bar 画布上按 bar 原始坐标绘制内容，再整体缩放贴入 actorFile，
  // 严格对应 Python：bar.resize((1450,222)) + actor_file.paste(bar, (-27,106))
  const barCanvas = createCanvas(barImg.width, barImg.height)
  const barCtx = barCanvas.getContext('2d')
  barCtx.drawImage(barImg, 0, 0)

  // 头像：bar 内 (69,15) 128x128，扣 mask；avatar_id → lqc.json 路径 → CDN 下载 bighead.png
  // 无 avatar_id（占位场景）或真实头像加载失败时，回退从 resources/person 随机抽取占位头像（按座位固定）。
  let avatarImg = null
  if (avatarId) {
    try {
      avatarImg = await getAvatarCanvas(avatarId)
    } catch (e) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 头像绘制失败 ${avatarId}: ${e.message}`)
    }
  }
  if (!avatarImg) {
    try {
      avatarImg = await getPlaceholderAvatar(seat)
    } catch (e) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 占位头像绘制失败: ${e.message}`)
    }
  }
  if (avatarImg) {
    const out = createCanvas(128, 128)
    const octx = out.getContext('2d')
    const av = maskImg ? applyMask(avatarImg, maskImg) : avatarImg
    octx.drawImage(av, 0, 0, 128, 128)
    barCtx.drawImage(out, 69, 15)
  }

          // 段位图：bar 内 (234,32) 94x94，使用 getRankImg 绘制徽章 + 星星/花朵（与记录图一致）
          try {
            const rankName = SIMPLE_RANKS[danMajor] || '初心'
            // 魂天用 minorRank 近似花朵数所需的 score（0~19，对应 getRankImg 内 0/5/10/15 阈值）
            const rankScore = danMajor >= 6 ? Math.min(19, Math.max(0, danMinor - 1)) : 0
            let rankImg = null
            for (const mode of ['4', '3']) {
              try {
                rankImg = await getRankImg(rankName, danMinor, mode, 94, rankScore)
                break
              } catch (e4) {}
            }
            if (rankImg) barCtx.drawImage(rankImg, 234, 32, 94, 94)
          } catch (e) {}

  // 玩家名 (355,80) lm；段位文字 (653,80) mm；段位分 (817,80) mm
  // 段位名 / 段位分已优先使用牌谱自身数据（mortalLog.dan / mortalLog.rate，对应牌谱 26508~26518 行）
  drawText(barCtx, name, 355, 80, 34, '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')
  drawText(barCtx, danText || '未知段位', 653, 80, 44, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
  drawText(barCtx, rateText || '-', 817, 80, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')

  // 整体缩放 bar 到 1450x222 并贴入 actorFile 的 (-27,106)
  actorCtx.drawImage(barCanvas, -27, 106, 1450, 222)

  finalCtx.drawImage(actorCanvas, 0, titleHeight)
  
  let actorId = reviewData.player_id || 0
  let nowReviewed = 0, nowMatches = 0, nowWarning = 0
  
  for (let index = 0; index < limit; index++) {
    const en = kyokus.entries[index]
    nowReviewed++
    
    const { canvas: enBg, actorId: aId } = await drawEnBg(en, index, actorId)
    actorId = aId
    
    if (en.is_equal) nowMatches++
    else {
      let warning = false
      for (let proba of (en.details || [])) {
        if (proba.action === en.actual && proba.prob >= 0.3) { warning = true; break }
      }
      if (warning) nowWarning++
    }
    
    let _x = index < hNum ? 0 : 1400
    finalCtx.drawImage(enBg, _x, spliterY + spliter.height + ((index % hNum) * 255))
  }
  
  const totalReviewed = reviewData.total_reviewed
  const totalMatches = reviewData.total_matches
  
  const totalRating = `${((totalMatches / totalReviewed) * 100).toFixed(2)}%`
  const nowRating = `${((nowMatches / nowReviewed) * 100).toFixed(2)}%`
  
  const totalStr = `${totalMatches} / ${totalReviewed}`
  const nowStr = `${nowMatches} / ${nowReviewed}`
  const nowWStr = `${nowWarning} / ${nowReviewed}`
  const nowScore = (nowWarning * 0.6 + nowMatches) / nowReviewed
  const nowScoreStr = `${(nowScore * 100).toFixed(2)}%`
  
  const totalColor = getColor(totalMatches / totalReviewed)
  const nowColor = getColor(nowMatches / nowReviewed)
  const nowScoreColor = getColor(nowScore)
  
  const riCanvas = createCanvas(reviewInfo.width, reviewInfo.height)
  const riCtx = riCanvas.getContext('2d')
  riCtx.drawImage(reviewInfo, 0, 0)
  
  const dataMap = [
    [nowScoreStr, nowScoreColor],
    [nowRating, nowColor],
    [nowStr, '#4AFF00'],
    [nowWStr, '#FFA100'],
    [totalRating, totalColor],
    [totalStr, totalColor]
  ]
  
  dataMap.forEach((item, index) => {
    drawText(riCtx, item[0], Math.floor(170 + index * 209.4), 200, 40, item[1], 'center', 'bold', 'Microsoft YaHei')
  })
  
  finalCtx.drawImage(riCanvas, 1390, titleHeight)
  
  const sCanvas = createCanvas(spliter.width, spliter.height)
  const sCtx = sCanvas.getContext('2d')
  sCtx.drawImage(spliter, 0, 0)
  drawText(sCtx, `【${kh}】`, 1400, 35, 50, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
  finalCtx.drawImage(sCanvas, 0, spliterY)
  
  drawText(finalCtx, `${meguruId > 0 ? `（展示前 ${limit} 手） ` : ''}Majsoul-Plugin by 小橙c | Data：Mortal 4.1b | Python-to-JS移植：QingFeng`, w / 2, h - footerHeight / 2, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
  
  return finalCanvas.toBuffer('image/jpeg', 85)
}

// ==================== 帮助界面（移植自 MajsoulUID majs_help，适配 JS 版指令）====================

const HELP_DATA = {
  "用户管理": {
    desc: "搜索玩家与绑定UID，便于后续查询",
    items: [
      { name: "雀魂绑定", desc: "绑定雀魂玩家UID", eg: "雀魂绑定 <UID>", icon: "绑定" },
      { name: "雀魂切换", desc: "切换已绑定的主账号", eg: "雀魂切换 <UID>", icon: "切换" },
      { name: "雀魂解绑", desc: "解绑指定或全部UID", eg: "雀魂解绑 [UID]", icon: "解绑" },
      { name: "雀魂我的绑定", desc: "查看已绑定的所有UID", eg: "雀魂我的绑定", icon: "我的绑定" },
      { name: "雀魂搜索", desc: "搜索雀魂玩家信息", eg: "雀魂搜索 <玩家名>", icon: "搜索" }
    ]
  },
  "玩家数据查询": {
    desc: "查询玩家详细战绩与段位数据",
    items: [
      { name: "雀魂查询", desc: "查询四麻详细数据（默认）", eg: "雀魂查询 [玩家名] [房间]", icon: "查询" },
      { name: "查询四麻", desc: "查询四麻段位/统计/走势", eg: "查询四麻 [玩家名] [房间]", icon: "查询四麻" },
      { name: "查询三麻", desc: "查询三麻段位/统计/走势", eg: "查询三麻 [玩家名] [房间]", icon: "查询三麻" }
    ]
  },
  "对局查询": {
    desc: "查询最近对局记录",

    items: [
      { name: "雀魂对局", desc: "查询最近5场四麻对局", eg: "雀魂对局 [玩家名] [房间]", icon: "雀魂对局" },
      { name: "三麻对局", desc: "查询最近5场三麻对局", eg: "三麻对局 [玩家名] [房间]", icon: "三麻对局" }
    ]
  },
  "AI牌谱分析": {
    desc: "基于 Mortal AI 的牌谱复盘与场况分析",
    items: [
      { name: "牌谱Review", desc: "AI 分析牌谱每手最优选择", eg: "牌谱Review <URL>", icon: "牌谱" },
      { name: "雀魂场况", desc: "查看指定局巡的场况图", eg: "场况 <URL> <局> [巡]", icon: "场况" },
      { name: "雀魂登录", desc: "登录账号以使用牌谱分析", eg: "雀魂登录 <账号> <密码>", icon: "登录" }
    ]
  },
  "对局订阅": {
    desc: "群内谁又偷偷上大分了？？",
    items: [
      { name: "雀魂订阅", desc: "订阅玩家四麻对局播报", eg: "雀魂订阅 <玩家名>", icon: "订阅" },
      { name: "三麻订阅", desc: "订阅玩家三麻对局播报", eg: "三麻订阅 <玩家名>", icon: "三麻订阅" }
    ]
  },
  "抽卡娱乐": {
    desc: "十连抽卡与卡池切换，每日限5次",
    items: [
      { name: "雀魂十连", desc: "模拟雀魂十连抽卡", eg: "雀魂十连", icon: "抽卡" },
      { name: "查看雀魂卡池", desc: "查看本群当前卡池", eg: "查看雀魂卡池", icon: "抽卡" },
      { name: "查询抽卡次数", desc: "查询今日剩余抽卡次数", eg: "查询抽卡次数 [QQ号]", icon: "抽卡" }
    ]
  }
}

export async function drawHelp() {
  const bannerBg = await loadResImage('help/texture2d/banner_bg.jpg')
  const helpBg = await loadResImage('help/texture2d/bg.jpg')
  const cagBg = await loadResImage('help/texture2d/cag_bg.png')
  const itemBg = await loadResImage('help/texture2d/item.png')

  // 布局常量 —— 严格参照 gsuid_core draw_new_plugin_help 原版参数
  const COLS = 3
  const W = 120 + 475 * COLS          // 1545
  const CARD_STEP = 490               // 每列水平步长
  const CARD_W = 475
  const ROW_H = 175                   // 每行卡片垂直高度
  const SOFT = 10                     // 分类间额外间距
  const ICON_SIZE = 150              // item 内图标尺寸
  const PAD_X = 45                    // 卡片起始 x

  let y = 0

  // ---- 顶部 Banner ----
  const bscale = W / bannerBg.width
  const bannerH = Math.round(bannerBg.height * bscale)

  // 预计算总高度（使用真实尺寸）
  const cagW = W - 90
  const cagScale = cagW / cagBg.width
  const realCagH = Math.round(cagBg.height * cagScale)
  let totalH = bannerH + Math.round(70 * bscale) + SOFT
  for (const cat of Object.values(HELP_DATA)) {
    const rows = Math.ceil(cat.items.length / COLS)
    totalH += realCagH + SOFT + rows * ROW_H + SOFT
  }
  totalH += 0 // 底部 footer 留白（设0，最小间距）

  const canvas = createCanvas(W, totalH)
  const ctx = canvas.getContext('2d')

  // 平铺背景
  for (let bx = 0; bx < W; bx += helpBg.width) {
    for (let by = 0; by < totalH; by += helpBg.height) {
      ctx.drawImage(helpBg, bx, by)
    }
  }

  // 绘制 Banner —— 完全复刻原版 gsuid_core 布局
  ctx.drawImage(bannerBg, 0, 0, W, bannerH)

  // 插件图标（128x128，左上角偏下位置，参照原版坐标缩放，拉近主副标题）
  try {
    const pluginIcon = await loadResImage('help/texture2d/ICON.png')
    const iconSize = Math.round(128 * bscale)
    const iconX = Math.round(110 * bscale)
    const iconY = Math.round((bannerH / bscale) - 195) * bscale
    // 圆形裁切
    ctx.save()
    ctx.beginPath()
    ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(pluginIcon, iconX, iconY, iconSize, iconSize)
    ctx.restore()
  } catch (_) {}

  // 标题文字（50px 白色，参照原版）
  const titleText = 'Majsoul-Plugin帮助'
  const titleX = Math.round(262 * bscale)
  const titleY = Math.round(((bannerH / bscale) - 172) * bscale)
  const titleDrawY = titleY + 20
  drawText(ctx, titleText, titleX, titleDrawY, Math.round(50 * bscale), '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')

  // 副标题（30px 灰色，加粗，参照原版）
  const subTitle = '该本大爷出场了汪。'
  const subTitleX = Math.round(262 * bscale)
  const subTitleY = Math.round(((bannerH / bscale) - 117) * bscale)
  drawText(ctx, subTitle, subTitleX, subTitleY + 15, Math.round(30 * bscale), '#CECECE', 'left', 'bold', 'Microsoft YaHei')

  // 版本徽章（红色圆角标签，与标题文字同高）
  const versionText = 'v5.2.2'
  const badgeX = titleX + measureTextWidth(ctx, titleText, Math.round(50 * bscale), 'bold', 'Microsoft YaHei') + Math.round(10 * bscale)
  const badgeY = titleDrawY
  const badgeW = measureTextWidth(ctx, versionText, Math.round(28 * bscale), 'bold', 'Microsoft YaHei') + Math.round(16 * bscale)
  const badgeH = Math.round(34 * bscale)
  const badgeR = Math.round(8 * bscale)
  ctx.fillStyle = '#FC4545'
  roundRect(ctx, badgeX, badgeY - badgeH / 2, badgeW, badgeH, badgeR)
  drawText(ctx, versionText, badgeX + badgeW / 2, badgeY + 2, Math.round(28 * bscale), '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')

  y = bannerH + Math.round(40 * bscale)

  // ---- 各分类 ----
  for (const [catName, cat] of Object.entries(HELP_DATA)) {
    // 分类标题：cag_bg 背景条（自带红色方块）+ 分类名（白字 45px）+ 描述（灰字 30px）
    const cagW = W - 90
    const cagScale = cagW / cagBg.width
    const cagDrawH = Math.round(cagBg.height * cagScale)
    ctx.drawImage(cagBg, 45, y, cagW, cagDrawH)

    // 文字从 cag_bg 内置红方块右侧开始（整体右移避免拥挤，描述保持 30px）
    drawText(ctx, catName, 175, y + cagDrawH / 2 + 2, 36, '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')
    drawText(ctx, cat.desc, 175 + measureTextWidth(ctx, catName, 36, 'bold', 'Microsoft YaHei') + 20, y + cagDrawH / 2 + 2, 30, '#999999', 'left', 'bold', 'Microsoft YaHei')

    y += cagDrawH + SOFT

    // 指令卡片网格
    const rows = Math.ceil(cat.items.length / COLS)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c
        if (idx >= cat.items.length) break
        const item = cat.items[idx]
        const x = PAD_X + c * CARD_STEP
        const cardY = y + r * ROW_H

        // item 背景（原比例缩放）
        const itemScale = CARD_W / itemBg.width
        const itemDrawH = Math.round(itemBg.height * itemScale)
        ctx.drawImage(itemBg, x, cardY, CARD_W, itemDrawH)

        // 图标（150x150，左上角，每条指令独立图标）
        try {
          const icon = await loadResImage(`help/icon_path/${item.icon}.png`)
          const iconX = x + 6
          const iconY = cardY + 12
          ctx.save()
          ctx.beginPath()
          ctx.arc(iconX + ICON_SIZE / 2, iconY + ICON_SIZE / 2, ICON_SIZE / 2, 0, Math.PI * 2)
          ctx.closePath()
          ctx.clip()
          ctx.drawImage(icon, iconX, iconY, ICON_SIZE, ICON_SIZE)
          ctx.restore()
        } catch (_) {}

        // 指令名称（图标右侧，38px 加粗白字）
        drawText(ctx, item.name, x + 168, cardY + 67, 38, '#FFFFFF', 'left', 'bold', 'Microsoft YaHei')

        // 示例（名称下方，24px 灰色，参数用 [] 标注可省略、<> 标注必填）
        const egText = item.eg.split('\n')[0]
        const maxEgW = CARD_W - 168 - 8
        let displayEg = egText
        ctx.font = `normal 24px Microsoft YaHei`
        while (ctx.measureText(displayEg).width > maxEgW && displayEg.length > 4) {
          displayEg = displayEg.slice(0, -1)
        }
        if (displayEg !== egText) displayEg += '…'
        drawText(ctx, displayEg, x + 168, cardY + 116, 24, '#AAAAAA', 'left', 'normal', 'Microsoft YaHei')
      }
    }

    y += rows * ROW_H + SOFT
  }

  // ---- 底部 Footer（白字加粗） ----
  drawText(ctx, 'Majsoul-Plugin by 小橙c',
    W / 2, totalH - 22, 28, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')

  return canvas.toBuffer('image/jpeg', 85)
}

// 辅助：测量文字宽度（用于紧凑排版时计算间距）
function measureTextWidth(ctx, text, fontSize, fontWeight, fontFamily) {
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
  return ctx.measureText(text).width
}

// 辅助：绘制圆角矩形
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.fill()
}