// plugins/Majsoul-Plugin/utils/GachaResultCard.js
// 寻觅结果卡片：官方素材三层合成（樱花背景 + 发光层 + 标题），内容区绘制所抽物品
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText } from '../components/canvas.js';
import { FONT } from '../components/fonts.js';
import { findPoolTitleArt } from './PoolTitleArt.js';
import { CURRENCY_ICONS } from './CurrencyCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const GACHA_DIR = path.join(RESOURCES_ROOT, 'gacha');
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');

// UP 角标（官方素材 47×28，缩放后贴在图标右下角）
const UP_BADGE_W = 72;
const UP_BADGE_H = 43;
// 限定角标（官方素材 99×68，贴在图标左上角）
const LIMIT_BADGE_W = 92;
const LIMIT_BADGE_H = 63;

// 官方素材尺寸
const W = 1920;
const H = 1080;
const TITLE_W = 520;              // 标题宽（原图 588×129 等比缩放）
const TITLE_Y = 28;
const CONTENT_TOP = 215;
const CONTENT_BOTTOM = 1010;

// 物品类型 → 资源目录（与 GachaCore.resolveItemImage 一致，全部本地读取）
const ITEM_DIR = {
  character: 'person',
  decoration: 'decoration',
  gift_blue: 'gift/intermediate',
  gift_purple: 'gift/advanced'
};
const EXT_LIST = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

async function loadRes (p) {
  const buf = await fs.promises.readFile(p);
  return loadImage(buf);
}

/** 按「数字/字母」与「中日文」拆段，数字段用 numFont 绘制 */
function splitByScript (text) {
  const s = String(text ?? '');
  const isNum = (c) => /[0-9A-Za-z.]/.test(c);
  const segs = [];
  let cur = '', curIsNum = null;
  for (const ch of s) {
    const n = isNum(ch);
    if (curIsNum === null || n === curIsNum) { cur += ch; curIsNum = n; }
    else { segs.push({ text: cur, isNum: curIsNum }); cur = ch; curIsNum = n; }
  }
  if (cur) segs.push({ text: cur, isNum: curIsNum });
  return segs;
}

/** 混排文本总宽度 */
function measureMixed (ctx, text, size, cjkFont, numFont, weight = 'bold') {
  let total = 0;
  for (const seg of splitByScript(text)) {
    ctx.font = `${weight} ${size}px ${seg.isNum ? numFont : cjkFont}`;
    total += ctx.measureText(seg.text).width;
  }
  return total;
}

/** 混排绘制：中文用 cjkFont，数字/字母用 numFont */
function drawMixedFont (ctx, text, x, y, size, color, align, cjkFont, numFont, weight = 'bold') {
  const segs = splitByScript(text);
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

/** 本地查找物品图片（雀士/装扮/礼物），与 GachaCore.resolveItemImage 同规则 */
function findItemImage (name, kind, poolName) {
  const dirs = [];
  if (kind === 'decoration') {
    dirs.push(path.join(RESOURCES_ROOT, 'decoration'));
    if (poolName && poolName !== 'normal') {
      let d = poolName.startsWith('custom:') ? poolName.slice('custom:'.length) : poolName;
      if (d.includes('|')) d = d.split('|')[0];
      dirs.unshift(path.join(RESOURCES_ROOT, 'decoration', d));
    }
  } else {
    const base = ITEM_DIR[kind];
    if (base) dirs.push(path.join(RESOURCES_ROOT, base));
  }
  for (const dir of dirs) {
    if (path.extname(name)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    } else {
      for (const ext of EXT_LIST) {
        const p = path.join(dir, name + ext);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * 渲染寻觅结果卡片
 * @param {object} options
 * @param {string} [options.title] 摘要标题（卡池｜十连寻觅结果｜累计寻觅 N 次）
 * @param {Array<{name: string, kind: string, count: number, tag?: string}>} options.items
 *   name：物品文件名；kind：character|decoration|gift_blue|gift_purple；count：数量；tag：附加说明
 * @param {Array<{icon: string, count: number|string, delta?: number}>} [options.wallet]
 *   底部货币行；delta 为本次增量（如卷轴 +10），有则显示为「43（+10）」
 * @param {string[]} [options.lines] 附加摘要行
 * @param {string} [options.poolName] 卡池名（装扮定位用）
 * @param {string[]} [options.upNames] UP 雀士名单（命中则在图标右下角贴 UP! 角标）
 * @param {string[]} [options.upDecorNames] UP 装扮名单（联动池）
 * @param {string[]} [options.limitedNames] 限定名单（贵人雀士 + 联动雀士/装扮），命中贴「限定」
 * @param {string} [options.nickname] 用户名（画在左上角头像旁）
 * @param {string} [options.avatar] 头像 URL/路径
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderGachaResultCard ({ title, items, wallet, lines, poolName, upNames, upDecorNames, limitedNames, nickname, avatar }) {
  if ((!items || items.length === 0) && (!lines || lines.length === 0) && (!wallet || !wallet.length)) {
    throw new Error('GachaResultCard: items / lines / wallet 不能同时为空');
  }

  const [bgImg, panelImg, titleImg] = await Promise.all([
    loadRes(path.join(GACHA_DIR, 'bg.png')),
    loadRes(path.join(GACHA_DIR, 'result_bg.png')),
    loadRes(path.join(GACHA_DIR, 'title_result.png'))
  ]);

  // UP / 限定角标（延迟加载：只有传入名单才需要）
  const upSet = new Set((upNames || []).filter(Boolean));
  const upDecorSet = new Set((upDecorNames || []).filter(Boolean));
  const limitedSet = new Set((limitedNames || []).filter(Boolean));
  const upBadge = (upSet.size > 0 || upDecorSet.size > 0)
    ? await loadRes(path.join(GACHA_DIR, 'up_badge.png')).catch(() => null)
    : null;
  const limitBadge = limitedSet.size > 0
    ? await loadRes(path.join(GACHA_DIR, 'limit_badge.png')).catch(() => null)
    : null;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 第一层：樱花背景，cover 裁切铺满（避免画布上下露出黑边）
  {
    const s = Math.max(W / bgImg.width, H / bgImg.height);
    const dw = bgImg.width * s, dh = bgImg.height * s;
    ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  // 第二层：官方发光面板
  ctx.drawImage(panelImg, 0, 0);
  // 第三层：标题置顶居中
  const tH = Math.round(titleImg.height * TITLE_W / titleImg.width);
  ctx.drawImage(titleImg, (W - TITLE_W) / 2, TITLE_Y, TITLE_W, tH);

  // ---- 左上角：头像 + 昵称（头像在上、昵称在正下方，头像水平居中于昵称）
  //      整块限制在内容区之上（y < CONTENT_TOP），不侵入抽卡结果区域
  if (nickname || avatar) {
    const AV = 96;
    const CX = 214;                       // 整块的垂直中轴（昵称与头像共用）
    const ax = Math.round(CX - AV / 2);
    const ay = 30;                        // 顶部留白
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
          cx.strokeStyle = '#F0D9A8';
          cx.lineWidth = 3;
          cx.stroke();
          ctx.drawImage(c, ax, ay);
        }
      } catch { /* 头像失败静默跳过 */ }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(ax, ay, AV, AV);
    }
    if (nickname) {
      // 昵称：红豆大黑体，居中画在头像正下方
      const name = String(nickname);
      // 可用宽度：以 CX 为中轴，左右各留 40px 安全边距
      const availW = Math.min(420, (CX - 40) * 2);
      let size = 34;
      ctx.font = `bold ${size}px ${FONT.name}`;
      while (size > 18 && ctx.measureText(name).width > availW) {
        size -= 2;
        ctx.font = `bold ${size}px ${FONT.name}`;
      }
      let out = name;
      if (ctx.measureText(out).width > availW) {
        while (out.length > 1 && ctx.measureText(out + '…').width > availW) out = out.slice(0, -1);
        out += '…';
      }
      drawText(ctx, out, CX, ay + AV + 40, size, '#FFE9B8', 'center', 'bold', FONT.name);
    }
  }

  let y = CONTENT_TOP;

  // ---- 标题区：卡池名用官方艺术字素材 + 次数/含保底用文鼎特毛楷 ----
  if (title) {
    // title 形如「樱花烂漫｜累计寻觅 108 次｜含保底」，拆出卡池名与后缀
    const parts = String(title).split('｜');
    const poolTitle = parts[0] || '';
    const suffix = parts.slice(1).join('｜');

    // 查官方艺术字素材（映射见 utils/PoolTitleArt.js）
    const artPath = findPoolTitleArt(poolTitle);
    const poolArt = artPath ? await loadRes(artPath).catch(() => null) : null;

    if (poolArt) {
      // 艺术字高度约 76px，与后缀文字基线对齐
      const artH = 76;
      const artW = Math.round(poolArt.width * artH / poolArt.height);
      // 后缀「累计寻觅 108 次｜含保底」：中文用文鼎特毛楷，数字用汉仪文黑75W
      const SUF_SIZE = 40;
      const sufW = suffix ? measureMixed(ctx, suffix, SUF_SIZE, FONT.kai, FONT.hei) : 0;
      const gap = suffix ? 24 : 0;
      const totalW = artW + gap + sufW;
      const startX = Math.round((W - totalW) / 2);
      ctx.drawImage(poolArt, startX, y - artH / 2 - 4, artW, artH);
      if (suffix) {
        drawMixedFont(ctx, suffix, startX + artW + gap, y, SUF_SIZE, '#FFE9B8',
          'left', FONT.kai, FONT.hei);
      }
    } else {
      // 无艺术字素材：整串混排（中文文鼎特毛楷 / 数字汉仪文黑75W）
      drawMixedFont(ctx, String(title), W / 2, y, 44, '#FFE9B8',
        'center', FONT.kai, FONT.hei);
    }
    y += 84;
  }

  // ---- 物品图标（本地资源，5 列自动换行）----
  if (items && items.length) {
    const ICON = 168;
    const GAP = 34;
    const COLS = items.length <= 5 ? items.length : 5;
    const MAX_W = W - 320;
    const rows = [];
    let cur = [];
    let curW = 0;
    for (const it of items) {
      const w = ICON + GAP;
      if (cur.length >= COLS || (cur.length && curW + w > MAX_W)) { rows.push(cur); cur = []; curW = 0; }
      cur.push(it); curW += w;
    }
    if (cur.length) rows.push(cur);

    for (const row of rows) {
      const rowW = row.length * ICON + (row.length - 1) * GAP;
      let x = Math.round((W - rowW) / 2);
      for (const it of row) {
        // 雀士/装扮名（文件名去后缀）
        const base = path.basename(it.name, path.extname(it.name));
        // UP 判定：雀士查 upNames，装扮查 upDecorNames（联动池可同时有 UP 雀士与 UP 装扮）
        const isUp = upBadge && (
          (it.kind === 'character' && upSet.has(base)) ||
          (it.kind === 'decoration' && upDecorSet.has(base))
        );
        // 限定判定：贵人雀士恒为限定；联动池的雀士/装扮也标限定
        const isLimited = limitBadge && (
          (it.kind === 'character' && limitedSet.has(base)) ||
          (it.kind === 'decoration' && limitedSet.has(base))
        );
        const p = findItemImage(it.name, it.kind, poolName);
        if (p) {
          try {
            const icon = await loadRes(p);
            const s = Math.min(ICON / icon.width, ICON / icon.height);
            const dw = icon.width * s, dh = icon.height * s;
            const ix = x + (ICON - dw) / 2;
            const iy = y + (ICON - dh) / 2;
            ctx.drawImage(icon, ix, iy, dw, dh);
            // UP! 贴右下角
            if (isUp) {
              const w = UP_BADGE_W * 0.72, h = UP_BADGE_H * 0.72;
              ctx.drawImage(upBadge, ix + dw - w, iy + dh - h, w, h);
            }
            // 限定贴左上角
            if (isLimited) {
              const w = LIMIT_BADGE_W * 0.72, h = LIMIT_BADGE_H * 0.72;
              ctx.drawImage(limitBadge, ix, iy, w, h);
            }
          } catch {
            ctx.fillStyle = 'rgba(255,255,255,0.14)';
            ctx.fillRect(x, y, ICON, ICON);
          }
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(x, y, ICON, ICON);
        }

        // 名称：红豆大黑体
        const label = it.count > 1 ? `${base}x${it.count}` : base;
        drawText(ctx, label, x + ICON / 2, y + ICON + 32, 26, '#FFF3D6', 'center', 'bold', FONT.name);
        if (it.tag) {
          // 重复转化说明：字数较多，按单元格宽度自动缩字号，避免与相邻物品文字重叠
          let tagSize = 22;
          const tagMaxW = ICON + GAP - 10;
          ctx.font = `bold ${tagSize}px ${FONT.name}`;
          while (tagSize > 13 && ctx.measureText(it.tag).width > tagMaxW) {
            tagSize -= 1;
            ctx.font = `bold ${tagSize}px ${FONT.name}`;
          }
          // 加一圈深色描边：背景是浅色樱花/天空时，纯橙色文字几乎看不清
          const tx = x + ICON / 2;
          const ty = y + ICON + 64;
          const prevAlign = ctx.textAlign;
          const prevBase = ctx.textBaseline;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';
          ctx.lineWidth = Math.max(3, Math.round(tagSize * 0.24));
          ctx.strokeStyle = 'rgba(48,26,8,0.9)';
          ctx.strokeText(it.tag, tx, ty);
          ctx.fillStyle = '#FFD79A';
          ctx.fillText(it.tag, tx, ty);
          ctx.textAlign = prevAlign;
          ctx.textBaseline = prevBase;
        }
        x += ICON + GAP;
      }
      y += ICON + 104;
    }
  }

  // ---- 底部货币行（图标 + 数量，可选增量；超宽自动拆成多行）----
  if (wallet && wallet.length) {
    const IC = 72;
    const GAP = 28;
    // 每个单元宽度按「图标 + 最长可能文案」估算，保证不重叠
    const UNIT = 190;
    const MAX_W = W - 320;
    const perRow = Math.max(1, Math.min(wallet.length, Math.floor(MAX_W / (IC + GAP + UNIT))));
    const rows = [];
    for (let i = 0; i < wallet.length; i += perRow) rows.push(wallet.slice(i, i + perRow));

    y += 14;
    for (const row of rows) {
      // 行内居中
      const rowW = row.length * (IC + UNIT);
      let x = Math.round((W - rowW) / 2);
      for (const it of row) {
        const file = CURRENCY_ICONS[it.icon] || it.icon;
        try {
          const icon = await loadRes(path.join(ECONOMY_DIR, `${file}.png`));
          const s = Math.min(IC / icon.width, IC / icon.height);
          const dw = icon.width * s, dh = icon.height * s;
          ctx.drawImage(icon, x, y, dw, dh);
        } catch {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(x, y, IC, IC);
        }
        // 数量与增量分两行：数量（米白粗体）/ 增量（金色小字，负值也支持，如 -1800）
        const tx = x + IC + 14;
        drawText(ctx, String(it.count), tx, y + 34, 28, '#FFEFC9', 'left', 'bold');
        if (it.delta) {
          drawText(ctx, it.delta > 0 ? `+${it.delta}` : String(it.delta), tx, y + 66, 24,
            it.delta > 0 ? '#FFC97A' : '#FF9E7A', 'left', 'bold');
        }
        x += IC + UNIT;
      }
      y += IC + 46;
    }
  }

  // ---- 附加摘要行 ----
  if (lines && lines.length) {
    for (const line of lines) {
      if (y > CONTENT_BOTTOM) break;
      drawText(ctx, line, W / 2, y, 28, '#FFE0AC', 'center');
      y += 44;
    }
  }

  return `base64://${canvas.toBuffer('image/png').toString('base64')}`;
}
