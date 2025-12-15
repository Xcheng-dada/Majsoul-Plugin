// plugins/Majsoul-Plugin/apps/MajsoulSubscribe.js
import plugin from "../../../lib/plugins/plugin.js";
import MajsoulSubscribeCore from '../utils/MajsoulSubscribeCore.js';

export class MajsoulSubscribe extends plugin {
    constructor() {
        // 必须先调用 super()，然后才能访问 this
        super({
            name: '雀魂对局订阅',
            dsc: '订阅雀魂玩家对局，新对局发生时自动播报',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?(雀魂|四麻)订阅\\s+(.+)$',
                    fnc: 'subscribePlayer',
                    permission: 'group'
                },
                {
                    reg: '^#?(关闭|取消)(雀魂|四麻)订阅\\s+(.+)$',
                    fnc: 'deactivateSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?开启(雀魂|四麻)订阅\\s+(.+)$',
                    fnc: 'activateSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?删除(雀魂|四麻)订阅\\s+(.+)$',
                    fnc: 'deleteSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?(雀魂|四麻)订阅状态$',
                    fnc: 'checkSubscribeStatus',
                    permission: 'group'
                },
                // 三麻指令
                {
                    reg: '^#?三麻订阅\\s+(.+)$',
                    fnc: 'subscribeTriPlayer',
                    permission: 'group'
                },
                {
                    reg: '^#?(关闭|取消)三麻订阅\\s+(.+)$',
                    fnc: 'deactivateTriSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?开启三麻订阅\\s+(.+)$',
                    fnc: 'activateTriSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?删除三麻订阅\\s+(.+)$',
                    fnc: 'deleteTriSubscribe',
                    permission: 'group'
                },
                {
                    reg: '^#?三麻订阅状态$',
                    fnc: 'checkTriSubscribeStatus',
                    permission: 'group'
                },
            ]
        });
        
        // 现在可以安全地初始化 this.core
        this.core = new MajsoulSubscribeCore();
    }
    
    // 四麻订阅
    async subscribePlayer(e) {
        const match = e.msg.match(/^#?(雀魂|四麻)订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[2].trim();
        return await this.processSubscribe(e, nickname, 4);
    }
    
    // 三麻订阅
    async subscribeTriPlayer(e) {
        const match = e.msg.match(/^#?三麻订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[1].trim();
        return await this.processSubscribe(e, nickname, 3);
    }
    
    // 通用的订阅处理逻辑
    async processSubscribe(e, nickname, mode = 4) {
        const modeName = mode === 4 ? '四麻' : '三麻';
        
        // 1. 搜索玩家
        const searchResult = await this.core.searchPlayerForSubscribe(nickname, mode);
        if (!searchResult.success) {
            await e.reply(searchResult.message);
            return true;
        }
        
        // 2. 添加订阅
        const subscribeResult = await this.core.addSubscription(
            e.group_id, 
            searchResult.playerId, 
            searchResult.nickname,
            mode
        );
        
        await e.reply(subscribeResult.message);
        
        // 3. 如果有多个匹配结果，提示用户
        if (searchResult.allMatches && searchResult.allMatches.length > 1) {
            let tip = `\n⚠️ 提示：共找到 ${searchResult.allMatches.length} 个相似昵称，已订阅第一个：\n`;
            searchResult.allMatches.slice(0, 3).forEach((p, i) => {
                tip += `${i+1}. ${p.nickname} (ID:${p.id})\n`;
            });
            if (searchResult.allMatches.length > 3) tip += `...等${searchResult.allMatches.length}个结果`;
            tip += `\n如需订阅其他玩家，请补全昵称后重试。`;
            await e.reply(tip);
        }
        
        return true;
    }
    
    // 关闭订阅 (record_on = false)
    async deactivateSubscribe(e) {
        const match = e.msg.match(/^#?(关闭|取消)(雀魂|四麻)订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[3].trim();
        return await this.processToggleSubscribe(e, nickname, 4, false);
    }
    
    async deactivateTriSubscribe(e) {
        const match = e.msg.match(/^#?(关闭|取消)三麻订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[2].trim();
        return await this.processToggleSubscribe(e, nickname, 3, false);
    }
    
    // 开启订阅 (record_on = true)
    async activateSubscribe(e) {
        const match = e.msg.match(/^#?开启(雀魂|四麻)订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[2].trim();
        return await this.processToggleSubscribe(e, nickname, 4, true);
    }
    
    async activateTriSubscribe(e) {
        const match = e.msg.match(/^#?开启三麻订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[1].trim();
        return await this.processToggleSubscribe(e, nickname, 3, true);
    }
    
    // 通用的开启/关闭逻辑
    async processToggleSubscribe(e, nickname, mode, setActive) {
        // 1. 搜索玩家
        const searchResult = await this.core.searchPlayerForSubscribe(nickname, mode);
        if (!searchResult.success) {
            await e.reply(searchResult.message);
            return true;
        }
        
        // 2. 切换订阅状态
        const toggleResult = await this.core.toggleSubscription(
            e.group_id,
            searchResult.playerId,
            setActive,
            mode
        );
        
        await e.reply(toggleResult.message);
        return true;
    }
    
    // 删除订阅 (从列表中移除)
    async deleteSubscribe(e) {
        const match = e.msg.match(/^#?删除(雀魂|四麻)订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[2].trim();
        return await this.processDeleteSubscribe(e, nickname, 4);
    }
    
    async deleteTriSubscribe(e) {
        const match = e.msg.match(/^#?删除三麻订阅\s+(.+)$/);
        if (!match) return false;
        const nickname = match[1].trim();
        return await this.processDeleteSubscribe(e, nickname, 3);
    }
    
    async processDeleteSubscribe(e, nickname, mode) {
        // 1. 搜索玩家
        const searchResult = await this.core.searchPlayerForSubscribe(nickname, mode);
        if (!searchResult.success) {
            await e.reply(searchResult.message);
            return true;
        }
        
        // 2. 删除订阅
        const deleteResult = await this.core.removeSubscription(
            e.group_id,
            searchResult.playerId,
            mode
        );
        
        await e.reply(deleteResult.message);
        return true;
    }
    
    // 查看订阅状态
    async checkSubscribeStatus(e) {
        const result = await this.core.getGroupSubscriptions(e.group_id, 4);
        await e.reply(result.message);
        return true;
    }
    
    async checkTriSubscribeStatus(e) {
        const result = await this.core.getGroupSubscriptions(e.group_id, 3);
        await e.reply(result.message);
        return true;
    }
    
    // 添加 handle 方法用于指令路由
    async handle(e) {
        try {
            // 根据正则匹配调用对应的方法
            if (e.msg.match(/^#?(雀魂|四麻)订阅\s+(.+)$/)) {
                return await this.subscribePlayer(e);
            } else if (e.msg.match(/^#?(关闭|取消)(雀魂|四麻)订阅\s+(.+)$/)) {
                return await this.deactivateSubscribe(e);
            } else if (e.msg.match(/^#?开启(雀魂|四麻)订阅\s+(.+)$/)) {
                return await this.activateSubscribe(e);
            } else if (e.msg.match(/^#?删除(雀魂|四麻)订阅\s+(.+)$/)) {
                return await this.deleteSubscribe(e);
            } else if (e.msg.match(/^#?(雀魂|四麻)订阅状态$/)) {
                return await this.checkSubscribeStatus(e);
            } else if (e.msg.match(/^#?三麻订阅\s+(.+)$/)) {
                return await this.subscribeTriPlayer(e);
            } else if (e.msg.match(/^#?(关闭|取消)三麻订阅\s+(.+)$/)) {
                return await this.deactivateTriSubscribe(e);
            } else if (e.msg.match(/^#?开启三麻订阅\s+(.+)$/)) {
                return await this.activateTriSubscribe(e);
            } else if (e.msg.match(/^#?删除三麻订阅\s+(.+)$/)) {
                return await this.deleteTriSubscribe(e);
            } else if (e.msg.match(/^#?三麻订阅状态$/)) {
                return await this.checkTriSubscribeStatus(e);
            }
            
            return false;
        } catch (error) {
            console.error(`[MajsoulSubscribe] 处理指令失败: ${error.message}`);
            await e.reply('指令处理失败，请稍后重试');
            return true;
        }
    }
}