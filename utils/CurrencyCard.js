// plugins/Majsoul-Plugin/utils/CurrencyCard.js
// 货币图标映射表（历史文件，卡片渲染已迁移到 WarehouseCard / SignCard / MailCard）
// 此处仅保留 CURRENCY_ICONS：key 或中文名 → resources/economy/ 下的图标文件名

// 货币key/中文名 → 图标文件名（resources/economy/ 目录）
export const CURRENCY_ICONS = {
  jade: '辉玉',
  ticket: '寻觅卷轴',
  ticket10: '十连寻觅卷轴',
  dust: '星之粉尘',
  stone: '星之石',
  wish: '许愿石',
  faith: '信仰',
  // 中文名 → 同名图标（调用方直接传中文名）
  '寻觅卷轴': '寻觅卷轴',
  '十连寻觅卷轴': '十连寻觅卷轴'
};
