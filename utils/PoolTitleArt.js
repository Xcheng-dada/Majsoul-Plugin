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

  // 贵人池/自定义UP池的标题会带「（樱花特别寻觅）」「（竹林特别寻觅）」后缀，
  // 但贵人池名（如「赤影骁歌」）本身就对应一张完整艺术字素材，需先剥掉后缀再匹配，
  // 否则会被下面的「（樱花特别寻觅）」宽泛规则抢走。
  const stripped = s.replace(/（(樱花|竹林)特别寻觅）$/, '').trim();
  const candidates = stripped !== s ? [stripped, s] : [s];

  for (const cand of candidates) {
    for (const [key, file] of TITLE_ART) {
      if (cand.includes(key)) {
        const p = path.join(GACHA_DIR, file);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

export { GACHA_DIR };
