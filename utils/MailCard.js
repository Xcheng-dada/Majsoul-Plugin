// plugins/Majsoul-Plugin/utils/MailCard.js
// 雀魂邮件卡：仿官方邮件界面
//   顶部：「邮件」金色标题（居中）
//   左侧：邮件标签列表（官方选中/未选中底板 + 信封图标 + 标题最多两行）
//   右侧：「获得奖励」金色文字（居中）+ 奖励图标格（图标 + 下方数量）
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { FONT } from '../components/fonts.js';
import { CURRENCY_ICONS } from './CurrencyCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const MAIL_DIR = path.join(RESOURCES_ROOT, 'mail');
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');
const MAIL_BG = path.join(MAIL_DIR, 'mail_bg.png');
const TITLE_MAIL = path.join(MAIL_DIR, 'title_mail.png');
const TITLE_GETREWARD = path.join(MAIL_DIR, 'title_getreward.png');
const TAB_OFF = path.join(MAIL_DIR, 'tab_unchoosen.png');
const ICON_READ_YES = path.join(MAIL_DIR, 'icon_read_yes.png');   // 官方信封图标（已读态）
const ICON_READ_NO = path.join(MAIL_DIR, 'icon_read_no.png');     // 官方信封图标（未读态）
const EMPTY_NOINFO = path.join(MAIL_DIR, 'empty_noinfo.png');     // 官方空状态猫咪图标

// ---- 素材分区（1700×1034，mail_bg.png）----
const W = 1700, H = 1034;
const HEADER_CY = 102;                 // 顶部金色带中心
const BODY_TOP = 164;                  // 内容起点
const BODY_BOTTOM = 872;               // 内容下沿

// 左侧标签列表（统一用未选中底板：静态图无需高亮选中态）
const SIDE_X = 126;
const TAB_H = 134;                     // 标签高度（标题最多两行 + 过期时间行）
const TAB_W = 337;                     // 按底板 332×132 原比例换算
const TAB_GAP = 6;
const TAB_TITLE_SIZE = 34;
const TAB_TITLE_LH = 38;
const TAB_DATE_SIZE = 25;
// 信封图标盒：两种信封素材长宽比不同，统一约束在盒内居中，避免压到标题
const ICON_X = 20;
const ICON_BOX_W = 44;
const ICON_BOX_H = 40;
const ICON_TEXT_GAP = 16;

// 左右分栏
const DIVIDER_X = 470;
const RIGHT_L = 512;
const RIGHT_R = 1544;
const RIGHT_CX = Math.round((RIGHT_L + RIGHT_R) / 2);

// 奖励格（画布 1700 宽，缩到手机后需足够大才看得清）
const REWARD_TITLE_CY = 226;
const REWARD_TITLE_H = 130;            // 「获得奖励」金字高度
const SLOT = 176;                      // 奖励方格边长
const SLOT_GAP = 34;
const SLOT_TOP = 312;
const COUNT_SIZE = 48;

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

/** 按最大宽度折行（最多 maxLines 行，末行超宽加省略号） */
function wrapLines (ctx, text, maxW, font, maxLines = 2) {
  ctx.font = font;
  const s = String(text ?? '');
  const lines = [];
  let cur = '';
  for (const ch of s) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // 末行超宽则截断
  const last = lines.length - 1;
  if (last >= 0 && ctx.measureText(lines[last]).width > maxW) {
    let t = lines[last];
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    lines[last] = t + '…';
  }
  return lines;
}

/** 剩余时长文案：剩余 X 天 / 剩余 X 小时 / 即将过期 */
function fmtRemain (expireAt) {
  if (!expireAt) return '';
  const ms = expireAt - Date.now();
  if (ms <= 0) return '已过期';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `剩余 ${days} 天`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `剩余 ${hours} 小时`;
  return '即将过期';
}

/** 空状态小图标（深色圆角脸 + 两只眼睛，近似官方「什么都没有」吉祥物） */
function drawEmptyMascot (ctx, cx, cy, w, h) {
  ctx.save();
  // 脸
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 16);
  else ctx.rect(cx - w / 2, cy - h / 2, w, h);
  ctx.fillStyle = 'rgba(66, 74, 102, 0.96)';
  ctx.fill();
  // 两只眼睛
  ctx.fillStyle = '#E9EEF8';
  const r = Math.max(3, Math.round(w * 0.07));
  for (const dx of [-w * 0.16, w * 0.16]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy - h * 0.08, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 画一个简单的信封图标 */
function drawEnvelope (ctx, x, y, w, h, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  // 信封主体
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 4);
  else ctx.rect(x, y, w, h);
  ctx.stroke();
  // 封口 V 形
  ctx.beginPath();
  ctx.moveTo(x + 1, y + 1);
  ctx.lineTo(x + w / 2, y + h * 0.58);
  ctx.lineTo(x + w - 1, y + 1);
  ctx.stroke();
  ctx.restore();
}

/**
 * 渲染邮件领取卡
 * @param {object} options
 * @param {Array<{title:string, rewards?:object, expireAt?:number}>} options.mails 本次领取的邮件
 * @param {Array<{icon:string, count:number}>} options.items 奖励合计
 * @param {string} [options.nickname] 用户昵称（左下角）
 * @param {string} [options.avatar] 头像 URL 或本地路径（左下角）
 * @param {string} [options.footerHint] 右下角提示文案（默认「已自动存入仓库…」）
 * @param {'getreward'|'rewardlist'|'none'} [options.rewardTitle] 右栏金字：
 *   getreward「获得奖励」（领取卡）/ rewardlist「奖励一览」/ none 不画标题、奖励垂直居中
 * @param {boolean} [options.unread] 信封图标用未读态（发送回执用 true）
 * @param {boolean} [options.hideUser] 不画左下角头像与昵称（发送回执用）
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderMailCard ({ mails = [], items = [], nickname, avatar, footerHint, rewardTitle = 'getreward', unread = false, hideUser = false }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- 背景 ----
  const bg = await loadRes(MAIL_BG);
  ctx.drawImage(bg, 0, 0);

  // ---- 顶部「邮件」金色标题（居中，与官方一致）----
  try {
    const t = await loadRes(TITLE_MAIL);
    const th = 60;
    const tw = Math.round(t.width * th / t.height);
    ctx.drawImage(t, Math.round(W / 2 - tw / 2), HEADER_CY - th / 2, tw, th);
  } catch {
    drawMixed(ctx, '邮件', W / 2, HEADER_CY, 40, '#F5D9A0', 'center', FONT.name, FONT.hei);
  }

  // ---- 左侧标签列表（只显示邮件标题）----
  let tabImg = null;
  try { tabImg = await loadRes(TAB_OFF); } catch { /* 缺失则用纯色块 */ }
  let iconImg = null;
  try { iconImg = await loadRes(unread ? ICON_READ_NO : ICON_READ_YES); } catch { /* 缺失则退回手绘 */ }

  const maxRows = Math.floor((BODY_BOTTOM - BODY_TOP) / (TAB_H + TAB_GAP));
  const shown = mails.slice(0, maxRows);

  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    const y = BODY_TOP + i * (TAB_H + TAB_GAP);
    if (tabImg) {
      ctx.drawImage(tabImg, SIDE_X, y, TAB_W, TAB_H);
    } else {
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(SIDE_X, y, TAB_W, TAB_H, 12);
      else ctx.rect(SIDE_X, y, TAB_W, TAB_H);
      ctx.fillStyle = 'rgba(30,45,80,0.85)';
      ctx.fill();
    }

    // 信封图标：放进固定盒子内等比缩放并居中。
    // read_yes(50×54) 与 read_no(50×38) 长宽比不同，若只按高度缩放，
    // read_no 会变得过宽而压到右侧文字 —— 因此按盒子双维约束。
    if (iconImg) {
      const s = Math.min(ICON_BOX_W / iconImg.width, ICON_BOX_H / iconImg.height);
      const iw = iconImg.width * s;
      const ih = iconImg.height * s;
      ctx.drawImage(
        iconImg,
        SIDE_X + ICON_X + (ICON_BOX_W - iw) / 2,
        y + (TAB_H - ih) / 2,
        iw, ih
      );
    } else {
      drawEnvelope(ctx, SIDE_X + ICON_X + 4, y + TAB_H / 2 - 14, 38, 28, '#B9C9E0');
    }

    // 标题（最多两行）+ 过期时间行
    const textX = SIDE_X + ICON_X + ICON_BOX_W + ICON_TEXT_GAP;
    const textW = SIDE_X + TAB_W - 20 - textX;
    const font = `bold ${TAB_TITLE_SIZE}px ${FONT.name}`;
    const lines = wrapLines(ctx, m.title || '邮件', textW, font, 2);
    const dateText = fmtRemain(m.expireAt);
    const dateH = dateText ? TAB_DATE_SIZE : 0;
    const contentH = lines.length * TAB_TITLE_LH + (dateText ? 4 + dateH : 0);
    let cy = y + (TAB_H - contentH) / 2;
    for (let k = 0; k < lines.length; k++) {
      drawMixed(ctx, lines[k], textX, cy + TAB_TITLE_LH / 2, TAB_TITLE_SIZE,
        '#DCE6F5', 'left', FONT.name, FONT.hei);
      cy += TAB_TITLE_LH;
    }
    if (dateText) {
      drawMixed(ctx, dateText, textX, cy + 4 + dateH / 2, TAB_DATE_SIZE,
        '#8FA3BC', 'left', FONT.hei, FONT.hei, 'normal');
    }
  }

  if (mails.length > shown.length) {
    drawMixed(ctx, `…还有 ${mails.length - shown.length} 封`, SIDE_X + 20,
      BODY_TOP + shown.length * (TAB_H + TAB_GAP) + 8, 18, '#8C9AB0',
      'left', FONT.hei, FONT.hei, 'normal');
  }

  // ---- 左右分栏线 ----
  ctx.strokeStyle = 'rgba(150,180,220,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(DIVIDER_X, BODY_TOP - 10);
  ctx.lineTo(DIVIDER_X, BODY_BOTTOM);
  ctx.stroke();

  // ===== 空状态：无邮件可领取（仿官方「暂无邮件 / 什么都没有...」）=====
  if (!mails.length) {
    const bodyCy = Math.round((BODY_TOP + BODY_BOTTOM) / 2);
    const leftCx = Math.round((SIDE_X + DIVIDER_X) / 2);
    // 手机 QQ 上图片会被缩放，字号需足够大才看得清
    const EMPTY_TEXT = 72;
    const MASCOT_H = 140;
    // 左栏：暂无邮件
    drawMixed(ctx, '暂无邮件', leftCx, bodyCy, EMPTY_TEXT, '#93A2BC', 'center', FONT.name, FONT.hei, 'normal');
    // 右栏：官方空状态图标 + 什么都没有...
    try {
      const ni = await loadRes(EMPTY_NOINFO);
      const nh = MASCOT_H;
      const nw = Math.round(ni.width * nh / ni.height);
      ctx.drawImage(ni, Math.round(RIGHT_CX - nw / 2), bodyCy - 60 - nh / 2, nw, nh);
    } catch {
      drawEmptyMascot(ctx, RIGHT_CX, bodyCy - 60, 160, MASCOT_H);
    }
    drawMixed(ctx, '什么都没有...', RIGHT_CX, bodyCy + 70, EMPTY_TEXT, '#93A2BC',
      'center', FONT.name, FONT.hei, 'normal');

    // 底部头像与昵称照常
    await drawFooter(ctx, nickname, avatar, '暂无未领取的邮件');
    return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
  }

  // ---- 右侧标题 ----
  //   getreward：官方「获得奖励」金字素材
  //   rewardlist：自绘「奖励一览」金色文字（文鼎特毛楷，带柔光，与卡片配色统一）
  //   none：不画标题，奖励网格改垂直居中
  const showTitle = rewardTitle !== 'none';
  if (showTitle) {
    if (rewardTitle === 'rewardlist') {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 214, 140, 0.55)';
      ctx.shadowBlur = 22;
      drawMixed(ctx, '奖励一览', RIGHT_CX, REWARD_TITLE_CY, 84, '#F2D89A',
        'center', FONT.kai, FONT.hei);
      ctx.restore();
    } else {
      try {
        const g = await loadRes(TITLE_GETREWARD);
        const gh = REWARD_TITLE_H;
        const gw = Math.min(Math.round(g.width * gh / g.height), RIGHT_R - RIGHT_L - 40);
        ctx.drawImage(g, Math.round(RIGHT_CX - gw / 2), REWARD_TITLE_CY - gh / 2, gw, gh);
      } catch {
        drawMixed(ctx, '获得奖励', RIGHT_CX, REWARD_TITLE_CY, 84, '#F5D9A0',
          'center', FONT.kai, FONT.hei);
      }
    }
  }

  // ---- 奖励格（均衡分行 + 每行水平居中，最多 7 个也能对称）----
  const MAX_COLS = 5;
  const ROW_STEP = SLOT + 68;            // 方格 + 数量区
  // 按最大列数均衡拆行（7 个 → 4+3、6 个 → 3+3），大行在上
  const rowCount = Math.max(1, Math.ceil(items.length / MAX_COLS));
  const base = Math.floor(items.length / rowCount);
  const extra = items.length % rowCount;
  const gridRows = [];
  let off = 0;
  for (let r = 0; r < rowCount; r++) {
    const n = base + (r < extra ? 1 : 0);
    gridRows.push(items.slice(off, off + n));
    off += n;
  }

  // 无标题时：整块奖励在右栏可用高度内垂直居中
  const blockH = (rowCount - 1) * ROW_STEP + SLOT + COUNT_SIZE + 20;
  let gridY = showTitle
    ? SLOT_TOP
    : Math.max(BODY_TOP + 20, Math.round((BODY_TOP + BODY_BOTTOM - blockH) / 2));
  for (const row of gridRows) {
    if (!row.length) continue;
    const rowW = row.length * SLOT + (row.length - 1) * SLOT_GAP;
    let x = Math.round(RIGHT_CX - rowW / 2);   // 每行独立居中
    for (const it of row) {
      const y = gridY;

      // 方格底板（官方样式：深蓝方块 + 细边）
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, SLOT, SLOT, 12);
      else ctx.rect(x, y, SLOT, SLOT);
      ctx.fillStyle = 'rgba(12,20,45,0.72)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,160,220,0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 图标（留 14px 内边距，尽量撑满方格）
      const iconFile = CURRENCY_ICONS[it.icon] || it.icon;
      try {
        const icon = await loadRes(path.join(ECONOMY_DIR, `${iconFile}.png`));
        const inner = SLOT - 14;
        const s = Math.min(inner / icon.width, inner / icon.height);
        const dw = icon.width * s, dh = icon.height * s;
        ctx.drawImage(icon, x + (SLOT - dw) / 2, y + (SLOT - dh) / 2, dw, dh);
      } catch { /* 图标缺失跳过 */ }

      // 数量（格下方居中）
      drawMixed(ctx, String(it.count), x + SLOT / 2, y + SLOT + COUNT_SIZE / 2 + 12, COUNT_SIZE,
        '#FFFFFF', 'center', FONT.hei, FONT.hei);

      x += SLOT + SLOT_GAP;
    }
    gridY += ROW_STEP;
  }

  // ---- 底部：左下角头像 + 昵称（替代引用回复），右下角提示 ----
  // ---- 底部：左下角头像 + 昵称（替代引用回复），右下角提示 ----
  if (hideUser) {
    // 发送回执不显示操作者身份，提示文字居中
    const hint = footerHint || '已发放到本群';
    drawMixed(ctx, hint, W / 2, BODY_BOTTOM + 58, 24, '#8C9AB0',
      'center', FONT.hei, FONT.hei, 'normal');
  } else {
    await drawFooter(ctx, nickname, avatar,
      footerHint || '已自动存入仓库　·　查看余额：#雀魂仓库');
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}

/**
 * 底部栏：左下头像 + 昵称，右下提示文字
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} [nickname]
 * @param {string} [avatar]
 * @param {string} [hint] 右下角提示
 */
async function drawFooter (ctx, nickname, avatar, hint) {
  const AV = 88;
  const avX = 150;
  const avY = BODY_BOTTOM + 26;
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
        if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, AV, AV, 14);
        else cx.rect(0, 0, AV, AV);
        cx.clip();
        const side = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AV, AV);
        cx.restore();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, AV - 2, AV - 2, 14);
        else cx.rect(0, 0, AV, AV);
        cx.strokeStyle = '#C9A063';
        cx.lineWidth = 2.5;
        cx.stroke();
        ctx.drawImage(c, avX, avY);
      }
    } catch { /* 头像失败静默跳过 */ }
  }

  if (nickname) {
    const name = String(nickname);
    const nameX = avX + AV + 20;
    const availW = 620;
    let size = 38;
    ctx.font = `bold ${size}px ${FONT.name}`;
    while (size > 16 && ctx.measureText(name).width > availW) {
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

  if (hint) {
    drawMixed(ctx, hint, RIGHT_R, rowCy, 24, '#8C9AB0', 'right', FONT.hei, FONT.hei, 'normal');
  }
}
