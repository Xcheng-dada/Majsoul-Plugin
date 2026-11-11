// plugins/Majsoul-Plugin/utils/PoolTitleArt.js
// 卡池标题艺术字素材映射：把卡池显示名映射到 resources/gacha/ 下的官方艺术字 PNG
// 素材名规则见 resources/gacha/ 目录（pool_<卡池标识>.png）
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GACHA_DIR = path.join(__dirname, '..', 'resources', 'gacha');

// 卡池显示名 → 艺术字文件名（按优先级从上到下匹配）
// 注意：更具体的名称必须排在更宽泛的名称之前（如「樱花烂漫Ⅰ」要先于「樱花烂漫」）
const TITLE_ART = [
  // ---- 贵人池（custom:<池名>，池名即艺术字内容，优先精确匹配）----
  // 贵人池标题会带「（樱花/竹林特别寻觅）」后缀，findPoolTitleArt 会先剥掉后缀再查这里
  ['赤影骁歌', 'pool_sakura_chiyin.png'],
  ['银雳蛇杞', 'pool_sakura_yinliang.png'],
  ['凤鸣竹云', 'pool_sakura_fengming.png'],
  ['早春魅影', 'pool_sakura_zaochun.png'],
  ['仲夏魅影', 'pool_sakura_zhongxia.png'],

  // ---- 新春甄选 ----
  ['新春甄选（樱花）', 'pool_xinchun_sakura.png'],
  ['新春甄选（竹林）', 'pool_xinchun_zhulin.png'],

  // ---- 定向寻觅 ----
  ['樱花 定向寻觅', 'pool_dingxiang_sakura.png'],
  ['竹林 定向寻觅', 'pool_dingxiang_zhulin.png'],
  ['定向寻觅', 'pool_dingxiang.png'],

  // ---- 常驻寻觅（樱花之路 / 竹林之路，官方带「-常驻寻觅-」小字）----
  ['樱花之路', 'pool_sakura_changzhu.png'],
  ['竹林之路', 'pool_zhulin_changzhu.png'],

  // ---- 樱花系列（带罗马数字的优先）----
  ['樱花烂漫Ⅳ', 'pool_sakura_lanman4.png'],
  ['樱花烂漫Ⅲ', 'pool_sakura_lanman3.png'],
  ['樱花烂漫Ⅱ', 'pool_sakura_lanman2.png'],
  ['樱花烂漫Ⅰ', 'pool_sakura_lanman1.png'],
  ['樱花烂漫', 'pool_sakura_lanman.png'],
  ['金秋魅影Ⅳ', 'pool_sakura_moying4.png'],
  ['金秋魅影Ⅲ', 'pool_sakura_moying3.png'],
  ['金秋魅影Ⅱ', 'pool_sakura_moying2.png'],
  ['金秋魅影Ⅰ', 'pool_sakura_moying1.png'],
  ['金秋魅影', 'pool_sakura_moying.png'],
  ['冬日魅影Ⅱ', 'pool_sakura_dongri2.png'],
  ['冬日魅影Ⅰ', 'pool_sakura_dongri1.png'],
  ['冬日魅影', 'pool_sakura_dongri.png'],

  // ---- 竹林系列 ----
  ['竹林深篁Ⅱ', 'pool_zhulin_shenhuang2.png'],
  ['竹林深篁Ⅰ', 'pool_zhulin_shenhuang1.png'],
  ['竹林深篁', 'pool_zhulin_shenhuang.png'],
  ['金秋华光Ⅱ', 'pool_zhulin_jinqiu2.png'],
  ['金秋华光Ⅰ', 'pool_zhulin_jinqiu1.png'],
  ['金秋华光', 'pool_zhulin_jinqiu.png'],
  ['冬日华光Ⅱ', 'pool_zhulin_dongri2.png'],
  ['冬日华光Ⅰ', 'pool_zhulin_dongri1.png'],
  ['冬日华光', 'pool_zhulin_dongri.png'],
  ['竹林早春', 'pool_zhulin_zaochun.png'],
  ['竹林仲夏', 'pool_zhulin_zhongxia.png'],

  // ---- 联动（樱花/竹林特别寻觅）----
  ['蔚蓝档案（樱花特别寻觅）', 'pool_sakura_bluearchive.png'],
  ['蔚蓝档案（竹林特别寻觅）', 'pool_zhulin_bluearchive.png'],
  ['刀剑神域（樱花特别寻觅）', 'pool_sakura_special_daojian.png'],
  ['刀剑神域（竹林特别寻觅）', 'pool_zhulin_special_daojian.png'],
  ['斗牌传说（樱花特别寻觅）', 'pool_sakura_special_doupai.png'],
  ['斗牌传说（竹林特别寻觅）', 'pool_zhulin_special_doupai.png'],
  ['偶像大师（樱花特别寻觅）', 'pool_sakura_special_imas.png'],
  ['偶像大师（竹林特别寻觅）', 'pool_zhulin_special_imas.png'],
  ['葬送的芙莉莲（樱花特别寻觅）', 'pool_sakura_special_fulilian.png'],
  ['葬送的芙莉莲（竹林特别寻觅）', 'pool_zhulin_special_fulilian.png'],
  ['（樱花特别寻觅）', 'pool_sakura_special2.png'],
  ['（竹林特别寻觅）', 'pool_zhulin_special2.png']
];

/**
 * 按卡池显示名找艺术字素材的绝对路径
 * @param {string} title 卡池显示名，如「樱花烂漫」「赤影骁歌（樱花特别寻觅）」
 * @returns {string|null} 素材绝对路径，找不到返回 null
 */
export function findPoolTitleArt (title) {
  if (!title) return null;
  let s = String(title).trim();

  // 贵人池/自定义UP池/联动池的标题会带「（樱花特别寻觅）」「（竹林特别寻觅）」后缀。
  //
  // 匹配策略（顺序很重要）：
  //   1) 先剥后缀，用池主体名找专属艺术字（如「赤影骁歌」「蔚蓝档案」）
  //   2) 找不到再用带后缀的完整名（专属的「蔚蓝档案（樱花特别寻觅）」）
  //   3) 最后才回退到通用后缀键「（樱花特别寻觅）」/「（竹林特别寻觅）」
  //      —— 联动池没有专属素材时走这条（如「狂赌之渊（樱花特别寻觅）」）
  //
  // ⚠️ 不能用 includes + 任意顺序：短 key「樱花」会抢走
  //    「狂赌之渊（樱花特别寻觅）」，错配成樱花之路的艺术字。
  const hasSuffix = /（(樱花|竹林)特别寻觅）$/.test(s);
  const stripped = s.replace(/（(樱花|竹林)特别寻觅）$/, '').trim();
  const suffixKey = hasSuffix ? (s.match(/（(樱花|竹林)特别寻觅）$/)?.[0] || '') : '';

  const lookups = [];
  if (stripped) lookups.push(stripped);       // 1) 主体名
  if (hasSuffix && s) lookups.push(s);          // 2) 完整名
  if (suffixKey) lookups.push(suffixKey);       // 3) 通用后缀

  for (const q of lookups) {
    // 同一轮里长 key 优先，避免子串误配
    const sorted = [...TITLE_ART].sort((a, b) => b[0].length - a[0].length);
    for (const [key, file] of sorted) {
      if (q === key || q.includes(key)) {
        const p = path.join(GACHA_DIR, file);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * 拆分「联动池显示名」为「主体名 + 后缀艺术字」，供排期图等需要
 * 「文字池名 + 官方后缀艺术字」组合展示的场景使用。
 *
 * 行为：
 *   - 名里带「（樱花特别寻觅）」「（竹林特别寻觅）」时：
 *       main  = 主体名（如「狂赌之渊」）
 *       suffix = 后缀文字（如「（樱花特别寻觅）」）
 *       art    = 该池**专属**的主体艺术字；没有专属素材时返回 null
 *                （此时调用方用 main 画文字，再画通用后缀艺术字）
 *       suffixArt = 通用后缀艺术字（「樱花特别寻觅」/「竹林特别寻觅」）
 *   - 名里不带后缀时：main = 原名，art = 该池艺术字，suffix/suffixArt 为空
 *
 * @param {string} title 卡池显示名
 * @returns {{main:string, art:string|null, suffix:string, suffixArt:string|null}}
 */
export function splitPoolTitleArt (title) {
  const empty = { main: '', art: null, suffix: '', suffixArt: null };
  if (!title) return empty;
  const s = String(title).trim();

  const m = s.match(/^(.+?)（(樱花|竹林)特别寻觅）$/);
  if (!m) {
    return { main: s, art: findPoolTitleArt(s), suffix: '', suffixArt: null };
  }

  const main = m[1].trim();
  const suffix = `（${m[2]}特别寻觅）`;
  const suffixArt = findPoolTitleArt(s) || findPoolTitleArt(suffix);   // 优先该池配色的特别寻觅后缀图，再回退通用后缀素材

  // 主体专属艺术字：
  // ⚠️ 实测 resources/gacha 里 pool_*_special_<池>*.png 素材画的都只是
  //    「樱花/竹林 + 特别寻觅」，**不含联动池名**，不能代表主体名
  //    （否则图上只剩「竹林特别寻觅」，看不出是哪个池）。
  //    这类素材统一当后缀素材用，主体名由调用方文字补全。
  //
  // 只有 TITLE_ART 里存在「键含主体名 + 素材真的含主体名」时才用艺术字。
  // 当前联动池均不满足，故实际恒为 null；保留逻辑以备将来补充真素材。
  let art = null;
  let artHasSuffix = false;
  const MARK = ['sakura', 'zhulin'];
  const suffixMark = m[2] === '樱花' ? 'sakura' : 'zhulin';
  const sorted = [...TITLE_ART].sort((a, b) => b[0].length - a[0].length);
  for (const [key, file] of sorted) {
    if (!key.includes(main)) continue;                 // 键里必须含主体名
    if (key === `（${m[2]}特别寻觅）`) continue;         // 跳过通用后缀
    // 素材若不是「special」后缀图，才可能是真主体图
    if (file.includes('_special')) continue;
    // 若素材名带樱花/竹林标记，必须与当前后缀一致
    const other = suffixMark === 'sakura' ? 'zhulin' : 'sakura';
    if (MARK.some(k => file.includes(k)) && file.includes(other) && !file.includes(suffixMark)) continue;
    const p = path.join(GACHA_DIR, file);
    if (fs.existsSync(p)) { art = p; artHasSuffix = true; break; }
  }

  return { main, art, artHasSuffix, suffix, suffixArt };
}

export { GACHA_DIR };
