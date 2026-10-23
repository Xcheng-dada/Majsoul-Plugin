// plugins/Majsoul-Plugin/utils/GachaResultCard.js
// 寻觅结果卡片：官方素材三层合成（樱花背景 + 发光层 + 标题），内容区绘制所抽物品
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText } from '../components/canvas.js';
import { CURRENCY_ICONS } from './CurrencyCard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
const GACHA_DIR = path.join(RESOURCES_ROOT, 'gacha');
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');

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
 * @param {string} [options.nickname] 用户名（画在左上角头像旁）
 * @param {string} [options.avatar] 头像 URL/路径
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderGachaResultCard ({ title, items, wallet, lines, poolName, nickname, avatar }) {
  if ((!items || items.length === 0) && (!lines || lines.length === 0) && (!wallet || !wallet.length)) {
    throw new Error('GachaResultCard: items / lines / wallet 不能同时为空');
  }

  const [bgImg, panelImg, titleImg] = await Promise.all([
    loadRes(path.join(GACHA_DIR, 'bg.png')),
    loadRes(path.join(GACHA_DIR, 'result_bg.png')),
    loadRes(path.join(GACHA_DIR, 'title_result.png'))
  ]);

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

  // ---- 左上角：头像 + 昵称（头像在上，昵称在正下方） ----
  if (nickname || avatar) {
    const AV = 108;
    const ax = 64, ay = 196;
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
          if (typeof cx.roundRect === 'function') cx.roundRect(0, 0, AV, AV, 20);
          else cx.rect(0, 0, AV, AV);
          cx.clip();
          const side = Math.min(img.width, img.height);
          cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AV, AV);
          cx.restore();
          cx.beginPath();
          if (typeof cx.roundRect === 'function') cx.roundRect(1, 1, AV - 2, AV - 2, 20);
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
      drawText(ctx, nickname, ax + AV / 2, ay + AV + 38, 34, '#FFE9B8', 'center', 'bold');
    }
  }

  let y = CONTENT_TOP;

  if (title) {
    drawText(ctx, title, W / 2, y, 44, '#FFE9B8', 'center', 'bold');
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
        const p = findItemImage(it.name, it.kind, poolName);
        if (p) {
          try {
            const icon = await loadRes(p);
            const s = Math.min(ICON / icon.width, ICON / icon.height);
            const dw = icon.width * s, dh = icon.height * s;
            ctx.drawImage(icon, x + (ICON - dw) / 2, y + (ICON - dh) / 2, dw, dh);
          } catch {
            ctx.fillStyle = 'rgba(255,255,255,0.14)';
            ctx.fillRect(x, y, ICON, ICON);
          }
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(x, y, ICON, ICON);
        }

        // 显示名：雀士名即文件名去后缀（characterFileMap 的 key 同规则）
        const base = path.basename(it.name, path.extname(it.name));
        const label = it.count > 1 ? `${base}x${it.count}` : base;
        drawText(ctx, label, x + ICON / 2, y + ICON + 32, 26, '#FFF3D6', 'center', 'bold');
        if (it.tag) {
          drawText(ctx, it.tag, x + ICON / 2, y + ICON + 64, 22, '#FFC97A', 'center', 'bold');
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
