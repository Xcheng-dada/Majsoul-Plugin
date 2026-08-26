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
  gachaDailyLimit: 5,        // 抽卡每日次数限制
  subscribeInterval4: 3,     // 四麻订阅检查间隔（分钟）
  subscribeInterval3: 5,     // 三麻订阅检查间隔（分钟）
  paipuCleanupDays: 15,      // 牌谱/头像自动清理天数
  recordsLimit: 5            // 对局查询默认返回场数
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
