// plugins/Majsoul-Plugin/utils/RankBadge.js
// 段位徽章绘制：段位图本体 + 右侧星级 / LvN（对外复用，供对局记录卡与订阅推送共用）
//
// 官方布局：
//   普通段位（初心~雀圣）：段位图右侧 3 颗星，亮 = minorRank，暗 = 余位
//   魂天：段位图右侧显示「LvN」（N = minorRank），不画星星、不画魂花魂珠
//
// 说明：不使用 render.js 的 getRankImg()，那会把段位图 + 魂花 + 魂珠 + Lv 合成到
// 156x190 的大画布，缩到行高尺寸后整组糊成一团；这里全部按需独立绘制。
import { loadResImage, drawText } from '../components/canvas.js';
import { FONT } from '../components/fonts.js';

// lv_0~lv_9 素材的实际墨迹范围（画布 26x36，每个数字左右留白不同，
// 直接按画布宽度拼接会让「19」的 1 和 9 相隔过远，故按墨迹裁剪后再拼）
const DIGIT_INK_X = { 0: 1, 1: 4, 2: 2, 3: 1, 4: 0, 5: 1, 6: 1, 7: 0, 8: 1, 9: 1 };
const DIGIT_INK_W = { 0: 25, 1: 17, 2: 24, 3: 25, 4: 26, 5: 24, 6: 24, 7: 25, 8: 25, 9: 24 };

/**
 * 数字字号补偿系数。
 *
 * 汉仪文黑75W 的数字字形只占字号的约 73%（15px → 墨迹 11px），
 * 而红豆大黑体的汉字占满（15px → 墨迹 15px）。同字号并排时数字会明显小一圈，
 * 看起来就是「忽大忽小」。乘以该系数让数字墨迹高与汉字对齐。
 */
export const NUM_SIZE_SCALE = 15 / 11;   // ≈ 1.364

/** 把「希望的数字视觉字号」换算成实际该用的 font-size */
export function numFontSize (visualSize) {
  return Math.round(visualSize * NUM_SIZE_SCALE * 10) / 10;
}

/**
 * 绘制数字，使墨迹垂直居中于 cy。
 *
 * ⚠️ 早期版本用 alphabetic 基线手工算偏移，实测与 canvas.js 的 drawText
 * （textBaseline='middle'，按 em 盒中点）**不一致**：汉仪文黑在中文字号
 * 20.5px 下，middle 基线的墨迹中心会比目标 y 高 6~7px，导致同一行里
 * 数字看着比昵称「偏上」。
 *
 * 现在改为先按 middle 基线试画、量出墨迹实际上下沿，再反推需要下移的距离，
 * 这样数字与画同一 cy 的中文文字**墨迹中心严格对齐**。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} cy 期望的墨迹垂直中心
 * @param {number} size font-size
 * @param {string} color
 * @param {'left'|'center'|'right'} align
 * @param {string} [family]
 */
export function drawNumText (ctx, text, x, cy, size, color, align = 'left', family = FONT.hei) {
  const s = String(text ?? '');
  if (!s) return 0;
  ctx.font = `normal ${size}px ${family}`;
  const m = ctx.measureText(s);
  // 用 middle 基线绘制时，墨迹相对 y 的偏移量：
  //   actualBoundingBoxAscent/Descent 是相对「alphabetic 基线」的，
  //   而 middle 基线的参考点是 em 盒中心 ≈ (ascent+descent)/2 处。
  // 直接取 middle 基线下的墨迹中心相对偏移：
  const emAscent = m.fontBoundingBoxAscent || size * 0.88;
  const emDescent = m.fontBoundingBoxDescent || size * 0.12;
  const midFromBaseline = (emAscent - emDescent) / 2;      // middle 基线到 alphabetic 基线的距离
  const inkCenterFromBaseline = ((m.actualBoundingBoxAscent || 0) - (m.actualBoundingBoxDescent || 0)) / 2;
  // middle 基线下，墨迹中心相对绘制点 y 的偏移（负=偏上）
  const inkShift = inkCenterFromBaseline - midFromBaseline;
  // 反推：要让墨迹中心落在 cy，绘制点应为 cy - inkShift
  // +1.5 为实测残差（汉仪文黑各字号下墨迹中心普遍比目标高约 1.5px），补掉后与中文对齐
  const drawY = cy - inkShift + 1.5;

  const prevAlign = ctx.textAlign;
  const prevBase = ctx.textBaseline;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, x, drawY);
  ctx.textAlign = prevAlign;
  ctx.textBaseline = prevBase;
  return m.width;
}

// 名次素材的实际墨迹范围（画布尺寸与留白各不相同，需按墨迹对齐）
//   rank_num_N : mj_main_common_2__s_N，画布 28~48 x 78，墨迹高度 74~78 不一致
//   rank_wei_N : mj_main_chs_0__s_N_N，画布 45x45，墨迹 44x45
const RANK_NUM_INK = {
  1: { x: 2, y: 0, w: 24, h: 78 },
  2: { x: 0, y: 0, w: 48, h: 76 },
  3: { x: 1, y: 1, w: 46, h: 74 },
  4: { x: 0, y: 0, w: 48, h: 77 }
};
const RANK_WEI_INK = { x: 0, y: 0, w: 44, h: 45 };

// 局数文字素材 chang.png（174x35，「第东南西北局」6 字横向排列）的逐字墨迹范围
// 逐列扫描 alpha 得到的实际边界，用于按字切片，避免整张拉伸导致字距不均

/**
 * 绘制 PT 变动。
 *
 * 普通段位（初心~雀圣）：纯数字 `+152` / `-11`
 *
 * 魂天：PT 列实际是「魂珠变化」，用亮起的魂珠图标 + 数值表示。
 *   变化量**不是固定 ±1.0**，按官方规则由「顺位 + 场次」决定：
 *     四麻 东场 1/2/3/4 位 → +0.3/+0.1/−0.1/−0.3
 *     四麻 南场 1/2/3/4 位 → +0.5/+0.2/−0.2/−0.5
 *     三麻 东场 1/2/3   位 → +0.3/ 0.0/−0.3
 *     三麻 南场 1/2/3   位 → +0.5/ 0.0/−0.5
 *   另有规则：**同桌全部为魂天时变化量翻倍**。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{pt:number, ptText:string, majorRank:string, rank?:number}} player
 * @param {number} x 左边缘
 * @param {number} cy 行垂直中心
 * @param {number} size 数字 font-size
 * @param {string} color 数字颜色
 * @param {{east?:boolean, allKonten?:boolean, playerCount?:number}} [ctxInfo]
 *   east 是否东风战；allKonten 同桌是否全魂天；playerCount 人数（3/4）
 * @returns {Promise<number>} 占用宽度
 */
export async function drawPtChange (ctx, player, x, cy, size, color, ctxInfo = {}) {
  const isKonten = player.majorRank === '魂天';

  if (!isKonten) {
    return drawNumText(ctx, player.ptText, x, cy, size, color, 'left');
  }

  // 魂天：按官方规则算魂珠变化量
  const beads = kontenBeadsDelta(player.rank, ctxInfo);
  // 魂珠画布 20x24（墨迹占满），放大到略高于数字墨迹才显得协调
  const pearlH = Math.round(size * 1.15);
  let curX = x;
  try {
    const pearl = await loadResImage('info_texture/light_pearl.png');
    const pearlW = Math.round(pearl.width * pearlH / pearl.height);
    ctx.drawImage(pearl, curX, cy - pearlH / 2, pearlW, pearlH);
    curX += pearlW + Math.max(3, Math.round(size * 0.16));
  } catch (e) { /* 素材缺失则只显示数字 */ }

  if (beads == null) {
    // 无法判定（缺 rank 等）时退回原始分值
    const pt = Number(player.pt) || 0;
    const t = pt === 0 ? '' : (pt > 0 ? `+${pt.toFixed(1)}` : pt.toFixed(1));
    if (t) {
      drawNumText(ctx, t, curX, cy, size, color, 'left');
      curX += ctx.measureText(t).width;
    }
    return curX - x;
  }

  if (beads === 0) return curX - x;
  const text = `${beads > 0 ? '+' : '−'}${Math.abs(beads).toFixed(1)}`;
  drawNumText(ctx, text, curX, cy, size, color, 'left');
  return curX - x + ctx.measureText(text).width;
}

/**
 * 魂天单局魂珠变化量（官方规则）。
 * @param {number|undefined} rank 1-based 顺位
 * @param {{east?:boolean, allKonten?:boolean, playerCount?:number}} ctxInfo
 * @returns {number|null} 变化量（已含同桌全魂天翻倍），无法判定时 null
 */
export function kontenBeadsDelta (rank, ctxInfo = {}) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 1) return null;
  const n = ctxInfo.playerCount === 3 ? 3 : 4;
  const east = !!ctxInfo.east;

  // 官方魂珠变化表（四麻/三麻 × 东场/南场）
  const TABLE = {
    4: { east: [0.3, 0.1, -0.1, -0.3], south: [0.5, 0.2, -0.2, -0.5] },
    3: { east: [0.3, 0, -0.3], south: [0.5, 0, -0.5] }
  };
  const arr = TABLE[n][east ? 'east' : 'south'];
  if (!arr || r > arr.length) return null;

  let d = arr[r - 1];
  // 同桌全部为魂天 → 变化量翻倍
  if (ctxInfo.allKonten) d *= 2;
  return d;
}

/**
 * 绘制名次「1位」~「4位」：用官方艺术字素材，不再用文字排版。
 *
 * 素材：
 *   rank_num_N.png  （mj_main_common_2__s_N）名次数字，各名次配色不同
 *   rank_wei_N.png  （mj_main_chs_0__s_N_N）「位」字
 *
 * 对齐要点（否则四行会参差不齐）：
 *   1) 数字墨迹宽度差异很大（1 是 24px、2/4 是 48px），若左对齐则「位」列位置浮动
 *      → 数字在固定宽度槽位内「水平居中」，四行的「位」自然对齐
 *   2) 「位」与数字「同墨迹高」而非小一档，视觉才匹配
 *   3) 数字与「位」之间留固定间距
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} rank 1~4
 * @param {number} x 槽位左边缘
 * @param {number} cy 行垂直中心
 * @param {number} [inkH] 数字与「位」的目标墨迹高度（默认 18）
 * @param {number} [slotW] 数字槽位宽度（默认 20，用于让不同宽度的数字居中）
 * @returns {Promise<number>} 占用宽度
 */
export async function drawRankLabel (ctx, rank, x, cy, inkH = 18, slotW = 20) {
  const n = Math.min(4, Math.max(1, rank | 0));
  const numInk = RANK_NUM_INK[n] || RANK_NUM_INK[1];

  try {
    const numImg = await loadResImage(`ui/rank_num_${n}.png`);
    // 按墨迹高度反推缩放，裁掉画布留白
    const numScale = inkH / numInk.h;
    const numW = Math.round(numInk.w * numScale);
    // 槽位内水平居中：数字宽度不同也能让右侧「位」对齐
    const numX = x + Math.round((slotW - numW) / 2);
    ctx.drawImage(
      numImg, numInk.x, numInk.y, numInk.w, numInk.h,
      numX, cy - inkH / 2, numW, inkH
    );

    // 「位」与数字同墨迹高，垂直居中对齐
    const weiImg = await loadResImage(`ui/rank_wei_${n}.png`);
    const weiScale = inkH / RANK_WEI_INK.h;
    const weiW = Math.round(RANK_WEI_INK.w * weiScale);
    const gap = Math.max(2, Math.round(inkH * 0.18));
    const weiX = x + slotW + gap;
    ctx.drawImage(
      weiImg, RANK_WEI_INK.x, RANK_WEI_INK.y, RANK_WEI_INK.w, RANK_WEI_INK.h,
      weiX, cy - inkH / 2, weiW, inkH
    );

    return slotW + gap + weiW;
  } catch (e) {
    // 素材缺失退回文字
    const txt = `${n}位`;
    ctx.font = `normal ${Math.round(inkH * 0.9)}px ${FONT.name}`;
    const prevAlign = ctx.textAlign;
    const prevBase = ctx.textBaseline;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7FB2E8';
    ctx.fillText(txt, x, cy);
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBase;
    return ctx.measureText(txt).width;
  }
}

// lv_prefix 画布 41x36，但实际墨迹只有 37x31（上下各留白 2~3px）；
// 数字墨迹则占满 36 高，故须按墨迹对齐，否则数字看着比「Lv」大一号
const PREFIX_INK_H = 31;
const PREFIX_INK_W = 37;
const PREFIX_CANVAS_H = 36;
const DIGIT_CANVAS_H = 36;

/**
 * 绘制段位徽章
 * @param {CanvasRenderingContext2D} ctx
 * @param {{majorRank:string, minorRank:number, level?:string}} player
 * @param {string} mode '4' | '3'
 * @param {number} x 段位图左边缘
 * @param {number} cy 行垂直中心
 * @param {number} size 段位图边长
 * @param {string} [fallbackColor] 无素材时文字颜色
 * @returns {Promise<number>} 徽章右边缘 x（供 PT 文本定位）
 */
export async function drawRankBadge (ctx, player, mode, x, cy, size, fallbackColor = '#C5D2E8') {
  const isKonten = player.majorRank === '魂天';
  let levelImg = null;
  try {
    levelImg = await loadResImage(`info_texture/${player.majorRank}_${mode}.png`);
  } catch (e) { /* 无素材走文字兜底 */ }

  if (!levelImg) {
    ctx.font = `normal 12px ${FONT.name}`;
    const txt = player.level || '-';
    if (typeof ctx.fillText === 'function') {
      const prevAlign = ctx.textAlign;
      const prevBase = ctx.textBaseline;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = fallbackColor;
      ctx.fillText(txt, x, cy);
      ctx.textAlign = prevAlign;
      ctx.textBaseline = prevBase;
    }
    return x + ctx.measureText(txt).width + 6;
  }

  ctx.drawImage(levelImg, x, cy - size / 2, size, size);
  let curX = x + size + 6;

  if (isKonten) {
    // 魂天：lv_prefix + lv_N 拼出 LvN，按墨迹对齐避免数字偏大
    const TARGET_INK_H = Math.round(size * 0.46);
    try {
      const prefixImg = await loadResImage('info_texture/lv_prefix.png');
      const pScale = TARGET_INK_H / PREFIX_INK_H;
      const pw = Math.round(prefixImg.width * pScale);
      const ph = Math.round(PREFIX_CANVAS_H * pScale);
      ctx.drawImage(prefixImg, curX, cy - ph / 2, pw, ph);
      curX += Math.round(PREFIX_INK_W * pScale) + Math.max(1, Math.round(1.5 * pScale));

      const dScale = TARGET_INK_H / DIGIT_CANVAS_H;
      for (const ch of String(player.minorRank || 1)) {
        const d = Number(ch);
        if (!Number.isFinite(d)) continue;
        const digitImg = await loadResImage(`info_texture/lv_${d}.png`);
        const inkW = DIGIT_INK_W[d] || digitImg.width;
        const inkX = DIGIT_INK_X[d] || 0;
        const dw = Math.max(1, Math.round(inkW * dScale));
        const dh = Math.round(DIGIT_CANVAS_H * dScale);
        ctx.drawImage(digitImg, inkX, 0, inkW, digitImg.height, curX, cy - dh / 2, dw, dh);
        curX += dw;
      }
    } catch (e) {
      // 素材缺失退回文字
      const txt = `Lv${player.minorRank || 1}`;
      ctx.font = `normal 13px ${FONT.hei}`;
      const prevAlign = ctx.textAlign;
      const prevBase = ctx.textBaseline;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#8FA9CC';
      ctx.fillText(txt, curX, cy);
      ctx.textAlign = prevAlign;
      ctx.textBaseline = prevBase;
      curX += ctx.measureText(txt).width;
    }
    return curX + 8;
  }

  // 普通段位：3 颗星（亮 minorRank 颗）
  const STAR = Math.round(size * 0.47);
  const STAR_GAP = Math.max(0, Math.round(size * 0.03));
  let starFull = null, starEmpty = null;
  try {
    starFull = await loadResImage('info_texture/star_full.png');
    starEmpty = await loadResImage('info_texture/star_empty.png');
  } catch (e) { /* 素材缺失则跳过星星 */ }

  if (starFull && starEmpty) {
    for (let i = 0; i < 3; i++) {
      const img = (player.minorRank || 0) > i ? starFull : starEmpty;
      ctx.drawImage(img, curX + i * (STAR + STAR_GAP), cy - STAR / 2, STAR, STAR);
    }
    curX += 3 * STAR + 2 * STAR_GAP;
  }
  return curX + 8;
}
