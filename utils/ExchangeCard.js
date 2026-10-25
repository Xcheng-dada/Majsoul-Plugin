// plugins/Majsoul-Plugin/utils/ExchangeCard.js
// 信仰兑换结果卡：仿官方兑换弹窗（深蓝面板 + 金边 + 头像金框 + 总价 + 按钮）
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FONT } from '../components/fonts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const FAITH_ICON = path.join(RESOURCES_ROOT, 'economy', '信仰.png');
const POP_BOUND = path.join(RESOURCES_ROOT, 'ui', 'pop_bound.png');   // 金色外框（611×455）
const POP_BG = path.join(RESOURCES_ROOT, 'ui', 'pop_bg.png');         // 深蓝内底（555×400）
const POP_DECO_L = path.join(RESOURCES_ROOT, 'ui', 'pop_deco_left.png');  // 波浪装饰·左（247×107）
const POP_DECO_R = path.join(RESOURCES_ROOT, 'ui', 'pop_deco_right.png'); // 波浪装饰·右（396×104）
const POP_BTN = path.join(RESOURCES_ROOT, 'ui', 'pop_btn_light.png');     // 金色按钮（162×92）
const POP_BTN_GRAY = path.join(RESOURCES_ROOT, 'ui', 'pop_btn_gray.png'); // 灰色按钮（162×92，失败态）
const MARK_OWNED = path.join(RESOURCES_ROOT, 'ui', 'mark_owned.png');     // 「已拥有」印章（198×158）

// ---- 布局与配色（官方弹窗：pop_bg 内底 + pop_bound 金框，等比放大 1.6 倍）----
const SCALE = 1.6;
const W = Math.round(611 * SCALE);      // 978
const H = Math.round(455 * SCALE);      // 728
// pop_bg 在 pop_bound 内居中：偏移 (611-555)/2=28, (455-400)/2=27
const BG_X = Math.round(28 * SCALE);    // 45
const BG_Y = Math.round(27 * SCALE);    // 43
const BG_W = Math.round(555 * SCALE);   // 888
const BG_H = Math.round(400 * SCALE);   // 640
// 底板内区（原生 x36..575 / y36..419）
const INNER_L = Math.round(58);
const INNER_R = W - Math.round(58);
const INNER_T = Math.round(58);
const INNER_B = H - Math.round(58);

const COL_GOLD = '#C9A45A';
const COL_GOLD_TEXT = '#E8C87E';
const COL_PRICE = '#E2493F';            // 信仰不足：红
const COL_PRICE_OK = '#57C46B';         // 信仰足够：绿
const COL_BTN_TOP = '#F7EDD2';
const COL_BTN_BOTTOM = '#E6D3A8';
const COL_BTN_TEXT = '#8A5A1E';

const NAME_Y = 108;
const PORTRAIT = 280;
const PORTRAIT_Y = 146;
const PRICE_Y = 474;
const BTN_W = 360;
const BTN_H = 72;
const BTN_Y = 512;

/** 把图片转成灰度并压暗，用于「未开启兑换」状态的头像 */
async function toGrayscale (img, w, h) {
  const off = createCanvas(w, h);
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0, w, h);
  const id = octx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * 0.55;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  octx.putImageData(id, 0, 0);
  return off;
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
 * 渲染兑换结果卡片
 *
 * @param {object} options
 * @param {string} options.name       雀士名
 * @param {boolean} [options.isLimited] 是否限定雀士（当前仅保留参数，卡面不再显示徽章）
 * @param {number} [options.cost]     本次消耗的信仰
 * @param {number} [options.faith]    兑换后的信仰余额
 * @param {string|null} [options.portraitPath] 立绘文件绝对路径（缺失时画占位）
 * @param {'success'|'insufficient'|'owned'|'unopened'|'notfound'} [options.state] 卡片状态：
 *   success 金色按钮·兑换成功；insufficient 灰色按钮·信仰不足；
 *   owned 灰色按钮 + 「已拥有」印章；unopened 灰度头像 + 「未开启兑换」；
 *   notfound 仅在头像位置显示「雀士未找到」，不画头像/名字/价格/按钮
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderExchangeCard ({ name, isLimited = false, cost = 0, faith = null, portraitPath = null, state = 'success' }) {
  const nameText = String(name || '');
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- 面板：pop_bg 深蓝内底 + pop_bound 金色外框 ----
  try {
    const bgImg = await loadImage(await fs.promises.readFile(POP_BG));
    ctx.drawImage(bgImg, BG_X, BG_Y, BG_W, BG_H);

    // 底部左右波浪装饰（裁在 pop_bg 区域内，避免溢出金框）
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(BG_X, BG_Y, BG_W, BG_H, 10);
    else ctx.rect(BG_X, BG_Y, BG_W, BG_H);
    ctx.clip();
    try {
      const dl = await loadImage(await fs.promises.readFile(POP_DECO_L));
      const dh = Math.round(dl.height * 1.15);
      const dw = Math.round(dl.width * 1.15);
      ctx.drawImage(dl, BG_X + 8, BG_Y + BG_H - dh, dw, dh);
    } catch { /* 缺失跳过 */ }
    try {
      const dr = await loadImage(await fs.promises.readFile(POP_DECO_R));
      const dh = Math.round(dr.height * 1.15);
      const dw = Math.round(dr.width * 1.15);
      ctx.drawImage(dr, BG_X + BG_W - dw - 8, BG_Y + BG_H - dh, dw, dh);
    } catch { /* 缺失跳过 */ }
    ctx.restore();
  } catch {
    // 内底缺失时用纯色兜底
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(INNER_L, INNER_T, INNER_R - INNER_L, INNER_B - INNER_T, 10);
    else ctx.rect(INNER_L, INNER_T, INNER_R - INNER_L, INNER_B - INNER_T);
    ctx.fillStyle = '#171e37';
    ctx.fill();
  }

  try {
    const boundImg = await loadImage(await fs.promises.readFile(POP_BOUND));
    ctx.drawImage(boundImg, 0, 0, W, H);
  } catch {
    ctx.strokeStyle = COL_GOLD;
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(INNER_L, INNER_T, INNER_R - INNER_L, INNER_B - INNER_T, 10);
    else ctx.rect(INNER_L, INNER_T, INNER_R - INNER_L, INNER_B - INNER_T);
    ctx.stroke();
  }

  // ---- 雀士名不存在：头像位置显示「雀士未找到」，其余内容全部不画 ----
  if (state === 'notfound') {
    drawMixed(ctx, '雀士未找到', W / 2, PORTRAIT_Y + PORTRAIT / 2, 72, '#93A2BC',
      'center', FONT.kai, FONT.hei);
    return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
  }

  // ---- 顶部雀士名（金色，居中，文鼎特毛楷）----
  drawMixed(ctx, nameText, W / 2, NAME_Y, 46, COL_GOLD_TEXT, 'center', FONT.kai, FONT.hei);

  // ---- 头像：正方形 + 金框（unopened 态转灰度）----
  const px = Math.round((W - PORTRAIT) / 2);
  let drewPortrait = false;
  if (portraitPath) {
    try {
      let img = await loadImage(await fs.promises.readFile(portraitPath));
      if (state === 'unopened') {
        // 池未开启：头像转灰度，表达「暂不可兑换」
        img = await toGrayscale(img, PORTRAIT, PORTRAIT);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, PORTRAIT_Y, PORTRAIT, PORTRAIT);
      ctx.clip();
      if (state === 'unopened') {
        // 已按目标尺寸预处理，直接铺满
        ctx.drawImage(img, px, PORTRAIT_Y, PORTRAIT, PORTRAIT);
      } else {
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
          px, PORTRAIT_Y, PORTRAIT, PORTRAIT);
      }
      ctx.restore();
      drewPortrait = true;
    } catch { /* 失败走占位 */ }
  }
  if (!drewPortrait) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(px, PORTRAIT_Y, PORTRAIT, PORTRAIT);
    drawMixed(ctx, nameText.slice(0, 1) || '?', W / 2, PORTRAIT_Y + PORTRAIT / 2, 120,
      '#6C7A99', 'center', FONT.name, FONT.hei);
  }
  // 金框
  ctx.strokeStyle = COL_GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(px + 1.5, PORTRAIT_Y + 1.5, PORTRAIT - 3, PORTRAIT - 3);

  // 已拥有印章（盖在头像上，边缘可越过金框，与官方一致）
  if (state === 'owned') {
    try {
      const mk = await loadImage(await fs.promises.readFile(MARK_OWNED));
      const mw = Math.round(PORTRAIT * 0.98);
      const mh = Math.round(mk.height * mw / mk.width);
      ctx.drawImage(mk, Math.round(W / 2 - mw / 2), Math.round(PORTRAIT_Y + PORTRAIT / 2 - mh / 2), mw, mh);
    } catch { /* 素材缺失则跳过 */ }
  }

  // ---- 总价：[文字] [信仰图标] [数量] ----
  const labelSize = 34;
  const priceSize = 46;
  ctx.font = `bold ${labelSize}px ${FONT.name}`;
  const labelW = ctx.measureText('总价').width;
  ctx.font = `bold ${priceSize}px ${FONT.hei}`;
  const priceW = ctx.measureText(String(cost)).width;
  const iconSize = 42;
  const gap = 14;
  const totalW = labelW + gap + iconSize + gap + priceW;
  let cx = Math.round((W - totalW) / 2);
  drawMixed(ctx, '总价', cx, PRICE_Y, labelSize, '#FFFFFF', 'left', FONT.name, FONT.hei);
  cx += labelW + gap;
  try {
    const fi = await loadImage(await fs.promises.readFile(FAITH_ICON));
    const s = Math.min(iconSize / fi.width, iconSize / fi.height);
    const dw = fi.width * s, dh = fi.height * s;
    ctx.drawImage(fi, cx + (iconSize - dw) / 2, PRICE_Y - dh / 2, dw, dh);
  } catch { /* 图标缺失则不画 */ }
  cx += iconSize + gap;
  // 信仰足够 → 绿色；不足 → 红色。
  // success 态传入的 faith 是「扣除后余额」，直接按成功判定为足够。
  const enough = state === 'success' || (faith == null ? true : faith >= cost);
  drawMixed(ctx, String(cost), cx, PRICE_Y, priceSize, enough ? COL_PRICE_OK : COL_PRICE,
    'left', FONT.name, FONT.hei);

  // ---- 按钮：成功用金色 button_light，失败/已拥有用 button_gray ----
  //      两端叶子固定，只拉伸中段，避免压扁装饰
  const bx = Math.round((W - BTN_W) / 2);
  const btnFile = state === 'success' ? POP_BTN : POP_BTN_GRAY;
  const BTN_TEXT = {
    success: '兑换成功',
    owned: '已拥有',
    insufficient: '信仰不足',
    unopened: '未开启兑换'
  };
  const btnText = BTN_TEXT[state] || '兑换成功';
  const btnTextColor = state === 'success' ? COL_BTN_TEXT : '#5A6273';
  let drewBtn = false;
  try {
    const btn = await loadImage(await fs.promises.readFile(btnFile));
    const s = BTN_H / btn.height;              // 等比缩放系数
    const endW = Math.round(46 * s);           // 两端各保留 46px 原图宽（含叶子）
    const midSrcW = btn.width - 46 * 2;
    // 左端
    ctx.drawImage(btn, 0, 0, 46, btn.height, bx, BTN_Y, endW, BTN_H);
    // 中段（横向拉伸）
    ctx.drawImage(btn, 46, 0, midSrcW, btn.height, bx + endW, BTN_Y, BTN_W - endW * 2, BTN_H);
    // 右端
    ctx.drawImage(btn, btn.width - 46, 0, 46, btn.height, bx + BTN_W - endW, BTN_Y, endW, BTN_H);
    drewBtn = true;
  } catch { /* 走兜底 */ }
  if (!drewBtn) {
    // 兜底：手绘按钮
    const btnGrad = ctx.createLinearGradient(0, BTN_Y, 0, BTN_Y + BTN_H);
    btnGrad.addColorStop(0, state === 'success' ? COL_BTN_TOP : '#D8DCE4');
    btnGrad.addColorStop(1, state === 'success' ? COL_BTN_BOTTOM : '#B9C0CC');
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, BTN_Y, BTN_W, BTN_H, 14);
    else ctx.rect(bx, BTN_Y, BTN_W, BTN_H);
    ctx.fillStyle = btnGrad;
    ctx.fill();
    ctx.strokeStyle = COL_GOLD;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  drawMixed(ctx, btnText, W / 2, BTN_Y + BTN_H / 2, 36, btnTextColor, 'center', FONT.kai, FONT.hei);

  // ---- 剩余信仰 ----
  if (faith != null) {
    drawMixed(ctx, `剩余信仰 ${faith}`, W / 2, BTN_Y + BTN_H + 32, 26, '#8FA3C4',
      'center', FONT.hei, FONT.hei, 'normal');
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}
