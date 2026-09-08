// plugins/Majsoul-Plugin/utils/GachaCollection.js
// 雀魂收集图鉴：记录每用户拥有的雀士/装扮，sharp 渲染收集进度网格图
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { ITEM_TYPE } from './GachaCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REDIS_PREFIX = 'Yunzai:majsoul_gacha:collection:';

const SUPPORTED_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// 网格渲染常量
const COLS = 6;            // 每行格数
const PER_PAGE = 48;       // 6列 × 8行 = 48格/页
const CELL = 160;          // 格子尺寸
const IMG = 150;           // 格内图片尺寸
const GAP = 8;             // 格间距
const MARGIN = 12;         // 画布边距
const TITLE_H = 72;        // 标题栏高度

const NEW_DAYS = 7;        // 获得后 7 天内显示 NEW 角标

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
  }

  _key(userId) {
    return `${REDIS_PREFIX}${userId}`;
  }

  // 读取用户图鉴数据
  async get(userId) {
    try {
      const raw = await redis.get(this._key(userId));
      const data = raw ? JSON.parse(raw) : {};
      return {
        characters: data.characters || {},
        decorations: data.decorations || {}
      };
    } catch (error) {
      logger.error(`[GachaCollection] 读取图鉴失败 userId=${userId}:`, error);
      return { characters: {}, decorations: {} };
    }
  }

  /**
   * 记录获得
   * @param {string|number} userId
   * @param {'characters'|'decorations'} kind
   * @param {string} name 物品名（文件名去后缀）
   * @returns {{ isNew: boolean, count: number }}
   */
  async add(userId, kind, name) {
    const coll = await this.get(userId);
    if (!coll[kind]) coll[kind] = {};
    let isNew = false;
    if (coll[kind][name]) {
      coll[kind][name].count += 1;
    } else {
      coll[kind][name] = { count: 1, first: todayStr() };
      isNew = true;
    }
    try {
      await redis.set(this._key(userId), JSON.stringify(coll));
    } catch (error) {
      logger.error(`[GachaCollection] 保存图鉴失败 userId=${userId}:`, error);
    }
    return { isNew, count: coll[kind][name].count };
  }

  // 判断是否为限定雀士（gacha.json 的 xianding 池）
  async isLimitedCharacter(name) {
    try {
      const pool = await this.gachaCore.gachaLoader();
      return Array.isArray(pool.xianding) && pool.xianding.includes(name);
    } catch {
      return false;
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

  // 扫描全部角色：gacha.json 各池去重，经 characterFileMap 过滤
  async _scanCharacters() {
    const pool = await this.gachaCore.gachaLoader();
    if (this.gachaCore.characterFileMap.size === 0) {
      await this.gachaCore._buildCharacterFileMap();
    }
    const names = new Set();
    for (const [poolName, arr] of Object.entries(pool)) {
      if (poolName === 'purple_gift' || !Array.isArray(arr)) continue;
      for (const n of arr) {
        if (this.gachaCore.characterFileMap.has(n)) names.add(n);
      }
    }
    const personDir = path.join(this.resourcesRoot, 'person');
    return [...names].map(name => ({
      name,
      path: path.join(personDir, this.gachaCore.characterFileMap.get(name))
    }));
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
  async _cellImage(item, collected) {
    let pipe = sharp(item.path).resize(IMG, IMG, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } });
    if (!collected) {
      pipe = pipe.modulate({ saturation: 0 }).linear(0.45, 0);
    }
    return pipe.png().toBuffer();
  }

  // NEW 角标 SVG buffer
  _newBadge() {
    const svg = `<svg width="56" height="28" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="28" rx="7" fill="#EF4444"/>
      <text x="28" y="20" font-size="17" font-family="Microsoft YaHei, sans-serif" font-weight="bold" fill="#FFFFFF" text-anchor="middle">NEW</text>
    </svg>`;
    return Buffer.from(svg);
  }

  // 标题栏 SVG buffer
  _titleSvg(width, text) {
    const svg = `<svg width="${width}" height="${TITLE_H}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width / 2}" y="${TITLE_H / 2 + 13}" font-size="38" font-family="Microsoft YaHei, sans-serif" font-weight="bold" fill="#1F2937" text-anchor="middle">${text}</text>
    </svg>`;
    return Buffer.from(svg);
  }

  /**
   * 渲染图鉴网格图
   * @param {string|number} userId
   * @param {'characters'|'decorations'} kind
   * @param {number} page 页码（从 1 开始）
   * @returns {Promise<string>} base64:// 图片
   */
  async renderImage(userId, kind = 'characters', page = 1) {
    const all = await this._getAllItems(kind);
    if (all.length === 0) {
      throw new Error('图鉴为空');
    }
    const coll = await this.get(userId);
    const collMap = coll[kind] || {};

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
    const W = MARGIN * 2 + COLS * CELL + (COLS - 1) * GAP;
    const H = MARGIN + TITLE_H + rows * CELL + (rows - 1) * GAP + MARGIN;

    const kindLabel = kind === 'decorations' ? '装扮图鉴' : '雀士图鉴';
    const titleText = `${kindLabel} ${got}/${total} (${percent}%) 第 ${page}/${maxPage} 页`;

    // 画布 + 标题
    const composites = [
      {
        input: this._titleSvg(W, titleText),
        top: MARGIN,
        left: 0
      }
    ];

    // 逐格渲染
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const left = MARGIN + col * (CELL + GAP);
      const top = MARGIN + TITLE_H + row * (CELL + GAP);

      // 格子底板（已收集白底 + 灰边，未收集浅灰底）
      const isCollected = !!item.rec;
      const bgSvg = `<svg width="${CELL}" height="${CELL}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${CELL}" height="${CELL}" rx="12" fill="${isCollected ? '#FFFFFF' : '#EFF1F5'}" stroke="#E5E7EB" stroke-width="2"/>
      </svg>`;
      composites.push({ input: Buffer.from(bgSvg), top, left });

      // 物品图片
      const imgBuf = await this._cellImage(item, isCollected);
      composites.push({
        input: imgBuf,
        top: top + Math.floor((CELL - IMG) / 2),
        left: left + Math.floor((CELL - IMG) / 2)
      });

      // NEW 角标（右上角）
      if (item.isNew) {
        composites.push({
          input: this._newBadge(),
          top: top + 2,
          left: left + CELL - 56
        });
      }
    }

    const outputBuffer = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 248, g: 249, b: 252, alpha: 1 } }
    })
      .composite(composites)
      .png()
      .toBuffer();
    return `base64://${outputBuffer.toString('base64')}`;
  }

  // 导出物品类型常量，便于外部判断
  static get ITEM_TYPE() {
    return ITEM_TYPE;
  }
}
