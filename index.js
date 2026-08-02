// plugins/Majsoul-Plugin/index.js
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

import { MajsoulGacha } from './apps/MajsoulGacha.js';
import { MajsoulUser } from './apps/MajsoulUser.js';
import { MajsoulSubscribe } from './apps/MajsoulSubscribe.js';
import { MajsoulRecords } from './apps/MajsoulRecords.js';
import { MajsoulInfo } from './apps/MajsoulInfo.js';
import { MajsoulReview } from './apps/MajsoulReview.js';
import { MajsoulHelp } from './apps/MajsoulHelp.js';
import MajsoulSchedule from './utils/MajsoulSchedule.js';
import { cleanupPaipu, PAIPU_CLEANUP_DAYS } from './utils/PaipuCleanup.js';
import { updateLqc } from './utils/lqcUpdater.js';

// 加载 Yunzai 的 plugin 基类（兼容默认导出与具名导出）
const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginModule = await import(pathToFileURL(join(__dirname, '../../lib/plugins/plugin.js')).href);
const plugin = pluginModule.default || pluginModule.Plugin || pluginModule;

// 模块级定时任务管理器（多实例共享，避免重复启动）
let scheduleManager = null;

// 定时检查配置：四麻每 3 分钟，三麻每 5 分钟
const SCHEDULES = [
  { type: 4, interval: 3 * 60 * 1000, label: '四麻' },
  { type: 3, interval: 5 * 60 * 1000, label: '三麻' },
];

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
          reg: '^#?雀魂十连$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?切换雀魂卡池\\s+(.+)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?查看雀魂卡池$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?查询抽卡次数\\s*(\\d*)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#?设置用户次数\\s+(\\d+)\\s+(\\d+)$',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        {
          reg: '^#?重置用户次数\\s+(\\d+)$',
          fnc: 'majsoulGacha',
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
    console.log('[Majsoul-Plugin] 定时任务启动成功（四麻3分钟/三麻5分钟）');

    // 牌谱文件定时清理：每 24 小时执行一次，删除超过 ${PAIPU_CLEANUP_DAYS} 天的旧牌谱
    const paipuCleanupTimer = setInterval(() => {
      try {
        cleanupPaipu(PAIPU_CLEANUP_DAYS);
      } catch (error) {
        logger?.error?.(`[Majsoul-Plugin] 牌谱清理失败: ${error.message}`);
      }
    }, 24 * 60 * 60 * 1000);
    scheduleManager.paipuCleanupTimer = paipuCleanupTimer;

    // 启动后稍作延迟执行一次初始检查
    setTimeout(async () => {
      for (const { type } of SCHEDULES) await scheduleManager.performCheck(type);
    }, 5000);

    // 启动后稍作延迟执行一次牌谱清理（避免刚启动就清理，给予缓冲）
    setTimeout(() => {
      try {
        cleanupPaipu(PAIPU_CLEANUP_DAYS);
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

