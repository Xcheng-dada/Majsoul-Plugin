// plugins/Majsoul-Plugin/utils/Config.js
// 功能配置读取工具：读取 config/config.json，与默认值合并。
// 修改配置请通过锅巴后台（guoba.support.js）或直接编辑 config/config.json。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, '../config/config.json')

// 功能配置默认值（与 config/config.json 保持一致，文件缺失/损坏时兜底）
export const FEATURE_CONFIG_DEFAULTS = {
  subscribeInterval4: 3,     // 四麻订阅检查间隔（分钟）
  subscribeInterval3: 5,     // 三麻订阅检查间隔（分钟）
  paipuCleanupDays: 15,      // 牌谱/头像自动清理天数
  recordsLimit: 5,           // 对局查询默认返回场数
  // 牌谱屋（amae-koromo）请求参数
  // ⚠️ 节点由牌谱屋作者按 token 授权，默认只用主节点 5-data。
  //    多节点（1/4-data、sapk.ch）实测不稳定（4-data 曾连续 21s 无响应）且易触发 429，
  //    未获作者许可不要擅自加回。需要时用英文逗号分隔填写。
  paipuHosts: '5-data.amae-koromo.com',
  // 请求超时（毫秒）。牌谱屋 player_records 接口服务端响应波动极大
  // （实测同一请求 461ms ~ 9569ms，偶发 50s+），15s 会让「其实能通」的请求被判死。
  // 取 30s：能救回绝大多数慢请求，又不会让单次失败等太久。
  paipuTimeout: 30000,
  // 单次请求的最大尝试次数（与节点数量无关，单节点时同样会退避重试）
  paipuMaxRetries: 3,
  // 每分钟最大请求数（作者要求 max 1 QPS = 60/min，默认 30 留余量）
  paipuMaxPerMinute: 30,
  // 是否 IPv4 优先解析牌谱屋域名（默认开启）。
  // 牌谱屋节点在 Cloudflare 后面且有 IPv6 记录，Node 默认会优先走 IPv6；
  // 部分网络下 IPv6 能建连但 HTTP 层卡死到超时（表现为 aborted）。
  // 若你的网络 IPv6 正常、想走 IPv6，可设为 false。
  paipuIpv4First: true,
  // 抽卡经济系统
  signJadeMin: 150,          // 签到随机辉玉下限
  signJadeMax: 250,          // 签到随机辉玉上限
  signCritRate: 8,           // 签到暴击概率（%），暴击时当日辉玉翻倍
  singleGachaJade: 200,      // 单抽辉玉价格
  tenGachaJade: 1800,        // 十连辉玉价格
  faithNormalCost: 150,      // 信仰兑换普通雀士所需
  faithLimitedCost: 300,     // 信仰兑换限定雀士所需
  halfHourTenPullLimit: 3,   // 每30分钟十连次数上限（防刷屏，0=不限制）
  halfHourSinglePullLimit: 3 // 每30分钟单抽次数上限（防刷屏，0=不限制）
}

/**
 * 读取功能配置（合并默认值，缺失字段回退默认）
 * @returns {object} 功能配置对象
 */
export function getFeatureConfig () {
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return { ...FEATURE_CONFIG_DEFAULTS, ...user }
  } catch {
    return { ...FEATURE_CONFIG_DEFAULTS }
  }
}

/**
 * 读取单个功能配置项
 * @param {string} key 配置项名
 * @returns {*} 配置值（缺失时返回默认值）
 */
export function getFeatureConfigItem (key) {
  return getFeatureConfig()[key]
}
