import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { FEATURE_CONFIG_DEFAULTS } from './utils/Config.js'

// 支持锅巴（Guoba-Plugin）后台管理插件配置。
// 锅巴会扫描插件根目录的 guoba.support.js，载入 supportGuoba 暴露的配置项。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL_CFG_PATH = path.join(__dirname, 'config/majsoul-protocol.json')
const FEATURE_CFG_PATH = path.join(__dirname, 'config/config.json')

// 本地 API（Majsoul.ProtocolLogin.Api）配置默认值，文件缺失/损坏时兜底
const DEFAULT_PROTOCOL_CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:5088',
  apiKey: '',
  timeoutMs: 20000,
  autoLaunch: true,
  apiDir: 'api'
}

function readJson (filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { ...fallback }
  }
}

export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'Majsoul-Plugin',
      title: '雀魂插件',
      description: '雀魂多功能插件：查询/牌谱Review/场况/抽卡/订阅播报',
      author: '小橙c',
      authorLink: 'https://github.com/Xcheng-dada',
      link: 'https://github.com/Xcheng-dada/Majsoul-Plugin',
      isV3: true,
      isV2: false,
      // 配置项大于等于 3 个时自动显示在左侧菜单
      showInMenu: 'auto',
      icon: 'mdi:cards-playing-outline',
      iconColor: '#3b82f6',
      iconPath: path.join(__dirname, 'resources/help/texture2d/ICON.png')
    },
    configInfo: {
      schemas: [
        {
          label: '本地 API',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'enabled',
          label: '启用本地取谱',
          bottomHelpMessage: '是否通过本地 API 拉取牌谱与玩家数据',
          component: 'Switch'
        },
        {
          field: 'baseUrl',
          label: 'API 地址',
          bottomHelpMessage: '本地 API 服务地址，默认 http://127.0.0.1:5088，修改后立即生效',
          component: 'Input',
          componentProps: {
            placeholder: 'http://127.0.0.1:5088'
          }
        },
        {
          field: 'apiKey',
          label: 'API 密钥',
          bottomHelpMessage: '本地 API 需要鉴权时填写，通过 X-Api-Key 请求头发送，一般留空即可',
          component: 'Input',
          componentProps: {
            placeholder: '可留空'
          }
        },
        {
          field: 'timeoutMs',
          label: '请求超时（毫秒）',
          bottomHelpMessage: '本地 API 请求超时时间，默认 20000',
          component: 'InputNumber',
          componentProps: {
            min: 1000,
            step: 1000,
            placeholder: '20000'
          }
        },
        {
          field: 'autoLaunch',
          label: '自动拉起 API 程序',
          bottomHelpMessage: 'API 未运行时是否自动启动本地 API 程序',
          component: 'Switch'
        },
        {
          field: 'apiDir',
          label: 'API 程序目录',
          bottomHelpMessage: '存放 Majsoul.ProtocolLogin.Api 可执行文件的目录，相对插件根目录或绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'api'
          }
        },
        {
          label: '功能配置',
          component: 'SOFT_GROUP_BEGIN'
        },
        {
          field: 'gachaDailyLimit',
          label: '抽卡每日次数限制',
          bottomHelpMessage: '每位用户每天可抽卡的上限，默认 5 次',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            placeholder: '5'
          }
        },
        {
          field: 'subscribeInterval4',
          label: '四麻订阅检查间隔（分钟）',
          bottomHelpMessage: '订阅播报每多久检查一次四麻新对局，默认 3 分钟',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '3'
          }
        },
        {
          field: 'subscribeInterval3',
          label: '三麻订阅检查间隔（分钟）',
          bottomHelpMessage: '订阅播报每多久检查一次三麻新对局，默认 5 分钟',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '5'
          }
        },
        {
          field: 'paipuCleanupDays',
          label: '牌谱自动清理天数',
          bottomHelpMessage: '超过该天数的旧牌谱与头像缓存会自动清理，默认 15 天',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            placeholder: '15'
          }
        },
        {
          field: 'recordsLimit',
          label: '对局查询默认返回场数',
          bottomHelpMessage: '#雀魂对局 默认返回的场次数（上限 20），默认 5 场',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 20,
            placeholder: '5'
          }
        }
      ],
      // 获取配置数据（用于前端填充显示，合并本地 API 配置与功能配置）
      getConfigData () {
        const protocol = readJson(PROTOCOL_CFG_PATH, DEFAULT_PROTOCOL_CONFIG)
        const feature = readJson(FEATURE_CFG_PATH, FEATURE_CONFIG_DEFAULTS)
        return { ...protocol, ...feature }
      },
      // 保存配置（前端点确定后调用，按字段归属写入对应配置文件）
      setConfigData (data, { Result }) {
        const protocol = readJson(PROTOCOL_CFG_PATH, DEFAULT_PROTOCOL_CONFIG)
        const feature = readJson(FEATURE_CFG_PATH, FEATURE_CONFIG_DEFAULTS)
        for (const [keyPath, value] of Object.entries(data)) {
          if (Object.prototype.hasOwnProperty.call(DEFAULT_PROTOCOL_CONFIG, keyPath)) {
            protocol[keyPath] = value
          } else if (Object.prototype.hasOwnProperty.call(FEATURE_CONFIG_DEFAULTS, keyPath)) {
            feature[keyPath] = value
          }
        }
        fs.writeFileSync(PROTOCOL_CFG_PATH, JSON.stringify(protocol, null, 2), 'utf8')
        fs.writeFileSync(FEATURE_CFG_PATH, JSON.stringify(feature, null, 2), 'utf8')
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
