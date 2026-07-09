// plugins/Majsoul-Plugin/apps/MajsoulGacha.js
import plugin from "../../../lib/plugins/plugin.js";
import GachaCore from '../core/GachaCore.js';
import DailyLimiter from '../utils/DailyLimiter.js';
import { ITEM_TYPE } from '../core/GachaCore.js';

export class MajsoulGacha extends plugin {
    constructor() {
        super({
            name: '雀魂抽卡',
            dsc: '雀魂模拟抽卡插件',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂十连$',
                    fnc: 'tenGacha'
                },
                {
                    reg: '^#?切换雀魂卡池\\s+(.+)$',
                    fnc: 'changePool',
                    permission: 'admin'
                },
                {
                    reg: '^#?(查看雀魂卡池|当前雀魂卡池)$',
                    fnc: 'viewPool'
                },
                // 抽卡开关功能
                {
                    reg: '^#?(开启|关闭)雀魂抽卡$',
                    fnc: 'toggleGacha',
                    permission: 'admin'
                },
                // 查询抽卡开关状态
                {
                    reg: '^#?雀魂抽卡状态$',
                    fnc: 'checkGachaStatus'
                },
                // 设置用户今日剩余抽卡次数
                {
                    reg: '^#?设置用户次数\\s+(\\d+)\\s+(\\d+)$',
                    fnc: 'setUserCount',
                    permission: 'master'
                },
                // 重置用户抽卡次数（清零）
                {
                    reg: '^#?重置用户次数\\s+(\\d+)$',
                    fnc: 'resetUserLimit',
                    permission: 'master'
                },
                {
                    reg: '^#?查询抽卡次数\\s*(\\d+)?$',
                    fnc: 'checkLimit'
                }
            ]
        });
        this.gachaCore = new GachaCore();
        this.dailyLimiter = new DailyLimiter(5); // 修改为每日5次
    }

    // 十连抽卡（增加保底提示）
    async tenGacha(e) {
        // 检查是否在群聊中
        if (!e.group_id) {
            await e.reply('雀魂抽卡功能仅限群聊使用');
            return true;
        }

        // 检查抽卡开关状态
        try {
            const isEnabled = await this.gachaCore.getGachaStatus(e.group_id);
            if (!isEnabled) {
                await e.reply('本群雀魂抽卡功能已关闭，请联系管理员开启');
                return true;
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 检查开关状态失败:', error);
            // 出错时继续执行，避免影响正常使用
        }

        try {
            const canGacha = await this.dailyLimiter.check(e.user_id);
            if (!canGacha) {
                const remaining = await this.dailyLimiter.getRemaining(e.user_id);
                await e.reply(`今天已经抽了 ${this.dailyLimiter.limit} 次啦，剩余次数：${remaining}，明天再来吧~`, true);
                return true;
            }

            const { imageBase64, results, hasGuaranteed } = await this.gachaCore.runGacha(e.group_id);
            await this.dailyLimiter.increase(e.user_id);

            const currentCount = await this.dailyLimiter.getCount(e.user_id);
            const remaining = await this.dailyLimiter.getRemaining(e.user_id);

            let resetTimeInfo = "";
            try {
                const resetTime = await this.dailyLimiter.getFormattedResetTime();
                resetTimeInfo = `\n⏰ 重置时间：${resetTime}`;
            } catch (resetError) {
                logger.error('[雀魂抽卡] 获取重置时间失败:', resetError);
                resetTimeInfo = "";
            }

            let rareCount = { '角色': 0, '装饰': 0, '蓝色礼物': 0, '紫色礼物': 0 };
            for (const [objInt] of results) {
                if (objInt === ITEM_TYPE.CHARACTER) rareCount['角色']++;
                else if (objInt === ITEM_TYPE.DECORATION) rareCount['装饰']++;
                else if (objInt === ITEM_TYPE.GIFT_BLUE) rareCount['蓝色礼物']++;
                else if (objInt === ITEM_TYPE.GIFT_PURPLE) rareCount['紫色礼物']++;
            }

            let textSummary = `🎉 十连寻觅总结：`;
            let summaryParts = [];
            if (rareCount['角色'] > 0) summaryParts.push(`角色x${rareCount['角色']}`);
            if (rareCount['装饰'] > 0) summaryParts.push(`装饰x${rareCount['装饰']}`);
            if (rareCount['蓝色礼物'] > 0) summaryParts.push(`蓝礼物x${rareCount['蓝色礼物']}`);
            if (rareCount['紫色礼物'] > 0) summaryParts.push(`紫礼物x${rareCount['紫色礼物']}`);
            textSummary += summaryParts.join('， ');

            // 添加保底提示
            if (hasGuaranteed) {
                textSummary += `\n✨ 触发十连保底！最后一抽升级为紫色礼物！`;
            }

            textSummary += `\n📊 今日抽卡：${currentCount}/${this.dailyLimiter.limit}（剩余${remaining}次）`;
            textSummary += resetTimeInfo;

            const msg = [
                segment.at(e.user_id),
                `\n`,
                textSummary,
                segment.image(imageBase64)
            ];
            await e.reply(msg);

        } catch (error) {
            logger.error('[雀魂抽卡] 抽卡失败:', error);
            // 如果是开关关闭的错误，提示更友好的信息
            if (error.message.includes('抽卡功能已关闭')) {
                await e.reply('本群雀魂抽卡功能已关闭，请联系管理员开启');
            } else {
                await e.reply('抽卡过程出现异常，请联系维护者。', true);
            }
        }
        return true;
    }

    // 开关抽卡功能
    async toggleGacha(e) {
        const match = e.msg.match(/^#?(开启|关闭)雀魂抽卡$/);
        if (!match || !e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }

        const action = match[1];
        const isEnable = action === '开启';
        
        try {
            const success = await this.gachaCore.setGachaStatus(e.group_id, isEnable);
            if (success) {
                const statusText = isEnable ? '开启' : '关闭';
                await e.reply(`已${statusText}本群雀魂抽卡功能`);
                
                // 如果是关闭操作，额外提示
                if (!isEnable) {
                    await e.reply('提示：关闭后，所有成员将无法使用雀魂抽卡功能');
                }
            } else {
                await e.reply('操作失败，请重试或联系维护者');
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 切换开关失败:', error);
            await e.reply('操作失败，系统异常');
        }
        return true;
    }

    // 查询抽卡开关状态
    async checkGachaStatus(e) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }

        try {
            const isEnabled = await this.gachaCore.getGachaStatus(e.group_id);
            const statusText = isEnabled ? '开启' : '关闭';
            const statusIcon = isEnabled ? '✅' : '❌';
            
            const replyMsg = [
                `群 ${e.group_id} 雀魂抽卡功能状态：`,
                `${statusIcon} ${statusText}`,
                '',
                isEnabled 
                    ? '✅ 成员可以使用 #雀魂十连 进行抽卡'
                    : '❌ 抽卡功能已禁用，请联系管理员开启',
                '',
                `📊 每日抽卡次数限制：${this.dailyLimiter.limit}次`
            ].join('\n');
            
            await e.reply(replyMsg);
        } catch (error) {
            logger.error('[雀魂抽卡] 查询状态失败:', error);
            await e.reply('查询失败，系统异常');
        }
        return true;
    }

    // 切换卡池（更新：删除up池相关提示）
    async changePool(e) {
        const match = e.msg.match(/^#?切换雀魂卡池\s+(.+)$/);
        if (!match) {
            logger.error('[雀魂抽卡] 切换卡池指令格式错误:', e.msg);
            return false;
        }

        const input = match[1];
        const poolId = this.gachaCore.getPoolId(input);
        if (!poolId) {
            const supportedPools = "辉夜大小姐想让我告白、Fate、咲-saki-1、咲-saki-2、斗牌传说、反叛的鲁路修、狂赌之渊、银魂、常驻池、限定、魔法少女伊莉雅、蔚蓝档案、偶像大师闪耀色彩";
            await e.reply(`没有找到该名称的卡池，当前支持的卡池有：${supportedPools}`);
            return true;
        }

        try {
            const groupPool = await this.gachaCore.groupPoolLoader();
            const newGroupPool = [];
            let found = false;

            for (const item of groupPool) {
                if (item.gid === String(e.group_id)) {
                    newGroupPool.push({ ...item, poolname: poolId });
                    found = true;
                } else {
                    newGroupPool.push(item);
                }
            }
            if (!found) {
                newGroupPool.push({
                    gid: String(e.group_id),
                    poolname: poolId
                });
            }

            await this.gachaCore.saveGroupPool(newGroupPool);
            const poolName = this.gachaCore.getPoolName(poolId);
            await e.reply(`已成功将本群卡池切换到：${poolName}`);

        } catch (error) {
            logger.error('[雀魂抽卡] 切换卡池失败:', error);
            await e.reply('切换卡池失败，可能是配置文件读写错误。');
        }
        return true;
    }

    // 查看卡池
    async viewPool(e) {
        try {
            const groupPool = await this.gachaCore.groupPoolLoader();
            let currentPool = 'normal'; // 默认池改为normal
            for (const item of groupPool) {
                if (item.gid === String(e.group_id)) {
                    currentPool = item.poolname;
                    break;
                }
            }
            const poolName = this.gachaCore.getPoolName(currentPool);
            await e.reply(`本群启用的雀魂卡池为：${poolName}`);
        } catch (error) {
            logger.error('[雀魂抽卡] 查看卡池失败:', error);
            await e.reply('查看卡池失败，可能是配置文件读取错误。');
        }
        return true;
    }

    // 查询抽卡次数
    async checkLimit(e) {
        const match = e.msg.match(/^#?查询抽卡次数\s*(\d+)?$/);
        const targetUserId = match ? (match[1] || e.user_id) : e.user_id;

        try {
            const currentCount = await this.dailyLimiter.getCount(targetUserId);
            const remaining = await this.dailyLimiter.getRemaining(targetUserId);

            const userInfo = targetUserId === e.user_id ? '你' : `用户 ${targetUserId}`;
            await e.reply(`${userInfo}今日已抽卡 ${currentCount} 次，剩余 ${remaining} 次，每日限制 ${this.dailyLimiter.limit} 次`);
        } catch (error) {
            logger.error('[雀魂抽卡] checkLimit 失败:', error);
            await e.reply('查询抽卡次数失败：' + error.message);
        }
        return true;
    }

    // 设置用户今日剩余抽卡次数
    async setUserCount(e) {
        const match = e.msg.match(/^#?设置用户次数\s+(\d+)\s+(\d+)$/);
        if (!match) {
            await e.reply('❌ 指令格式错误！正确格式：#设置用户次数 [用户ID] [剩余次数]');
            return true;
        }

        const targetUserId = match[1];
        const remainingToSet = parseInt(match[2]);

        // 基础校验：剩余次数必须在0到每日上限之间
        if (isNaN(remainingToSet) || remainingToSet < 0 || remainingToSet > this.dailyLimiter.limit) {
            await e.reply(`❌ 设置次数无效，请输入0到${this.dailyLimiter.limit}之间的整数。`);
            return true;
        }

        try {
            // 计算已抽次数 = 每日上限 - 设置的剩余次数
            const usedCount = this.dailyLimiter.limit - remainingToSet;
            
            // 调用底层方法设置已抽次数
            const success = await this.dailyLimiter.setCount(targetUserId, usedCount);
            
            if (success) {
                await e.reply(`✅ 已将用户 ${targetUserId} 的今日抽卡次数设置为：\n` +
                    `📊 已抽次数：${usedCount} 次\n` +
                    `💫 剩余次数：${remainingToSet} 次\n` +
                    `🎯 每日上限：${this.dailyLimiter.limit} 次`);
            } else {
                await e.reply('❌ 设置用户抽卡次数失败，请检查日志。');
            }
        } catch (error) {
            logger.error('[雀魂抽卡] setUserCount 方法执行失败:', error);
            await e.reply('❌ 执行操作时出现系统错误：' + error.message);
        }
        return true;
    }

    // 重置指定用户抽卡次数（清零）
    async resetUserLimit(e) {
        const match = e.msg.match(/^#?重置用户次数\s+(\d+)$/);
        if (!match) {
            await e.reply('❌ 指令格式错误！正确格式：#重置用户次数 [用户ID]');
            return true;
        }

        const targetUserId = match[1];

        try {
            // 重置 = 设置已抽次数为0，剩余次数为每日上限
            const success = await this.dailyLimiter.setCount(targetUserId, 0);
            
            if (success) {
                await e.reply(`✅ 已重置用户 ${targetUserId} 的今日抽卡记录\n` +
                    `📊 已抽次数：0 次\n` +
                    `💫 剩余次数：${this.dailyLimiter.limit} 次\n` +
                    `🎯 每日上限：${this.dailyLimiter.limit} 次`);
            } else {
                await e.reply('❌ 重置用户抽卡次数失败，请检查日志。');
            }
        } catch (error) {
            logger.error('[雀魂抽卡] resetUserLimit 方法执行失败:', error);
            await e.reply('❌ 执行操作时出现系统错误：' + error.message);
        }
        return true;
    }
}