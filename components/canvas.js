import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'

// 封装简单的图像加载工具
export async function loadResImage(subPath) {
  const fullPath = path.resolve('./plugins/Majsoul-Plugin/resources', subPath)
  return await loadImage(fullPath)
}

// 图片圆角/特定绘制工具
export function drawRoundRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.arcTo(x + width, y, x + width, y + radius, radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius)
  ctx.lineTo(x + radius, y + height)
  ctx.arcTo(x, y + height, x, y + height - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
  
  if (fillStyle) {
    ctx.fillStyle = fillStyle
    ctx.fill()
  }
}

export function drawPartialRoundRect(ctx, x, y, width, height, radius, topLeft, topRight, bottomLeft, bottomRight, fillStyle) {
  ctx.beginPath()
  
  if (topLeft) {
    ctx.moveTo(x + radius, y)
  } else {
    ctx.moveTo(x, y)
  }
  
  if (topRight) {
    ctx.lineTo(x + width - radius, y)
    ctx.arcTo(x + width, y, x + width, y + radius, radius)
  } else {
    ctx.lineTo(x + width, y)
  }
  
  if (bottomRight) {
    ctx.lineTo(x + width, y + height - radius)
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius)
  } else {
    ctx.lineTo(x + width, y + height)
  }
  
  if (bottomLeft) {
    ctx.lineTo(x + radius, y + height)
    ctx.arcTo(x, y + height, x, y + height - radius, radius)
  } else {
    ctx.lineTo(x, y + height)
  }
  
  if (topLeft) {
    ctx.lineTo(x, y + radius)
    ctx.arcTo(x, y, x + radius, y, radius)
  } else {
    ctx.lineTo(x, y)
  }
  
  ctx.closePath()
  
  if (fillStyle) {
    ctx.fillStyle = fillStyle
    ctx.fill()
  }
}

export function drawText(ctx, text, x, y, size = 30, color = '#FFFFFF', align = 'center', weight = 'normal', family = 'Microsoft YaHei, sans-serif') {
  ctx.font = `${weight} ${size}px ${family}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

// 带蒙版抠图：把 src 按 mask 的 alpha 通道抠出来，返回新的 Canvas（对应 Python 的 paste(im, box, mask)）
export function applyMask(srcCanvas, maskCanvas) {
  const c = createCanvas(srcCanvas.width, srcCanvas.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(srcCanvas, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  // 将 mask 拉伸到 src 实际尺寸，避免 mask 与头像原图尺寸不一致导致头像被裁切/偏移
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, srcCanvas.width, srcCanvas.height)
  ctx.globalCompositeOperation = 'source-over'
  return c
}