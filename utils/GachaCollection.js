// plugins/Majsoul-Plugin/utils/GachaCollection.js
// 雀魂收集图鉴：记录每用户拥有的雀士/装扮，sharp 渲染收集进度网格图
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'url';
import { drawText } from '../components/canvas.js';
import { FONT } from '../components/fonts.js';
import { drawUiChrome } from './UiFrame.js';
import { ITEM_TYPE } from './GachaCore.js';
import { getDatabase } from './MajsoulDatabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 预编译语句按连接实例缓存（测试关闭重开后自动重建）
const stmtCache = new WeakMap();

function getStmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    selUser: db.prepare(`SELECT kind, item_name, count, first_date FROM majsoul_collections WHERE qq_id = ?`),
    sel: db.prepare(`SELECT count FROM majsoul_collections WHERE qq_id = ? AND kind = ? AND item_name = ?`),
    ins: db.prepare(`INSERT INTO majsoul_collections (qq_id, kind, item_name, count, first_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    upd: db.prepare(`UPDATE majsoul_collections SET count = ?, updated_at = ? WHERE qq_id = ? AND kind = ? AND item_name = ?`)
  };
  stmtCache.set(db, s);
  return s;
}

const SUPPORTED_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// 贵人名单（限定雀士）：不进常驻池，仅通过 #创建UP池 <池名> 樱花/竹林 贵人 发放
const LIMITED_CHARACTERS = ['西园寺一羽', '东城玄音', '北原莉莉', '南枫花', '璃央', '赤麟'];

// 网格渲染常量
const COLS = 6;            // 每行格数
const PER_PAGE = 30;       // 6列 × 5行 = 30格/页（最多5行，避免画布过高）
const CELL = 160;          // 格子尺寸
const IMG = 150;           // 格内图片尺寸
const GAP = 8;             // 格间距
const TITLE_H = 72;        // 标题栏最小高度（网格起点下限）
const TITLE_Y = 52;        // 标题文字中心 y
const TITLE_GAP = 20;      // 标题文字下沿与网格顶部的间距

const NEW_DAYS = 1;        // 获得后 1 天内显示 NEW 角标

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default class GachaCollection {
  /**
   * @param {import('./GachaCore.js').default} gachaCore 复用其资源定位与角色文件映射
   */
  constructor(gachaCore) {
    this.gachaCore = gachaCore;
    this.resourcesRoot = gachaCore.resourcesRoot;
    // 全量物品缓存 { expireAt, characters: [{name, path}], decorations: [{name, path}] }
    this._allItemsCache = null;
    // 格子图缓存 Map<"路径|是否收集", { expireAt, buf }>：格子内容与用户无关，可复用
    this._cellCache = new Map();
  }

  // 读取用户图鉴数据（结构兼容旧版：{ characters: {名称: {count, first}}, decorations: {...} }）
  async get(userId) {
    try {
      const rows = getStmts(getDatabase()).selUser.all(String(userId));
      const coll = { characters: {}, decorations: {} };
      for (const r of rows) {
        if (!coll[r.kind]) continue; // CHECK 约束兜底，理论上不会出现
        // 雀士不可重复拥有：count 恒为 1，此处对旧库残留的 count>1 做读取层归一化
        // （历史 bug：add 曾对雀士也累加，实测真实库有 48 条 count>1）
        const raw = Math.max(1, Math.floor(Number(r.count) || 1));
        const count = r.kind === 'characters' ? 1 : raw;
        coll[r.kind][r.item_name] = { count, first: r.first_date || null };
      }
      return coll;
    } catch (error) {
      logger.error(`[GachaCollection] 读取图鉴失败 userId=${userId}:`, error);
      return { characters: {}, decorations: {} };
    }
  }

  /**
   * 记录获得（事务内判断新旧，防止并发重复计数）
   *
   * ⚠️ **雀士不可重复拥有**：重复抽到雀士会即时转为许愿石（见 MajsoulGacha 的
   * 重复转化逻辑），图鉴里的 count 因此恒为 1 —— 不再累加。
   * 此前对所有 kind 一律 count+1，导致雀士图鉴出现「x3」这种无意义计数
   * （实测真实库 48 条雀士记录 count>1，12/24 用户受影响）。
   * 装扮可以重复拥有（重复转星之石），仍保留累加语义。
   *
   * @param {string|number} userId
   * @param {'characters'|'decorations'} kind
   * @param {string} name 物品名（文件名去后缀）
   * @returns {{ isNew: boolean, count: number }}
   */
  async add(userId, kind, name) {
    if (kind !== 'characters' && kind !== 'decorations') {
      logger.warn(`[GachaCollection] 未知的图鉴类型 kind=${kind}`);
      return { isNew: false, count: 0 };
    }
    const db = getDatabase();
    const s = getStmts(db);
    const qq = String(userId);
    const item = String(name);
    const now = Date.now();
    const countable = kind === 'decorations';
    return db.transaction(() => {
      const existing = s.sel.get(qq, kind, item);
      if (existing) {
        if (!countable) return { isNew: false, count: 1 };
        const count = existing.count + 1;
        s.upd.run(count, now, qq, kind, item);
        return { isNew: false, count };
      }
      s.ins.run(qq, kind, item, 1, todayStr(), now, now);
      return { isNew: true, count: 1 };
    })();
  }

  // 判断是否为限定雀士（贵人：仅通过 #创建UP池 贵人 发放，重复转化 150 许愿石）
  async isLimitedCharacter(name) {
    return LIMITED_CHARACTERS.includes(name);
  }

  // 查单个雀士立绘路径（用于兑换结果卡片等；找不到返回 null）
  async getCharacterPortrait(name) {
    try {
      const all = await this._getAllItems('characters');
      return all.find(it => it.name === name)?.path || null;
    } catch {
      return null;
    }
  }

  // 全量物品列表（5 分钟缓存）：characters / decorations
  async _getAllItems(kind) {
    const now = Date.now();
    if (!this._allItemsCache || this._allItemsCache.expireAt < now) {
      const [characters, decorations] = await Promise.all([
        this._scanCharacters(),
        this._scanDecorations()
      ]);
      this._allItemsCache = { expireAt: now + 5 * 60 * 1000, characters, decorations };
    }
    return this._allItemsCache[kind] || [];
  }

  // 扫描全部角色：person 目录全量（"轻库娘"除外），文件名即雀士名
  // 不依赖卡池配置：未开放池/下架池/贵人等全部计入图鉴
  async _scanCharacters() {
    if (this.gachaCore.characterFileMap.size === 0) {
      await this.gachaCore._buildCharacterFileMap();
    }
    const personDir = path.join(this.resourcesRoot, 'person');
    return [...this.gachaCore.characterFileMap.entries()]
      .filter(([name]) => !name.includes('轻库娘'))
      .map(([name, file]) => ({ name, path: path.join(personDir, file) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  // 扫描全部装扮：decoration 根目录 + 子目录，按文件名去重
  async _scanDecorations() {
    const rootDir = path.join(this.resourcesRoot, 'decoration');
    const map = new Map(); // name -> path
    let entries = [];
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (SUPPORTED_EXT.includes(ext)) {
          map.set(path.basename(ent.name, ext), path.join(rootDir, ent.name));
        }
      } else if (ent.isDirectory()) {
        try {
          const files = await fs.readdir(path.join(rootDir, ent.name));
          for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (SUPPORTED_EXT.includes(ext) && !map.has(path.basename(f, ext))) {
              map.set(path.basename(f, ext), path.join(rootDir, ent.name, f));
            }
          }
        } catch { /* 子目录读取失败忽略 */ }
      }
    }
    return [...map.entries()].map(([name, p]) => ({ name, path: p }));
  }

  // 单元格图片 buffer（未收集灰度压暗）
  // 结果仅取决于 (图片路径, 是否收集)，与用户无关：缓存 5 分钟；WebP 比 PNG 编解码更快、体积更小且保留透明背景
  async _cellImage(item, collected) {
    const key = `${item.path}|${collected ? 1 : 0}`;
    const now = Date.now();
    const cached = this._cellCache.get(key);
    if (cached && cached.expireAt > now) {
      return cached.buf;
    }
    let pipe = sharp(item.path).resize(IMG, IMG, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } });
    if (!collected) {
      pipe = pipe.modulate({ saturation: 0 }).linear(0.45, 0);
    }
    const buf = await pipe.webp({ quality: 85 }).toBuffer();
    // 简单容量控制：超限先清过期项，仍超限则整体清空
    if (this._cellCache.size >= 2000) {
      for (const [k, v] of this._cellCache) {
        if (v.expireAt <= now) this._cellCache.delete(k);
      }
      if (this._cellCache.size >= 2000) this._cellCache.clear();
    }
    this._cellCache.set(key, { expireAt: now + 5 * 60 * 1000, buf });
    return buf;
  }

  // 官方「新!」角标图片（懒加载 + 缓存）
  async _newBadgeImage() {
    if (this._newBadgeImg !== undefined) return this._newBadgeImg;
    try {
      const p = path.join(this.resourcesRoot, 'ui', 'badge_new.png');
      const buf = await fs.readFile(p);
      this._newBadgeImg = await loadImage(buf);
    } catch {
      this._newBadgeImg = null;
    }
    return this._newBadgeImg;
  }

  /**
   * 渲染图鉴网格图
   * @param {string|number} userId
   * @param {'characters'|'decorations'} kind
   * @param {number} page 页码（从 1 开始）
   * @param {string} [userName] 用户名（显示在标题里，如"xx的雀士图鉴"）
   * @returns {Promise<string>} base64:// 图片
   */
  async renderImage(userId, kind = 'characters', page = 1, userName = '') {
    // 克隆共享缓存，避免把"已拥有的下架雀士"合并进全局缓存
    const all = [...await this._getAllItems(kind)];
    if (all.length === 0) {
      throw new Error('图鉴为空');
    }
    const coll = await this.get(userId);
    const collMap = coll[kind] || {};

    // 已拥有但不在当前任何开放池的雀士（如限时UP池下架后）：数据仍在，需继续显示
    if (kind === 'characters' && this.gachaCore.characterFileMap.size === 0) {
      await this.gachaCore._buildCharacterFileMap();
    }
    if (kind === 'characters') {
      const listed = new Set(all.map(i => i.name));
      const personDir = path.join(this.resourcesRoot, 'person');
      for (const name of Object.keys(collMap)) {
        if (listed.has(name)) continue;
        const file = this.gachaCore.characterFileMap.get(name);
        if (!file) continue; // 无资源文件无法渲染，图鉴数据仍保留
        all.push({ name, path: path.join(personDir, file) });
      }
    }

    // 已收集排前（获得时间倒序），未收集排后
    const collected = [];
    const uncollected = [];
    const nowMs = Date.now();
    for (const item of all) {
      const rec = collMap[item.name];
      if (rec) {
        const isNew = rec.first && (nowMs - new Date(rec.first).getTime()) < NEW_DAYS * 86400 * 1000;
        collected.push({ ...item, rec, isNew });
      } else {
        uncollected.push(item);
      }
    }
    collected.sort((a, b) => String(b.rec.first || '').localeCompare(String(a.rec.first || '')));
    const sorted = [...collected, ...uncollected];

    const total = all.length;
    const got = collected.length;
    const percent = total > 0 ? ((got / total) * 100).toFixed(1) : '0.0';
    const maxPage = Math.max(1, Math.ceil(total / PER_PAGE));
    page = Math.min(Math.max(1, Math.floor(page) || 1), maxPage);
    const pageItems = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    const rows = Math.max(1, Math.ceil(pageItems.length / COLS));
    // 画布 = 金框内侧留白 + 6列网格 + 标题区 + 底部留白
    const PAD_X = 70;                 // 左右内边距（金框内侧）
    const PAD_BOTTOM = 46;            // 底部留白
    const W = PAD_X * 2 + COLS * CELL + (COLS - 1) * GAP;
    // 高度按「标题中心 + 标题下沿 + 间距 + 网格 + 底部」计算，保证标题与网格不重叠
    const TITLE_BLOCK = TITLE_Y + 17 + TITLE_GAP;   // 标题下沿(34px字号半高≈17) + 间距
    const H = TITLE_BLOCK + rows * CELL + (rows - 1) * GAP + PAD_BOTTOM;

    const kindLabel = kind === 'decorations' ? '装扮寮舍' : '雀士寮舍';
    const ownerPrefix = userName ? `${String(userName).slice(0, 16)}的` : '';
    const titleText = `${ownerPrefix}${kindLabel} ${got}/${total} (${percent}%) 第 ${page}/${maxPage} 页`;

    // ---- canvas 渲染（背景 + 滤镜 + 金框）----
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    await drawUiChrome(ctx, W, H, 'liaoshe', 0);

    // 标题：红豆大黑体（超宽自动缩字号）
    // 标题中心固定在 TITLE_Y，字号自适应；与网格之间留出 TITLE_GAP 的间距
    let titleSize = 34;
    {
      const maxW = W - 120;
      ctx.font = `bold ${titleSize}px ${FONT.name}`;
      while (titleSize > 18 && ctx.measureText(titleText).width > maxW) {
        titleSize -= 2;
        ctx.font = `bold ${titleSize}px ${FONT.name}`;
      }
      drawText(ctx, titleText, W / 2, TITLE_Y, titleSize, '#FFE9B8', 'center', 'bold', FONT.name);
    }

    // 网格起点：水平居中；纵向上保证不与标题文字重叠
    const gridW = COLS * CELL + (COLS - 1) * GAP;
    const x0 = Math.round((W - gridW) / 2);
    // 标题文字下沿 ≈ TITLE_Y + titleSize/2，再加间距
    const y0 = Math.round(Math.max(TITLE_H, TITLE_Y + titleSize / 2 + TITLE_GAP));

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = x0 + col * (CELL + GAP);
      const y = y0 + row * (CELL + GAP);

      const isCollected = !!item.rec;
      // 格子底：已收集半透明深色 + 金边，未收集更暗 + 淡金边（避免白底突兀）
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, CELL, CELL, 10);
      else ctx.rect(x, y, CELL, CELL);
      ctx.fillStyle = isCollected ? 'rgba(28, 24, 20, 0.55)' : 'rgba(0, 0, 0, 0.55)';
      ctx.fill();
      ctx.strokeStyle = isCollected ? 'rgba(214, 175, 110, 0.85)' : 'rgba(214, 175, 110, 0.28)';
      ctx.lineWidth = isCollected ? 2.5 : 1.5;
      ctx.stroke();

      // 物品图片：已收集彩色，未收集灰度压暗（复用 _cellImage 的 sharp 处理）
      try {
        const imgBuf = await this._cellImage(item, isCollected);
        const img = await loadImage(imgBuf);
        // 圆角裁切后居中绘制
        ctx.save();
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x + 6, y + 6, CELL - 12, CELL - 12, 8);
        else ctx.rect(x + 6, y + 6, CELL - 12, CELL - 12);
        ctx.clip();
        ctx.drawImage(img, x + (CELL - IMG) / 2, y + (CELL - IMG) / 2, IMG, IMG);
        ctx.restore();
      } catch { /* 无图片时保留格子底 */ }

      // 官方「新!」角标（右上角）
      if (item.isNew) {
        try {
          const nb = await this._newBadgeImage();
          if (nb) ctx.drawImage(nb, x + CELL - 64 + 6, y - 8, 64, 48);
        } catch { /* 角标失败跳过 */ }
      }
    }

    // JPEG 质量 90：PNG 体积过大，LLOneBot 上传偶发失败导致"图片已过期"
    const outputBuffer = await sharp(canvas.toBuffer('image/png'))
      .flatten({ background: '#0d1017' })
      .jpeg({ quality: 90 })
      .toBuffer();
    return `base64://${outputBuffer.toString('base64')}`;
  }

  // 导出物品类型常量，便于外部判断
  static get ITEM_TYPE() {
    return ITEM_TYPE;
  }
}
