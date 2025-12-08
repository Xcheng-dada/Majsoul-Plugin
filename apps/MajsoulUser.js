// plugins/Majsoul-Plugin/apps/MajsoulUser.js
import plugin from "../../../lib/plugins/plugin.js";
import MajsoulApi from '../utils/MajsoulApi.js';
import PlayerLevel from '../utils/PlayerLevel.js';

export class MajsoulUser extends plugin {
    constructor() {
        super({
            name: '雀魂用户管理',
            dsc: '雀魂玩家搜索与UID绑定管理',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂搜索\\s+(.+)$',
                    fnc: 'searchPlayer'
                },
                {
                    reg: '^#?雀魂绑定\\s+(\\d+)$',
                    fnc: 'bindUid'
                },
                {
                    reg: '^#?雀魂切换\\s+(\\d+)$',
                    fnc: 'switchUid'
                },
                {
                    reg: '^#?雀魂解绑(?:\\s+(\\d+))?$',
                    fnc: 'unbindUid'
                },
                {
                    reg: '^#?雀魂我的绑定$',
                    fnc: 'myBindings'
                }
            ]
        });
        
        this.api = new MajsoulApi();
        this.redisPrefix = 'majsoul:user:';
    }
    
    // 搜索玩家
    async searchPlayer(e) {
        try {
            const match = e.msg.match(/^#?雀魂搜索\s+(.+)$/);
            if (!match) return false;
            
            const playerName = match[1].trim();
            if (!playerName) {
                await e.reply('请输入要搜索的玩家名称');
                return true;
            }
            
            const players = await this.api.searchPlayer(playerName);
            
            if (players.length === 0) {
                await e.reply('暂未搜索到该玩家ID噢~\n提示: 需要在金之间有一定数量的对局才能被搜索到！');
                return true;
            }
            
            let message = '🔍 搜索结果：\n\n';
            for (let i = 0; i < players.length; i++) {
                const player = players[i];
                const playerLevel = new PlayerLevel(player.level.id, player.level.score);
                
                message += `【${i + 1}】${player.nickname}\n`;
                message += `   ID: ${player.id}\n`;
                message += `   段位: ${playerLevel.getTag()} (${playerLevel.formatAdjustedScore(player.level.score)})\n\n`;
            }
            
            message += '💡 提示：使用【雀魂绑定+ID】进行角色绑定\n';
            message += '📊 使用【雀魂查询+ID】查看详细数据';
            
            await e.reply(message);
            
        } catch (error) {
            logger.error('[MajsoulUser] 搜索玩家失败:', error);
            await e.reply('搜索玩家时出现错误，请稍后重试');
        }
        return true;
    }
    
    // 绑定UID
    async bindUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂绑定\s+(\d+)$/);
            if (!match) return false;
            
            const uid = match[1];
            const qid = e.user_id;
            
            // 验证UID格式
            if (uid.length < 6 || uid.length > 10) {
                await e.reply('UID格式不正确，应为6-10位数字');
                return true;
            }
            
            // 检查是否已绑定
            const existingBind = await this.getUserBindings(qid);
            if (existingBind.includes(uid)) {
                await e.reply(`UID ${uid} 已经绑定过了！`);
                return true;
            }
            
            // 保存绑定
            await this.addUserBinding(qid, uid, e.nickname || '未知用户');
            
            await e.reply(`✅ 成功绑定雀魂UID: ${uid}\n使用【雀魂查询】查看详细数据`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 绑定UID失败:', error);
            await e.reply('绑定UID时出现错误');
        }
        return true;
    }
    
    // 切换绑定
    async switchUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂切换\s+(\d+)$/);
            if (!match) return false;
            
            const uid = match[1];
            const qid = e.user_id;
            
            // 获取当前绑定
            const bindings = await this.getUserBindings(qid);
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何UID');
                return true;
            }
            
            // 检查目标UID是否在绑定列表中
            if (!bindings.includes(uid)) {
                await e.reply(`您尚未绑定UID ${uid}，无法切换\n当前已绑定的UID：${bindings.join(', ')}`);
                return true;
            }
            
            // 设置为主UID
            await redis.set(`${this.redisPrefix}${qid}:main`, uid);
            
            await e.reply(`✅ 已切换主UID为: ${uid}`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 切换UID失败:', error);
            await e.reply('切换UID时出现错误');
        }
        return true;
    }
    
    // 解绑UID
    async unbindUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂解绑(?:\s+(\d+))?$/);
            if (!match) return false;
            
            const targetUid = match[1];
            const qid = e.user_id;
            
            // 获取当前绑定
            const bindings = await this.getUserBindings(qid);
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何UID');
                return true;
            }
            
            // 如果没有指定UID，解绑所有
            if (!targetUid) {
                await this.clearUserBindings(qid);
                await e.reply('✅ 已解绑所有UID');
                return true;
            }
            
            // 解绑指定UID
            if (!bindings.includes(targetUid)) {
                await e.reply(`您尚未绑定UID ${targetUid}`);
                return true;
            }
            
            await this.removeUserBinding(qid, targetUid);
            await e.reply(`✅ 已解绑UID: ${targetUid}\n剩余绑定: ${bindings.filter(id => id !== targetUid).join(', ')}`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 解绑UID失败:', error);
            await e.reply('解绑UID时出现错误');
        }
        return true;
    }
    
    // 查看我的绑定
    async myBindings(e) {
        try {
            const qid = e.user_id;
            const bindings = await this.getUserBindings(qid);
            
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何雀魂UID\n使用【雀魂绑定+UID】进行绑定');
                return true;
            }
            
            let message = '📋 您的雀魂绑定：\n\n';
            const mainUid = await redis.get(`${this.redisPrefix}${qid}:main`) || bindings[0];
            
            for (let i = 0; i < bindings.length; i++) {
                const uid = bindings[i];
                const isMain = uid === mainUid;
                message += `${isMain ? '⭐ ' : '  '}${i + 1}. UID: ${uid}`;
                if (isMain) message += ' (主账号)';
                message += '\n';
            }
            
            message += '\n💡 指令：\n';
            message += '【雀魂切换+UID】切换主账号\n';
            message += '【雀魂解绑+UID】解绑指定账号\n';
            message += '【雀魂解绑】解绑所有账号';
            
            await e.reply(message);
            
        } catch (error) {
            logger.error('[MajsoulUser] 查看绑定失败:', error);
            await e.reply('查看绑定信息时出现错误');
        }
        return true;
    }
    
    // ========== 数据库操作方法 ==========
    
    // 获取用户的所有绑定
    async getUserBindings(qid) {
        try {
            const key = `${this.redisPrefix}${qid}:bindings`;
            const bindingsStr = await redis.get(key);
            return bindingsStr ? JSON.parse(bindingsStr) : [];
        } catch (error) {
            logger.error('[MajsoulUser] 获取用户绑定失败:', error);
            return [];
        }
    }
    
    // 添加绑定
    async addUserBinding(qid, uid, nickname = '') {
        try {
            const key = `${this.redisPrefix}${qid}:bindings`;
            const bindings = await this.getUserBindings(qid);
            
            // 检查是否已存在
            if (!bindings.includes(uid)) {
                bindings.push(uid);
                await redis.set(key, JSON.stringify(bindings));
                
                // 如果是第一个绑定，设置为主账号
                if (bindings.length === 1) {
                    await redis.set(`${this.redisPrefix}${qid}:main`, uid);
                }
                
                // 存储额外信息（可选）
                await redis.set(`${this.redisPrefix}${qid}:${uid}:nickname`, nickname);
            }
            return true;
        } catch (error) {
            logger.error('[MajsoulUser] 添加绑定失败:', error);
            return false;
        }
    }
    
    // 移除绑定
    async removeUserBinding(qid, uid) {
        try {
            const key = `${this.redisPrefix}${qid}:bindings`;
            const bindings = await this.getUserBindings(qid);
            const newBindings = bindings.filter(id => id !== uid);
            
            await redis.set(key, JSON.stringify(newBindings));
            
            // 清理相关数据
            await redis.del(`${this.redisPrefix}${qid}:${uid}:nickname`);
            
            // 如果删除的是主账号，重新设置主账号
            const mainUid = await redis.get(`${this.redisPrefix}${qid}:main`);
            if (mainUid === uid && newBindings.length > 0) {
                await redis.set(`${this.redisPrefix}${qid}:main`, newBindings[0]);
            }
            
            return true;
        } catch (error) {
            logger.error('[MajsoulUser] 移除绑定失败:', error);
            return false;
        }
    }
    
    // 清除所有绑定
    async clearUserBindings(qid) {
        try {
            const bindings = await this.getUserBindings(qid);
            
            // 删除所有相关键
            for (const uid of bindings) {
                await redis.del(`${this.redisPrefix}${qid}:${uid}:nickname`);
            }
            
            await redis.del(`${this.redisPrefix}${qid}:bindings`);
            await redis.del(`${this.redisPrefix}${qid}:main`);
            
            return true;
        } catch (error) {
            logger.error('[MajsoulUser] 清除绑定失败:', error);
            return false;
        }
    }
}