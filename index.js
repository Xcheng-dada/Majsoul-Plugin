// plugins/Majsoul-Plugin/index.js
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

// 获取当前文件的绝对路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 计算正确的 plugin.js 路径（使用相对路径）
const pluginRelativePath = '../../lib/plugins/plugin.js';
const pluginPath = join(__dirname, pluginRelativePath);

// 使用 pathToFileURL 将 Windows 路径转换为正确的 file:// URL
const pluginUrl = pathToFileURL(pluginPath).href;

// 使用动态导入
let plugin;
try {
    console.log(`[Majsoul-Plugin] 尝试导入 plugin.js，路径: ${pluginUrl}`);
    const module = await import(pluginUrl);
    plugin = module.default || module;
    console.log('[Majsoul-Plugin] 成功导入 plugin.js');
} catch (error) {
    console.error(`[Majsoul-Plugin] 无法导入 plugin.js: ${error.message}`);
    console.error(`[Majsoul-Plugin] 尝试的路径: ${pluginUrl}`);
    
    // 如果失败，尝试其他可能的路径
    const alternativePaths = [
        join(__dirname, '../../../lib/plugins/plugin.js'),  // 多一层
        join(__dirname, '../../../../../lib/plugins/plugin.js'), // 更多层
        'file:///F:/桌面/BOT/YunzaiBOT/Yunzai/TRSS-Yunzai/lib/plugins/plugin.js' // 绝对路径
    ];
    
    for (const altPath of alternativePaths) {
        try {
            const altUrl = altPath.startsWith('file://') ? altPath : pathToFileURL(altPath).href;
            console.log(`[Majsoul-Plugin] 尝试备用路径: ${altUrl}`);
            const module = await import(altUrl);
            plugin = module.default || module;
            console.log(`[Majsoul-Plugin] 使用备用路径成功导入: ${altUrl}`);
            break;
        } catch (altError) {
            console.error(`[Majsoul-Plugin] 备用路径 ${altPath} 也失败: ${altError.message}`);
        }
    }
    
    if (!plugin) {
        throw new Error('[Majsoul-Plugin] 无法找到 plugin.js，请检查 Yunzai 的安装路径');
    }
}

// 导入其他模块
import { MajsoulGacha } from './apps/MajsoulGacha.js';
import { MajsoulUser } from './apps/MajsoulUser.js';
import { MajsoulSubscribe } from './apps/MajsoulSubscribe.js';
import MajsoulSchedule from './utils/MajsoulSchedule.js';

let scheduleManager = null;

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
          reg: '^#雀魂十连$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#切换雀魂卡池\\s+(.+)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#查看雀魂卡池$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#查询抽卡次数\\s*(\\d*)$',
          fnc: 'majsoulGacha',
          permission: 'group'
        },
        {
          reg: '^#设置用户次数\\s+(\\d+)\\s+(\\d+)$',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        {
          reg: '^#重置用户次数\\s+(\\d+)$',
          fnc: 'majsoulGacha',
          permission: 'master'
        },
        
        // 用户管理相关指令
        {
          reg: '^#雀魂搜索\\s+(.+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#雀魂绑定\\s+(\\d+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#雀魂切换\\s+(\\d+)$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#雀魂解绑(?:\\s+(\\d+))?$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        {
          reg: '^#雀魂我的绑定$',
          fnc: 'majsoulUser',
          permission: 'group'
        },
        
        // 对局订阅相关指令 (四麻)
        {
          reg: '^#(雀魂|四麻)订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#(关闭|取消)(雀魂|四麻)订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#开启(雀魂|四麻)订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#删除(雀魂|四麻)订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#(雀魂|四麻)订阅状态$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        
        // 对局订阅相关指令 (三麻)
        {
          reg: '^#三麻订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#(关闭|取消)三麻订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#开启三麻订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#删除三麻订阅\\s+(.+)$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        },
        {
          reg: '^#三麻订阅状态$',
          fnc: 'majsoulSubscribe',
          permission: 'group'
        }
      ]
    });
    
    // 现在可以安全地初始化各个功能模块
    this.majsoulGacha = new MajsoulGacha();
    this.majsoulUser = new MajsoulUser();
    this.majsoulSubscribe = new MajsoulSubscribe();
  }
  
  // 指令路由 - 抽卡相关
  async majsoulGacha(e) {
    return await this.majsoulGacha.handle(e);
  }
  
  // 指令路由 - 用户管理相关
  async majsoulUser(e) {
    return await this.majsoulUser.handle(e);
  }
  
  // 指令路由 - 对局订阅相关
  async majsoulSubscribe(e) {
    return await this.majsoulSubscribe.handle(e);
  }

  // 插件加载时的初始化
  async init() {
    console.log('[Majsoul-Plugin] 雀魂插件初始化...');
    
    try {
      // 初始化抽卡模块
      await this.majsoulGacha.init?.();
      console.log('[Majsoul-Plugin] 抽卡模块初始化完成');
      
      // 初始化用户管理模块
      await this.majsoulUser.init?.();
      console.log('[Majsoul-Plugin] 用户管理模块初始化完成');
      
      // 初始化订阅模块
      await this.majsoulSubscribe.init?.();
      console.log('[Majsoul-Plugin] 对局订阅模块初始化完成');
      
    } catch (error) {
      console.error('[Majsoul-Plugin] 模块初始化失败:', error);
    }
  }

  // 任务初始化 - 启动定时任务
  async task() {
    // 确保定时任务只初始化一次
    if (!scheduleManager) {
      console.log('[Majsoul-Plugin] 初始化对局订阅定时任务...');
      
      try {
        scheduleManager = new MajsoulSchedule();
        
        // 获取 Bot 实例
        let botInstance = null;
        
        // 尝试不同的方式获取 Bot 实例
        if (typeof Bot !== 'undefined') {
          botInstance = Bot;
          console.debug('[Majsoul-Plugin] 从全局 Bot 对象获取实例');
        } else if (typeof global.Bot !== 'undefined') {
          botInstance = global.Bot;
          console.debug('[Majsoul-Plugin] 从 global.Bot 获取实例');
        } else if (this.bot) {
          botInstance = this.bot;
          console.debug('[Majsoul-Plugin] 从插件实例获取 Bot 实例');
        }
        
        if (botInstance) {
          scheduleManager.setBot(botInstance);
          scheduleManager.start();
          console.log('[Majsoul-Plugin] 定时任务启动成功');
        } else {
          console.warn('[Majsoul-Plugin] 无法获取 Bot 实例，定时任务将无法发送消息');
          // 仍然启动定时任务，但只能记录日志
          scheduleManager.start();
        }
        
      } catch (error) {
        console.error('[Majsoul-Plugin] 定时任务初始化失败:', error);
        scheduleManager = null;
      }
    }
  }

  // 插件卸载时的清理
  async uninstall() {
    console.log('[Majsoul-Plugin] 正在卸载插件...');
    
    // 停止定时任务
    if (scheduleManager) {
      try {
        scheduleManager.stop();
        console.log('[Majsoul-Plugin] 定时任务已停止');
      } catch (error) {
        console.error('[Majsoul-Plugin] 停止定时任务时出错:', error);
      }
      scheduleManager = null;
    }
    
    // 清理各个模块
    try {
      await this.majsoulGacha.uninstall?.();
      await this.majsoulUser.uninstall?.();
      await this.majsoulSubscribe.uninstall?.();
      console.log('[Majsoul-Plugin] 各模块已清理');
    } catch (error) {
      console.error('[Majsoul-Plugin] 模块清理时出错:', error);
    }
    
    console.log('[Majsoul-Plugin] 插件卸载完成');
  }
  
  // 用于调试的手动检查命令
  async debugCheck() {
    if (!scheduleManager) {
      return '定时任务未初始化';
    }
    
    try {
      const result = await scheduleManager.manualCheck();
      return result.message;
    } catch (error) {
      return `手动检查失败: ${error.message}`;
    }
  }
}

// 保持原有的导出，确保向后兼容
export { MajsoulGacha, MajsoulUser, MajsoulSubscribe };