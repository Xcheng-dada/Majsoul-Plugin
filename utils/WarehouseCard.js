// plugins/Majsoul-Plugin/utils/WarehouseCard.js
// 雀魂仓库卡：indoor 樱花背景 + 黑色滤镜 + 官方九宫格金框
// 布局：左上头像 + 标题（居中于头像右侧区域），下方货币网格水平/垂直居中
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText } from '../components/canvas.js';
import { FONT } from '../components/fonts.js';
import { drawUiChrome } from './UiFrame.js';
import { CURRENCY_ICONS } from './CurrencyCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');

// ---- 布局常量（与已确认的样张一致）----
const W = 1000, H = 780;
const PAD = 74;                 // 内容左边界（金框内侧留白）
const AV = 96;                  // 头像尺寸
const AV_X = PAD, AV_Y = 56;    // 头像位置
const TITLE_SIZE = 38;          // 标题字号
const GRID_COLS = 3;            // 货币网格列数
const ICON = 104;               // 图标尺寸
const COL_W = 300;              // 列宽
const ROW_H = 190;              // 行高
const COUNT_SIZE = 36;          // 数量字号
const NAME_SIZE = 22;           // 货币名字号
const FOOTER_H = 110;           // 底部说明区高度

/**
 * 渲染仓库卡
 * @param {object} options
 * @param {string} options.title 标题（如「XXX的仓库」）
 * @param {string} [options.avatar] 头像 URL 或本地路径
 * @param {Array<{icon:string, count:number}>} options.items 货币列表
 * @param {string} [options.footer] 底部说明文字
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderWarehouseCard ({ title, avatar, items = [], footer }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景 + 黑色滤镜 + 金框
  await drawUiChrome(ctx, W, H, 'liaoshe', 0);

  // ---- 头像（左上）----
  if (avatar) {
    try {
      let buf;
      if (/^https?:\/\//.test(avatar)) {
        const res = await fetch(avatar);
        if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      } else {
        buf = await fs.promises.readFile(avatar);
      }
      if (buf) {
        const img = await loadImage(buf);
        const c = createCanvas(AV, AV);
        const cx = c.getContext('2d');
        cx.save();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, AV, AV, 18);
        else cx.rect(0, 0, AV, AV);
        cx.clip();
        const side = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AV, AV);
        cx.restore();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, AV - 2, AV - 2, 18);
        else cx.rect(0, 0, AV, AV);
        cx.strokeStyle = '#D6AF6E';
        cx.lineWidth = 3;
        cx.stroke();
        ctx.drawImage(c, AV_X, AV_Y);
      }
    } catch { /* 头像失败静默跳过 */ }
  }

  // ---- 标题：居中于「头像右侧 → 画布右边界」这段区域 ----
  if (title) {
    const tCx = (AV_X + AV + W) / 2;
    drawText(ctx, title, tCx, AV_Y + AV / 2, TITLE_SIZE, '#FFE9B8', 'center', 'bold', FONT.name);
  }

  // ---- 货币网格：水平居中 + 垂直居中于「标题下方 → 页脚上方」----
  if (items.length) {
    const rows = Math.ceil(items.length / GRID_COLS);
    const gridW = GRID_COLS * COL_W;
    const gridH = rows * ROW_H;
    // 网格水平居中
    const gx = Math.round((W - gridW) / 2);
    // 垂直：可用区 = 头像区下方 .. 页脚上方，网格在该区间居中
    const areaTop = AV_Y + AV + 46;
    const areaBottom = H - (footer ? FOOTER_H : 60);
    const gy = Math.round(areaTop + (areaBottom - areaTop - gridH) / 2);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = Math.floor(i / GRID_COLS);
      const c = i % GRID_COLS;
      const x = gx + c * COL_W;
      const y = gy + r * ROW_H;

      // 图标（等比缩放到 ICON 内，左对齐）
      const iconFile = CURRENCY_ICONS[it.icon] || it.icon;
      const iconPath = path.join(ECONOMY_DIR, `${iconFile}.png`);
      try {
        const buf = await fs.promises.readFile(iconPath);
        const icon = await loadImage(buf);
        const s = Math.min(ICON / icon.width, ICON / icon.height);
        ctx.drawImage(icon, x, y, icon.width * s, icon.height * s);
      } catch { /* 图标缺失跳过 */ }

      // 数量（图标右侧）+ 名称（数量下方）
      const tx = x + ICON + 26;
      drawText(ctx, String(it.count), tx, y + ICON / 2 - 10, COUNT_SIZE, '#FFF6E0', 'left', 'bold', FONT.hei);
      drawText(ctx, it.name || '', tx, y + ICON / 2 + 32, NAME_SIZE, '#C9BFA8', 'left', 'normal', FONT.hei);
    }
  }

  // ---- 底部说明 ----
  if (footer) {
    drawText(ctx, footer, W / 2, H - 62, 20, '#A89C86', 'center', 'normal', FONT.hei);
  }

  const buf = canvas.toBuffer('image/png');
  return `base64://${buf.toString('base64')}`;
}
