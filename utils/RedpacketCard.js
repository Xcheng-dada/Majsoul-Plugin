// plugins/Majsoul-Plugin/utils/RedpacketCard.js
// 红包卡片渲染：发红包封面图 / 抢到金额图
import { createCanvas, loadImage } from '@napi-rs/canvas';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { drawText, drawRoundRect } from '../components/canvas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JADE_ICON_PATH = path.join(__dirname, '..', 'resources', 'economy', '辉玉.png');

// 主题色
const RED_TOP = '#E8554A';
const RED_BOTTOM = '#C3272B';
const GOLD = '#FFE3A1';
const GOLD_BRIGHT = '#FFD24D';

// 构建圆角矩形路径（描边用）
function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// 绘制竖向渐变红包底板
function drawRedBase(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, RED_TOP);
  grad.addColorStop(1, RED_BOTTOM);
  drawRoundRect(ctx, 0, 0, w, h, 26, grad);
  // 顶部金色描边装饰线
  ctx.strokeStyle = 'rgba(255,227,161,0.55)';
  ctx.lineWidth = 3;
  roundedPath(ctx, 10, 10, w - 20, h - 20, 20);
  ctx.stroke();
}

async function loadJadeIcon(size) {
  if (!fs.existsSync(JADE_ICON_PATH)) return null;
  const img = await loadImage(JADE_ICON_PATH);
  return { img, size };
}

/**
 * 渲染发红包封面图
 * @param {string} ownerName 发红包人昵称
 * @param {number} total 辉玉总额
 * @param {number} count 红包份数
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderPacketCover(ownerName, total, count) {
  const W = 560, H = 360;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawRedBase(ctx, W, H);

  const icon = await loadJadeIcon(92);
  if (icon) {
    ctx.drawImage(icon.img, (W - icon.size) / 2, 34, icon.size, icon.size);
  }

  drawText(ctx, `${ownerName}的红包`, W / 2, 170, 42, GOLD, 'center', 'bold');
  drawText(ctx, `${total} 辉玉 · 共 ${count} 份`, W / 2, 228, 32, GOLD_BRIGHT, 'center', 'bold');
  drawText(ctx, '发送 #抢红包 开启 · 5分钟内有效', W / 2, 310, 24, 'rgba(255,255,255,0.85)');

  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}

/**
 * 渲染抢到红包金额图
 * @param {string} userName 抢红包人昵称
 * @param {number} amount 抢到的辉玉数量
 * @param {string} ownerName 红包主人昵称
 * @param {string} [note] 底部附加说明（如自动兑换信息）
 * @returns {Promise<string>} base64:// 图片
 */
export async function renderGrabCard(userName, amount, ownerName, note = '') {
  const W = 560, H = note ? 330 : 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawRedBase(ctx, W, H);

  drawText(ctx, `${userName} 抢到了`, W / 2, 64, 30, 'rgba(255,255,255,0.92)');

  const icon = await loadJadeIcon(84);
  if (icon) {
    ctx.drawImage(icon.img, (W - icon.size) / 2, 92, icon.size, icon.size);
  }
  drawText(ctx, `${amount} 辉玉`, W / 2, 216, 52, GOLD, 'center', 'bold');

  drawText(ctx, `来自 ${ownerName} 的红包 · 手气随机`, W / 2, 266, 22, 'rgba(255,255,255,0.8)');
  if (note) {
    drawText(ctx, note, W / 2, H - 32, 22, GOLD_BRIGHT);
  }

  return 'base64://' + canvas.toBuffer('image/png').toString('base64');
}
