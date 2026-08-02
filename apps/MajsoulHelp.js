import { drawHelp } from '../components/render.js'
import { segment } from 'oicq'

export class MajsoulHelp {
  constructor() {}

  async handle(e) {
    try {
      const imgBuffer = await drawHelp()
      if (imgBuffer) {
        await e.reply(segment.image(imgBuffer))
      } else {
        await e.reply('帮助图片生成失败，请稍后重试')
      }
    } catch (error) {
      console.error('[MajsoulHelp] 帮助界面生成失败:', error)
      await e.reply(`帮助界面生成失败: ${error.message}`)
    }
    return true
  }
}
