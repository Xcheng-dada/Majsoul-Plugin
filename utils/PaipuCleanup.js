// 牌谱文件定时清理：按文件修改时间删除超过指定天数的旧牌谱（review.json）
// 默认保留 15 天，避免 data/paipu 目录无限增长。
import fs from 'fs'
import path from 'path'

const PAIPU_DIR = path.resolve('./plugins/Majsoul-Plugin/data/paipu')
const AVATAR_DIR = path.resolve('./plugins/Majsoul-Plugin/data/charactor')
const PAIPU_CLEANUP_DAYS = 15

// 清理超过 days 天的牌谱文件（仅删除本插件生成的 review.json）
// 返回本次删除的文件数量
export function cleanupPaipu(days = PAIPU_CLEANUP_DAYS) {
  if (!fs.existsSync(PAIPU_DIR)) return 0

  const now = Date.now()
  const maxAge = days * 24 * 60 * 60 * 1000
  let deleted = 0

  try {
    for (const file of fs.readdirSync(PAIPU_DIR)) {
      // 仅清理本插件落盘的牌谱文件，避免误删其他文件
      if (!file.endsWith(' - review.json')) continue
      const filePath = path.join(PAIPU_DIR, file)
      try {
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath)
          deleted++
        }
      } catch (err) {
        logger?.error?.(`[PaipuCleanup] 删除文件失败 ${file}: ${err.message}`)
      }
    }
    if (deleted > 0) console.log(`[PaipuCleanup] 已清理 ${deleted} 个超过 ${days} 天的旧牌谱`)
  } catch (err) {
    logger?.error?.(`[PaipuCleanup] 清理失败: ${err.message}`)
  }

  return deleted
}

// 清理超过 days 天的头像缓存（data/charactor/<角色>/bighead.png）
// 与牌谱共用同一过期时间，避免头像缓存无限增长。
// 返回本次删除的头像文件数量
export function cleanupAvatar(days = PAIPU_CLEANUP_DAYS) {
  if (!fs.existsSync(AVATAR_DIR)) return 0

  const now = Date.now()
  const maxAge = days * 24 * 60 * 60 * 1000
  let deleted = 0

  try {
    for (const charDir of fs.readdirSync(AVATAR_DIR)) {
      const dirPath = path.join(AVATAR_DIR, charDir)
      let stat
      try { stat = fs.statSync(dirPath) } catch { continue }
      // 仅处理角色子目录，跳过非目录项
      if (!stat.isDirectory()) continue
      // 目录整体超过过期时间则清空其下头像文件
      if (now - stat.mtimeMs <= maxAge) continue
      try {
        for (const f of fs.readdirSync(dirPath)) {
          const fp = path.join(dirPath, f)
          try {
            const s = fs.statSync(fp)
            if (s.isFile()) {
              fs.unlinkSync(fp)
              deleted++
            }
          } catch (err) {
            logger?.error?.(`[PaipuCleanup] 删除头像失败 ${charDir}/${f}: ${err.message}`)
          }
        }
        // 子目录空了则移除目录本身
        const remain = fs.readdirSync(dirPath)
        if (remain.length === 0) fs.rmdirSync(dirPath)
      } catch (err) {
        logger?.error?.(`[PaipuCleanup] 清理头像目录失败 ${charDir}: ${err.message}`)
      }
    }
    if (deleted > 0) console.log(`[PaipuCleanup] 已清理 ${deleted} 个超过 ${days} 天的旧头像`)
  } catch (err) {
    logger?.error?.(`[PaipuCleanup] 头像清理失败: ${err.message}`)
  }

  return deleted
}

export { PAIPU_CLEANUP_DAYS }
