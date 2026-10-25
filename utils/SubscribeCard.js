// plugins/Majsoul-Plugin/utils/SubscribeCard.js
// 订阅状态卡：官方弹窗底板（pop_bg + 波浪装饰 + pop_bound）
//   标题「对局订阅」+ 模式标签 + 订阅列表（昵称 / UID / 播报状态）
//   左下头像昵称，右下指令提示
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { FONT } from '../components/fonts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const UI_DIR = path.join(RESOURCES_ROOT, 'ui');
const POP_BG = path.join(UI_DIR, 'pop_bg.png');
const POP_BOUND = path.join(UI_DIR, 'pop_bound.png');
const POP_DECO_L = path.join(UI_DIR, 'pop_deco_left.png');
const POP_DECO_R = path.join(UI_DIR, 'pop_deco_right.png');

// ---- 画布与内区（与绑定卡/兑换卡一致的弹窗尺寸）----
const SCALE = 1.6;
const W = Math.round(611 * SCALE);      // 978
const H = Math.round(455 * SCALE);      // 728
const BG_X = Math.round(28 * SCALE);
const BG_Y = Math.round(27 * SCALE);
const BG_W = Math.round(555 * SCALE);   // 888
const BG_H = Math.round(400 * SCALE);   // 640

const TITLE_Y = 104;
const LIST_TOP = 162;
const ROW_H = 64;
const ROW_GAP = 9;
const MAX_ROWS = 5;
const HINT_Y_OFFSET = 112;

const COL_GOLD = '#C9A45A';
const COL_GOLD_TEXT = '#E8C87E';

const _cache = new Map();
async function loadRes (p) {
  if (_cache.has(p)) return _cache.get(p);
  const img = await loadImage(await fs.promises.readFile(p));
  _cache.set(p, img);
  return img;
}

/** 中英数字混排绘制 */
function drawMixed (ctx, text, x, y, size, color, align, cjkFont, numFont, weight = 'bold') {
  const s = String(text ?? '');
  if (!s) return;
  const isNum = (c) => /[0-9A-Za-z.]/.test(c);
  const segs = [];
  let cur = '', curIsNum = null;
  for (const ch of s) {
    const n = isNum(ch);
    if (curIsNum === null || n === curIsNum) { cur += ch; curIsNum = n; }
    else { segs.push({ text: cur, isNum: curIsNum }); cur = ch; curIsNum = n; }
  }
  if (cur) segs.push({ text: cur, isNum: curIsNum });

  let total = 0;
  for (const seg of segs) {
    ctx.font = `${weight} ${size}px ${seg.isNum ? numFont : cjkFont}`;
    seg.w = ctx.measureText(seg.text).width;
    total += seg.w;
  }
  let sx = x;
  if (align === 'center') sx = x - total / 2;
  else if (align === 'right') sx = x - total;

  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (const seg of segs) {
    ctx.font = `${weight} ${size}px ${seg.isNum ? numFont : cjkFont}`;
    ctx.fillText(seg.text, sx, y);
    sx += seg.w;
  }
  ctx.textAlign = prevAlign;
}

/**
 * 渲染订阅状态卡
 * @param {object} options
 * @param {Array<{id:string, nickname:string, active:boolean}>} options.subs 订阅列表
 * @param {number} [options.mode] 4 或 3
 * @param {string} [options.footer] 底部指令提示
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderSubscribeCard ({ subs = [], mode = 4, footer }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- 面板：pop_bg + 波浪 + pop_bound ----
  try {
    const bg = await loadRes(POP_BG);
    ctx.drawImage(bg, BG_X, BG_Y, BG_W, BG_H);
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(BG_X, BG_Y, BG_W, BG_H, 10);
    else ctx.rect(BG_X, BG_Y, BG_W, BG_H);
    ctx.clip();
    try {
      const dl = await loadRes(POP_DECO_L);
      const dh = Math.round(dl.height * 1.15), dw = Math.round(dl.width * 1.15);
      ctx.drawImage(dl, BG_X + 8, BG_Y + BG_H - dh, dw, dh);
    } catch { /* 缺失跳过 */ }
    try {
      const dr = await loadRes(POP_DECO_R);
      const dh = Math.round(dr.height * 1.15), dw = Math.round(dr.width * 1.15);
      ctx.drawImage(dr, BG_X + BG_W - dw - 8, BG_Y + BG_H - dh, dw, dh);
    } catch { /* 缺失跳过 */ }
    ctx.restore();
  } catch { /* 底缺失则透明 */ }
  try {
    const bound = await loadRes(POP_BOUND);
    ctx.drawImage(bound, 0, 0, W, H);
  } catch { /* 框缺失则跳过 */ }

  // ---- 标题 + 模式标签 ----
  drawMixed(ctx, '对局订阅', W / 2, TITLE_Y, 44, COL_GOLD_TEXT, 'center', FONT.kai, FONT.hei);

  if (!subs.length) {
    const cy = Math.round((LIST_TOP + BG_Y + BG_H - HINT_Y_OFFSET) / 2);
    drawMixed(ctx, `本群暂无${mode === 4 ? '四麻' : '三麻'}订阅`, W / 2, cy, 40, '#93A2BC',
      'center', FONT.name, FONT.hei, 'normal');
    if (footer) {
      drawMixed(ctx, footer, W / 2, BG_Y + BG_H - HINT_Y_OFFSET, 20, '#A89C86',
        'center', FONT.hei, FONT.hei, 'normal');
    }
    return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
  }

  // ---- 订阅列表 ----
  const rows = subs.slice(0, MAX_ROWS);
  const rowW = W - 200;
  const rowX = Math.round((W - rowW) / 2);
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    const y = LIST_TOP + i * (ROW_H + ROW_GAP);

    // 行底：开启绿边高亮，关闭暗灰
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(rowX, y, rowW, ROW_H, 10);
    else ctx.rect(rowX, y, rowW, ROW_H);
    ctx.fillStyle = s.active ? 'rgba(87,196,107,0.14)' : 'rgba(0,0,0,0.30)';
    ctx.fill();
    ctx.strokeStyle = s.active ? 'rgba(87,196,107,0.70)' : 'rgba(201,164,90,0.18)';
    ctx.lineWidth = s.active ? 2 : 1.2;
    ctx.stroke();

    // 序号（汉仪文黑）
    drawMixed(ctx, String(i + 1), rowX + 40, y + ROW_H / 2, 26,
      s.active ? '#8FE0A0' : '#8FA3C4', 'center', FONT.hei, FONT.hei);

    // 昵称（红豆大黑体）
    const nameSize = 30;
    const nameMaxW = 300;
    ctx.font = `bold ${nameSize}px ${FONT.name}`;
    let name = String(s.nickname || '');
    let fitSize = nameSize;
    while (fitSize > 16 && ctx.measureText(name).width > nameMaxW) {
      fitSize -= 2;
      ctx.font = `bold ${fitSize}px ${FONT.name}`;
    }
    if (ctx.measureText(name).width > nameMaxW) {
      while (name.length > 1 && ctx.measureText(name + '…').width > nameMaxW) name = name.slice(0, -1);
      name += '…';
    }
    drawMixed(ctx, name, rowX + 78, y + ROW_H / 2, fitSize,
      s.active ? '#FFF3D6' : '#C3D0E2', 'left', FONT.name, FONT.hei);

    // UID（汉仪文黑）
    drawMixed(ctx, `UID ${s.id}`, rowX + 420, y + ROW_H / 2, 24, '#8FA3C4',
      'left', FONT.hei, FONT.hei, 'normal');

    // 状态（右对齐）
    drawMixed(ctx, s.active ? '播报中' : '已关闭', rowX + rowW - 30, y + ROW_H / 2, 24,
      s.active ? '#57C46B' : '#7A8598', 'right', FONT.name, FONT.hei);
  }

  if (subs.length > rows.length) {
    drawMixed(ctx, `…还有 ${subs.length - rows.length} 个`, W / 2,
      LIST_TOP + rows.length * (ROW_H + ROW_GAP) + 8, 20, '#8C9AB0',
      'center', FONT.hei, FONT.hei, 'normal');
  }

  // ---- 指令提示（列表下方居中）----
  if (footer) {
    drawMixed(ctx, footer, W / 2, BG_Y + BG_H - HINT_Y_OFFSET, 20, '#A89C86',
      'center', FONT.hei, FONT.hei, 'normal');
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}
