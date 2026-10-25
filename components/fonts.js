// plugins/Majsoul-Plugin/components/fonts.js
// 插件自带字体注册与家族名常量
// 字体文件放在 resources/fonts/，随插件分发，用户无需自行安装
import { GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', 'resources', 'fonts');

// 文件名 → 注册到 canvas 的家族名
// 用自定义英文名注册，避免字体内部名乱码（红豆大黑体的内部名是乱码）
const FONT_DEFS = [
  { file: '红豆大黑体.ttf', family: 'HongDouDaHei' },
  { file: '文鼎特毛楷简繁.ttf', family: 'AR MaoKai' },
  { file: '汉仪文黑75W.ttf', family: 'HYWenHei' }
];

// 对外暴露的字体族（含回退链，单字体缺失也不至于整段不渲染）
export const FONT = {
  // 物品名称：红豆大黑体
  name: 'HongDouDaHei, Microsoft YaHei, sans-serif',
  // 累计寻觅次数 / 含保底：文鼎特毛楷
  kai: 'AR MaoKai, KaiTi, Microsoft YaHei, sans-serif',
  // 正文/其他：汉仪文黑
  hei: 'HYWenHei, Microsoft YaHei, sans-serif',
  // 默认（沿用系统黑体）
  base: 'Microsoft YaHei, Segoe UI Emoji, sans-serif'
};

let _done = false;
/** 注册全部自带字体（幂等） */
export function ensureFonts () {
  if (_done) return;
  _done = true;
  for (const { file, family } of FONT_DEFS) {
    try {
      const p = path.join(FONT_DIR, file);
      if (!fs.existsSync(p)) {
        logger?.warn?.(`[fonts] 缺少字体文件 ${file}，回退系统字体`);
        continue;
      }
      if (!GlobalFonts.registerFromPath(p, family)) {
        logger?.warn?.(`[fonts] 注册失败 ${file}`);
      }
    } catch (e) {
      logger?.warn?.(`[fonts] 加载 ${file} 异常: ${e.message}`);
    }
  }
}

ensureFonts();
