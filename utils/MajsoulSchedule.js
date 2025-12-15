// plugins/Majsoul-Plugin/utils/MajsoulSchedule.js
import MajsoulSubscribeCore from './MajsoulSubscribeCore.js';

export default class MajsoulSchedule {
    constructor() {
        this.core = new MajsoulSubscribeCore();
        this.isRunning = false;
        this.checkInterval = null;
        this.bot = null;
        // 使用全局 logger 或 console
        this.logger = global.logger || console;
    }
    
    // 设置Bot实例
    setBot(botInstance) {
        this.bot = botInstance;
        this.logger.info('[MajsoulSchedule] Bot实例已设置');
    }
    
    // 启动定时检查
    start() {
        if (this.isRunning) {
            this.logger.warn('[MajsoulSchedule] 定时任务已在运行中');
            return;
        }
        
        this.logger.info('[MajsoulSchedule] 启动定时任务，每3分钟检查一次');
        this.isRunning = true;
        
        // 每3分钟检查一次
        this.checkInterval = setInterval(() => {
            this.performCheck();
        }, 3 * 60 * 1000);
        
        // 立即执行一次检查
        setTimeout(() => this.performCheck(), 5000);
    }
    
    // 停止定时检查
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        this.logger.info('[MajsoulSchedule] 定时任务已停止');
    }
    
    // 执行检查
    async performCheck() {
        try {
            this.logger.debug('[MajsoulSchedule] 开始检查订阅更新...');
            
            const updates = await this.core.checkAllSubscriptions();
            
            if (updates.length === 0) {
                this.logger.debug('[MajsoulSchedule] 未发现新对局');
                return;
            }
            
            this.logger.info(`[MajsoulSchedule] 发现${updates.length}个新对局，开始播报`);
            
            // 发送更新消息
            for (const update of updates) {
                await this.sendGroupMessage(update.groupId, update.message);
                // 避免消息轰炸，每条消息间隔1秒
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            this.logger.info(`[MajsoulSchedule] 完成播报，共${updates.length}条消息`);
            
        } catch (error) {
            this.logger.error(`[MajsoulSchedule] 检查更新失败: ${error.message}`);
        }
    }
    
    // 发送群消息
    async sendGroupMessage(groupId, message) {
        if (!this.bot) {
            this.logger.error(`[MajsoulSchedule] 未设置Bot实例，无法发送消息`);
            return false;
        }
        
        try {
            // TRSS-Yunzai 中发送群消息的标准方式
            // 首先尝试通过 this.bot 发送
            if (typeof this.bot.sendGroupMsg === 'function') {
                await this.bot.sendGroupMsg(groupId, message);
            } else if (typeof this.bot.pickGroup === 'function') {
                await this.bot.pickGroup(groupId).sendMsg(message);
            } else {
                // 使用全局的 Bot 对象
                const Bot = global.Bot || this.bot;
                if (Bot && typeof Bot.sendGroupMsg === 'function') {
                    await Bot.sendGroupMsg(groupId, message);
                } else {
                    this.logger.error(`[MajsoulSchedule] 无法找到可用的消息发送方法`);
                    return false;
                }
            }
            
            this.logger.debug(`[MajsoulSchedule] 消息已发送到群 ${groupId}`);
            return true;
        } catch (error) {
            this.logger.error(`[MajsoulSchedule] 发送消息失败: ${error.message}`);
            return false;
        }
    }
    
    // 手动触发一次检查
    async manualCheck() {
        if (!this.bot) {
            this.logger.error('[MajsoulSchedule] 无法执行手动检查：未设置Bot实例');
            return { success: false, message: '未设置Bot实例' };
        }
        
        try {
            this.logger.info('[MajsoulSchedule] 开始手动检查...');
            const updates = await this.core.checkAllSubscriptions();
            
            let resultMessage = `手动检查完成，发现 ${updates.length} 条新对局`;
            if (updates.length > 0) {
                resultMessage += `，已发送播报消息`;
            }
            
            this.logger.info(`[MajsoulSchedule] ${resultMessage}`);
            return { 
                success: true, 
                message: resultMessage,
                updatesCount: updates.length 
            };
        } catch (error) {
            this.logger.error('[MajsoulSchedule] 手动检查失败:', error);
            return { success: false, message: `检查失败: ${error.message}` };
        }
    }
}