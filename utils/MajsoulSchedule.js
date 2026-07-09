// plugins/Majsoul-Plugin/utils/MajsoulSchedule.js
import MajsoulSubscribeCore from './MajsoulSubscribeCore.js';

export default class MajsoulSchedule {
    constructor() {
        this.core = new MajsoulSubscribeCore();
        this.isRunning = false;
        this.checkInterval4p = null; // 四麻检查定时器
        this.checkInterval3p = null; // 三麻检查定时器
        this.bot = null;
        // 使用全局 logger 或 console（确保使用 console.log 级别确保控制台可见）
        this.logger = global.logger || console;
        
        // 统计信息
        this.stats = {
            totalChecks: 0,
            totalUpdates: 0,
            lastCheckTime: null
        };
    }
    
    // 设置Bot实例
    setBot(botInstance) {
        this.bot = botInstance;
        console.log('[雀魂对局订阅] INFO: Bot实例已设置');
        this.logger.info('[MajsoulSchedule] Bot实例已设置');
    }
    
    // 启动定时检查
    start() {
        if (this.isRunning) {
            console.log('[雀魂对局订阅] INFO: 定时任务已在运行中');
            this.logger.warn('[MajsoulSchedule] 定时任务已在运行中');
            return;
        }
        
        console.log('[雀魂对局订阅] INFO: 启动定时任务');
        this.logger.info('[MajsoulSchedule] 启动定时任务');
        this.isRunning = true;
        
        // 四麻：每3分钟检查一次（与Majsoul_bot一致）
        this.checkInterval4p = setInterval(() => {
            this.performCheck(4);
        }, 3 * 60 * 1000);
        
        // 三麻：每5分钟检查一次（与Majsoul_bot一致）
        this.checkInterval3p = setInterval(() => {
            this.performCheck(3);
        }, 5 * 60 * 1000);
        
        // 立即执行一次检查（四麻和三麻各一次）
        setTimeout(() => this.performCheck(4), 3000);
        setTimeout(() => this.performCheck(3), 5000);
        
        console.log('[雀魂对局订阅] INFO: 定时任务启动成功（四麻3分钟/三麻5分钟）');
    }
    
    // 停止定时检查
    stop() {
        if (this.checkInterval4p) {
            clearInterval(this.checkInterval4p);
            this.checkInterval4p = null;
        }
        if (this.checkInterval3p) {
            clearInterval(this.checkInterval3p);
            this.checkInterval3p = null;
        }
        this.isRunning = false;
        console.log('[雀魂对局订阅] INFO: 定时任务已停止');
        this.logger.info('[MajsoulSchedule] 定时任务已停止');
    }
    
    // 执行检查（支持指定模式）
    async performCheck(mode = 4) {
        const modeName = mode === 4 ? '四麻' : '三麻';
        const jobName = mode === 4 ? 'record_scheduled' : 'Trirecord_scheduled';
        
        try {
            // 使用 console.log 确保控制台可见（模拟 Majsoul_bot 的输出格式）
            console.log(`[雀魂对局订阅] INFO: Scheduled job ${jobName} start.`);
            this.logger.info(`[MajsoulSchedule] 开始检查${modeName}订阅...`);
            
            // 更新统计信息
            this.stats.totalChecks++;
            this.stats.lastCheckTime = new Date().toISOString();
            
            const updates = await this.core.checkSubscriptionsByMode(mode);
            
            if (updates.length === 0) {
                console.log(`[雀魂对局订阅] INFO: Scheduled job ${jobName} completed.`);
                this.logger.info(`[MajsoulSchedule] ${modeName}暂无新对局`);
                return;
            }
            
            console.log(`[雀魂对局订阅] INFO: ${modeName}发现${updates.length}个新对局，开始播报`);
            this.logger.info(`[MajsoulSchedule] ${modeName}发现${updates.length}个新对局，开始播报`);
            
            // 更新统计信息
            this.stats.totalUpdates += updates.length;
            
            // 发送更新消息
            let sentCount = 0;
            for (const update of updates) {
                const success = await this.sendGroupMessage(update.groupId, update.message, update.image);
                if (success) sentCount++;
                // 避免消息轰炸，每条消息间隔1秒
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            console.log(`[雀魂对局订阅] INFO: ${modeName}完成播报，成功${sentCount}/${updates.length}条消息`);
            this.logger.info(`[MajsoulSchedule] ${modeName}完成播报，共${updates.length}条消息，成功${sentCount}条`);
            
            // 输出完成日志
            console.log(`[雀魂对局订阅] INFO: Scheduled job ${jobName} completed.`);
            
        } catch (error) {
            console.error(`[雀魂对局订阅] ERROR: 检查${modeName}更新失败: ${error.message}`);
            this.logger.error(`[MajsoulSchedule] 检查${modeName}更新失败: ${error.message}`);
        }
    }
    
    // 执行全量检查（四麻+三麻）
    async performFullCheck() {
        await this.performCheck(4);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.performCheck(3);
    }
    
    // 发送群消息（支持文字+图片合并发送）
    async sendGroupMessage(groupId, message, imageBuffer = null) {
        if (!this.bot) {
            this.logger.error(`[MajsoulSchedule] 未设置Bot实例，无法发送消息到群 ${groupId}`);
            return false;
        }
        
        try {
            // 如果有图片，合并成一条消息发送：标题 + 图片 + 牌谱链接
            if (imageBuffer) {
                const imageBase64 = `base64://${imageBuffer.toString('base64')}`;
                
                // 使用 segment 组合消息
                if (typeof global.segment === 'object') {
                    const imageSegment = global.segment.image(imageBase64);
                    const msgChain = [
                        '本群侦测到新的对局\n',
                        imageSegment,
                        `\n${message}`
                    ];
                    
                    if (typeof this.bot.sendGroupMsg === 'function') {
                        await this.bot.sendGroupMsg(parseInt(groupId), msgChain);
                        this.logger.debug(`[MajsoulSchedule] 合并消息已发送到群 ${groupId}`);
                        return true;
                    }
                    else if (typeof this.bot.pickGroup === 'function') {
                        await this.bot.pickGroup(parseInt(groupId)).sendMsg(msgChain);
                        this.logger.debug(`[MajsoulSchedule] 合并消息已发送到群 ${groupId}`);
                        return true;
                    }
                }
            }
            
            // 没有图片或图片发送失败，只发送文字（文字消息已包含完整内容）
            let sent = false;
            
            if (typeof this.bot.sendGroupMsg === 'function') {
                await this.bot.sendGroupMsg(parseInt(groupId), message);
                sent = true;
            }
            else if (typeof this.bot.pickGroup === 'function') {
                await this.bot.pickGroup(parseInt(groupId)).sendMsg(message);
                sent = true;
            }
            else if (typeof global.Bot === 'object' && typeof global.Bot.sendGroupMsg === 'function') {
                await global.Bot.sendGroupMsg(parseInt(groupId), message);
                sent = true;
            }
            else if (typeof global.Bots === 'object') {
                for (const [, bot] of Object.entries(global.Bots)) {
                    if (typeof bot.sendGroupMsg === 'function') {
                        await bot.sendGroupMsg(parseInt(groupId), message);
                        sent = true;
                        break;
                    }
                }
            }
            
            if (sent) {
                this.logger.debug(`[MajsoulSchedule] 消息已发送到群 ${groupId}`);
                return true;
            } else {
                this.logger.error(`[MajsoulSchedule] 无法找到可用的消息发送方法`);
                return false;
            }
            
        } catch (error) {
            this.logger.error(`[MajsoulSchedule] 发送消息到群 ${groupId} 失败: ${error.message}`);
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
            
            // 检查四麻
            const updates4p = await this.core.checkSubscriptionsByMode(4);
            // 检查三麻
            const updates3p = await this.core.checkSubscriptionsByMode(3);
            
            const totalUpdates = updates4p.length + updates3p.length;
            
            let resultMessage = `手动检查完成，四麻发现 ${updates4p.length} 条新对局，三麻发现 ${updates3p.length} 条新对局`;
            if (totalUpdates > 0) {
                resultMessage += `，已发送播报消息`;
            }
            
            // 发送消息
            for (const update of [...updates4p, ...updates3p]) {
                await this.sendGroupMessage(update.groupId, update.message, update.image);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            this.logger.info(`[MajsoulSchedule] ${resultMessage}`);
            return { 
                success: true, 
                message: resultMessage,
                updatesCount: totalUpdates,
                updates4p: updates4p.length,
                updates3p: updates3p.length
            };
        } catch (error) {
            this.logger.error('[MajsoulSchedule] 手动检查失败:', error);
            return { success: false, message: `检查失败: ${error.message}` };
        }
    }
}
