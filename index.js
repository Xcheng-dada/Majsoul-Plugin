// plugins/Majsoul-Plugin/index.js
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

import { MajsoulGacha } from './apps/MajsoulGacha.js';
import { MajsoulEconomy } from './apps/MajsoulEconomy.js';
import { MajsoulUser } from './apps/MajsoulUser.js';
import { MajsoulSubscribe } from './apps/MajsoulSubscribe.js';
import { MajsoulRecords } from './apps/MajsoulRecords.js';
import { MajsoulInfo } from './apps/MajsoulInfo.js';
import { MajsoulReview } from './apps/MajsoulReview.js';
import { MajsoulHelp } from './apps/MajsoulHelp.js';
import MajsoulSchedule from './utils/MajsoulSchedule.js';
import { cleanupPaipu, cleanupAvatar, PAIPU_CLEANUP_DAYS } from './utils/PaipuCleanup.js';
import { updateLqc } from './utils/lqcUpdater.js';
import { ensureApiRunning } from './utils/MajsoulProtocolClient.js';
import { getFeatureConfig, getFeatureConfigItem } from './utils/Config.js';

// 加载 Yunzai 的 plugin 基类（兼容默认导出与具名导出）
const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginModule = await import(pathToFileURL(join(__dirname, '../../lib/plugins/plugin.js')).href);
const plugin = pluginModule.default || pluginModule.Plugin || pluginModule;

// 模块级定时任务管理器（多实例共享，避免重复启动）
let scheduleManager = null;

// 定时检查配置：间隔（分钟）通过 config/config.json 的 subscribeInterval4/3 配置（默认四麻3分钟、三麻5分钟）
function buildSchedules () {
  const cfg = getFeatureConfig();
  const iv4 = Math.max(1, Number(cfg.subscribeInterval4) || 3);
  const iv3 = Math.max(1, Number(cfg.subscribeInterval3) || 5);
  return [
    { type: 4, interval: iv4 * 60 * 1000, label: '四麻' },
    { type: 3, interval: iv3 * 60 * 1000, label: '三麻' },
  ];
}

export class majsoul extends plugin {
  constructor() {
    // 必须首先调用 super()
    super({
      name: '雀魂插件',
      dsc: '雀魂抽卡、查询、订阅多功能插件',
      event: 'message',
      priority: 500,
      rule: [
        // 抽卡相关指令
        {
          reg: '^#?雀魂寻觅$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?雀魂十连$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?查看雀魂卡池$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?(设置UP池关闭|取消UP池关闭|查看UP池关闭)',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        {
          reg: '^#?(创建UP池|解散UP池)',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        {
          reg: '^#?查看UP池$',
          fnc: 'majsoulGacha'
        },
        {
          reg: '^#?(切换|使用)(竹林|男池)(之路)?$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?(切换|使用)(樱花|女池)(之路)?$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?切换卡池\\s+(.+)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?(重置卡池|我的卡池)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?查看UP池$',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        {
          reg: '^#?(开启联动|关闭联动|查看联动池)',
          fnc: 'majsoulGacha',
          permission: 'master'
        },

        // 抽卡经济系统指令
        {
          reg: '^#?雀魂签到$',
          fnc: 'majsoulEconomy',
          permission: 'all'
        },
        {
          reg: '^#?雀魂钱包$',
          fnc: 'majsoulEconomy',
          permission: 'all'
        },
        {
          reg: '^#?雀魂图鉴',
          fnc: 'majsoulEconomy',
          permission: 'all'
        },
        {
          reg: '^#?雀魂兑换\\s+(.+)$',
          fnc: 'majsoulEconomy',
          permission: 'all'
        },
        {
          reg: '^#?发红包\\s+(\\d+)\\s+(\\d+)$',
          fnc: 'majsoulEconomy',
          permission: 'master'
        },
        {
          reg: '^#?抢红包$',
          fnc: 'majsoulEconomy',
          permission: 'group'
        },
        {
          reg: '^#?发送邮件\\s+(.+)$',
          fnc: 'majsoulEconomy',
          permission: 'master'
        },
        {
          reg: '^#?雀魂邮件$',
          fnc: 'majsoulEconomy',
          permission: 'group'
        },
        {
          reg: '^#?设置(十连寻觅卷轴|寻觅卷轴|十连寻觅券|寻觅券|辉玉|星之粉尘|星之石|许愿石|信仰)\\s+(\\d+)\\s+(-?\\d+)$',
          fnc: 'majsoulEconomy',
          permission: 'master'
        },

        // 用户管理相关指令
        {
          reg: '^#?雀魂搜索\\s+(.+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#?雀魂绑定\\s+(\\d+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#?雀魂切换\\s+(\\d+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#?雀魂解绑(?:\\s+(\\d+))?$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#?雀魂我的绑定$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        
        // 对局订阅相关指令 (四麻)
        {
          reg: '^#?(雀魂|四麻)订阅(?!状态)\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?(关闭|取消)(雀魂|四麻)订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?开启(雀魂|四麻)订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?删除(雀魂|四麻)订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?(雀魂|四麻)订阅状态$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        
        // 对局订阅相关指令 (三麻)
        {
          reg: '^#?三麻订阅(?!状态)\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?(关闭|取消)三麻订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?开启三麻订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?删除三麻订阅\\s*(.+)?$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        {
          reg: '^#?三麻订阅状态$',
          fnc: 'majsoulSubscribe',
          permission: 'admin'
        },
        
        // 对局查询相关指令（不带昵称，使用绑定的UID）
        {
          reg: '^#?雀魂对局$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        {
          reg: '^#?四麻对局$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        {
          reg: '^#?三麻对局$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        // 对局查询相关指令（带昵称）
        {
          reg: '^#?雀魂对局\\s+(.+)$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        {
          reg: '^#?四麻对局\\s+(.+)$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        {
          reg: '^#?三麻对局\\s+(.+)$',
          fnc: 'majsoulRecords',
          permission: 'group'
        },
        
        // 玩家信息查询相关指令（四麻）
        {
          reg: '^#?雀魂查询$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        {
          reg: '^#?雀魂查询\\s+(.+)$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        {
          reg: '^#?查询四麻$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        {
          reg: '^#?查询四麻\\s+(.+)$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        // 玩家信息查询相关指令（三麻）
        {
          reg: '^#?查询三麻$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        {
          reg: '^#?查询三麻\\s+(.+)$',
          fnc: 'majsoulInfo',
          permission: 'group'
        },
        
        // AI 牌谱分析相关指令
        {
          reg: '^#?(牌谱Review|牌谱review|Review|review)\\s+(.+)$',
          fnc: 'majsoulReview',
          permission: 'group'
        },
        {
          reg: '^#?(雀魂场况|场况|牌谱详情)\\s+(.+)$',
          fnc: 'majsoulRenderLog',
          permission: 'group'
        },
        // 雀魂账号登录（获取真实昵称/头像，并持久化登录态以支持自动续期）
        {
          reg: '^#?雀魂登录\\s+(\\S+)\\s+(.+)$',
          fnc: 'majsoulLogin',
          permission: 'group'
        },
        // 帮助界面
        {
          reg: '^#?(雀魂帮助|雀魂菜单|帮助|menu)$',
          fnc: 'majsoulHelp',
          permission: 'all'
        }
      ]
    });
    
    // 实例化各功能模块
    this.modules = {
      gacha: new MajsoulGacha(),
      economy: new MajsoulEconomy(),
      user: new MajsoulUser(),
      subscribe: new MajsoulSubscribe(),
      records: new MajsoulRecords(),
      info: new MajsoulInfo(),
      review: new MajsoulReview(),
      help: new MajsoulHelp(),
    };
  }
  
  // 指令路由 - 抽卡相关
  async majsoulGacha(e) {
    return await this.modules.gacha.handle(e);
  }

  // 指令路由 - 抽卡经济系统
  async majsoulEconomy(e) {
    return await this.modules.economy.handle(e);
  }
  
  // 指令路由 - 用户管理相关
  async majsoulUser(e) {
    return await this.modules.user.handle(e);
  }
  
  // 指令路由 - 对局订阅相关
  async majsoulSubscribe(e) {
    return await this.modules.subscribe.handle(e);
  }
  
  // 指令路由 - 对局查询相关
  async majsoulRecords(e) {
    return await this.modules.records.handle(e);
  }
  
  // 指令路由 - 玩家信息查询相关
  async majsoulInfo(e) {
    return await this.modules.info.handle(e);
  }
  
  // 指令路由 - AI 牌谱分析相关
  async majsoulReview(e) {
    return await this.modules.review.reviewCommand(e);
  }
  
  async majsoulRenderLog(e) {
    return await this.modules.review.renderLog(e);
  }

  // 指令路由 - 雀魂登录
  async majsoulLogin(e) {
    return await this.modules.review.loginCommand(e);
  }

  // 指令路由 - 帮助界面
  async majsoulHelp(e) {
    return await this.modules.help.handle(e);
  }

    // 插件加载时的初始化
  async init() {
    console.log('[Majsoul-Plugin] 雀魂插件初始化...');
    // Windows 下若启用 autoLaunch 且 API 未运行，则自动 spawn 拉起（非 Windows/未开启则跳过）
    ensureApiRunning().catch(e => console.error('[Majsoul-Plugin] 拉起 API 失败:', e));
    // 启动时尝试更新 lqc.json（角色/皮肤映射）；失败不影响使用，内部已捕获
    updateLqc().catch(() => {});
    for (const [key, mod] of Object.entries(this.modules)) {
      try {
        await mod.init?.();
        console.log(`[Majsoul-Plugin] ${key} 模块初始化完成`);
      } catch (error) {
        console.error(`[Majsoul-Plugin] ${key} 模块初始化失败:`, error);
      }
    }
    this._startSchedule();
  }
  
  // 启动定时任务
  _startSchedule() {
    if (scheduleManager && scheduleManager.isRunning) {
      console.log('[Majsoul-Plugin] 定时任务已在运行中');
      return;
    }

    scheduleManager = new MajsoulSchedule();
    if (typeof global.Bot !== 'undefined') scheduleManager.setBot(global.Bot);
    else if (this.bot) scheduleManager.setBot(this.bot);

    const SCHEDULES = buildSchedules();
    for (const { type, interval, label } of SCHEDULES) {
      const timer = setInterval(async () => {
        try {
          if (!scheduleManager.bot && typeof global.Bot !== 'undefined') scheduleManager.setBot(global.Bot);
          await scheduleManager.performCheck(type);
          console.log(`[Majsoul-Plugin] ${label}定时检查完成`);
        } catch (error) {
          console.error(`[Majsoul-Plugin] ${label}定时检查失败:`, error);
        }
      }, interval);
      scheduleManager['interval' + type + 'p'] = timer;
    }

    scheduleManager.isRunning = true;
    const iv4m = Math.max(1, Number(getFeatureConfigItem('subscribeInterval4')) || 3);
    const iv3m = Math.max(1, Number(getFeatureConfigItem('subscribeInterval3')) || 5);
    console.log(`[Majsoul-Plugin] 定时任务启动成功（四麻${iv4m}分钟/三麻${iv3m}分钟）`);

    // 牌谱文件 + 头像缓存定时清理：每 24 小时执行一次，删除超过 paipuCleanupDays 天的旧文件（默认 15 天）
    const cleanupDays = Math.max(1, Number(getFeatureConfigItem('paipuCleanupDays')) || PAIPU_CLEANUP_DAYS);
    const paipuCleanupTimer = setInterval(() => {
      try {
        cleanupPaipu(cleanupDays);
        cleanupAvatar(cleanupDays);
      } catch (error) {
        logger?.error?.(`[Majsoul-Plugin] 牌谱清理失败: ${error.message}`);
      }
    }, 24 * 60 * 60 * 1000);
    scheduleManager.paipuCleanupTimer = paipuCleanupTimer;

    // UP池定时关闭检查：每分钟检查一次，到点把处于限定池/自定义UP池的群默认池退回樱花之路并通知
    const poolScheduleTimer = setInterval(async () => {
      try {
        const result = await this.modules?.gacha?.poolSchedule?.check();
        if (!result || result.affected === 0) return;
        const bot = scheduleManager.bot || global.Bot;
        for (const gid of result.gids) {
          try {
            await bot.pickGroup(gid).sendMsg('雀魂UP池已关闭，本群卡池已自动退回樱花之路（女池）');
          } catch (error) {
            logger?.error?.(`[Majsoul-Plugin] UP池关闭通知群 ${gid} 失败:`, error);
          }
        }
      } catch (error) {
        logger?.error?.('[Majsoul-Plugin] UP池定时关闭检查失败:', error);
      }
    }, 60 * 1000);
    scheduleManager.poolScheduleTimer = poolScheduleTimer;

    // 启动后稍作延迟执行一次初始检查
    setTimeout(async () => {
      for (const { type } of SCHEDULES) await scheduleManager.performCheck(type);
    }, 5000);

    // 启动后稍作延迟执行一次牌谱/头像清理（避免刚启动就清理，给予缓冲）
    setTimeout(() => {
      try {
        cleanupPaipu(cleanupDays);
        cleanupAvatar(cleanupDays);
      } catch (error) {
        logger?.error?.(`[Majsoul-Plugin] 牌谱初始清理失败: ${error.message}`);
      }
    }, 60000);
  }

  // 插件卸载时的清理
  async uninstall() {
    console.log('[Majsoul-Plugin] 正在卸载插件...');

    if (scheduleManager) {
      clearInterval(scheduleManager.interval4p);
      clearInterval(scheduleManager.interval3p);
      clearInterval(scheduleManager.paipuCleanupTimer);
      await scheduleManager.stop?.();
      scheduleManager = null;
    }

    for (const [key, mod] of Object.entries(this.modules)) {
      try {
        await mod.uninstall?.();
      } catch (error) {
        console.error(`[Majsoul-Plugin] ${key} 模块清理失败:`, error);
      }
    }

    console.log('[Majsoul-Plugin] 插件卸载完成');
  }
  
}

