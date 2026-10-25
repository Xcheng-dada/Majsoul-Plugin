// plugins/Majsoul-Plugin/utils/SignCard.js
// 雀魂签到卡：官方木质公告栏素材（resources/sign/）+ 头像昵称 + 奖励图标
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText } from '../components/canvas.js';
import { FONT } from '../components/fonts.js';
import { CURRENCY_ICONS } from './CurrencyCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const SIGN_DIR = path.join(RESOURCES_ROOT, 'sign');
// board_unsigned.png：未签到（下方留白放奖励图标）
// board_signed.png：今天已签到（右侧自带「今天已经签到过啦~ 明天再来吧」文案）
const SIGN_BG = path.join(SIGN_DIR, 'board_unsigned.png');
const SIGN_BG_DONE = path.join(SIGN_DIR, 'board_signed.png');
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');

// ---- 素材实测坐标（1367×809，sign/board_unsigned.png 与 board_signed.png 同尺寸）----
const BOARD_W = 1367;
const BOARD_H = 809;
// 白板（浅米色区域）右边界
const PANEL_X1 = 1094;
// 文字行 y（「已连续签到」「当前已累计签到」所在行）
const LABEL_Y = 310;
// 左侧数字插入点（「已连续签到」与「天」之间）
const LEFT_NUM_X = 500;
// 右侧数字插入点（「当前已累计签到」与「天」之间）
const RIGHT_NUM_X = 1028;
// 数字字号（与两侧标签文字 28px 视觉协调，不过大）
const NUM_SIZE = 36;
// 白板可用内容区：分隔线下方（y≈345）到底边上方
const CONTENT_TOP = 375;
const CONTENT_BOTTOM = 580;
// 内容区垂直中线（头像/昵称与道具统一以此对齐）
const CONTENT_CY = Math.round((CONTENT_TOP + CONTENT_BOTTOM) / 2);
// 左右两个内容块的水平中心：与上方两段文字的中心对齐
//   左侧文字「已连续签到 X 天」约 x310~560 → 中心 435
//   右侧文字「当前已累计签到 X 天」约 x775~1090 → 中心 932
const LEFT_BLOCK_CX = 435;
const RIGHT_BLOCK_CX = 932;

/**
 * 在指定横向区间内绘制数字，超出则自动缩小字号。
 *
 * 签到天数可能非常庞大（如 36500 天），固定字号会压到两侧的「天」字上，
 * 因此按可用宽度逐档缩字号；缩到下限仍放不下时，把区间放宽到「天」字左侧。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text 数字文本
 * @param {number} x0 可用区间左边界（不含）
 * @param {number} x1 可用区间右边界（不含）
 * @param {number} centerX 视觉中心（区间不足时以它为中心绘制）
 * @param {number} y 基线
 * @param {number} maxSize 最大字号
 * @param {string} color 颜色
 */
function drawFitNum (ctx, text, x0, x1, centerX, y, maxSize, color) {
  const avail = Math.max(20, x1 - x0)
  let size = maxSize
  ctx.font = `bold ${size}px ${FONT.hei}`
  // 逐档缩小（2px 步长），直到宽度放进可用区间
  while (size > 14 && ctx.measureText(text).width > avail) {
    size -= 2
    ctx.font = `bold ${size}px ${FONT.hei}`
  }
  // 缩到下限仍超宽：允许向两侧略微溢出，但仍以 centerX 居中，避免明显偏斜
  drawText(ctx, text, centerX, y, size, color, 'center', 'bold', FONT.hei)
}

/**
 * 渲染签到卡
 * @param {object} options
 * @param {string} options.nickname 用户昵称
 * @param {string} [options.avatar] 头像 URL 或本地路径
 * @param {number} options.streak 已连续签到天数
 * @param {number} options.totalDays 累计签到天数
 * @param {Array<{icon:string, count:number, extra?:string}>} options.items 奖励列表
 * @param {boolean} [options.alreadySigned] 今天已签到（用 bg1 素材，右侧自带提示文案）
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderSignCard ({ nickname, avatar, streak, totalDays, items = [], alreadySigned = false }) {
  const bgBuf = await fs.promises.readFile(alreadySigned ? SIGN_BG_DONE : SIGN_BG);
  const bg = await loadImage(bgBuf);

  const canvas = createCanvas(BOARD_W, BOARD_H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bg, 0, 0);

  // ---- 两个签到天数（汉仪文黑75W，按可用宽度自适应缩字号）----
  // 左侧数字可用区间：「已连续签到」右边界(x≈470) 到「天」左边界(x≈537)
  // 右侧数字可用区间：「当前已累计签到」右边界(x≈995) 到「天」左边界(x≈1067)
  // 两边都留出安全内边距。数字可能很大（如 36500），必须自适应，否则会压到「天」。
  drawFitNum(ctx, String(streak ?? 0), 478, 529, LEFT_NUM_X, LABEL_Y, NUM_SIZE, '#3D2B1F');
  drawFitNum(ctx, String(totalDays ?? 0), 1003, 1059, RIGHT_NUM_X, LABEL_Y, NUM_SIZE, '#3D2B1F');

  // ---- 分隔线下方：左侧头像+昵称，右侧奖励图标 ----
  //      两个内容块各自与上方对应文字块水平居中对齐，纵向统一在 CONTENT_CY 居中
  const AV = 112;

  // ===== 左侧：头像（上）+ 昵称（下），整体纵向居中于 CONTENT_CY =====
  {
    const name = String(nickname || '');
    // 昵称先定字号与宽度，才能算出整块高度
    const availW = 320;
    let size = 34;
    if (name) {
      ctx.font = `bold ${size}px ${FONT.name}`;
      while (size > 14 && ctx.measureText(name).width > availW) {
        size -= 2;
        ctx.font = `bold ${size}px ${FONT.name}`;
      }
    }
    let out = name;
    if (name && ctx.measureText(out).width > availW) {
      while (out.length > 1 && ctx.measureText(out + '…').width > availW) out = out.slice(0, -1);
      out += '…';
    }
    const NAME_GAP = 12;                       // 头像与昵称间距
    const blockH = AV + (out ? NAME_GAP + size : 0);
    const blockTop = Math.round(CONTENT_CY - blockH / 2);
    const avX = Math.round(LEFT_BLOCK_CX - AV / 2);
    const avY = blockTop;

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
          if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, AV, AV, 16);
          else cx.rect(0, 0, AV, AV);
          cx.clip();
          const side = Math.min(img.width, img.height);
          cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AV, AV);
          cx.restore();
          cx.beginPath();
          if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, AV - 2, AV - 2, 16);
          else cx.rect(0, 0, AV, AV);
          cx.strokeStyle = '#C9A063';
          cx.lineWidth = 3;
          cx.stroke();
          ctx.drawImage(c, avX, avY);
        }
      } catch { /* 头像失败静默跳过 */ }
    }

    if (out) {
      drawText(ctx, out, LEFT_BLOCK_CX, avY + AV + NAME_GAP + size / 2, size, '#3D2B1F', 'center', 'bold', FONT.name);
    }
  }

  // ===== 右侧：奖励图标横排 + 数量，整体纵向居中于 CONTENT_CY =====
  // 已签到模式：bg1 素材右侧自带「今天已经签到过啦~ 明天再来吧」文案，不再画奖励
  if (!alreadySigned && items && items.length) {
    // 图标受面板右边界约束（RIGHT_BLOCK_CX=932 到面板右缘 1094），
    // 3 个道具时 ICON*3+GAP*2 需 ≤ 318，故放大图标的同时收紧间距
    const ICON = 94;
    const GAP = 18;
    const COUNT_SIZE = 34;
    const EXTRA_SIZE = 22;
    const COUNT_GAP = 14;          // 图标与数量间距
    const EXTRA_GAP = 6;           // 数量与附加说明间距
    const hasExtra = items.some(i => i.extra);

    const rowW = items.length * ICON + (items.length - 1) * GAP;
    const startX = Math.round(RIGHT_BLOCK_CX - rowW / 2);
    // 整块高度 = 图标 + 数量 +（可选附加说明）
    const blockH = ICON + COUNT_GAP + COUNT_SIZE + (hasExtra ? EXTRA_GAP + EXTRA_SIZE : 0);
    const iconY = Math.round(CONTENT_CY - blockH / 2);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const x = startX + i * (ICON + GAP);
      const iconFile = CURRENCY_ICONS[it.icon] || it.icon;
      const iconPath = path.join(ECONOMY_DIR, `${iconFile}.png`);
      try {
        const buf = await fs.promises.readFile(iconPath);
        const icon = await loadImage(buf);
        const s = Math.min(ICON / icon.width, ICON / icon.height);
        const dw = icon.width * s, dh = icon.height * s;
        ctx.drawImage(icon, x + (ICON - dw) / 2, iconY + (ICON - dh) / 2, dw, dh);
      } catch { /* 图标缺失跳过 */ }

      const cxItem = x + ICON / 2;
      drawText(ctx, String(it.count), cxItem, iconY + ICON + COUNT_GAP + COUNT_SIZE / 2,
        COUNT_SIZE, '#3D2B1F', 'center', 'bold', FONT.hei);
      if (it.extra) {
        drawText(ctx, it.extra, cxItem, iconY + ICON + COUNT_GAP + COUNT_SIZE + EXTRA_GAP + EXTRA_SIZE / 2,
          EXTRA_SIZE, '#B5452F', 'center', 'bold', FONT.hei);
      }
    }
  }

  const buf = canvas.toBuffer('image/png');
  return `base64://${buf.toString('base64')}`;
}
