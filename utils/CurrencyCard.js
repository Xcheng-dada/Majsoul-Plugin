// plugins/Majsoul-Plugin/utils/CurrencyCard.js
// 货币卡片渲染：横排"图标 + 数量"卡片图（签到奖励 / 钱包余额 / 邮件附件共用）
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText, drawRoundRect } from '../components/canvas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = path.join(__dirname, '..', 'resources');
// 货币图标统一放在 resources/economy/ 子目录，避免散落在 resources 根目录
const ECONOMY_DIR = path.join(RESOURCES_ROOT, 'economy');

// 货币key/中文名 → 图标文件名（resources/economy/ 目录）
export const CURRENCY_ICONS = {
  jade: '辉玉',
  ticket: '寻觅卷轴',
  ticket10: '十连寻觅卷轴',
  dust: '星之粉尘',
  stone: '星之石',
  wish: '许愿石',
  faith: '信仰',
  // 中文名别名（"券"为兼容旧叫法）
  '寻觅卷轴': '寻觅卷轴',
  '十连寻觅卷轴': '十连寻觅卷轴',
  '寻觅券': '寻觅卷轴',
  '十连寻觅券': '十连寻觅卷轴'
};

/**
 * 渲染货币卡片
 * @param {object} options
 * @param {string} [options.title] 卡片标题（如"XXX的钱包"），可省略
 * @param {Array<{icon: string, count: number|string, extra?: string}>} options.items
 *   icon：货币中文名（辉玉/寻觅卷轴/十连寻觅卷轴/星之粉尘/星之石/许愿石/信仰）或直接图标文件名；
 *   extra：附加说明（如"暴击×2"），橙色小字
 * @param {string} [options.footer] 底部小字提示（灰色），可省略
 * @param {string} [options.avatar] 头像图片 URL（显示在标题左侧圆形框内），可省略
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderCurrencyCard({ title, items, footer, avatar }) {
  if (!items || items.length === 0) {
    throw new Error('CurrencyCard: items 不能为空');
  }

  // ---- 布局常量 ----
  const UNIT_W = 230;               // 每个货币单元宽度
  const ICON_SIZE = 120;            // 图标尺寸
  const COUNT_SIZE = 42;            // 数量字号
  const EXTRA_SIZE = 28;            // 附加说明字号
  const PAD = 50;                   // 卡片内边距
  const TITLE_H = 78;               // 标题区高度
  const FOOTER_H = 52;              // 底部提示区高度
  const ICON_TOP = 30;              // 图标距单元顶部
  const COUNT_GAP = 18;             // 图标与数量间距
  const EXTRA_GAP = 10;             // 数量与附加说明间距
  const PER_ROW = 4;                // 每行最多货币单元数（超出自动换行，避免图片过长）
  const ROW_GAP = 24;               // 行间距

  const hasTitle = !!title;
  const hasFooter = !!footer;
  // 头像尺寸（参考 Daily-Attendance-plugin：120px 圆角矩形放左侧，昵称自适应缩放不重叠）
  const AV = 120;
  const AX = 24;
  const titleH = hasTitle ? (avatar ? AV + 32 : TITLE_H) : 0;
  const unitH = ICON_TOP + ICON_SIZE + COUNT_GAP + COUNT_SIZE + 10
    + (items.some(i => i.extra) ? EXTRA_GAP + EXTRA_SIZE : 0);
  // 按每行 PER_ROW 个拆行，每行在卡内水平居中
  const rows = [];
  for (let i = 0; i < items.length; i += PER_ROW) {
    rows.push(items.slice(i, i + PER_ROW));
  }
  const cols = Math.max(...rows.map(r => r.length));
  let W = PAD * 2 + UNIT_W * cols;
  // 标题过宽时扩宽卡片，避免文字被裁切（与 drawText 的字体保持一致以正确测量）
  if (hasTitle) {
    const measure = createCanvas(10, 10).getContext('2d');
    measure.font = `bold 46px Microsoft YaHei, Segoe UI Emoji, sans-serif`;
    let need = Math.ceil(measure.measureText(title).width) + PAD * 2;
    if (avatar) {
      // 带头像：标题在头像右侧左对齐，保底按最小字号 26 测出所需宽度
      const x = AX + AV + 20;
      measure.font = `bold 26px Microsoft YaHei, Segoe UI Emoji, sans-serif`;
      need = Math.max(need, x + Math.ceil(measure.measureText(title).width) + PAD);
    }
    W = Math.max(W, need);
  }
  const H = titleH + rows.length * unitH + (rows.length - 1) * ROW_GAP + PAD + (hasFooter ? FOOTER_H : 0);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 卡片背景：浅灰描边（外层）+ 白色圆角矩形（内层）
  ctx.clearRect(0, 0, W, H);
  drawRoundRect(ctx, 0, 0, W, H, 26, '#E5E7EB');
  drawRoundRect(ctx, 4, 4, W - 8, H - 8, 23, '#FFFFFF');

  // 标题
  if (hasTitle) {
    // 头像：圆形裁切画在标题左侧（加载失败则静默跳过，不影响出图）
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
          const ay = (titleH - AV) / 2;
          const avImg = await loadImage(buf);
          const avCanvas = createCanvas(AV, AV);
          const avCtx = avCanvas.getContext('2d');
          avCtx.save();
          avCtx.beginPath();
          // 圆角矩形裁切（与 Daily-Attendance-plugin 一致）
          if (typeof avCtx.roundRect === 'function') {
            avCtx.roundRect(0, 0, AV, AV, 20);
          } else {
            avCtx.rect(0, 0, AV, AV);
          }
          avCtx.clip();
          // cover 模式：取头像中间正方形区域缩放填充
          const side = Math.min(avImg.width, avImg.height);
          avCtx.drawImage(avImg, (avImg.width - side) / 2, (avImg.height - side) / 2, side, side, 0, 0, AV, AV);
          avCtx.restore();
          // 描边
          avCtx.beginPath();
          if (typeof avCtx.roundRect === 'function') {
            avCtx.roundRect(1, 1, AV - 2, AV - 2, 20);
          } else {
            avCtx.rect(1, 1, AV - 2, AV - 2);
          }
          avCtx.strokeStyle = '#E5E7EB';
          avCtx.lineWidth = 2;
          avCtx.stroke();
          ctx.drawImage(avCanvas, AX, ay);
        }
      } catch (error) {
        logger?.warn?.(`[CurrencyCard] 头像加载失败: ${error.message}`);
      }
    }
    if (avatar) {
      // 标题在头像右侧左对齐，超宽时自动缩小字号（26px 下限，宽度已在上面按 26px 保底扩宽）
      const x = AX + AV + 20;
      const maxW = W - x - PAD;
      let titleSize = 46;
      ctx.font = `bold ${titleSize}px Microsoft YaHei, Segoe UI Emoji, sans-serif`;
      while (titleSize > 26 && ctx.measureText(title).width > maxW) {
        titleSize -= 2;
        ctx.font = `bold ${titleSize}px Microsoft YaHei, Segoe UI Emoji, sans-serif`;
      }
      drawText(ctx, title, x, titleH / 2, titleSize, '#1F2937', 'left', 'bold');
    } else {
      drawText(ctx, title, W / 2, titleH / 2, 46, '#1F2937', 'center', 'bold');
    }
  }

  // 按行渲染货币单元
  const top = (titleH || 20);
  for (let r = 0; r < rows.length; r++) {
    const rowItems = rows[r];
    const rowTop = top + r * (unitH + ROW_GAP);
    for (let i = 0; i < rowItems.length; i++) {
      const item = rowItems[i];
      // 每行水平居中：最后一行不满时向中间收拢
      const cx = W / 2 + (i - (rowItems.length - 1) / 2) * UNIT_W;

      // 图标（Windows 下 loadImage 不支持本地路径，读 Buffer 后走 data URI）
      // 统一缩至图标槽的 86% 居中绘制：部分素材（如信仰）内容贴边，避免视觉上被裁切
      const iconFile = CURRENCY_ICONS[item.icon] || item.icon;
      const iconPath = path.join(ECONOMY_DIR, `${iconFile}.png`);
      const drawSize = Math.round(ICON_SIZE * 0.86);
      const drawOffset = Math.round((ICON_SIZE - drawSize) / 2);
      try {
        const buf = fs.readFileSync(iconPath);
        const icon = await loadImage(`data:image/png;base64,${buf.toString('base64')}`);
        ctx.drawImage(icon, cx - drawSize / 2, rowTop + ICON_TOP + drawOffset, drawSize, drawSize);
      } catch (error) {
        logger.warn(`[CurrencyCard] 图标加载失败: ${iconFile}.png（${error.message}）`);
        // 占位圆形
        ctx.fillStyle = '#F3F4F6';
        ctx.beginPath();
        ctx.arc(cx, rowTop + ICON_TOP + ICON_SIZE / 2, ICON_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 数量
      drawText(ctx, String(item.count), cx, rowTop + ICON_TOP + ICON_SIZE + COUNT_GAP,
        COUNT_SIZE, '#111827', 'center', 'bold');

      // 附加说明（橙色）
      if (item.extra) {
        drawText(ctx, item.extra, cx, rowTop + ICON_TOP + ICON_SIZE + COUNT_GAP + COUNT_SIZE + 10 + EXTRA_GAP,
          EXTRA_SIZE, '#F97316', 'center', 'bold');
      }
    }
  }

  // 底部提示（灰色小字）
  if (hasFooter) {
    drawText(ctx, footer, W / 2, H - FOOTER_H / 2 - 4, 24, '#6B7280', 'center', 'normal');
  }

  const outputBuffer = await canvas.encode('png');
  return `base64://${outputBuffer.toString('base64')}`;
}

// 摘要条布局常量
const SUMMARY_FONT = 30;      // 正文字号
const SUMMARY_LINE_H = 46;    // 行高
const SUMMARY_PAD = 40;       // 左右内边距
const SUMMARY_FONT_FAMILY = 'Microsoft YaHei, sans-serif';

/**
 * 按最大宽度折行（优先在顿号/分号处断开）
 */
function _wrapSummaryLine(ctx, text, maxW, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxW) return [text];
  // 切 token：顿号/分号/右括号后、左括号前为断行点（避免"）"单独成行）
  const tokens = [];
  for (const ch of text) {
    if (tokens.length === 0 || ch === '（') {
      tokens.push(ch);
    } else {
      tokens[tokens.length - 1] += ch;
      if ('、；）'.includes(ch)) tokens.push('');
    }
  }
  const rows = [];
  let cur = '';
  for (const token of tokens) {
    if (cur && ctx.measureText(cur + token).width > maxW) {
      rows.push(cur);
      cur = token;
    } else {
      cur += token;
    }
  }
  if (cur) rows.push(cur);
  // 单个 token 仍超宽时按字符硬折
  const result = [];
  for (const row of rows) {
    if (ctx.measureText(row).width <= maxW) {
      result.push(row);
      continue;
    }
    let chunk = '';
    for (const ch of row) {
      if (chunk && ctx.measureText(chunk + ch).width > maxW) {
        result.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    if (chunk) result.push(chunk);
  }
  return result;
}

/**
 * 在结果图下方拼接文字摘要条（抽卡"纯图片输出"用）
 * @param {string} imageBase64 结果图（base64:// 前缀）
 * @param {string} title 摘要标题（如"十连寻觅结果（辉玉 x1800）｜含保底"）
 * @param {string[]} lines 摘要行
 * @returns {Promise<string>} 拼接后的 base64:// 图片
 */
export async function appendSummary(imageBase64, title, lines) {
  const imgBuf = Buffer.from(String(imageBase64).replace(/^base64:\/\//, ''), 'base64');
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width;
  const maxW = W - SUMMARY_PAD * 2;

  // 预折行计算摘要条高度（标题自适应缩字号：窄图如单抽 420px 时避免超宽裁切；空标题不占位）
  const ctx = createCanvas(10, 10).getContext('2d');
  let titleSize = 38;
  let titleRows = [];
  if (title) {
    const titleFont = `bold ${titleSize}px ${SUMMARY_FONT_FAMILY}`;
    ctx.font = titleFont;
    while (titleSize > 26 && ctx.measureText(title).width > maxW) {
      titleSize -= 2;
      ctx.font = `bold ${titleSize}px ${SUMMARY_FONT_FAMILY}`;
    }
    titleRows = _wrapSummaryLine(ctx, title, maxW, `bold ${titleSize}px ${SUMMARY_FONT_FAMILY}`);
  }
  const rows = [];
  for (const line of lines) rows.push(..._wrapSummaryLine(ctx, line, maxW, `normal ${SUMMARY_FONT}px ${SUMMARY_FONT_FAMILY}`));
  const topPad = titleRows.length > 0 ? 34 + titleRows.length * 52 + 18 : 24;
  const stripH = topPad + rows.length * SUMMARY_LINE_H + 30;

  const canvas = createCanvas(W, stripH);
  const ctx2 = canvas.getContext('2d');
  // 与结果图底边衔接：白底通栏
  drawRoundRect(ctx2, 0, 0, W, stripH, 0, '#FFFFFF');
  let ty = 34;
  for (const row of titleRows) {
    drawText(ctx2, row, W / 2, ty, titleSize, '#1F2937', 'center', 'bold');
    ty += 52;
  }
  let y = topPad + SUMMARY_LINE_H / 2;
  for (const row of rows) {
    drawText(ctx2, row, SUMMARY_PAD, y, SUMMARY_FONT, '#374151', 'left');
    y += SUMMARY_LINE_H;
  }
  const strip = await canvas.encode('png');

  // sharp 的 composite 不会扩展画布：先向下扩展 stripH，把摘要条贴到底部，再输出 JPEG
  // （JPEG 质量90：PNG 大图 base64 体积过大，LLOneBot 上传偶发失败会导致接收端"图片已过期"，
  // 压缩后体积约为原来的 1/5，视觉上无差异，可显著提高发送成功率）
  const extended = await sharp(imgBuf).extend({ bottom: stripH, background: '#FFFFFF' }).png().toBuffer();
  const out = await sharp(extended)
    .composite([{ input: strip, top: meta.height, left: 0 }])
    .flatten({ background: '#FFFFFF' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `base64://${out.toString('base64')}`;
}
