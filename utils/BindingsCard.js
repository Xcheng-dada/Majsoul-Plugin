// plugins/Majsoul-Plugin/utils/BindingsCard.js
// 雀魂绑定列表卡：官方弹窗底板（pop_bg + pop_bound + 波浪装饰）
//   标题「雀魂绑定」+ UID 列表（主账号金色标记）+ 左下头像昵称 + 右下指令提示
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

// ---- 画布与内区（与兑换卡一致的弹窗尺寸）----
const SCALE = 1.6;
const W = Math.round(611 * SCALE);      // 978
const H = Math.round(455 * SCALE);      // 728
const BG_X = Math.round(28 * SCALE);
const BG_Y = Math.round(27 * SCALE);
const BG_W = Math.round(555 * SCALE);
const BG_H = Math.round(400 * SCALE);

const TITLE_Y = 108;
const LIST_TOP = 168;
const ROW_H = 66;
const ROW_GAP = 10;
const MAX_ROWS = 5;                    // 超出会压到底部提示区，故限 5 行
const HINT_Y_OFFSET = 118;             // 指令提示距内底的距离（底行留给头像昵称）

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
 * 渲染绑定列表卡
 * @param {object} options
 * @param {Array<{uid:string|number, name?:string, isMain?:boolean}>} options.bindings 绑定列表
 * @param {string} [options.nickname] 用户昵称（左下）
 * @param {string} [options.avatar] 头像 URL 或本地路径（左下）
 * @param {string} [options.footer] 右下指令提示
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderBindingsCard ({ bindings = [], nickname, avatar, footer }) {
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
  } catch { /* 底缺失则纯色 */ }
  try {
    const bound = await loadRes(POP_BOUND);
    ctx.drawImage(bound, 0, 0, W, H);
  } catch { /* 框缺失则跳过 */ }

  // ---- 标题 ----
  drawMixed(ctx, '雀魂绑定', W / 2, TITLE_Y, 44, COL_GOLD_TEXT, 'center', FONT.kai, FONT.hei);

  // ---- UID 列表 ----
  const rows = bindings.slice(0, MAX_ROWS);
  const rowW = W - 200;
  const rowX = Math.round((W - rowW) / 2);
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const y = LIST_TOP + i * (ROW_H + ROW_GAP);
    const isMain = !!b.isMain;

    // 行底：主账号金色描边高亮
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(rowX, y, rowW, ROW_H, 10);
    else ctx.rect(rowX, y, rowW, ROW_H);
    ctx.fillStyle = isMain ? 'rgba(201,164,90,0.20)' : 'rgba(0,0,0,0.30)';
    ctx.fill();
    ctx.strokeStyle = isMain ? 'rgba(201,164,90,0.85)' : 'rgba(201,164,90,0.20)';
    ctx.lineWidth = isMain ? 2 : 1.2;
    ctx.stroke();

    // 序号
    drawMixed(ctx, String(i + 1), rowX + 42, y + ROW_H / 2, 26,
      isMain ? COL_GOLD_TEXT : '#8FA3C4', 'center', FONT.hei, FONT.hei);

    // UID
    const uidText = `UID ${b.uid}`;
    const uidSize = 34;
    drawMixed(ctx, uidText, rowX + 86, y + ROW_H / 2, uidSize,
      isMain ? '#FFF3D6' : '#DCE6F5', 'left', FONT.hei, FONT.hei);

    // 雀魂昵称（UID 右侧，小一号灰白字；过长则截断）
    if (b.name) {
      ctx.font = `bold ${uidSize}px ${FONT.hei}`;
      const uidW = ctx.measureText(uidText).width;
      const nameX = rowX + 86 + uidW + 22;
      const nameMaxW = rowX + rowW - (isMain ? 130 : 34) - nameX;
      if (nameMaxW > 60) {
        const nameSize = 26;
        ctx.font = `bold ${nameSize}px ${FONT.name}`;
        let out = String(b.name);
        if (ctx.measureText(out).width > nameMaxW) {
          while (out.length > 1 && ctx.measureText(out + '…').width > nameMaxW) out = out.slice(0, -1);
          out += '…';
        }
        drawMixed(ctx, out, nameX, y + ROW_H / 2, nameSize,
          isMain ? '#D9C89A' : '#A8B8CE', 'left', FONT.name, FONT.hei);
      }
    }

    // 主账号标记
    if (isMain) {
      drawMixed(ctx, '主账号', rowX + rowW - 30, y + ROW_H / 2, 24,
        COL_GOLD_TEXT, 'right', FONT.name, FONT.hei);
    }
  }

  if (bindings.length > rows.length) {
    drawMixed(ctx, `…还有 ${bindings.length - rows.length} 个`, W / 2,
      LIST_TOP + rows.length * (ROW_H + ROW_GAP) + 10, 20, '#8C9AB0',
      'center', FONT.hei, FONT.hei, 'normal');
  }

  // ---- 指令提示：列表下方居中单独一行，避免与底部昵称挤在一起 ----
  if (footer) {
    drawMixed(ctx, footer, W / 2, BG_Y + BG_H - HINT_Y_OFFSET, 20, '#A89C86',
      'center', FONT.hei, FONT.hei, 'normal');
  }

  // ---- 底部：头像 + 昵称（左）----
  const AV = 72;
  const avX = 150;
  const avY = BG_Y + BG_H - AV - 26;
  const rowCy = avY + AV / 2;

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
        if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, AV, AV, 12);
        else cx.rect(0, 0, AV, AV);
        cx.clip();
        const side = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AV, AV);
        cx.restore();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, AV - 2, AV - 2, 12);
        else cx.rect(0, 0, AV, AV);
        cx.strokeStyle = COL_GOLD;
        ctx.lineWidth = 2.5;
        cx.lineWidth = 2.5;
        cx.strokeStyle = COL_GOLD;
        cx.stroke();
        ctx.drawImage(c, avX, avY);
      }
    } catch { /* 头像失败跳过 */ }
  }

  if (nickname) {
    const name = String(nickname);
    const nameX = avX + AV + 16;
    const availW = 560;                 // 右侧不再放提示文字，昵称可用更宽
    let size = 30;
    ctx.font = `bold ${size}px ${FONT.name}`;
    while (size > 14 && ctx.measureText(name).width > availW) {
      size -= 2;
      ctx.font = `bold ${size}px ${FONT.name}`;
    }
    let out = name;
    if (ctx.measureText(out).width > availW) {
      while (out.length > 1 && ctx.measureText(out + '…').width > availW) out = out.slice(0, -1);
      out += '…';
    }
    drawMixed(ctx, out, nameX, rowCy, size, '#E8DCC0', 'left', FONT.name, FONT.hei);
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}
