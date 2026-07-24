import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { fileURLToPath } from 'url'

puppeteer.use(StealthPlugin())

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BASE_URL = 'https://mjai.ekyu.moe'

function convertTile(tile) {
  if (!tile) return ''
  tile = tile.toLowerCase()
  const mapping = {
    '1m': '1m', '2m': '2m', '3m': '3m', '4m': '4m', '5m': '5m',
    '6m': '6m', '7m': '7m', '8m': '8m', '9m': '9m',
    '1p': '1p', '2p': '2p', '3p': '3p', '4p': '4p', '5p': '5p',
    '6p': '6p', '7p': '7p', '8p': '8p', '9p': '9p',
    '1s': '1s', '2s': '2s', '3s': '3s', '4s': '4s', '5s': '5s',
    '6s': '6s', '7s': '7s', '8s': '8s', '9s': '9s',
    'e': 'E', 's': 'S', 'w': 'W', 'n': 'N',
    'p': 'P', 'f': 'F', 'c': 'C',
    '5mr': '5mr', '5pr': '5pr', '5sr': '5sr'
  }
  return mapping[tile] || tile
}

let browserInstance = null

function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'
  ]
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p
    }
  }
  return null
}

function getUserDataDir() {
  const tempDir = path.join(__dirname, '../data/temp_chrome_profile')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  return tempDir
}

async function getBrowser() {
  if (browserInstance) {
    try {
      const pages = await browserInstance.pages()
      if (pages.length > 0) {
        return browserInstance
      }
    } catch (e) {
      browserInstance = null
    }
  }

  const chromePath = getChromePath()
  if (!chromePath) {
    logger.error('未找到 Chrome/Edge 浏览器')
    return null
  }

  const userDataDir = getUserDataDir()
  logger.info(`浏览器路径: ${chromePath}`)
  logger.info(`用户数据目录: ${userDataDir}`)

  try {
    browserInstance = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      userDataDir: userDataDir,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        '--disable-infobars'
      ],
      defaultViewport: { width: 1280, height: 800 },
      timeout: 60000
    })

    logger.info('浏览器启动成功')
    return browserInstance
  } catch (e) {
    logger.error(`启动浏览器失败: ${e.message}`)
    browserInstance = null
    return null
  }
}

async function solveTurnstileAndSubmit(paipuUrl, engine, gameId) {
  const browser = await getBrowser()
  if (!browser) return null

  let page
  try {
    const pages = await browser.pages()
    page = pages[0] || await browser.newPage()

    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    })

    await new Promise(r => setTimeout(r, 3000))

    await page.click('input[name="input-method"][value="log-url"]', { force: true })
    await new Promise(r => setTimeout(r, 500))

    const urlInput = await page.$('input[name="log-url"]')
    if (urlInput) {
      await urlInput.type(paipuUrl, { delay: 50 })
    }
    await new Promise(r => setTimeout(r, 500))

    const engineSelect = await page.$('select[name="engine"]')
    if (engineSelect) {
      await engineSelect.select(engine.toLowerCase())
    }
    await new Promise(r => setTimeout(r, 500))

    const uiSelect = await page.$('select[name="ui"]')
    if (uiSelect) {
      await uiSelect.select('killerducky')
      logger.info('已选择Killerducky界面')
    } else {
      logger.info('未找到ui选择框')
    }
    await new Promise(r => setTimeout(r, 300))

    // 自动切换为简体中文牌谱，便于阅读（动作标签识别已兼容中英文）
    const langSelect = await page.$('select[name="lang"]')
    if (langSelect) {
      await langSelect.select('zh-CN')
      logger.info('已切换为简体中文牌谱')
    }
    await new Promise(r => setTimeout(r, 300))

    logger.info('等待Turnstile验证...')
      for (let i = 0; i < 30; i++) {
        const isBtnEnabled = await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"]')
          return btn && !btn.disabled
        })

        if (isBtnEnabled) {
          logger.info('Turnstile验证完成')
          break
        }

        await page.evaluate(() => {
          const turnstile = document.querySelector('.cf-turnstile') || 
                           document.querySelector('iframe[src*="challenges.cloudflare.com"]')
          if (turnstile) {
            turnstile.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        })
        await new Promise(r => setTimeout(r, 500))

        try {
          const turnstileBox = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]')
            if (iframe) {
              const rect = iframe.getBoundingClientRect()
              return {
                x: rect.left + 30,
                y: rect.top + rect.height / 2,
                width: rect.width,
                height: rect.height
              }
            }
            return null
          })

          if (turnstileBox) {
            await page.mouse.click(turnstileBox.x, turnstileBox.y)
            logger.info(`尝试坐标点击Turnstile: (${turnstileBox.x}, ${turnstileBox.y})`)
          }
        } catch (e) {
          logger.info(`坐标点击失败: ${e.message}`)
        }

        const turnstileDiv = await page.$('.cf-turnstile')
        if (turnstileDiv) {
          try {
            const box = await turnstileDiv.boundingBox()
            if (box) {
              await page.mouse.click(box.x + 30, box.y + box.height / 2)
              logger.info('尝试点击cf-turnstile div区域')
            }
          } catch (e) {
            logger.info('cf-turnstile点击失败')
          }
        }

        const turnstileFrames = page.frames()
        for (const frame of turnstileFrames) {
          if (frame.url().includes('challenges.cloudflare.com')) {
            try {
              await frame.click('input[type="checkbox"]', { timeout: 1000 }).catch(() => {})
              logger.info('尝试frame.click点击checkbox')
            } catch (e) {
            }
            break
          }
        }

        await new Promise(r => setTimeout(r, 2000))
      }

    await page.waitForFunction(() => {
      const btn = document.querySelector('button[type="submit"]')
      return btn && !btn.disabled
    }, { timeout: 60000 })

    await new Promise(r => setTimeout(r, 1000))

    const submitBtn = await page.$('button[type="submit"]')
    if (submitBtn) {
      await submitBtn.click()
      logger.info('点击提交按钮')
    }

    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 60000
    })

    let currentUrl = page.url()
    logger.info(`当前URL: ${currentUrl}`)

    if (currentUrl.includes('/progress')) {
      logger.info('等待分析完成...')
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000))
        currentUrl = page.url()
        logger.info(`轮询URL: ${currentUrl}`)
        if (currentUrl.includes('?data=')) {
          break
        }
        if (!currentUrl.includes('/progress')) {
          break
        }
      }
    }

    if (currentUrl.includes('?data=')) {
      const dataParam = currentUrl.split('?data=')[1]
      if (dataParam) {
        logger.info(`提取到data参数: ${dataParam}`)
        return dataParam
      }
    }

    if (!currentUrl.includes('/progress')) {
      logger.info(`最终URL: ${currentUrl}`)
      const htmlContent = await page.content()
      logger.info('获取HTML内容成功')
      return htmlContent
    }

    logger.info(`最终URL: ${currentUrl}`)
    return null

  } catch (e) {
    logger.error(`提交牌谱失败: ${e.message}`)
    return null
  } finally {
    try {
      logger.info('关闭浏览器...')
      await browser.close()
      browserInstance = null
      logger.info('浏览器已关闭')
    } catch (e) {
      logger.error(`关闭浏览器失败: ${e.message}`)
    }
  }
}

export async function reviewMortal(mortalLog, token, engine) {
  const gameId = mortalLog.ref
  const reviewPath = path.resolve(`./plugins/Majsoul-Plugin/data/paipu/${gameId} - review.json`)
  
  if (fs.existsSync(reviewPath)) {
    const reportData = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
    if (reportData.review && reportData.review.kyokus) {
      return {
        data: {
          review: reportData.review,
          player_id: reportData.player_id || 0
        }
      }
    }
    return reportData
  }

  const paipuUrl = mortalLog._originalUrl || ''
  if (!paipuUrl) {
    return '❌ 缺少牌谱URL!'
  }

  let reportUrl = ''
  let attempts = 0
  const maxAttempts = 3

  while (attempts < maxAttempts) {
    attempts++
    reportUrl = await solveTurnstileAndSubmit(paipuUrl, engine, gameId)
    if (reportUrl) break
    await new Promise(r => setTimeout(r, 5000))
  }

  if (!reportUrl) {
    return '❌ 提交牌谱失败，请稍后重试!'
  }

  // reportUrl 应是 "/..." 形式的路径（如 /?data=xxx）。若因游戏日志下载失败/牌谱失效，
  // solveTurnstileAndSubmit 返回了整页 HTML，直接报错，避免后续长时间空轮询。
  if (!reportUrl.startsWith('/') || reportUrl.includes('<')) {
    return '❌ 下载游戏日志失败，可能是网络波动，请稍后重试！'
  }

  logger.info(`开始获取报告: ${BASE_URL}${reportUrl}`)

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    
    try {
      logger.info(`第${i+1}次尝试获取报告...`)
      const reportRes = await fetch(`${BASE_URL}${reportUrl}`)
      logger.info(`HTTP状态码: ${reportRes.status}`)
      
      if (!reportRes.ok) {
        if (reportRes.status === 404) {
          logger.info('报告尚未生成，继续等待...')
          continue
        }
        const errText = await reportRes.text()
        if (/failed to download game log/i.test(errText)) {
          return '❌ 下载游戏日志失败，可能是网络波动或牌谱已失效，请稍后重试！'
        }
        return `❌ 获取报告失败! status: ${reportRes.status}`
      }
      
      logger.info('开始解析响应...')
      const text = await reportRes.text()
      // mjai 下载游戏日志失败（网络波动/牌谱失效）时可能返回 HTML 错误页（含 "failed to download game log"）而非 JSON，需立即报错避免空轮询
      if (/failed to download game log|<html|<!doctype html/i.test(text)) {
        logger.info('检测到牌谱失效/错误页面，立即返回错误')
        return '❌ 下载游戏日志失败，可能是网络波动或牌谱已失效，请稍后重试！'
      }
      
      const reportData = JSON.parse(text)
      logger.info(`报告数据结构: ${JSON.stringify(Object.keys(reportData))}`)
      
      // 提取段位信息
      if (reportData.player && reportData.player.rank) {
        logger.info(`段位信息: ${JSON.stringify(reportData.player.rank)}`)
      }
      if (reportData.players) {
        logger.info(`玩家信息: ${JSON.stringify(reportData.players.map(p => ({ name: p.name, rank: p.rank })))}`)
      }
      if (reportData.review) {
        logger.info(`review结构: ${JSON.stringify(Object.keys(reportData.review))}`)
        if (reportData.review.kyokus) {
          logger.info(`kyokus数量: ${reportData.review.kyokus.length}`)
        }
      }
      
      if (!fs.existsSync(path.dirname(reviewPath))) {
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true })
      }
      fs.writeFileSync(reviewPath, JSON.stringify(reportData, null, 2), 'utf8')
      logger.info('已保存报告到本地')
      
      if (reportData.review && reportData.review.kyokus) {
        return {
          data: {
            review: reportData.review,
            player_id: reportData.player_id || 0
          }
        }
      }
      return reportData
    } catch (e) {
      logger.error(`获取报告失败: ${e.message}`)
      continue
    }
  }

  return '❌ 获取报告超时!'
}

