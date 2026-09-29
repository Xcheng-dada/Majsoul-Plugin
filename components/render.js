import { createCanvas, loadImage } from '@napi-rs/canvas'
import { loadResImage, drawText, drawRoundRect, applyMask } from './canvas.js'
import MajsoulApi from '../utils/MajsoulApi.js'
import { PlayerLevel, playerStatsZero, playerExtendZero } from '../utils/PlayerLevel.js'
import { buildPlayerTags, drawTags, RANK_WINDOW } from '../utils/PlayerTags.js'
import { computePlayStyle } from '../utils/PlayStyle.js'
import { computeStableRank, computeStableRankWeighted, estimateGamesToRankChange, stableRankEligibleRooms, stableRankFilterRooms } from '../utils/StableRank.js'
import { getPlayerStatistics } from '../utils/MajsoulProtocolClient.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

// ---- 头像渲染：avatar_id → lqc.json 路径 → CDN 下载 bighead.png ----
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
const pluginVersion = createRequire(import.meta.url)('../package.json').version // help 横幅版本徽章，与 package.json 同步
const avatarCacheRoot = path.join(pluginRoot, 'data', 'charactor')
let avatarConfigCache = null

// ---- 牌画皮肤：review_texture/pai/ 直读文件为默认；其子目录各为一套皮肤 ----
// 每渲染一张回顾图随机选择一套，整图统一；无皮肤子目录时恒用默认
function pickPaiBase() {
  try {
    const paiRoot = path.join(pluginRoot, 'resources', 'review_texture', 'pai')
    const skins = fs.readdirSync(paiRoot, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
    if (skins.length === 0) return 'pai'
    return `pai/${skins[Math.floor(Math.random() * skins.length)]}`
  } catch (e) { return 'pai' }
}

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
  // 自定义条目（config/lqc.custom.json）：CDN 表未收录的皮肤（如仅客户端实装的 akagi_sp2 / 数字id装扮），
  // 每次读取时叠加，避免 lqc.json 自动更新全量重写后丢失
  const custom = readJsonIfExists(path.join(pluginRoot, 'config', 'lqc.custom.json')) || {}
  for (const lqcPath of lqcPaths) {
    const lqc = readJsonIfExists(lqcPath)
    if (!lqc) continue
    // extendRes.json 与 lqc.json 不一定同目录：data/ 下通常只有自动更新的 lqc.json，
    // 而 extendRes.json 是随包分发的静态表（在 config/）。此前只找 lqc 同目录，
    // 命中 data/lqc.json 时 extendRes 恒为空 {}，导致所有服饰资源 key 解析失败、
    // 官方 CDN 404，立绘只能靠兜底镜像或干脆缺失。故两处都找。
    const extendRes = readJsonIfExists(path.join(path.dirname(lqcPath), 'extendRes.json'))
      || readJsonIfExists(path.join(pluginRoot, 'data', 'extendRes.json'))
      || readJsonIfExists(path.join(pluginRoot, 'config', 'extendRes.json'))
      || {}
    avatarConfigCache = { lqc: { ...lqc, ...custom }, extendRes }
    return avatarConfigCache
  }
  avatarConfigCache = { lqc: { ...custom }, extendRes: {} }
  return avatarConfigCache
}

// 本地素材查找：resources/charactor/<目录>/（git 分发的解包图，如 akagi_sp2/40011703）优先，
// 其次 data/charactor/<目录>/（运行时 CDN 下载缓存）
function findCachedAsset(charDirName, fileName) {
  const candidates = [
    path.join(pluginRoot, 'resources', 'charactor', charDirName, fileName),
    path.join(avatarCacheRoot, charDirName, fileName)
  ]
  return candidates.find(p => fs.existsSync(p)) || null
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
// 注意：多数角色的 chs_t/jp/en/kr 前缀资源在国服 CDN 上 404，只有 lang/base/（基础资源）真实可用，
// 因此候选优先选择 lang/base/，其次 lang/base_q7/，最后才是其它语言前缀。
function findKeyBySuffix(source, suffix) {
  if (!source) return null
  if (source[suffix]) return suffix
  const normalized = suffix.replace(/\\/g, '/')
  const matches = Object.keys(source).filter(k => k === normalized || k.endsWith(`/${normalized}`))
  if (matches.length === 0) return null
  const langBase = matches.find(k => k.startsWith('lang/base/'))
  if (langBase) return langBase
  const langBaseQ7 = matches.find(k => k.startsWith('lang/base_q7/'))
  if (langBaseQ7) return langBaseQ7
  return matches[0]
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

async function resolveAvatarAsset(infoPath, extendRes, fileName = 'bighead.png') {
  const suffix = `${infoPath}/${fileName}` // 形如 extendRes/charactor/jinwu/bighead.png
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
    // 表外皮肤（lqc 缺失）：从 resources/person 随机头像，不再回退默认角色 400000
    if (typeof logger !== 'undefined') logger.warn(`[render.js] avatar_id=${avatarId} 不在 lqc.json 中，使用随机 person 头像`)
    const randomPerson = getRandomPerson()
    if (randomPerson) return await loadResImage(randomPerson)
    return null
  }
  const info = avatarInfo
  if (!info?.path) return null

  const charDirName = path.basename(info.path)
  // 同 loadPortraitImage：缓存不存在时给出目标路径，避免 fetchImageToFile(url, null)
  // 在 mkdirSync(path.dirname(null)) 处抛 TypeError，导致头像永远下载不下来。
  const cached = findCachedAsset(charDirName, 'bighead.png')
  const localPath = cached || path.join(avatarCacheRoot, charDirName, 'bighead.png')
  if (cached) {
    try {
      return await loadImageFromCache(cached)
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
    // CDN 原路径取不到（该角色在此版本缺 bighead.png）时，兜底走雀魂DB 资源镜像
    // 结构：https://d7.mjsdb.ovh/s3/files/extracted/MyAssets/deco/character/<角色目录>/bighead/bighead.png
    const mjsdbUrl = `https://d7.mjsdb.ovh/s3/files/extracted/MyAssets/deco/character/${charDirName}/bighead/bighead.png`
    try {
      await fetchImageToFile(mjsdbUrl, localPath)
      if (typeof logger !== 'undefined') logger.debug(`[render.js] 头像走雀魂DB兜底成功 ${avatarId}: ${mjsdbUrl}`)
      return await loadImageFromCache(localPath)
    } catch (err2) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 头像加载失败 ${avatarId}: ${url} -> ${err.message}；雀魂DB兜底亦失败: ${err2.message}`)
      return null
    }
  }
}

// ---- 服饰立绘处理：去黑边/透明边 + 保持 300:650 比例（Python 版 process_image 的 JS 移植） ----
// 与 resources/person_full 的预处理规则一致：内容绝不拉伸，只补透明边，避免黑边/遮挡。
async function processPortraitImage(buffer, targetW = 300, targetH = 650) {
  const img = await loadImage(buffer)
  const srcCanvas = createCanvas(img.width, img.height)
  const srcCtx = srcCanvas.getContext('2d')
  srcCtx.drawImage(img, 0, 0)
  const { data } = srcCtx.getImageData(0, 0, img.width, img.height)

  // 第一步：寻找有效内容边界（透明度 > 10 且 非接近纯黑 r+g+b > 10）
  let left = img.width, top = img.height, right = 0, bottom = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      if (data[i + 3] > 10 && (data[i] + data[i + 1] + data[i + 2]) > 10) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right <= left || bottom <= top) return buffer // 全透明/全黑：原样返回

  const cw = right - left + 1
  const ch = bottom - top + 1

  // 第二步：按 300:650 补透明画布（内容绝不拉伸、绝不裁剪，与 person_full 预处理规则一致）
  const ratio = targetW / targetH
  let newW, newH, ox, oy
  if (cw / ch > ratio) {
    // 偏宽：上下补透明条
    newW = cw
    newH = Math.round(cw / ratio)
    ox = 0
    oy = Math.floor((newH - ch) / 2)
  } else {
    // 瘦高：左右补透明条
    newH = ch
    newW = Math.round(ch * ratio)
    ox = Math.floor((newW - cw) / 2)
    oy = 0
  }
  const out = createCanvas(newW, newH)
  const octx = out.getContext('2d')
  octx.drawImage(img, left, top, cw, ch, ox, oy, cw, ch)
  return out.toBuffer('image/png')
}

// 实时服饰立绘：avatarId → lqc.json path → CDN full.png → XOR解密 → 去黑边/比例处理 → 缓存 data/charactor/<角色>/full.png
// CDN 失败时走雀魂DB 兜底（同头像 bighead 结构）；仅支持 lqc.json 内收录的皮肤，
// 表外皮肤（lqc 缺失）返回 null，由调用方回退 person_full 随机图
async function loadPortraitImage(avatarId) {
  if (!avatarId) return null
  const { lqc, extendRes } = loadAvatarConfig()
  const info = lqc[String(avatarId)]
  if (!info?.path) return null

  const charDirName = path.basename(info.path)
  // 本地已有缓存则直接用；否则把下载结果落到 data/charactor/<角色>/full.png。
  // 注意：localPath 为 null 时不能直接 mkdirSync(path.dirname(null))（会抛 TypeError），
  // 此前因此导致「下载成功但保存失败、两条路径都报错」，立绘永远出不来。
  const cached = findCachedAsset(charDirName, 'full.png')
  const localPath = cached || path.join(avatarCacheRoot, charDirName, 'full.png')
  if (cached) {
    try {
      return await loadImageFromCache(cached)
    } catch (err) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 本地服饰缓存不可用 ${avatarId}: ${err.message}`)
    }
  }

  // 解析真实资源路径（含 locale 前缀）与版本前缀
  try {
    const { assetPath, prefix } = await resolveAvatarAsset(info.path, extendRes, 'full.png')
    const url = `https://game.maj-soul.com/1/${prefix}/${assetPath}`
    const res = await (globalThis.fetch || (await import('node-fetch')).default)(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = Buffer.from(await res.arrayBuffer())
    const processed = await processPortraitImage(normalizeMajsoulImageBuffer(raw))
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, processed)
    if (typeof logger !== 'undefined') logger.debug(`[render.js] 服饰立绘获取成功 ${avatarId}: ${url}`)
    return await loadImage(processed)
  } catch (err) {
    // CDN 原路径取不到时，兜底走雀魂DB 资源镜像（与头像 bighead 同结构，full 为全身立绘）
    const mjsdbUrl = `https://d7.mjsdb.ovh/s3/files/extracted/MyAssets/deco/character/${charDirName}/full/full.png`
    try {
      const res = await (globalThis.fetch || (await import('node-fetch')).default)(mjsdbUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = Buffer.from(await res.arrayBuffer())
      const processed = await processPortraitImage(normalizeMajsoulImageBuffer(raw))
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, processed)
      if (typeof logger !== 'undefined') logger.debug(`[render.js] 服饰立绘雀魂DB兜底成功 ${avatarId}: ${mjsdbUrl}`)
      return await loadImage(processed)
    } catch (err2) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 服饰立绘加载失败 ${avatarId}: ${err.message}；雀魂DB兜底亦失败: ${err2.message}`)
      return null
    }
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

async function drawEnBg(en, index, _actorId, entries, paiBase = 'pai') {
  const tehai = en.state.tehai || []
  const fuuros = en.state.fuuros || []
  const ai = en.expected
  const actual = en.actual
  const nowPai = en.tile
  const lastActor = en.last_actor
  const enIsEqual = en.is_equal

  const actorId = actual.actor !== undefined ? actual.actor : _actorId

  const actualType = actual.type
  const aiType = ai.type

  // 立直(actual 无 pai)时，从「下一个同玩家的 dahai entry」推导真正的立直打牌。
  // tenhou 日志里 reach 和 dahai 是两条连续事件，Mortal 的 actual.type==='reach' 不带 pai，
  // 真正的立直打牌在后续 entry 里。注意：不能从 en.details 抓 AI 候选的 dahai，
  // 否则会把 AI 建议（如“不立直就打 4m”）误当成实际打出的牌。
  function getReachDiscardPai(act, actor) {
    if (act && act.pai) return act.pai
    if (!act || act.type !== 'reach') return null
    if (!entries || !Array.isArray(entries)) return null
    for (let i = index + 1; i < entries.length; i++) {
      const a = entries[i].actual
      if (a && a.actor === actor && a.type === 'dahai' && a.pai) return a.pai
    }
    return null
  }
  // AI 推荐立直时也没有直接 pai；按用户要求，AI 立直时显示的打牌取 details 中
  // 第一个 AI 候选 dahai，以便在图中高亮展示推荐打牌。
  function getAiReachDiscardPai(act, actor) {
    if (act && act.pai) return act.pai
    if (!act || act.type !== 'reach') return null
    for (const det of (en.details || [])) {
      const a = det && det.action
      if (a && a.type === 'dahai' && a.actor === actor && a.pai) return a.pai
    }
    return null
  }
  const reachPai = actualType === 'reach' ? getReachDiscardPai(actual, actorId) : null
  const aiReachPai = aiType === 'reach' ? getAiReachDiscardPai(ai, actorId) : null
  // dahai 用 actual.pai；reach 用推导出的立直打牌
  const discardPai = actualType === 'reach' ? reachPai : (actual.pai || null)
  const aiDiscardPai = aiType === 'reach' ? aiReachPai : (ai.pai || null)
  // 立直帧：actual/expected 都是 reach（is_equal 恒为 true），真正的分歧在
  // 「立直打哪张」——用推导出的「你立直打牌」与「AI 立直打牌」是否一致来判定异议。
  // 例如 AI 立直打 4m、你立直打 8m，应判为异议（no）而非一致。
  const isReachDiff = actualType === 'reach' && (discardPai || aiDiscardPai) && discardPai !== aiDiscardPai
  const isEqual = actualType === 'reach' ? !isReachDiff : enIsEqual
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
  } else if (actualType === "none") {
    // 玩家无实际动作（跳过/无响应）：这是「其他家出牌、你跳过」的帧。
    // 在右侧显示对方打出的牌 + 来源（上家/对家/下家），让玩家看到他家出了什么。
    // 注意：Mortal 在 none 帧的 en.tile/last_actor 偶有错位，但本帧的 tile 即对方刚打出的牌，
    // 用 last_actor 与 actorId 的差定位来源，错位风险可控（虚建议和牌帧已在主循环单独跳过）。
    frameName = 'action.png'
    const targetStr = getDiff(actorId, lastActor)
    frameStr = `${targetStr}出牌`
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
    // 立直打牌：从后续 entry 推导出的 discardPai；摸切(打出==摸到)时左手不抬。
    // 注意：不要 fallback 到 tehai[0]，否则会高亮错误的牌（如把 4m 当成立直打牌）。
    actualPais = isTsumogiri ? [] : (discardPai ? [discardPai] : [])
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
    try { haiImg = await loadResImage(`review_texture/${paiBase}/${hai}.png`) } catch(e) { continue }
    
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
      try { pimg = await loadResImage(`review_texture/${paiBase}/${_fuuroPai}.png`) } catch(e) { continue }

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
          try { aImg = await loadResImage(`review_texture/${paiBase}/${pais[addedIdx]}.png`) } catch(e) { aImg = null }
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
  // 4. none（他家出牌、玩家跳过）显示对方打出的牌
  // 碰/吃后的打牌其 tile 是副露牌，不应再画在右侧。
  // 自摸打牌（isSelfDraw）显示"自己摸到"；碰/吃/杠显示获得的牌；荣和显示荣和的牌；
  // none 帧显示上家/对家/下家打出的牌（来源见上方 frameStr）。
  if (nowPai && (isSelfDraw || actualType === 'none' || ['pon', 'chi', 'kan', 'kakan', 'hora'].includes(actualType))) {
    try { 
      nowHaiImg = await loadResImage(`review_texture/${paiBase}/${nowPai}.png`) 
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

  return { canvas, actorId, isMatch: isEqual }
}

const api = new MajsoulApi()

function getRandomPersonFull() {
  // 用 pluginRoot 而非 process.cwd()：后者只有在 TRSS-Yunzai 根目录启动时才指向正确位置，
  // 从插件目录直接运行（测试/脚本）会拼成 plugins/Majsoul-Plugin/plugins/Majsoul-Plugin/... 而 ENOENT。
  const dirPath = path.join(pluginRoot, 'resources', 'person_full')
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

// 从 resources/person（角色头像图）随机取一张，用于表外皮肤的头像兜底
function getRandomPerson() {
  const dirPath = path.join(pluginRoot, 'resources', 'person')
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.png'))
    if (files.length === 0) return null
    const randomIndex = Math.floor(Math.random() * files.length)
    return `person/${files[randomIndex]}`
  } catch (e) {
    if (typeof logger !== 'undefined') logger.warn(`[render.js] 读取person目录失败: ${e.message}`)
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

/**
 * 段位卡。
 *
 * 素材有两版，坐标不同，需按实际加载到的版本调整：
 *   rank_bg2.png（新）：保持 600x320，把「场次/均顺位」上移 16px，
 *                       在下方预留「安定段」标签（文字块中心 y≈170, x 232~294）
 *   rank_bg.png（旧）：场次/均顺位在 y≈146，无安定段位
 * 缺失新素材时回落到旧素材与原坐标，保证兼容。
 *
 * @param {object|null} stableInfo { text, promo } 该模式的安定段位与升/掉段预计
 * @param {boolean} stableApplicable 本次查询是否存在「安定段位」这个概念
 *   （友人场/比赛场不存在）—— 为 false 时用无安定段槽的旧素材
 */
async function getRankIcon(level, stats, extended, mode = '4', stableInfo = null, stableApplicable = true) {
  // 以下两种情况用旧素材 rank_bg.png（无「安定段」槽），不预留标签位：
  //   1) 初心段位 —— 安定段位数学上无定义（rankpt=0 且不可掉段）；
  //   2) 本次查询不存在安定段概念（友人场/比赛场）—— 留槽只会显示「—」，
  //      看起来像渲染缺失，而实际上该字段对本次查询根本不存在。
  // 其余情况用新素材 rank_bg2.png（带安定段位槽）；此时若无数据（如房间筛选
  // 下该房间南场无对局）会在槽内显示「—」，表示「有此概念但暂无数据」。
  // level.major_rank 是字符串段位名，level._majorRank 是数字 1~6。
  const isBeginner = level && level._majorRank === 1
  let rankbg, hasStableSlot = false
  if (!isBeginner && stableApplicable) {
    try {
      rankbg = await loadResImage('info_texture/rank_bg2.png')
      hasStableSlot = true
    } catch (e) {
      rankbg = await loadResImage('info_texture/rank_bg.png')
    }
  } else {
    rankbg = await loadResImage('info_texture/rank_bg.png')
  }
  const canvas = createCanvas(rankbg.width, rankbg.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(rankbg, 0, 0)

  const rankIcon = await getRankImg(level.major_rank, level.minor_rank, mode, 156, level._adjustedScore)
  ctx.drawImage(rankIcon, 51, 28)

  const avgRank = stats.avg_rank ? stats.avg_rank.toFixed(2) : "0.00"
  const firstRate = getRate(stats.rank_rates[0])
  const rongRate = getRate(extended["和牌率"])
  const chongRate = getRate(extended["放铳率"])

  // 段位名与分数：新素材（rank_bg2）方框中心 y=62，旧素材（rank_bg）中心 y=78。
  // 旧素材无安定段位槽，沿用原坐标。
  const nameY = hasStableSlot ? 62 : 78
  drawText(ctx, level.full_tag, 296, nameY, 44, '#FFFFFF', 'center', 'bold')
  drawText(ctx, level.real_display_score, 461, nameY, 28, '#C1C1C1', 'center')

  // 场次/均顺位：新素材标签中心 y=121，旧素材 y=146。
  const rowY = hasStableSlot ? 121 : 146
  drawText(ctx, String(stats.count), 282, rowY, 32, '#FFFFFF', 'left', 'bold')
  drawText(ctx, avgRank, 458, rowY, 32, '#FFFFFF', 'left', 'bold')

  // 安定段：素材自带「安定段」标签（中心 y=163，x 232~294），数值紧随其后。
  // 只显示安定段位与预计战数，**不显示期望值**（E[PT] 对玩家无意义）。
  // 可用横向区间仅 x 300~548（248px），内容过长时自动缩字号，避免与预计战数重叠。
  // 该模式无南场数据时在数值位写「—」，避免看似渲染缺失。
  if (hasStableSlot) {
    const LEFT_X = 300, RIGHT_X = 548, AVAIL = RIGHT_X - LEFT_X
    const ROW_Y = 163
    if (stableInfo && stableInfo.text) {
      const promo = stableInfo.promo || ''
      // 从大到小试字号，取第一个能放下的组合。
      // 步长 1px 而非 2px：魂天玩家的安定段位带「魂天±X.XX珠」前缀，长度介于
      // 「雀圣3.00」与「雀豪3.34」之间，2px 步长会多降一档、字号偏小。
      const steps = [[26, 21], [25, 20], [24, 19], [23, 18], [22, 17], [21, 16], [20, 15], [19, 14], [18, 13]]
      let chosen = steps[steps.length - 1]
      for (const [s1, s2] of steps) {
        ctx.font = `bold ${s1}px "Microsoft YaHei", sans-serif`
        const w1 = ctx.measureText(stableInfo.text).width
        ctx.font = `bold ${s2}px "Microsoft YaHei", sans-serif`
        const w2 = promo ? ctx.measureText(promo).width : 0
        if (w1 + (promo ? 16 + w2 : 0) <= AVAIL) { chosen = [s1, s2]; break }
      }
      const [s1, s2] = chosen
      drawText(ctx, stableInfo.text, LEFT_X, ROW_Y, s1, '#FFFFFF', 'left', 'bold')
      if (promo) drawText(ctx, promo, RIGHT_X, ROW_Y, s2, '#FFFFFF', 'right', 'bold')
    } else {
      drawText(ctx, '—', LEFT_X, 170, 26, '#5A6272', 'left', 'bold')
    }
  }

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

/**
 * 从本地 API 的 statistics 里取出「模式 × 对局类别」对应的那一条。
 *
 * mahjongCategory：1 四麻 / 2 三麻；gameCategory：1 友人场 / 2 段位场 / 4 比赛场。
 * gameType=1（真正的对局记录）优先，取不到再退回该类别下任意 gameType。
 *
 * 注意 gameCategory=2 的这一条是**段位场整体**：finalPositionCounts 为全量顺位累计
 * （含铜银金玉，不区分房间），recentGames 为该玩家**真实时间序**的最近对局
 * （同样跨全部房间）。这正是牌谱屋做不到的部分 —— 牌谱屋的 mode 参数只能圈定
 * 金/玉/王座，圈不到铜银（恒 404）。
 *
 * @returns {object|null}
 */
function pickLocalEntry (statRes, mode, gc = 2) {
  if (!statRes || !Array.isArray(statRes.entries)) return null
  const mc = String(mode) === '3' ? 2 : 1
  return statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === gc && x.gameType === 1)
    || statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === gc)
    || null
}

/**
 * 用本地 API 统计（gameCategory=gc）填充牌谱屋无数据的模式（缺失字段保持零）。
 * gc=2 段位场（覆盖铜银金玉），gc=1 友人场，gc=4 比赛场；
 * 这里仅把有对应关系的字段填上：
 *   count/rank_rates/avg_rank ← finalPositionCounts
 *   和牌率/自摸率/放铳率      ← winRate/tsumoRate/dealInRate
 *
 * @param {object} [statRes] 已取到的 statistics；显式传入（含 null）时不再重复请求。
 */
async function fillModeFromLocal (data, extended, uid, mode, gc = 2, statRes) {
  try {
    const stats = statRes !== undefined ? statRes : await getPlayerStatistics(uid)
    const entry = pickLocalEntry(stats, mode, gc)
    if (!entry) return
    const fpc = entry.finalPositionCounts || []
    const count = fpc.reduce((a, b) => (a || 0) + (b || 0), 0) || entry.roundCount || 0
    if (count > 0) {
      data.count = count
      data.rank_rates = fpc.map(c => (c || 0) / count)
      while (data.rank_rates.length < 4) data.rank_rates.push(0)
      data.rank_rates = data.rank_rates.slice(0, 4)
      data.avg_rank = fpc.reduce((a, c, i) => a + ((c || 0) * (i + 1)), 0) / count
    }
    if (entry.winRate != null) extended['和牌率'] = entry.winRate
    if (entry.tsumoRate != null) extended['自摸率'] = entry.tsumoRate
    if (entry.dealInRate != null) extended['放铳率'] = entry.dealInRate
    return entry
  } catch (e) {
    console.warn(`[render.js] 本地API填充模式${mode}数据失败: ${e.message}`)
    return null
  }
}

/**
 * 从本地 API 取段位场（gc=2，覆盖铜银金玉）的总场次数，按模式返回 { 4: count, 3: count }。
 * 牌谱屋只统计金之间以上，用于把卡片上的对局数覆盖为完整段位场次数；
 * sum(finalPositionCounts) 为全量顺位累计，不受 roundCount 封顶 100 限制。
 */
async function getLocalRankedCounts (uid, statRes) {
  try {
    const stats = statRes !== undefined ? statRes : await getPlayerStatistics(uid)
    if (!stats || !Array.isArray(stats.entries)) return null
    const pick = (mc) => {
      const entry = pickLocalEntry(stats, mc === 2 ? 3 : 4, 2)
      if (!entry) return null
      const count = (entry.finalPositionCounts || []).reduce((a, b) => (a || 0) + (b || 0), 0) || entry.roundCount || 0
      return count > 0 ? count : null
    }
    return { 4: pick(1), 3: pick(2) }
  } catch (e) {
    console.warn(`[render.js] 本地API获取段位场总场次失败: ${e.message}`)
    return null
  }
}

/**
 * 对局记录拉取场数。
 *
 * 走势图只画 16 场（record_bg 宽 1000，点位 x = 108 + i*50，16 个点恰好到 x858），
 * 但「绝好调 / 恶调中」需要最近 RANK_WINDOW(20) 场顺位率，故一次取 20 场：
 * 两者共用同一次请求，不多发。走势图只取前 16 个点绘制。
 */
const RECORD_FETCH_LIMIT = Math.max(16, RANK_WINDOW)

/**
 * 走势图绘制的点位数（record_bg 宽 1000，点位 x = 108 + i*50，16 点恰好到 x858）。
 * 模块级：preferLocalRecord 需据此判断本地顺位序列是否够画满一张图。
 */
const CHART_POINTS = 16

/**
 * 无牌谱屋数据时，用本地 recentGames（顺位序列）构造走势图所需 record。
 * 走势图按 旧→新 从左到右绘制，故 record 需为 新→旧（chart 内会 reverse）。
 *
 * @param {number} limit 取最近多少场（默认 16，走势图用；标签需要更多时传 RECORD_FETCH_LIMIT）
 */
function buildLocalRecord (entry, nickname, mode, limit = 16) {
  if (!entry || !Array.isArray(entry.recentGames) || entry.recentGames.length === 0) return []
  const n = mode === '3' ? 3 : 4
  return entry.recentGames.slice(-limit).reverse().map(g => {
    const k = (g && g.rank != null && g.rank >= 1 && g.rank <= n) ? g.rank : n
    const players = []
    for (let i = 0; i < n; i++) {
      players.push({ nickname: i === (k - 1) ? nickname : `__p${i}`, score: (n - i) * 100 })
    }
    return { players }
  })
}

/**
 * 为走势图与「绝好调 / 恶调中」选择数据源：本地 recentGames 优先，返回 null 表示沿用牌谱屋。
 *
 * 起因（实测用户三麻）：牌谱屋的 mode 参数只能圈定**金/玉/王座**
 * （四麻 16.12.9.15.11.8、三麻 22.24.26.21.23.25），**圈不到铜之间(2/3、17/18)
 * 与银之间(5/6、19/20)** —— 对这两档牌谱屋恒返回 404。于是玩家近期改打银之间、
 * 历史上有金之间对局时，牌谱屋仍能返回**几个月前的金之间对局**且被当成「最近对局」，
 * 走势图与顺位率全部失真。
 *
 * 本地 API 的段位场 recentGames 是**跨全部房间的真实时间序**（不区分房间，
 * 上限 50 场），因此只要本地覆盖的对局数**严格多于**牌谱屋（说明存在牌谱屋
 * 看不到的房间），就以本地顺位序列为准。相等时不切换 —— 那说明玩家只打
 * 金/玉/王座，牌谱屋的记录本就是完整的，保持原有行为。
 *
 * 另需本地序列足够长（≥ CHART_POINTS），否则宁可继续用牌谱屋的 16 场，
 * 避免把走势图从 16 点缩短成几个点。
 *
 * @returns {Array|null} record（新→旧）；返回 null 时调用方应改用牌谱屋
 */
function preferLocalRecord (localEntry, paipuCount, nickname, mode, limit) {
  const recent = localEntry?.recentGames
  if (!Array.isArray(recent) || recent.length < CHART_POINTS) return null
  const localTotal = (localEntry.finalPositionCounts || []).reduce((a, b) => a + (b || 0), 0)
  const paipu = Number(paipuCount) || 0
  // 严格大于：本地统计含铜/银，牌谱屋只看金/玉/王座，故「本地更多」即存在隐藏房间
  if (!(localTotal > paipu)) return null
  return buildLocalRecord(localEntry, nickname, mode, limit)
}

/**
 * 从对局记录（新→旧）提取「最近 window 场」的顺位序列，供「绝好调 / 恶调中」判定。
 *
 * 顺位判定与走势图完全一致（按 score 降序、找自己昵称的下标），
 * 因此不会出现「图上是 1 位、标签却按末位算」的矛盾。找不到自己时按末位处理。
 *
 * @param {Array} records 新→旧的记录数组，元素含 players[{nickname, score}]
 * @param {string} nickname 本人昵称
 * @param {number|string} mode 4 或 3
 * @param {number} window 窗口场数
 * @returns {Array<{rank:number}>|null}
 */
function extractRecentRanks (records, nickname, mode, window) {
  if (!Array.isArray(records) || !nickname || !window) return null
  const n = mode === '3' ? 3 : 4
  const out = []
  for (const r of records) {
    if (!r || !Array.isArray(r.players) || r.players.length === 0) continue
    const sorted = r.players.slice().sort((a, b) => (b.score || 0) - (a.score || 0))
    let idx = sorted.findIndex(p => p.nickname === nickname)
    if (idx < 0) idx = n - 1
    out.push({ rank: idx + 1 })
    if (out.length >= window) break
  }
  return out.length ? out : null
}

// 本地数据卡片（details_bg_3/4.png）下方对局走势区：
// 以 record_bg_3/4.png 为背景（在原生 1000x400 坐标系绘制，再整体缩放到卡片趋势区），
// 按旧→新画最近16场顺位点线，顶部写「最近16场对局记录走势」标题。
/**
 * 牌谱屋查不到时（铜/银等金之间以下段位），用本地 API 的段位场数据算安定段位。
 *
 * 本地 API 的 statistics 按 mahjongCategory × gameCategory 给出「段位场」整体数据，
 * **不区分房间** —— 这正适合按段位判断的用法（用户确认：按段位判断，用混合数据算）。
 *
 * 数据构成（实测本地 API）：
 *   finalPositionCounts  各顺位次数，**全量**（含铜银金玉，如 1456 场）
 *   recentGames[{rank,finalPoint}]  最近若干场（**上限 50 场**），用于聚合各顺位平均点数
 *
 * 因此：顺位率用全量 fpc（可靠），各顺位平均点数用 recentGames 聚合（样本较小，
 * 是精度的主要瓶颈）。对低段位玩家而言这是唯一可用的途径 —— 牌谱屋完全不覆盖他们。
 *
 * @returns {{room:number, stats:object, sr:object, count:number}|null}
 */
async function stableRankFromLocal (uid, mode, curLevelId, statRes) {
  try {
    const m = String(mode) === '3' ? 3 : 4
    const n = m === 3 ? 3 : 4
    const statResolved = statRes !== undefined ? statRes : await getPlayerStatistics(uid)
    const entry = pickLocalEntry(statResolved, m, 2)
    if (!entry) return null

    const fpc = entry.finalPositionCounts || []
    const total = fpc.slice(0, n).reduce((a, b) => a + (b || 0), 0)
    if (!total) return null

    // recentGames → 各顺位平均点数
    const cnt = new Array(n).fill(0), sum = new Array(n).fill(0)
    for (const g of (entry.recentGames || [])) {
      const r = g?.rank
      if (!(r >= 1 && r <= n)) continue
      cnt[r - 1]++; sum[r - 1] += (g.finalPoint || 0)
    }
    let aggTotal = cnt.reduce((a, b) => a + b, 0)
    if (!aggTotal) return null
    const rankAvgScore = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0)

    // 取准入范围内最高房间作为计算基准
    const rooms = stableRankEligibleRooms(m, curLevelId)
    if (!rooms.length) return null

    const stats = {
      count: total,
      rank_rates: fpc.slice(0, n).map(c => (c || 0) / total),
      rank_avg_score: rankAvgScore,
      level: { id: curLevelId }
    }
    for (const room of rooms) {
      const sr = computeStableRank(stats, room, m)
      if (sr) return { room, stats, sr, count: total, local: true }
    }
    return null
  } catch (e) {
    return null
  }
}

/**
 * 本地兜底卡（details_bg_3/4，870x646）的牌风带与走势图布局。
 *
 * bg 已自带「牌风」标题（x45~86, y179~199）与牌风下线（y224~227），
 * 牌风带净空 y156~223（68px，容 2 行 28+8+28=64px），走势区自 y228 起。
 * 走势图按 **1:1 原尺寸**贴入（不缩放）—— record_bg 1000x400，
 * 卡片宽 870 故水平居中后左右各裁 65px（内容实际在 x116~880，不受影响）。
 */
const LOCAL_TAG_X = 112         // 标签起点（「牌风」标题右边界 x86 + 26px 间距）
const LOCAL_TAG_W = 709         // 到数据蓝线右端 x821
const LOCAL_TAG_Y0 = 156        // 牌风带顶（数据蓝线 y152~155 之下）
const LOCAL_TAG_BAND_H = 68     // 牌风带高（y156~223）
const LOCAL_TAG_ROW_H = 28
const LOCAL_TAG_GAP = 8
const LOCAL_TAG_FONT = 24
const LOCAL_TAG_PADX = 14
const LOCAL_TREND_TOP = 228     // 走势图起点（牌风下线 y224~227 之后）

async function drawLocalTrend (ctx, recentGames, mode, roomLabel = null, top = LOCAL_TREND_TOP) {
  const recordBg = await loadResImage(mode === '3' ? 'info_texture/record_bg_3.png' : 'info_texture/record_bg_4.png')
  // **1:1 原尺寸**贴入（不缩放），水平居中。record_bg 为 1000x400 而卡片宽 870，
  // 居中后左右各溢出 65px —— 溢出部分落在卡外且为透明边（内容实际在 x116~880），
  // 故不影响观感；这样走势图保持原生大小，不会被压缩变形。
  const cw = ctx.canvas.width
  const scale = 1
  const newW = recordBg.width
  const newH = recordBg.height
  const drawX = Math.round((cw - newW) / 2)
  const rc = createCanvas(recordBg.width, recordBg.height)
  const rctx = rc.getContext('2d')
  rctx.drawImage(recordBg, 0, 0)

  const RANK_POS_4P = { 4: 316, 3: 237, 2: 155, 1: 73 }
  const RANK_POS_3P = { 3: 316, 2: 199, 1: 73 }
  const RANK_POS = mode === '3' ? RANK_POS_3P : RANK_POS_4P

  // 本地 API 的 recentGames 为 旧→新 顺序，直接取最近16场并按原序从左(旧)到右(新)绘制
  const list = (recentGames || []).slice(-16)
  if (!list.length) {
    drawText(rctx, '暂无对局数据', 500, 200, 34, '#888888', 'center', 'bold')
  } else {
    let posPrev = null
    for (let i = 0; i < list.length; i++) {
      const g = list[i]
      const n = mode === '3' ? 3 : 4
      const k = (g && g.rank != null && g.rank >= 1 && g.rank <= n) ? g.rank : n
      const pos = { x: 108 + i * 50, y: RANK_POS[k] }
      if (posPrev) {
        rctx.beginPath()
        rctx.moveTo(posPrev.x + 15, posPrev.y + 15)
        rctx.lineTo(pos.x + 15, pos.y + 15)
        rctx.strokeStyle = '#FFFFFF'
        rctx.lineWidth = 3
        rctx.stroke()
      }
      const rankDot = await loadResImage(`info_texture/rank_${k}.png`)
      rctx.drawImage(rankDot, pos.x, pos.y)
      posPrev = pos
    }
  }

  // 整体缩放到趋势区（y=140 至卡片底部），水平居中，使走势图尽量贴近牌谱屋原生大小
  ctx.drawImage(rc, drawX, top, newW, newH)
  drawText(ctx, `${roomLabel ? roomLabel : ''}最近16场对局记录走势`, 435, top + 34 * scale, 34, '#FFFFFF', 'center', 'bold')
}

export async function drawMajsInfoImg(uid, mode = '4', realtimePT = null, roomFilter = null, playerName = null, scope = null) {
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

  // 友人场/比赛场：出本地卡，数据范围 gameCategory=1/4，走势标题加房间名
  const scopeCfg = {
    friend: { gc: 1, label: '友人场' },
    match: { gc: 4, label: '比赛场' }
  }
  const scopeInfo = scopeCfg[scope] || null
  const scopeGc = scopeInfo ? scopeInfo.gc : 2
  const scopeLabel = scopeInfo ? scopeInfo.label : ''

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
  // 友人场/比赛场始终出本地卡，跳过该判断，直接走下方 fillModeFromLocal 填充
  let otherData = null
  if (!scopeInfo && ((mainMode === 3 && data3.retcode) || (mainMode === 4 && data4.retcode))) {
    const otherMode = mainMode === 3 ? 4 : 3
    try {
      otherData = await fetchStats(otherMode)
    } catch {
      otherData = null
    }
    // 两模式都 404（无金之间对局）不返回标记：下方 fillModeFromLocal 用本地段位场(gc=2)数据出本地卡
  }

  // 先记录主模式是否有有效数据（retcode 会被下方抹掉，后续判断需依赖此标记）
  const data4Valid = data4 && !data4.retcode
  const data3Valid = data3 && !data3.retcode

  // 本地 API 段位场统计：**整个渲染流程只取一次**，供四处共用
  // （此前 fillModeFromLocal / getLocalRankedCounts / stableRankFromLocal 各自
  //   独立请求同一接口，最多重复 3 次）：
  //   1) 牌谱屋无数据时的统计字段填充（fillModeFromLocal）
  //   2) 走势图与「绝好调/恶调中」的顺位序列（recentGames，见下）
  //   3) 卡片上的段位场总场次（getLocalRankedCounts）
  //   4) 低段位玩家的安定段位兜底（stableRankFromLocal）
  let localStats = null
  try {
    localStats = await getPlayerStatistics(uid)
  } catch (e) {
    console.warn(`[render.js] 本地API统计获取失败: ${e.message}`)
  }

  const localEntry4 = pickLocalEntry(localStats, 4, scopeGc)
  const localEntry3 = pickLocalEntry(localStats, 3, scopeGc)
  // 主模式 404 或友人场/比赛场时，用本地 API 对应房间（gc=scopeGc）数据填充统计字段。
  // 注意：零对象无 retcode，必须先取好真实昵称再替换，否则替换后 if(retcode) 判断会失效导致兜底不执行；
  // 友人场/比赛场且有牌谱屋数据时不重置（保留昵称/段位），仅覆盖统计字段。
  //
  // ⚠️ 昵称不能取带 retcode 的模式数据：
  //   牌谱屋 404（铜银玩家无金之间对局）时 data3/data4 已被 fetchStats 换成
  //   `{...playerStatsZero, retcode:-404}`，其 nickname 是**空串占位符**
  //   （playerStatsZero.nickname 已置空，见 PlayerLevel.js）。空串本身不会造成
  //   `||` 短路，但带 retcode 的数据整体就代表「无数据」，不应作为昵称来源。
  //   优先级：显式昵称查询 > 本地 API 实时昵称 > 本模式牌谱屋 > 另一模式牌谱屋 > UID。
  const nameOf = d => (d && !d.retcode) ? d.nickname : null
  if (data4.retcode || scopeInfo) {
    const realName = playerName || realtimePT?.nickname || nameOf(data4) || nameOf(otherData) || nameOf(data3) || String(uid)
    if (data4.retcode) {
      data4 = JSON.parse(JSON.stringify(playerStatsZero))
      data4.nickname = realName
      extended4 = JSON.parse(JSON.stringify(playerExtendZero))
    }
    await fillModeFromLocal(data4, extended4, uid, 4, scopeGc, localStats)
  }
  if (data3.retcode || scopeInfo) {
    const realName = playerName || realtimePT?.nickname || nameOf(data3) || nameOf(otherData) || nameOf(data4) || String(uid)
    if (data3.retcode) {
      data3 = JSON.parse(JSON.stringify(playerStatsZero))
      data3.nickname = realName
      extended3 = JSON.parse(JSON.stringify(playerExtendZero))
    }
    await fillModeFromLocal(data3, extended3, uid, 3, scopeGc, localStats)
  }
  

  if (extended4.retcode) extended4 = JSON.parse(JSON.stringify(playerExtendZero))
  if (extended3.retcode) extended3 = JSON.parse(JSON.stringify(playerExtendZero))

  // 牌谱屋原始场次（金/玉/王座口径）：必须在下方「用本地总场次覆盖 count」之前留存，
  // preferLocalRecord 靠它判断本地是否覆盖了牌谱屋看不到的房间（铜/银）。
  const paipuCount4 = data4.count || 0
  const paipuCount3 = data3.count || 0

  let _mode, data, extended, record
  if (mode === "3") {
    _mode = "三麻战绩"
    data = data3
    extended = extended3
    // 数据源选择：牌谱屋圈不到铜/银之间，玩家改打银之间时会一直显示旧的金之间对局，
    // 本地 recentGames 跨全部房间（见 preferLocalRecord），本地覆盖更全时以它为准。
    const localRec3 = (!scopeInfo && !roomFilter)
      ? preferLocalRecord(localEntry3, paipuCount3, data3.nickname, '3', RECORD_FETCH_LIMIT)
      : null
    if (localRec3) {
      record = localRec3
    } else if (data3Valid && !scopeInfo) {
      try {
        record = await api.getRecentRecords(uid, 3, RECORD_FETCH_LIMIT)
      } catch (e) {
        console.warn(`[render.js] 获取三麻最近对局失败: ${e.message}`)
        record = []
      }
    } else {
      record = buildLocalRecord(localEntry3, data3.nickname, '3', RECORD_FETCH_LIMIT)
    }
      if (roomFilter && data3Valid) {
        const mp = (roomFilter.ids[3] || []).join(',')
        let rdOk = false
        try {
          const rd = await api.getPlayerStats(uid, 3, mp)
          if (rd && !rd.retcode) { data = rd; rdOk = true }
        } catch (e) {}
        if (!rdOk) data = { ...JSON.parse(JSON.stringify(playerStatsZero)), nickname: data.nickname }
        try {
          const re = await api.getPlayerExtendedStats(uid, 3, mp)
          if (re && !re.retcode) extended = re
          else extended = JSON.parse(JSON.stringify(playerExtendZero))
        } catch (e) { extended = JSON.parse(JSON.stringify(playerExtendZero)) }
        try {
          const rr = await api.getRecentRecords(uid, 3, RECORD_FETCH_LIMIT, mp)
          if (rr && !rr.retcode && Array.isArray(rr) && rr.length) record = rr
          else record = []
        } catch (e) { record = [] }
      }
  } else {
    _mode = "四麻战绩"
    data = data4
    extended = extended4
    // 数据源选择：同上（牌谱屋圈不到铜/银之间）
    const localRec4 = (!scopeInfo && !roomFilter)
      ? preferLocalRecord(localEntry4, paipuCount4, data4.nickname, '4', RECORD_FETCH_LIMIT)
      : null
    if (localRec4) {
      record = localRec4
    } else if (data4Valid && !scopeInfo) {
      try {
        record = await api.getRecentRecords(uid, 4, RECORD_FETCH_LIMIT)
      } catch (e) {
        console.warn(`[render.js] 获取四麻最近对局失败: ${e.message}`)
        record = []
      }
    } else {
      record = buildLocalRecord(localEntry4, data4.nickname, '4', RECORD_FETCH_LIMIT)
    }
    if (roomFilter && data4Valid) {
      const mp = (roomFilter.ids[4] || []).join(',')
      let rdOk = false
      try {
        const rd = await api.getPlayerStats(uid, 4, mp)
        if (rd && !rd.retcode) { data = rd; rdOk = true }
      } catch (e) {}
      if (!rdOk) data = { ...JSON.parse(JSON.stringify(playerStatsZero)), nickname: data.nickname }
      try {
        const re = await api.getPlayerExtendedStats(uid, 4, mp)
        if (re && !re.retcode) extended = re
        else extended = JSON.parse(JSON.stringify(playerExtendZero))
      } catch (e) { extended = JSON.parse(JSON.stringify(playerExtendZero)) }
      try {
        const rr = await api.getRecentRecords(uid, 4, RECORD_FETCH_LIMIT, mp)
        if (rr && !rr.retcode && Array.isArray(rr) && rr.length) record = rr
        else record = []
      } catch (e) { record = [] }
    }
  }

  for (let s in playerExtendZero) {
    if (extended[s] === undefined) extended[s] = playerExtendZero[s]
  }

  if (record.retcode) record = []

  // 卡片同时绘制四麻与三麻两个段位图标（各带对局数），两者都用本地 API 段位场总场次
  // 覆盖（牌谱屋仅统计金之间以上）；仅默认段位场查询生效，友人/比赛场、房间筛选保持牌谱屋原值。
  // 主模式 404 的场景 fillModeFromLocal 已直接填好本地总场次，此处跳过该模式。
  if (!scopeInfo && !roomFilter) {
    const localCounts = await getLocalRankedCounts(uid, localStats)
    if (localCounts) {
      if (data4Valid && localCounts[4] != null) data4.count = localCounts[4]
      if (data3Valid && localCounts[3] != null) data3.count = localCounts[3]
    }
  }

  let level4Score = data4.level?.score + data4.level?.delta || 0
  let level3Score = data3.level?.score + data3.level?.delta || 0

  // 安定段位：四麻/三麻各自独立计算（卡片有两张段位卡，各显示各的）。
  //
  // 做法：**逐房间查询，再按局数加权**（computeStableRankWeighted）。
  // 玩家通常同时打东场与南场、以及不同等级的房间，只取其中一个会答非所问。
  // 加权模型：
  //   E(v) = Σ_r  w_r × [ E_r[PT]不含罚分 + pen_r(v) × 末位率_r ]   ，求 E(v)=0
  // 其中 w_r 是房间 r 的局数占比，各房间**用自己的 PT 表与罚分表**
  // （东 rankpt1 / 南 rankpt2），v 是规范段位轴（豪1=1.00…圣3=6.00）。
  //
  // ⚠️ 不能把东+南的统计池化后喂单表：两表量纲不同（四麻东每星 10 PT、
  // 南每星 15 PT），池化相当于把两种量纲加权平均（实测平均偏 0.26 星、最大 1.56 星）。
  //
  // 房间选择：**先按当前段位过滤准入房间**（东场、南场各一份）。
  // 不能只按等级排序：雀豪玩家的王南数据是过去雀圣时期打的，用那段算会产出
  // 「雀杰3.99」这类与当前水平无关的结果（实测 UID 16644588）。
  //
  // 数据来源：优先牌谱屋（精度高）；牌谱屋查不到时（铜/银等金之间以下段位，
  // 实测恒为 404）用本地 API 兜底 —— 本地 API 的段位场数据覆盖**全部段位**，
  // 且 finalPositionCounts 是全量顺位率（不区分房间，正适合按段位判断的用法）。
  //
  // 「安定段位」这个概念在哪些查询里存在：
  //   默认段位场 —— 有（数据来自牌谱屋/本地 API 的 gc=2 段位场）；
  //   房间筛选   —— 有（用户指定了具体房间，取其东场+南场按局数加权）；
  //   友人场/比赛场 —— **没有**：数据来自本地 API 的 gc=1/4，与段位场（gc=2）是
  //     不同的对局集合，其顺位率/平均点数不适用于段位场 PT 模型。
  const stableApplicable = !scopeInfo

  const stableByMode = { 4: null, 3: null }
  if (stableApplicable) {
    for (const m of [4, 3]) {
      const rtKey = m === 3 ? 'threePlayer' : 'fourPlayer'
      const modeValid = m === 4 ? data4Valid : data3Valid

      // 当前段位优先取本地 API 的实时值，其次牌谱屋
      const modeData = m === 4 ? data4 : data3
      const curLevelId = realtimePT?.[rtKey]?.levelId ?? modeData.level?.id

      // 房间筛选：用户指定了一个等级，取该等级的东场+南场两个 id，
      // 其安定段位即这两个场次的混合结果（各用各的表，按局数加权）。
      // 其余情况：按当前段位准入范围，东场与南场都取（同样按局数加权，见下）。
      const candidates = roomFilter
        ? stableRankFilterRooms(m, roomFilter.ids[m])
        : [...stableRankEligibleRooms(m, curLevelId, false), ...stableRankEligibleRooms(m, curLevelId, true)]

      // 1) 牌谱屋：把候选房间**逐个查全**（不再取第一个就停）。
      // 因为安定段位要按局数加权各房间：玩家可能同时打东场与南场、以及不同等级的房间，
      // 只取一个房间会答非所问。数据量不大（每模式至多 10 个房间），且失败房间会被跳过。
      const entries = []
      if (modeValid) {
        for (const srRoom of candidates) {
          try {
            const rs = await api.getPlayerStats(uid, m, String(srRoom))
            if (!rs || rs.retcode || !rs.count) continue
            entries.push({ roomId: srRoom, stats: rs, count: rs.count })
          } catch (e) { /* 无该房间数据（404）：跳过 */ }
        }
      }

      // 2) 牌谱屋全无数据 → 本地 API 兜底。
      // 本地段位场数据覆盖全部段位（finalPositionCounts 全量），牌谱屋不覆盖的低段位
      // 与「该模式牌谱屋 404」两种情况都靠这里出结果 —— 此前用 continue 提前跳过整个
      // 分支，导致三麻 404 时连本地兜底也走不到，安定段只能显示「—」（实测 UID 14367043）。
      //
      // 房间筛选时**不能**走本地兜底：本地 API 的 finalPositionCounts 是段位场整体
      // （不区分房间），拿它算「玉之间安定段位」等于答非所问 —— 宁可显示「—」。
      let sr = null
      if (entries.length) {
        sr = computeStableRankWeighted(entries, m)
      } else if (!roomFilter) {
        const local = await stableRankFromLocal(uid, m, curLevelId, localStats)
        if (local) { sr = local.sr; entries.push({ roomId: local.room, stats: local.stats, count: local.count }) }
      }

      if (sr && entries.length) {
        // 升/掉段预计战数：用**局数最多的房间**作代表（该房间是玩家当前的主场，
        // 其 PT 表与罚分最能反映实际涨跌速度）。当前段位与分数优先取实时值
        // （牌谱屋的 level.score 有延迟，实时值才能算准「还差多少分」）。
        const main = entries.reduce((a, b) => (b.count > a.count ? b : a))
        const liveId = realtimePT?.[rtKey]?.levelId
        const liveScore = realtimePT?.[rtKey]?.score
        const estStats = (liveId != null)
          ? { ...main.stats, level: { ...main.stats.level, id: liveId } }
          : main.stats
        const curScore = (liveScore != null) ? liveScore : main.stats.level?.score
        let promo = ''
        if (typeof curScore === 'number') {
          const rc = estimateGamesToRankChange(estStats, main.roomId, curScore)
          // 魂天的「掉魂花」在游戏内同样显示为掉段，故文案统一用「掉段」，
          // 不出现「掉花」字样；flower 仅用于判断阈值（魂花 15/10/5）。
          if (rc?.promote) promo = `约${rc.promote}战升段`
          else if (rc?.flower) promo = `约${rc.flower}战掉段`
          else if (rc?.demote) promo = `约${rc.demote}战掉段`
        }
        const totalCount = entries.reduce((s, e) => s + e.count, 0)
        stableByMode[m] = { text: sr.text, promo, room: main.roomId, count: totalCount }
      }
    }
  }

  if (realtimePT) {
    if (realtimePT.fourPlayer) {
      // 优先用本地 API 直给的 levelId（已包含模式位 1/2），跳过 parseRankFromText
      let level4Id = null;
      if (realtimePT.fourPlayer.levelId != null) {
        level4Id = realtimePT.fourPlayer.levelId;
      } else if (realtimePT.fourPlayer.rank) {
        const rank4 = parseRankFromText(realtimePT.fourPlayer.rank);
        level4Id = 1 * 10000 + rank4.majorRank * 100 + rank4.minorRank;
      }
      if (level4Id != null) {
        data4.level = { ...data4.level, id: level4Id };
      }
      // 本地 API 为实时数据：直给 score，不走 useApiScore 分支；仅在旧 BotLink 结构时回退原逻辑
      if (realtimePT.fourPlayer.levelId != null) {
        level4Score = realtimePT.fourPlayer.score;
        // 本地 API 魂天 score 为 pt 值(0-2000)，需 /100 换算为 rating(0-20) 显示
        if (level4Score != null && new PlayerLevel(level4Id, 0).isTenhou()) {
          level4Score = level4Score / 100;
        }
      } else if (realtimePT.fourPlayer.useApiScore && data4.level) {
        const apiScore = data4.level.score + (data4.level.delta || 0);
        const level4Obj = new PlayerLevel(data4.level.id, 0);
        level4Score = level4Obj.isTenhou() ? apiScore / 100 : apiScore;
      } else {
        level4Score = realtimePT.fourPlayer.score;
      }
    }
    if (realtimePT.threePlayer) {
      let level3Id = null;
      if (realtimePT.threePlayer.levelId != null) {
        level3Id = realtimePT.threePlayer.levelId;
      } else if (realtimePT.threePlayer.rank) {
        const rank3 = parseRankFromText(realtimePT.threePlayer.rank);
        level3Id = 2 * 10000 + rank3.majorRank * 100 + rank3.minorRank;
      }
      if (level3Id != null) {
        data3.level = { ...data3.level, id: level3Id };
      }
      if (realtimePT.threePlayer.levelId != null) {
        level3Score = realtimePT.threePlayer.score;
        // 本地 API 魂天 score 为 pt 值(0-2000)，需 /100 换算为 rating(0-20) 显示
        if (level3Score != null && new PlayerLevel(level3Id, 0).isTenhou()) {
          level3Score = level3Score / 100;
        }
      } else if (realtimePT.threePlayer.useApiScore && data3.level) {
        const apiScore = data3.level.score + (data3.level.delta || 0);
        const level3Obj = new PlayerLevel(data3.level.id, 0);
        level3Score = level3Obj.isTenhou() ? apiScore / 100 : apiScore;
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
  // 本地兜底卡片按模式区分：三麻 details_bg_3.png / 四麻 details_bg_4.png
  const detailsBg = await loadResImage(mode === '3' ? 'info_texture/details_bg_3.png' : 'info_texture/details_bg_4.png')
  const mid = await loadResImage('info_texture/mid.png')
  const title = await loadResImage('info_texture/title.png')

  // 取 bg 底边像素色，供画布向下延伸（牌风标签行）时填充，避免出现黑色断层
  let _bgBottomColor = '#0d1017'
  try {
    const probe = createCanvas(1, 1)
    const pctx = probe.getContext('2d')
    pctx.drawImage(bg, 0, bg.height - 1, 1, 1, 0, 0, 1, 1)
    const d = pctx.getImageData(0, 0, 1, 1).data
    _bgBottomColor = `rgb(${d[0]},${d[1]},${d[2]})`
  } catch (e) { /* 取色失败时用兜底色 */ }

  // 主模式牌谱屋无数据（本地兜底）时，详情区使用本地数据专用卡片（无柱状图，卡片更短）；
  // 友人场/比赛场始终出本地卡
  const useLocalDetail = scopeInfo ? true : (mainMode === 3 ? !data3Valid : !data4Valid)
  const detailBgImg = useLocalDetail ? detailsBg : detailBg
  const detailCanvas = createCanvas(detailBgImg.width, detailBgImg.height)
  const detailCtx = detailCanvas.getContext('2d')
  detailCtx.drawImage(detailBgImg, 0, 0)

  // 本地卡片不含柱状图区域：画布高度裁到「卡片底部 + 页脚」，不保留原 2200 高度
  const detailBottom = 1188 + detailCanvas.height

  // 牌风标签：两类卡都画在详情卡内的「牌风」带里，标题与分隔线均由各自的
  // bg 自带（标准卡 detail_bg.png、本地卡 details_bg_3/4.png），因此不需要为标签加高画布。
  // 样本不足（< MIN_GAMES_FOR_TAGS 场）时不出标签，避免统计噪声误导。
  let playerTags = []
  try {
    // 牌风标签有两类来源（THsBot 亦将两者统称「牌风」）：
    //   1) PCA 聚类牌风（PlayStyle.js）—— 需 10 个特征，牌谱屋缺失时算不出；
    //   2) 规则牌风（PlayerTags.js）—— 只需 和牌率/放铳率/顺位率，本地 API 亦可得。
    //
    // 友人场/比赛场同样计算：fillModeFromLocal 填充的字段与 gc 无关，
    // 顺位率（finalPositionCounts）+ 和牌率 + 放铳率 均取自本地 API 真实数据，
    // 足以判定规则牌风（实测友人场可出「防守大师 / 绝好调」）。
    // 聚类牌风因缺 副露率/立直率 等 7 个特征，在这些场景自然为 null，无需特殊处理。
    {
      // 聚类牌风排在规则牌风之前，用独立配色区分来源
      const ps = computePlayStyle(extended, mode, data.count)
      if (ps) playerTags.push({ text: ps.name, type: 'playstyle' })

      // 「绝好调 / 恶调中」用最近 RANK_WINDOW 场顺位率（状态词，不能用生涯均值）。
      // record 已含 RECORD_FETCH_LIMIT 场，此处取前 window 场；不足时该函数返回 null，
      // 两个标签自然不出（不报错）。
      const recentRanks = extractRecentRanks(record, data.nickname, mode, RANK_WINDOW)

      const r = buildPlayerTags(data, extended, mode, recentRanks)
      if (r.reliable) {
        // 聚类牌风已给出打法取向时，规则牌风里的「倾向」类与之语义重复
        // （如聚类「均衡型」与倾向「均衡」、「门清防守型」与「门清防守」），
        // 只保留强度/特征类，避免同一件事占两个标签位。
        const rest = ps ? r.tags.filter(t => t.type !== 'style') : r.tags
        playerTags.push(...rest)
      }
    }
  } catch (e) {
    console.warn(`[render.js] 牌风标签计算失败: ${e.message}`)
  }
  // 标签行高度与字号：两类卡都用 24px（原 20px，再早 15px；手机上过小难辨认）。
  // 标签放不下时先自动缩字号（最低 14px），仍缩不下才折叠为 +N。
  //
  // 标准（牌谱屋）卡：标签放进详情卡内、背景图「牌风」标题右侧的专用带。
  // detail_bg 实测：数据分隔线 y200~203，「牌风」标题 x113~154 / y227~247，
  // 带下线 y272~275 → 可用带 y204~271（68px）。
  // 纵向：2 行（行高 28 + 间距 8 = 64px）上下各留 2px，均匀分布。
  // 横向：**左对齐**紧贴标题（标题右边界 x154 + 14px 间距 = x168），
  // 右边界收到 x921（卡体 x72~927 内）；居中排布会让首行左侧空出 30px+，显得离标题过远。
  const TAG_DETAIL_ROW_H = 28
  const TAG_DETAIL_GAP = 8
  const TAG_DETAIL_Y0 = 204   // 带顶（y204~271）；实际起点由 centerInHeight 垂直居中决定
  const TAG_DETAIL_X = 168
  const TAG_DETAIL_W = 753
  const TAG_DETAIL_FONT = 24
  const TAG_DETAIL_PADX = 14
  const TAG_DETAIL_BAND_H = 68   // y204~271，用于垂直居中
  // 本地兜底卡（details_bg_3/4）的牌风带参数见文件顶部 LOCAL_TAG_* 常量。
  const tagExtra = 0

  const baseHeight = useLocalDetail ? detailBottom + 63 : bg.height
  const canvasHeight = baseHeight + tagExtra
  const canvas = createCanvas(bg.width, canvasHeight)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(bg, 0, 0)
  // 画布向下延伸时，延伸区用 bg 底边色填充，避免出现纯黑断层
  if (tagExtra > 0 && canvasHeight > bg.height) {
    ctx.fillStyle = _bgBottomColor || '#0d1017'
    ctx.fillRect(0, bg.height, bg.width, canvasHeight - bg.height)
  }
  ctx.drawImage(title, 0, 0)

  const subTitle = roomFilter ? roomFilter.name : `UID ${uid}`
  // 昵称兜底（覆盖所有分支）：无 token / 非 404 错误 / 房间筛选失败等路径都可能让
  // data.nickname 停留在占位符（playerStatsZero.nickname，已置空串），此处统一兜一次。
  const titleName = playerName || realtimePT?.nickname || data.nickname || String(uid)
  drawText(ctx, `${titleName} · ${subTitle}`, 504, 435, 30, '#FFFFFF', 'center', 'bold')

  if (!useLocalDetail) {
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

  // 三组柱状图落点：原 238/328/418，为牌风带让位并避免压住走势区蓝线。
  // 关键：lz_*.png 源图内容在局部 y14~38（组标题/图例），而 getLzBar 程序绘制的
  // 彩色条+百分比在局部 y51~81 —— 决定纵向占位的是后者。
  // 约束：柱1 彩条顶 (y+51) ≥ 272（牌风带下线 y268~271 之下）；
  //       柱3 彩条底 (y+81) ≤ 551（走势区线 y551~554 之上）。
  // 取 272/362/452 → 彩条 323~353 / 413~443 / 503~533，两组约束均满足。
  detailCtx.drawImage(lzRong, 0, 272)
  detailCtx.drawImage(lzChong, 0, 362)
  detailCtx.drawImage(lzChongz, 0, 452)
  
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
  
  // 走势图只画最近 16 场：record 为新→旧且可能含 RECORD_FETCH_LIMIT(20) 场，
  // 先截最近 16 场再反转为 旧→新。点位 x = 108 + i*50，20 个点会画到 x1058 超出画布。
  const revRecords = record.slice(0, CHART_POINTS).reverse()
  
  // 如果没有对局数据，显示提示文字
  if (revRecords.length === 0) {
    drawText(recordCtx, "暂无对局数据", 500, 200, 36, '#888888', 'center', 'bold')
    drawText(recordCtx, "可能是网络问题或数据尚未同步", 500, 250, 28, '#666666', 'center')
  }
  
  for (let i = 0; i < revRecords.length; i++) {
    const r = revRecords[i]
    let ranks = []
    r.players.forEach(p => ranks.push({ nick: p.nickname, score: p.score }))
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
  } else {
    // 本地数据卡片（details_bg_3/4.png）：顶部数据（画在标签上方）+ 牌风带 + 下方对局走势区
    // 标签：三麻「自摸率|荣和率|二位率|三位率」，四麻「自摸率|二位率|三位率|四位率」。
    // 新 bg（870x646）把标签文字带下移到 y110~130（中心 120），故数值画在 y86
    // （与旧版一致的 34px 间距）；四个标签中心 x 取自实测 152/291/566/705。
    // 三麻第二槽位为荣和率（ronRate），与背景图标签「荣和率」对应；和牌率在段位卡已显示
    const localEntry = mainMode === 3 ? localEntry3 : localEntry4
    const fpc = localEntry?.finalPositionCounts || []
    const fpcTotal = fpc.reduce((a, b) => a + b, 0) || 1
    const slotX = [152, 291, 566, 705]
    const valueY = 86
    if (mode === '3') {
      drawText(detailCtx, getRate(localEntry?.tsumoRate || 0), slotX[0], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate(localEntry?.ronRate || 0), slotX[1], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate((fpc[1] || 0) / fpcTotal), slotX[2], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate((fpc[2] || 0) / fpcTotal), slotX[3], valueY, 34, '#FFFFFF', 'center', 'bold')
    } else {
      drawText(detailCtx, getRate(localEntry?.tsumoRate || 0), slotX[0], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate((fpc[1] || 0) / fpcTotal), slotX[1], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate((fpc[2] || 0) / fpcTotal), slotX[2], valueY, 34, '#FFFFFF', 'center', 'bold')
      drawText(detailCtx, getRate((fpc[3] || 0) / fpcTotal), slotX[3], valueY, 34, '#FFFFFF', 'center', 'bold')
    }
    // 牌风标题与牌风下线由 details_bg_3/4 自带（x45~86 / y179~199 与 y224~227），
    // 无需代码补画；标签直接画在牌风带 y156~223 内即可。
    await drawLocalTrend(detailCtx, localEntry?.recentGames || [], mode, scopeLabel)
  }

  // 牌风标签：两类详情卡都画在卡内的「牌风」带里（视觉统一）。
  //   标准卡：detail_bg.png 自带「牌风」标题，带 y204~271，标签紧贴标题右侧左对齐；
  //   本地卡：details_bg_3/4 无该标题，由上方代码补画，带 y138~206。
  if (playerTags.length > 0) {
    try {
      drawTags(detailCtx, playerTags, {
        x: useLocalDetail ? LOCAL_TAG_X : TAG_DETAIL_X,
        y: useLocalDetail ? LOCAL_TAG_Y0 : TAG_DETAIL_Y0,
        maxWidth: useLocalDetail ? LOCAL_TAG_W : TAG_DETAIL_W,
        height: useLocalDetail ? LOCAL_TAG_ROW_H : TAG_DETAIL_ROW_H,
        fontSize: useLocalDetail ? LOCAL_TAG_FONT : TAG_DETAIL_FONT,
        minFontSize: 14,
        shrinkSteps: 3,
        gap: useLocalDetail ? LOCAL_TAG_GAP : TAG_DETAIL_GAP,
        padX: useLocalDetail ? LOCAL_TAG_PADX : TAG_DETAIL_PADX,
        // 左对齐紧贴「牌风」标题（两类卡一致）
        align: 'left',
        // 在带内垂直居中（1 行居中、2 行上下均匀）
        centerInHeight: useLocalDetail ? LOCAL_TAG_BAND_H : TAG_DETAIL_BAND_H,
        maxLines: 2
      })
    } catch (e) {
      console.warn(`[render.js] 牌风标签绘制失败: ${e.message}`)
    }
  }

  // 拼接整体画面
  ctx.drawImage(detailCanvas, useLocalDetail ? Math.floor((bg.width - detailCanvas.width) / 2) : 0, 1188)
  ctx.drawImage(mid, 0, 1161)
  drawText(ctx, _mode, 500, 1161 + 40, 30, '#FFFFFF', 'center', 'bold')
  // 页脚：本地卡片较短，页脚上移到卡片下方（距卡片底部 43px），标准卡保持原位置
  // 本地卡为原生 JS 实现（数据来自本地 API/雀魂官方），无 Python→JS 移植署名；标准卡保留移植署名
  const footerY = (useLocalDetail ? detailBottom + 43 : 2151 + 30) + tagExtra
  const footerText = useLocalDetail
    ? 'Majsoul-Plugin by 小橙c | Data: 雀魂官方'
    : 'Majsoul-Plugin by 小橙c | Data: 牌谱屋 + 雀魂官方 | Python-to-JS移植: QingFeng'

  drawText(ctx, footerText, 500, footerY, 24, '#FFFFFF', 'center', 'bold')

  const rank4Icon = await getRankIcon(level4, data4, extended4, "4", stableByMode[4], stableApplicable)
  const rank3Icon = await getRankIcon(level3, data3, extended3, "3", stableByMode[3], stableApplicable)

  const charBg = await loadResImage('info_texture/char_bg.png')
  const charFg = await loadResImage('info_texture/char_fg.png')
  const charCanvas = createCanvas(charBg.width, charBg.height)
  const charCtx = charCanvas.getContext('2d')
  charCtx.drawImage(charBg, 0, 0)
  try {
    const avatarId = realtimePT && realtimePT.avatarId
    const targetWidth = 289
    const targetHeight = 617
    // 优先：实时服饰立绘（已按 300:650 处理，contain 居中不裁内容）
    let personImg = avatarId ? await loadPortraitImage(avatarId) : null
    if (personImg) {
      const scale = Math.min(targetWidth / personImg.width, targetHeight / personImg.height)
      const dw = personImg.width * scale
      const dh = personImg.height * scale
      charCtx.drawImage(personImg, 0, 0, personImg.width, personImg.height, 38 + (targetWidth - dw) / 2, 37 + (targetHeight - dh) / 2, dw, dh)
    } else {
      // 回退：随机 person_full（cover 填满）
      const randomPerson = getRandomPersonFull()
      if (randomPerson) {
        const randImg = await loadResImage(randomPerson)
        const scale = Math.max(targetWidth / randImg.width, targetHeight / randImg.height)
        const sx = (randImg.width - targetWidth / scale) / 2
        const sy = (randImg.height - targetHeight / scale) / 2
        charCtx.drawImage(randImg, sx, sy, targetWidth / scale, targetHeight / scale, 38, 37, targetWidth, targetHeight)
      }
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
      // 优先用本地 API 直给的 levelId；旧 BotLink 结构回退 parseRankFromText（修正模式位 bug）
      let levelId
      let score
      if (realtime.fourPlayer.levelId != null) {
        levelId = realtime.fourPlayer.levelId
        score = realtime.fourPlayer.score
        // 本地 API 魂天 score 为 pt 值(0-2000)，需 /100 换算为 rating(0-20) 显示
        if (score != null && new PlayerLevel(levelId, 0).isTenhou()) {
          score = score / 100
        }
      } else {
        const rank = parseRankFromText(realtime.fourPlayer.rank)
        levelId = 1 * 10000 + rank.majorRank * 100 + rank.minorRank
        score = realtime.fourPlayer.score
        if (realtime.fourPlayer.useApiScore && player.level4) {
          const apiScore = player.level4.score + (player.level4.delta || 0)
          const tempLevel = new PlayerLevel(levelId, 0)
          score = tempLevel.isTenhou() ? apiScore / 100 : apiScore
        }
      }
      level4 = new PlayerLevel(levelId, score)
    } else if (player.level4) {
      const level4Score = player.level4.score + (player.level4.delta || 0)
      level4 = new PlayerLevel(player.level4.id, level4Score)
    }

    if (realtime && realtime.threePlayer) {
      let levelId
      let score
      if (realtime.threePlayer.levelId != null) {
        levelId = realtime.threePlayer.levelId
        score = realtime.threePlayer.score
        // 本地 API 魂天 score 为 pt 值(0-2000)，需 /100 换算为 rating(0-20) 显示
        if (score != null && new PlayerLevel(levelId, 0).isTenhou()) {
          score = score / 100
        }
      } else {
        const rank = parseRankFromText(realtime.threePlayer.rank)
        levelId = 2 * 10000 + rank.majorRank * 100 + rank.minorRank
        score = realtime.threePlayer.score
        if (realtime.threePlayer.useApiScore && player.level3) {
          const apiScore = player.level3.score + (player.level3.delta || 0)
          const tempLevel = new PlayerLevel(levelId, 0)
          score = tempLevel.isTenhou() ? apiScore / 100 : apiScore
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
  
  drawText(ctx, 'Majsoul-Plugin by 小橙c | Data: 牌谱屋 + 雀魂官方', width / 2, height - 12, 12, '#ffffff', 'center', 'bold')
  
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
  const paiBase = pickPaiBase() // 本张回顾图统一使用的牌画皮肤（随机）
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
  
  // ---- 玩家信息条 ----
  // reviewData.player_id 即被分析玩家的座号（0~3）
  const seat = (data && data.data && data.data.player_id) ||
               (data && data.player_id) || 0

  // 名字用真实昵称（mortalLog.name，由 review 命令从本地 API 获取），
  // 其次 review.json 缓存的真实昵称，最后兜底为空。未登录不进行牌谱分析，故不再使用占位名。
  const name = (mortalLog && mortalLog.name && mortalLog.name[seat]) ||
               (reviewData.name && reviewData.name[seat]) || ''
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
  // 未登录不进行牌谱分析，头像一律使用真实 avatar_id；无 avatar_id 或加载失败时留空（不再用随机占位头像）。
  let avatarImg = null
  if (avatarId) {
    try {
      avatarImg = await getAvatarCanvas(avatarId)
    } catch (e) {
      if (typeof logger !== 'undefined') logger.warn(`[render.js] 头像绘制失败 ${avatarId}: ${e.message}`)
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

  // 座次图标（东南西北）：画在头像右下角
  // 头像区域 bar 内 (69,15) 128x128，右下角 = (69+128-41, 15+128-41) = (156,102)
  // 素材来自 review_texture/{east,south,west,north}.png（41x41）
  // 注意：player_id 是被分析玩家的「起家座位」（固定身份 0~3），而每局的门风会顺延，
  // 当前局门风 = (player_id - 本局序号 kyoku + 4) % 4（每过一局所有玩家逆时针轮一家）。
  try {
    const SEAT_IMG = ['east', 'south', 'west', 'north']
    const kyoku = Number(kyokus?.kyoku) || 0
    const windSeat = ((seat - kyoku) % 4 + 4) % 4
    const seatImg = await loadResImage(`review_texture/${SEAT_IMG[windSeat] || 'east'}.png`)
    if (seatImg) barCtx.drawImage(seatImg, 156, 102, 41, 41)
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
    const actualType = (en.actual && en.actual.type) || 'none'

    // 立直后的 dahai 帧（at_self_riichi）：它与「立直宣言(reach)帧」是同一手动作的两段，
    // 真正的「AI 立直打 X / 你立直打 Y」分歧已在 reach 帧展示，故此处跳过避免重复。
    // 立直后的自摸/暗杠/荣和（hora/ankan）不属于该重复帧，正常保留。
    if (en.at_self_riichi === true && actualType === 'dahai') {
      // 跳过渲染，但维持 actorId 链（与 drawEnBg 返回值一致：取本帧 actual.actor）
      if (en.actual && typeof en.actual.actor === 'number') actorId = en.actual.actor
      continue
    }

    // 虚建议和牌帧：actual.type==='none' 但 expected==='hora'（你实际没有和、AI 建议和）。
    // Mortal 在此类帧的 tile/last_actor 经常错位（实锤：会把别处打出的牌串到这帧，
    // 如本该对家打 7m 荣和却挂错巡），画出来会误导，故直接跳过不渲染。
    if (actualType === 'none' && (en.expected && en.expected.type) === 'hora') {
      if (en.actual && typeof en.actual.actor === 'number') actorId = en.actual.actor
      continue
    }

    nowReviewed++
    
    const { canvas: enBg, actorId: aId, isMatch } = await drawEnBg(en, index, actorId, kyokus.entries, paiBase)
    actorId = aId

    if (isMatch) nowMatches++
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
  const nowScoreStr = (nowScore * 100).toFixed(2)
  
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
  
  drawText(finalCtx, `${meguruId > 0 ? `（展示前 ${limit} 手） ` : ''}Majsoul-Plugin by 小橙c | Data：Mortal 4.1b | Python-to-JS移植：QingFeng | 本地API by Ayu`, w / 2, h - footerHeight / 2, 24, '#FFFFFF', 'center', 'bold', 'Microsoft YaHei')
  
  return finalCanvas.toBuffer('image/jpeg', 85)
}

// ==================== 帮助界面（适配 JS 版指令）====================

const HELP_DATA = {
  "用户管理": {
    desc: "搜索玩家与绑定UID，便于后续查询",
    items: [
      { name: "雀魂绑定", desc: "绑定雀魂玩家UID", eg: "雀魂绑定 <UID>", icon: "绑定" },
      { name: "雀魂切换", desc: "切换已绑定的主账号", eg: "雀魂切换 <UID>", icon: "切换" },
      { name: "雀魂解绑", desc: "解绑指定或全部UID", eg: "雀魂解绑 [UID]", icon: "解绑" },
      { name: "雀魂我的绑定", desc: "查看已绑定的所有UID", eg: "雀魂我的绑定", icon: "我的绑定" },
      { name: "雀魂搜索", desc: "搜索雀魂玩家信息（支持好友码）", eg: "雀魂搜索 <玩家名/好友码>", icon: "搜索" }
    ]
  },
  "玩家数据查询": {
    desc: "查询玩家详细战绩与段位数据",
    items: [
      { name: "雀魂查询", desc: "查询四麻详细数据（默认）", eg: "雀魂查询 [玩家名] [房间]", icon: "查询" },
      { name: "查询四麻", desc: "查询四麻段位/统计/走势", eg: "查询四麻 [玩家名] [房间]", icon: "查询四麻" },
      { name: "查询三麻", desc: "查询三麻段位/统计/走势", eg: "查询三麻 [玩家名] [房间]", icon: "查询三麻" },
      { name: "查询友人场", desc: "查看玩家友人场战绩", eg: "雀魂查询 友 <玩家名>", icon: "友人" },
      { name: "查询比赛场", desc: "查看玩家比赛场战绩", eg: "雀魂查询 赛 <玩家名>", icon: "比赛" }
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
      { name: "牌谱Review", desc: "AI 分析牌谱（可选座位）", eg: "牌谱Review <URL> [座位]", icon: "牌谱" },
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
    desc: "签到攒辉玉，寻觅集雀士，带图鉴收集玩法",
    items: [
      { name: "雀魂签到", desc: "每日签到领辉玉和寻觅卷轴", eg: "雀魂签到", icon: "抽卡" },
      { name: "雀魂寻觅", desc: "消耗1卷轴或200辉玉单抽", eg: "雀魂寻觅", icon: "抽卡" },
      { name: "雀魂十连", desc: "消耗1800辉玉或1张十连卷轴", eg: "雀魂十连", icon: "抽卡" },
      { name: "雀魂钱包", desc: "查看七种货币余额", eg: "雀魂钱包", icon: "抽卡" },
      { name: "雀魂图鉴", desc: "查看雀士/装扮收集进度", eg: "雀魂图鉴 [角色/装扮] [页码]", icon: "抽卡" },
      { name: "雀魂兑换", desc: "用信仰兑换雀士（150/300）", eg: "雀魂兑换 四宫辉夜", icon: "抽卡" },
      { name: "雀魂邮件", desc: "领取奖励邮件", eg: "雀魂邮件", icon: "抽卡" },
      { name: "切换竹林/樱花", desc: "切换个人卡池，仅对自己生效", eg: "切换樱花", icon: "抽卡" },
      { name: "切换卡池", desc: "切换到指定池，联动可加 樱花/竹林 选特别寻觅（个人）", eg: "切换卡池 斗牌传说 竹林", icon: "抽卡" },
      { name: "查看卡池", desc: "查看自己当前卡池与可用池列表", eg: "查看卡池", icon: "抽卡" },
      { name: "重置卡池", desc: "重置为跟随全局池（默认樱花之路）", eg: "重置卡池", icon: "抽卡" },
      { name: "抢红包", desc: "抢机器人主发的辉玉红包", eg: "抢红包", icon: "抽卡" }
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
  const versionText = `v${pluginVersion}`
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