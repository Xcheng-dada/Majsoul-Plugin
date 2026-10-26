// plugins/Majsoul-Plugin/utils/PoolListCard.js
// 卡池一览图：官方寻觅鸟居背景 + 黑色滤镜（不加金框）
// 布局：上方左侧当前卡池（艺术字）+ 右侧 UP 雀士头像（UP 角标、名字在下）
//       下方可用卡池列表（全部艺术字，联动池带「特定装扮UP」标签，限时池带「剩余时间」）
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { FONT } from '../components/fonts.js';
import { findPoolTitleArt } from './PoolTitleArt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const GACHA_DIR = path.join(RESOURCES_ROOT, 'gacha');
const PERSON_DIR = path.join(RESOURCES_ROOT, 'person');
const POOLS_BG = path.join(GACHA_DIR, 'pools_bg.png');
const UP_BADGE = path.join(GACHA_DIR, 'up_badge.png');
const BADGE_LEFTTIME = path.join(GACHA_DIR, 'badge_lefttime.png');       // 「剩余时间」
const BADGE_SPECIAL_SAKURA = path.join(GACHA_DIR, 'badge_special_sakura.png'); // 「特定装扮UP!」紫（樱花）
const BADGE_SPECIAL_ZHULIN = path.join(GACHA_DIR, 'badge_special_zhulin.png'); // 「特定装扮UP!」绿（竹林）

const DARK_ALPHA = 0.52;

// ---- 布局常量 ----
const W = 1040;
const PAD_X = 72;
const TITLE_Y = 62;

// 上方：当前卡池 + UP 雀士（同一横带）
const BAND_LABEL_Y = 140;      // 「当前卡池」「UP 雀士」小标签 y
const BAND_CY = 214;           // 该横带的垂直中心（艺术字与头像共用）
const CUR_ART_H = 62;          // 当前池艺术字高度
const AV = 86;                 // UP 头像尺寸
const AV_GAP = 24;
const NAME_SIZE = 19;
const UP_LABEL_GAP = 56;       // 当前池艺术字与 UP 区的间距

const ROW_ART_H = 44;
const ROW_H = 64;          // 普通行（只有池名）
const ROW_GAP = 8;

// 顶部当前池 UP 装扮缩略图（与 UP 雀士头像同尺寸，视觉才统一）
const TOP_DECOR_TS = AV;
const FOOTER_H = 92;                   // 底部：头像+昵称（左）与提示（右）
const FOOTER_AV = 64;                  // 底部头像尺寸
// 「剩余时间」角标与倒计时数字之间的间距（角标图自带 2px 透明边，故留 12px 才不显黏）
const BADGE_TEXT_GAP = 12;

const _cache = new Map();
async function loadRes (p) {
  if (_cache.has(p)) return _cache.get(p);
  const img = await loadImage(await fs.promises.readFile(p));
  _cache.set(p, img);
  return img;
}

/** 雀士名 → 头像文件路径（resources/person/） */
function findPersonImage (name) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = path.join(PERSON_DIR, n + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const DECOR_DIR = path.join(RESOURCES_ROOT, 'decoration');
const DECOR_EXT = ['.jpg', '.png', '.jpeg', '.webp'];

/**
 * 装扮名 → 图片路径。
 * 联动池/自定义UP池的装扮在自己的子目录里（如 decoration/saki1/），
 * 所以先查池目录再回退到 decoration 根目录。
 * @param {string} name 装扮文件名（可带或不带扩展名）
 * @param {string} [poolName] 池名（用于定位子目录）
 */
function findDecorationImage (name, poolName) {
  const n = String(name || '').trim();
  if (!n) return null;
  const dirs = [];
  if (poolName && poolName !== 'normal') {
    let d = String(poolName);
    if (d.startsWith('custom:')) d = d.slice('custom:'.length);
    if (d.includes('|')) d = d.split('|')[0];
    if (d) dirs.push(path.join(DECOR_DIR, d));
  }
  dirs.push(DECOR_DIR);
  for (const dir of dirs) {
    if (path.extname(n)) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    } else {
      for (const ext of DECOR_EXT) {
        const p = path.join(dir, n + ext);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** 中英数字混排绘制 */
function drawMixed (ctx, text, x, y, size, color, align, cjkFont, numFont, weight = 'bold') {
  const s = String(text ?? '');
  if (!s) return 0;
  const { segs, total } = splitMixed(ctx, s, size, cjkFont, numFont, weight);
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
  return total;
}

/**
 * 按「数字段用 numFont、其余用 cjkFont」切段并测量总宽。
 * ⚠️ 必须与 drawMixed 使用同一套字体分段，否则量出来的宽度和实际绘制不一致，
 *    右对齐时会导致文字压到左侧元素（如「剩余时间」角标）。
 */
function splitMixed (ctx, text, size, cjkFont, numFont, weight = 'bold') {
  const isNum = (c) => /[0-9A-Za-z.]/.test(c);
  const segs = [];
  let cur = '', curIsNum = null;
  for (const ch of String(text ?? '')) {
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
  return { segs, total };
}

/** 混排文本的真实绘制宽度（与 drawMixed 完全一致） */
function measureMixed (ctx, text, size, cjkFont, numFont, weight = 'bold') {
  return splitMixed(ctx, text, size, cjkFont, numFont, weight).total;
}

/**
 * 缩略图下方的名称（与雀士名下同一行同字号）。
 * 装扮名通常较长（如「和牌-冷血射击」），先缩字号，仍超宽则省略号截断。
 */
function drawThumbCaption (ctx, text, cx, cy, maxW) {
  const s = String(text || '').trim();
  if (!s) return;
  let size = NAME_SIZE;
  ctx.font = `bold ${size}px ${FONT.name}`;
  while (size > 11 && ctx.measureText(s).width > maxW) {
    size -= 1;
    ctx.font = `bold ${size}px ${FONT.name}`;
  }
  let t = s;
  if (ctx.measureText(t).width > maxW) {
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    t += '…';
  }
  drawMixed(ctx, t, cx, cy, size, '#FFF6E0', 'center', FONT.name, FONT.hei);
}

/**
 * 画一个圆形/圆角图片缩略图（带金边）
 */
function drawThumb (ctx, img, x, y, size, radius) {
  const c = createCanvas(size, size);
  const cx = c.getContext('2d');
  cx.save();
  cx.beginPath();
  if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, size, size, radius);
  else cx.rect(0, 0, size, size);
  cx.clip();
  const side = Math.min(img.width, img.height);
  cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  cx.restore();
  cx.beginPath();
  if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, size - 2, size - 2, radius);
  else cx.rect(0, 0, size, size);
  cx.strokeStyle = '#D6AF6E';
  cx.lineWidth = 2;
  cx.stroke();
  ctx.drawImage(c, x, y);
}


/**
 * 渲染卡池一览图
 * @param {object} options
 * @param {string} options.currentName 当前卡池显示名
 * @param {string[]} [options.upNames] 当前池 UP 雀士名称列表
 * @param {string[]} [options.upDecorNames] 当前池 UP 装扮名称列表
 * @param {string} [options.currentCountdown] 当前池剩余时间（限时池才显示）
 * @param {Array<{name:string, countdown?:string, isCurrent?:boolean, upNames?:string[], upDecorNames?:string[]}>} options.pools 可用卡池
 * @param {string} [options.footer] 底部提示
 * @param {string} [options.nickname] 用户昵称（左下角，个人卡池各不相同）
 * @param {string} [options.avatar] 头像 URL 或本地路径
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderPoolListCard ({ currentName, currentPoolId = '', upNames = [], upDecorNames = [], currentCountdown = '', pools = [], footer, nickname, avatar }) {
  const upList = (upNames || []).filter(Boolean);
  const upDecorList = (upDecorNames || []).filter(Boolean);

  // ---- 动态布局 ----
  // 顶部横带底部 = 头像名 / 当前池倒计时 的最大下沿
  // （UP 装扮改为与 UP 雀士同行的右侧区域，不再单独占一行）
  const AV_BOTTOM = BAND_CY + AV / 2 + 10 + NAME_SIZE;         // 头像 + 名字
  const CUR_CD_Y = BAND_CY + CUR_ART_H / 2 + 24;               // 当前池倒计时
  const bandBottom = Math.max(
    AV_BOTTOM,
    currentCountdown ? CUR_CD_Y + 8 : 0
  );
  const LIST_TITLE_Y = bandBottom + 46;   // 「可用卡池」标签 y
  const LIST_TOP = LIST_TITLE_Y + 30;     // 列表首行顶部

  // 行内 UP 缩略图：统一单行布局，不再为 UP 内容额外加高整行
  const rowHs = pools.map(() => ROW_H);
  const rowsH = rowHs.length
    ? rowHs.reduce((a, b) => a + b, 0) + (pools.length - 1) * ROW_GAP
    : ROW_H;
  const H = LIST_TOP + rowsH + FOOTER_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- 背景：cover 铺满 + 黑色滤镜（不加金框）----
  const bg = await loadRes(POOLS_BG);
  const s = Math.max(W / bg.width, H / bg.height);
  const dw = bg.width * s, dh = bg.height * s;
  ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.fillStyle = `rgba(0,0,0,${DARK_ALPHA})`;
  ctx.fillRect(0, 0, W, H);

  // ---- 标题 ----
  drawMixed(ctx, '卡池一览', W / 2, TITLE_Y, 38, '#FFE9B8', 'center', FONT.name, FONT.hei);

  // ===== 上方横带：左 = 当前卡池，右 = UP 雀士 =====
  // 左侧小标签
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 20px ${FONT.hei}`;
  ctx.fillStyle = '#C9BFA8';
  ctx.fillText('当前卡池', PAD_X, BAND_LABEL_Y);

  // 当前池艺术字
  const curArtPath = findPoolTitleArt(currentName);
  const curArt = curArtPath ? await loadRes(curArtPath).catch(() => null) : null;
  let curW = 0;
  if (curArt) {
    const artW = Math.round(curArt.width * CUR_ART_H / curArt.height);
    curW = artW;
    ctx.drawImage(curArt, PAD_X, BAND_CY - CUR_ART_H / 2, artW, CUR_ART_H);
  } else {
    // 无素材时用文字，宽度按测量值估算
    ctx.font = `bold 34px ${FONT.name}`;
    curW = Math.min(ctx.measureText(currentName || '未知卡池').width, 360);
    drawMixed(ctx, currentName || '未知卡池', PAD_X, BAND_CY + 10, 34, '#FFF6E0', 'left', FONT.name, FONT.hei);
  }

  // 当前池剩余时间（限时池才显示，画在池名艺术字下方）
  if (currentCountdown) {
    drawMixed(ctx, currentCountdown, PAD_X, CUR_CD_Y, 19, '#9FD8A0', 'left', FONT.kai, FONT.hei, 'normal');
  }

  // UP 雀士：放在当前卡池右侧
  const upStartX = PAD_X + curW + UP_LABEL_GAP;
  if (upList.length) {
    ctx.font = `bold 20px ${FONT.hei}`;
    ctx.fillStyle = '#C9BFA8';
    ctx.textAlign = 'left';
    ctx.fillText('UP 雀士', upStartX, BAND_LABEL_Y);

    let upBadge = null;
    try { upBadge = await loadRes(UP_BADGE); } catch { /* 缺失则不加角标 */ }

    const avTop = BAND_CY - AV / 2;
    for (let i = 0; i < upList.length; i++) {
      const name = upList[i];
      const x = upStartX + i * (AV + AV_GAP);

      // 头像（圆角裁切 + 金边）
      const p = findPersonImage(name);
      if (p) {
        try {
          const img = await loadRes(p);
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
          cx.strokeStyle = '#D6AF6E';
          cx.lineWidth = 2.5;
          cx.stroke();
          ctx.drawImage(c, x, avTop);
        } catch { /* 头像失败跳过 */ }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(x, avTop, AV, AV);
      }

      // UP 角标（右下角）
      if (upBadge) {
        const w = 52, h = Math.round(w * upBadge.height / upBadge.width);
        ctx.drawImage(upBadge, x + AV - w + 4, avTop + AV - h + 4, w, h);
      }

      // 名字（头像下方居中）
      drawMixed(ctx, name, x + AV / 2, avTop + AV + 10 + NAME_SIZE / 2, NAME_SIZE,
        '#FFF6E0', 'center', FONT.name, FONT.hei);
    }
  }

  // 当前池 UP 装扮：与 UP 雀士同行，放在其右侧的空白区域（不单独占一行）
  if (upDecorList.length) {
    // 先解析图片，一个都找不到就整块跳过（无 UP 装扮的池不显示该区域）
    const TS = TOP_DECOR_TS;     // 缩略图边长（= AV，与雀士头像一致）
    const TGAP = AV_GAP;         // 间距也与雀士头像一致
    const decorImgs = [];
    for (const name of upDecorList) {
      const imgPath = findDecorationImage(name, currentPoolId);
      if (!imgPath) continue;
      const img = await loadRes(imgPath).catch(() => null);
      if (img) decorImgs.push({ img, name });
    }

    if (decorImgs.length) {
      // UP 雀士右侧起排；无 UP 雀士时直接从 upStartX 开始
      const decorStartX = upList.length
        ? upStartX + upList.length * (AV + AV_GAP) + 10
        : upStartX;

      const label = 'UP 装扮';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `bold 20px ${FONT.hei}`;
      ctx.fillStyle = '#C9BFA8';
      ctx.fillText(label, decorStartX, BAND_LABEL_Y);
      const labelW = ctx.measureText(label).width + 14;

      let dx = decorStartX + labelW;
      const maxX = W - PAD_X;
      const avTop = BAND_CY - AV / 2;
      for (const { img, name } of decorImgs) {
        if (dx + TS > maxX) break;
        // 与雀士头像顶部对齐（同一 y 起画）
        drawThumb(ctx, img, dx, avTop, TS, 14);
        // 装扮名（与雀士名同一行同一字号，过长则缩字号，再不行省略号）
        // 宽度限制在缩略图本体宽度内，避免相邻两个名字挤在一起
        drawThumbCaption(ctx, name, dx + TS / 2, avTop + AV + 10 + NAME_SIZE / 2, TS + 6);
        dx += TS + TGAP;
      }
    }
  }

  // ---- 分隔线 ----
  const sepY = LIST_TITLE_Y - 22;
  ctx.strokeStyle = 'rgba(214,175,110,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD_X, sepY);
  ctx.lineTo(W - PAD_X, sepY);
  ctx.stroke();

  // ---- 「可用卡池」标签 ----
  ctx.textAlign = 'left';
  ctx.font = `bold 20px ${FONT.hei}`;
  ctx.fillStyle = '#C9BFA8';
  ctx.fillText('可用卡池', PAD_X, LIST_TITLE_Y);

  // ---- 列表素材（懒加载）----
  let badgeLefttime = null, badgeSakura = null, badgeZhulin = null;
  try { badgeLefttime = await loadRes(BADGE_LEFTTIME); } catch { /* 缺失则不画 */ }
  try { badgeSakura = await loadRes(BADGE_SPECIAL_SAKURA); } catch { /* 缺失则不画 */ }
  try { badgeZhulin = await loadRes(BADGE_SPECIAL_ZHULIN); } catch { /* 缺失则不画 */ }

  // ---- 卡池列表 ----
  const rowW = W - PAD_X * 2;
  const RIGHT_X = W - PAD_X - 22;
  let rowY = LIST_TOP;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const rowH = rowHs[i];
    const y = rowY;
    const cy = y + rowH / 2;
    const isCur = !!p.isCurrent;
    // 仅联动池带「特定装扮UP」标签；贵人池（custom:<池名>）暂无，用 isCollab 显式区分
    const isCollab = !!p.isCollab;
    // 该池是否有可渲染的 UP 内容（当前池的 UP 已在顶部展示，行内不重复）
    const hasUp = !isCur && (
      (Array.isArray(p.upNames) && p.upNames.length) ||
      (Array.isArray(p.upDecorNames) && p.upDecorNames.length)
    );

    // 行底：当前池金边高亮
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(PAD_X, y, rowW, rowH, 10);
    else ctx.rect(PAD_X, y, rowW, rowH);
    ctx.fillStyle = isCur ? 'rgba(214,175,110,0.20)' : 'rgba(0,0,0,0.34)';
    ctx.fill();
    ctx.strokeStyle = isCur ? 'rgba(214,175,110,0.85)' : 'rgba(214,175,110,0.22)';
    ctx.lineWidth = isCur ? 2 : 1.2;
    ctx.stroke();

    // 池名艺术字（始终单行居中）
    const artCy = cy;
    const artPath = findPoolTitleArt(p.name);
    const art = artPath ? await loadRes(artPath).catch(() => null) : null;
    let artRight = PAD_X + 22;
    if (art) {
      const artH = ROW_ART_H;
      const artW = Math.round(art.width * artH / art.height);
      ctx.drawImage(art, PAD_X + 22, artCy - artH / 2, artW, artH);
      artRight = PAD_X + 22 + artW;
    } else {
      ctx.font = `bold 24px ${FONT.name}`;
      const tw = Math.min(ctx.measureText(p.name).width, 420);
      drawMixed(ctx, p.name, PAD_X + 22, artCy, 24,
        isCur ? '#FFE9B8' : '#E6DCC8', 'left', FONT.name, FONT.hei);
      artRight = PAD_X + 22 + tw;
    }

    // 联动池标签：樱花版（紫）/ 竹林版（绿）
    let badgeRight = artRight;
    if (isCollab) {
      const badge = /竹林/.test(p.name) ? badgeZhulin : badgeSakura;
      if (badge) {
        const bh = 26;
        const bw = Math.round(badge.width * bh / badge.height);
        ctx.drawImage(badge, artRight + 14, artCy - bh / 2, bw, bh);
        badgeRight = artRight + 14 + bw;
      }
    }

    // 该池的 UP 雀士 / UP 装扮：单行排在池名右侧的空白区域
    // （非当前池才显示，当前池的已在顶部展示）
    if (hasUp) {
      const TS = 30;                                  // 行内缩略图边长
      const TGAP = 6;
      const gapLeft = 20;

      // 先量右侧倒计时宽度，避免缩略图压到它
      let cdReserve = 0;
      if (p.countdown) {
        ctx.font = `normal 19px ${FONT.hei}`;
        cdReserve = measureMixed(ctx, p.countdown, 19, FONT.kai, FONT.hei, 'normal') + (badgeLefttime ? 34 : 0) + 16;
      }
      const hardMaxX = Math.max(badgeRight + 80, RIGHT_X - cdReserve);
      let cx = badgeRight + gapLeft;

      const drawLabel = (text) => {
        if (cx + 24 > hardMaxX) return;
        ctx.font = `bold 14px ${FONT.hei}`;
        ctx.fillStyle = '#C9BFA8';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, cy);
        const w = ctx.measureText(text).width;
        cx += w + 6;
      };

      // UP 雀士：先把图片解析出来，一个都没有就不画标签
      if (Array.isArray(p.upNames) && p.upNames.length) {
        const charImgs = [];
        for (const nm of p.upNames) {
          const ip = findPersonImage(nm);
          if (!ip) continue;
          const img = await loadRes(ip).catch(() => null);
          if (img) charImgs.push(img);
        }
        if (charImgs.length) {
          drawLabel('UP');
          for (const img of charImgs) {
            if (cx + TS > hardMaxX) break;
            drawThumb(ctx, img, cx, cy - TS / 2, TS, 8);
            cx += TS + TGAP;
          }
          cx += 8;
        }
      }

      // UP 装扮：同样先解析，没有可用图片就整个跳过（不画「装扮」标签，也不留灰块）
      if (Array.isArray(p.upDecorNames) && p.upDecorNames.length) {
        const decorImgs = [];
        for (const nm of p.upDecorNames) {
          const ip = findDecorationImage(nm, p.id);
          if (!ip) continue;
          const img = await loadRes(ip).catch(() => null);
          if (img) decorImgs.push(img);
        }
        if (decorImgs.length) {
          if (cx + 30 < hardMaxX) drawLabel('装扮');
          for (const img of decorImgs) {
            if (cx + TS > hardMaxX) break;
            drawThumb(ctx, img, cx, cy - TS / 2, TS, 8);
            cx += TS + TGAP;
          }
        }
      }
    }

    // 右侧：当前标记 / 剩余时间（仅开放中）+ 倒计时 / 未开启提示（不配「剩余时间」标签）
    if (isCur) {
      // 当前池：显示「当前使用」，若为限时池再显示剩余时间
      let curRight = RIGHT_X;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `bold 19px ${FONT.hei}`;
      ctx.fillStyle = '#FFC97A';
      ctx.fillText('当前使用', curRight, cy);
      const curTagW = ctx.measureText('当前使用').width;
      ctx.textAlign = 'left';

      if (p.countdown) {
        const cdW = measureMixed(ctx, p.countdown, 19, FONT.kai, FONT.hei, 'normal');
        drawMixed(ctx, p.countdown, curRight - curTagW - 16, cy, 19,
          '#9FD8A0', 'right', FONT.kai, FONT.hei, 'normal');
        if (badgeLefttime) {
          const lh = 22;
          const lw = Math.round(badgeLefttime.width * lh / badgeLefttime.height);
          const bx = curRight - curTagW - 16 - cdW - BADGE_TEXT_GAP - lw;
          ctx.drawImage(badgeLefttime, bx, cy - lh / 2, lw, lh);
        }
      } else if (p.pendingText) {
        const pw = measureMixed(ctx, p.pendingText, 19, FONT.kai, FONT.hei, 'normal');
        drawMixed(ctx, p.pendingText, curRight - curTagW - 16, cy, 19,
          '#8FA3B8', 'right', FONT.kai, FONT.hei, 'normal');
        if (badgeLefttime) {
          const lh = 22;
          const lw = Math.round(badgeLefttime.width * lh / badgeLefttime.height);
          const bx = curRight - curTagW - 16 - pw - BADGE_TEXT_GAP - lw;
          ctx.drawImage(badgeLefttime, bx, cy - lh / 2, lw, lh);
        }
      }
    } else if (p.countdown) {
      // 开放中且有结束时间：先量倒计时宽度，再在其左侧画「剩余时间」素材
      const cdW = measureMixed(ctx, p.countdown, 19, FONT.kai, FONT.hei, 'normal');
      drawMixed(ctx, p.countdown, RIGHT_X, cy, 19,
        '#9FD8A0', 'right', FONT.kai, FONT.hei, 'normal');
      if (badgeLefttime) {
        const lh = 22;
        const lw = Math.round(badgeLefttime.width * lh / badgeLefttime.height);
        const bx = RIGHT_X - cdW - BADGE_TEXT_GAP - lw;
        ctx.drawImage(badgeLefttime, bx, cy - lh / 2, lw, lh);
      }
    } else if (p.pendingText) {
      // 尚未开启（仅主人可见）：纯文字提示，不加「剩余时间」标签
      drawMixed(ctx, p.pendingText, RIGHT_X, cy, 19,
        '#8FA3B8', 'right', FONT.kai, FONT.hei, 'normal');
    }

    rowY += rowH + ROW_GAP;
  }

  // ---- 底部：左下头像 + 昵称（个人卡池各不相同），右下切换提示 ----
  const avX = PAD_X;
  const avY = H - FOOTER_H / 2 - FOOTER_AV / 2 + 6;
  const rowCy = avY + FOOTER_AV / 2;

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
        const c = createCanvas(FOOTER_AV, FOOTER_AV);
        const cx = c.getContext('2d');
        cx.save();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, FOOTER_AV, FOOTER_AV, 12);
        else cx.rect(0, 0, FOOTER_AV, FOOTER_AV);
        cx.clip();
        const side = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, FOOTER_AV, FOOTER_AV);
        cx.restore();
        cx.beginPath();
        if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, FOOTER_AV - 2, FOOTER_AV - 2, 12);
        else cx.rect(0, 0, FOOTER_AV, FOOTER_AV);
        cx.strokeStyle = '#D6AF6E';
        cx.lineWidth = 2.5;
        cx.stroke();
        ctx.drawImage(c, avX, avY);
      }
    } catch { /* 头像失败静默跳过 */ }
  }

  if (nickname) {
    const name = String(nickname);
    const nameX = avX + FOOTER_AV + 16;
    const availW = 420;
    let size = 26;
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

  if (footer) {
    drawMixed(ctx, footer, W - PAD_X, rowCy, 17, '#A89C86', 'right', FONT.hei, FONT.hei, 'normal');
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}

/**
 * 渲染卡池排期图（#查看卡池计划）
 * @param {object} options
 * @param {Array<{name:string, status:'pending'|'open'|'early', timeText:string}>} options.rows 排期行
 * @param {string} [options.footer] 底部提示
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderPoolScheduleCard ({ rows = [], footer }) {
  const ROW_H_S = 66;
  const TITLE_Y_S = 62;
  const LIST_TOP_S = 118;
  const H = LIST_TOP_S + Math.max(rows.length, 1) * ROW_H_S
    + (rows.length > 1 ? (rows.length - 1) * ROW_GAP : 0) + FOOTER_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景 + 滤镜（与卡池一览一致，无金框）
  const bg = await loadRes(POOLS_BG);
  const s = Math.max(W / bg.width, H / bg.height);
  const dw = bg.width * s, dh = bg.height * s;
  ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.fillStyle = `rgba(0,0,0,${DARK_ALPHA})`;
  ctx.fillRect(0, 0, W, H);

  // 标题
  drawMixed(ctx, '卡池排期', W / 2, TITLE_Y_S, 38, '#FFE9B8', 'center', FONT.name, FONT.hei);

  const rowW = W - PAD_X * 2;
  const RIGHT_X = W - PAD_X - 22;
  const STATUS = {
    pending: { text: '未开启', color: '#8FA3B8' },
    open: { text: '开启中', color: '#9FD8A0' },
    early: { text: '已提前开启', color: '#FFC97A' }
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = LIST_TOP_S + i * (ROW_H_S + ROW_GAP);
    const st = STATUS[r.status] || STATUS.open;

    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(PAD_X, y, rowW, ROW_H_S, 10);
    else ctx.rect(PAD_X, y, rowW, ROW_H_S);
    ctx.fillStyle = r.status === 'open' ? 'rgba(214,175,110,0.18)' : 'rgba(0,0,0,0.34)';
    ctx.fill();
    ctx.strokeStyle = r.status === 'open' ? 'rgba(214,175,110,0.8)' : 'rgba(214,175,110,0.22)';
    ctx.lineWidth = r.status === 'open' ? 2 : 1.2;
    ctx.stroke();

    // 池名艺术字（无素材则文字）
    const artPath = findPoolTitleArt(r.name);
    const art = artPath ? await loadRes(artPath).catch(() => null) : null;
    let cursorX = PAD_X + 22;
    if (art) {
      const artH = 42;
      const artW = Math.round(art.width * artH / art.height);
      ctx.drawImage(art, cursorX, y + (ROW_H_S - artH) / 2, artW, artH);
      cursorX += artW;
    } else {
      ctx.font = `bold 24px ${FONT.name}`;
      const tw = Math.min(ctx.measureText(r.name).width, 380);
      drawMixed(ctx, r.name, cursorX, y + ROW_H_S / 2, 24, '#E6DCC8', 'left', FONT.name, FONT.hei);
      cursorX += tw;
    }

    // 状态标签
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 20px ${FONT.hei}`;
    ctx.fillStyle = st.color;
    ctx.fillText(st.text, cursorX + 16, y + ROW_H_S / 2);

    // 右侧时间
    if (r.timeText) {
      drawMixed(ctx, r.timeText, RIGHT_X, y + ROW_H_S / 2, 17,
        '#B9C4D2', 'right', FONT.hei, FONT.hei, 'normal');
    }
  }

  // 空状态
  if (!rows.length) {
    drawMixed(ctx, '当前没有卡池排期', W / 2, LIST_TOP_S + 30, 26, '#8FA3B8',
      'center', FONT.name, FONT.hei, 'normal');
  }

  if (footer) {
    drawMixed(ctx, footer, W / 2, H - 38, 19, '#A89C86', 'center', FONT.hei, FONT.hei, 'normal');
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}


