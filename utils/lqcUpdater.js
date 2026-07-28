// utils/lqcUpdater.js
// 从官方 CDN 拉取 lqc.lqbin（角色/皮肤配置）并解析为 lqc.json，
// 与 liqi.json 的更新方式对称。解析使用 protobufjs（lqc.lqbin 为标准 protobuf）。
import protobuf from 'protobufjs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// 与 render.js 一致：优先使用 Yunzai 全局 logger，否则退回 console
function log(level, msg) {
  if (typeof logger !== 'undefined' && typeof logger[level] === 'function') logger[level](msg)
  else console[level === 'info' ? 'log' : level](msg)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
const protoPath = path.join(pluginRoot, 'config', 'lqc.proto')
const outPath = path.join(pluginRoot, 'data', 'lqc.json')
const metaPath = path.join(pluginRoot, 'data', 'lqc.version.json')
const CDN = 'https://game.maj-soul.com/'

// 皮肤表在 ConfigTables 中的 table/sheet 名（to_camel_case 拼接即 ItemDefinitionSkin）
const SKIN_TABLE = 'item_definition'
const SKIN_SHEET = 'skin'

let _root = null
let _ConfigTables = null
let _ItemDefinitionSkin = null

function loadProto() {
  if (_root) return
  _root = protobuf.loadSync(protoPath)
  _ConfigTables = _root.lookupType('ConfigTables')
  _ItemDefinitionSkin = _root.lookupType('ItemDefinitionSkin')
}

async function fetchText(url) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`)
  return res.text()
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url))
}

async function fetchBuffer(url) {
  const fetch = globalThis.fetch || (await import('node-fetch')).default
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`)
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

// camelCase -> snake_case（protobufjs toObject 输出驼峰键，转为与现有 lqc.json 一致的蛇形键）
function camelToSnake(s) {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
}

// 将 ItemDefinitionSkin 转为可序列化对象（保留全部字段，含默认零值，键为 snake_case）
function skinToPlain(skin) {
  const obj = _ItemDefinitionSkin.toObject(skin, {
    enums: Number,
    longs: String,
    bytes: String,
    defaults: true,
    arrays: true,
    objects: true,
  })
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[camelToSnake(k)] = v
  return out
}

/**
 * 更新 lqc.json。
 * - force=true 时忽略版本缓存强制刷新；
 * - 否则仅在 CDN 版本变化（或本地文件缺失）时刷新。
 */
export async function updateLqc(force = false) {
  try {
    const meta = readJsonIfExists(metaPath)
    let version = null
    try {
      version = (await fetchJson(`${CDN}1/version.json?randv=${Date.now()}`)).version
    } catch (e) {
      throw new Error(`获取 version.json 失败: ${e.message}`)
    }

    // 版本未变且本地已生成则跳过
    if (!force && meta && meta.version === version && fs.existsSync(outPath)) {
      log('info', `[Majsoul-Plugin] lqc.json 已是最新 (${version})，跳过更新`)
      return
    }

    const resv = await fetchJson(`${CDN}1/resversion${version}.json`)
    const lqcEntry = resv?.res?.['res/config/lqc.lqbin']
    if (!lqcEntry || !lqcEntry.prefix) throw new Error('resversion 中未找到 res/config/lqc.lqbin')
    const prefix = lqcEntry.prefix

    const buf = await fetchBuffer(`${CDN}1/${prefix}/res/config/lqc.lqbin`)
    loadProto()

    const configTables = _ConfigTables.decode(buf)
    const lqc = {}
    for (const sheet of configTables.datas || []) {
      if (sheet.table !== SKIN_TABLE || sheet.sheet !== SKIN_SHEET) continue
      for (const row of sheet.data || []) {
        const skin = _ItemDefinitionSkin.decode(row)
        const id = skin.id
        if (!id) continue
        lqc[String(id)] = skinToPlain(skin)
      }
    }

    if (Object.keys(lqc).length === 0) throw new Error('解析后皮肤条目为 0')

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(lqc, null, 2))
    fs.writeFileSync(metaPath, JSON.stringify({ version, updated_at: new Date().toISOString() }, null, 2))
    log('info', `[Majsoul-Plugin] lqc.json 更新完成 (${version}, 共 ${Object.keys(lqc).length} 条皮肤)`)
  } catch (e) {
    // 失败时保留本地已有文件（config/lqc.json 或 data/lqc.json），不影响渲染
    log('warn', `[Majsoul-Plugin] lqc.json 更新失败，使用本地缓存: ${e.message}`)
  }
}
