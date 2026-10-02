// plugins/Majsoul-Plugin/utils/ExchangeCard.js
// 信仰兑换雀士的结果卡片：展示雀士立绘 + 名称 + 稀有度 + 消耗与剩余信仰
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'fs';
import { drawText, drawRoundRect } from '../components/canvas.js';

const FONT_FAMILY = 'Microsoft YaHei, Segoe UI Emoji, sans-serif';

// 布局常量
const PAD = 44;          // 卡片内边距
const PORTRAIT = 260;    // 立绘尺寸
const GAP = 40;          // 立绘与文字区间距
const TITLE_H = 92;      // 标题区高度
const LINE_H = 58;       // 文字行高

/**
 * 渲染兑换结果卡片
 *
 * @param {object} options
 * @param {string} options.name       雀士名
 * @param {boolean} options.isLimited 是否限定雀士（贵人）
 * @param {number} options.cost       本次消耗的信仰
 * @param {number} [options.faith]    兑换后的信仰余额
 * @param {string|null} [options.portraitPath] 立绘文件绝对路径（缺失时画占位）
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderExchangeCard({ name, isLimited = false, cost = 0, faith = null, portraitPath = null }) {
  const nameText = String(name || '');
  const rarityText = isLimited ? '限定雀士' : '普通雀士';

  // 右侧文字区宽度：按最长文本测量（名称/稀有度/消耗/剩余）
  const probe = createCanvas(10, 10).getContext('2d');
  const rightTexts = [nameText, `消耗信仰 ${cost}`, faith == null ? '' : `剩余信仰 ${faith}`];
  let rightW = 0;
  for (const t of rightTexts) {
    probe.font = `bold 56px ${FONT_FAMILY}`;
    rightW = Math.max(rightW, probe.measureText(t).width);
  }
  probe.font = `bold 30px ${FONT_FAMILY}`;
  rightW = Math.max(rightW, probe.measureText(rarityText).width + 48);
  rightW = Math.max(rightW, 340);

  const W = PAD * 2 + PORTRAIT + GAP + rightW;
  const H = TITLE_H + PORTRAIT + PAD;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景：浅灰描边 + 白色圆角卡片
  ctx.clearRect(0, 0, W, H);
  drawRoundRect(ctx, 0, 0, W, H, 28, '#E5E7EB');
  drawRoundRect(ctx, 4, 4, W - 8, H - 8, 25, '#FFFFFF');

  // 标题
  drawText(ctx, '兑换成功', W / 2, 46, 42, '#1F2937', 'center', 'bold');

  const top = TITLE_H;
  const px = PAD;

  // 立绘：圆角矩形裁切，cover 模式居中（素材均为 256x256 正方形）
  let drewPortrait = false;
  if (portraitPath) {
    try {
      const buf = fs.readFileSync(portraitPath);
      const img = await loadImage(buf);
      const c = createCanvas(PORTRAIT, PORTRAIT);
      const cc = c.getContext('2d');
      cc.save();
      cc.beginPath();
      if (typeof cc.roundRect === 'function') cc.roundRect(0, 0, PORTRAIT, PORTRAIT, 22);
      else cc.rect(0, 0, PORTRAIT, PORTRAIT);
      cc.clip();
      const side = Math.min(img.width, img.height);
      cc.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, PORTRAIT, PORTRAIT);
      cc.restore();
      ctx.drawImage(c, px, top);
      // 描边
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(px + 1, top + 1, PORTRAIT - 2, PORTRAIT - 2, 22);
      else ctx.rect(px + 1, top + 1, PORTRAIT - 2, PORTRAIT - 2);
      ctx.strokeStyle = '#E5E7EB';
      ctx.lineWidth = 2;
      ctx.stroke();
      drewPortrait = true;
    } catch (error) {
      logger?.warn?.(`[ExchangeCard] 立绘加载失败 ${portraitPath}: ${error.message}`);
    }
  }
  if (!drewPortrait) {
    // 占位：浅灰底 + 首字
    drawRoundRect(ctx, px, top, PORTRAIT, PORTRAIT, 22, '#F3F4F6');
    drawText(ctx, nameText.slice(0, 1) || '?', px + PORTRAIT / 2, top + PORTRAIT / 2, 96, '#9CA3AF', 'center', 'bold');
  }

  // 右侧文字区
  const tx = px + PORTRAIT + GAP;
  let ty = top + 46;
  drawText(ctx, nameText, tx, ty, 56, '#111827', 'left', 'bold');

  // 稀有度徽章（限定用金色，普通用灰蓝）
  ty += LINE_H;
  probe.font = `bold 30px ${FONT_FAMILY}`;
  const badgeW = Math.ceil(probe.measureText(rarityText).width) + 48;
  const badgeH = 46;
  const badgeY = ty - badgeH / 2;
  drawRoundRect(ctx, tx, badgeY, badgeW, badgeH, badgeH / 2, isLimited ? '#B8860B' : '#64748B');
  drawText(ctx, rarityText, tx + badgeW / 2, ty, 30, '#FFFFFF', 'center', 'bold');

  // 消耗
  ty += LINE_H + 16;
  drawText(ctx, `消耗信仰 ${cost}`, tx, ty, 40, '#B45309', 'left', 'bold');

  // 剩余
  if (faith != null) {
    ty += LINE_H - 6;
    drawText(ctx, `剩余信仰 ${faith}`, tx, ty, 36, '#6B7280', 'left');
  }

  const out = await canvas.encode('png');
  return `base64://${out.toString('base64')}`;
}
