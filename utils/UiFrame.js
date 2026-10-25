// plugins/Majsoul-Plugin/utils/UiFrame.js
// 雀魂风格界面框架：indoor 背景 + 黑色滤镜 + 官方九宫格金框
// 供「雀魂仓库」（钱包）与「雀魂寮舍」（图鉴）共用
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const UI_DIR = path.join(RESOURCES_ROOT, 'ui');

// 官方背景（室内樱花鸟居）
const BG_FILE = 'bag_bg.png';
// 九宫格金框：边角尺寸必须能完整包含四角装饰，否则拉伸会压扁
//   frame_liaoshe (256x256)  四角 L 形括号各占 100x100 → B=100
//   frame_catchat (1349x849) 细金线无装饰 → B=46
export const FRAMES = {
  liaoshe: { file: 'frame_liaoshe.png', corner: 100 },
  catchat: { file: 'frame_catchat.png', corner: 46 }
};

// 中间黑色滤镜浓度（0~1）。太淡文字看不清，太浓背景糊成黑块。
export const DARK_ALPHA = 0.47;

const _cache = new Map();
async function loadRes (p) {
  if (_cache.has(p)) return _cache.get(p);
  const buf = await fs.promises.readFile(p);
  const img = await loadImage(buf);
  _cache.set(p, img);
  return img;
}

/**
 * 绘制雀魂风格背景（indoor 图 cover 铺满 + 黑色滤镜）
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 */
export async function drawUiBackground (ctx, W, H) {
  const bg = await loadRes(path.join(UI_DIR, BG_FILE));
  // cover：等比放大到完全覆盖画布，居中裁切，避免上下/左右露黑边
  const s = Math.max(W / bg.width, H / bg.height);
  const dw = bg.width * s, dh = bg.height * s;
  ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);

  // 黑色滤镜：让前景内容（白字、图标）可读
  ctx.fillStyle = `rgba(0, 0, 0, ${DARK_ALPHA})`;
  ctx.fillRect(0, 0, W, H);
}

/**
 * 绘制九宫格金框（四角/四边保持原比例，仅中段拉伸）
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W 画布宽
 * @param {number} H 画布高
 * @param {'liaoshe'|'catchat'} which 使用哪套框
 * @param {number} [inset] 内缩像素（框与画布边缘的距离）
 */
export async function drawUiFrame (ctx, W, H, which = 'liaoshe', inset = 0) {
  const cfg = FRAMES[which] || FRAMES.liaoshe;
  const img = await loadRes(path.join(UI_DIR, cfg.file));
  const fw = img.width, fh = img.height;
  const B = cfg.corner;

  const x0 = inset, y0 = inset;
  const x1 = W - inset, y1 = H - inset;
  const innerW = x1 - x0 - 2 * B;
  const innerH = y1 - y0 - 2 * B;

  // 四角：原样绘制，绝不缩放（保住装饰形状）
  ctx.drawImage(img, 0, 0, B, B, x0, y0, B, B);                       // 左上
  ctx.drawImage(img, fw - B, 0, B, B, x1 - B, y0, B, B);              // 右上
  ctx.drawImage(img, 0, fh - B, B, B, x0, y1 - B, B, B);              // 左下
  ctx.drawImage(img, fw - B, fh - B, B, B, x1 - B, y1 - B, B, B);     // 右下

  // 四边：只沿一个方向拉伸（细线拉伸不变形）
  if (innerW > 0) {
    ctx.drawImage(img, B, 0, fw - 2 * B, B, x0 + B, y0, innerW, B);            // 上
    ctx.drawImage(img, B, fh - B, fw - 2 * B, B, x0 + B, y1 - B, innerW, B);   // 下
  }
  if (innerH > 0) {
    ctx.drawImage(img, 0, B, B, fh - 2 * B, x0, y0 + B, B, innerH);            // 左
    ctx.drawImage(img, fw - B, B, B, fh - 2 * B, x1 - B, y0 + B, B, innerH);   // 右
  }
}

/**
 * 一次性铺好背景 + 金框
 * @returns {Promise<void>}
 */
export async function drawUiChrome (ctx, W, H, which = 'liaoshe', inset = 0) {
  await drawUiBackground(ctx, W, H);
  await drawUiFrame(ctx, W, H, which, inset);
}
