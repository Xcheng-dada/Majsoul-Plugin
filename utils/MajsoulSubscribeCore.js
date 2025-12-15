// plugins/Majsoul-Plugin/utils/MajsoulSubscribeCore.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import MajsoulApi from './MajsoulApi.js';

// 获取当前文件所在目录，用于构建绝对路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data/subscribe');
const FILE_4P = path.join(DATA_DIR, 'account_4p.json');
const FILE_3P = path.join(DATA_DIR, 'account_3p.json');

// 房间等级映射
const ROOM_LEVEL_MAP = {
    8: "金之间 四人东", 9: "金之间 四人南",
    11: "玉之间 四人东", 12: "玉之间 四人南",
    15: "王座之间 四人东", 16: "王座之间 四人南",
    21: "金之间 三人东", 22: "金之间 三人南",
    23: "玉之间 三人东", 24: "玉之间 三人南",
    25: "王座之间 三人东", 26: "王座之间 三人南"
};

// 工具函数：格式化时间戳
function formatTime(timestamp) {
    if (!timestamp) return '未知时间';
    return new Date(timestamp * 1000).toLocaleString('zh-CN');
}

export default class MajsoulSubscribeCore {
    constructor() {
        this.api = new MajsoulApi();
        // 使用全局 logger 或 console
        this._logger = global.logger || console;
        
        // 初始化数据目录
        this._initialize();
    }
    
    // 初始化方法
    async _initialize() {
        try {
            await this._ensureDataDir();
            this._logger.info(`[MajsoulSubscribeCore] 初始化完成`);
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 初始化失败: ${error.message}`);
        }
    }
    
    // 确保数据目录存在
    async _ensureDataDir() {
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            this._logger.debug(`[MajsoulSubscribeCore] 数据目录: ${DATA_DIR}`);
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 创建数据目录失败: ${error.message}`);
            throw error;
        }
    }
    
    // 加载订阅数据
    async _loadSubscriptions(mode = 4) {
        const file = mode === 4 ? FILE_4P : FILE_3P;
        try {
            const data = await fs.readFile(file, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            // 文件不存在或读取错误，返回空数组
            if (error.code !== 'ENOENT') {
                this._logger.error(`[MajsoulSubscribeCore] 读取订阅文件失败: ${error.message}`);
            }
            return [];
        }
    }
    
    // 保存订阅数据
    async _saveSubscriptions(data, mode = 4) {
        const file = mode === 4 ? FILE_4P : FILE_3P;
        try {
            await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 保存订阅文件失败: ${error.message}`);
            throw error;
        }
    }
    
    // ---------- 公开的业务方法 ----------
    
    // 1. 搜索玩家并返回首个结果ID
    async searchPlayerForSubscribe(nickname, mode = 4) {
        try {
            // 检查昵称长度
            if (nickname.length > 15) {
                return { success: false, message: '昵称长度超过雀魂最大限制' };
            }
            
            this._logger.info(`[MajsoulSubscribeCore] 搜索玩家: ${nickname}, mode: ${mode}`);
            
            const players = await this.api.searchPlayer(nickname, mode);
            if (!players || players.length === 0) {
                return { success: false, message: '未找到该昵称的玩家，请确认昵称是否正确且该玩家在金之间以上有过对局。' };
            }
            
            // 返回第一个匹配的玩家
            return {
                success: true,
                playerId: players[0].id,
                nickname: players[0].nickname,
                allMatches: players
            };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 搜索玩家失败: ${error.message}`);
            return { success: false, message: '搜索玩家时网络出错，请稍后重试。' };
        }
    }
    
    // 2. 添加订阅
    async addSubscription(groupId, playerId, playerNickname, mode = 4) {
        try {
            const subscriptions = await this._loadSubscriptions(mode);
            
            // 检查是否已存在相同群和玩家的订阅
            const exists = subscriptions.find(s => s.gid == groupId && s.id == playerId);
            if (exists) {
                return { success: false, message: `玩家「${playerNickname}」在本群已被订阅。` };
            }
            
            // 获取该玩家的最新一场对局，作为初始记录
            this._logger.info(`[MajsoulSubscribeCore] 获取玩家 ${playerNickname} 的对局记录...`);
            const records = await this.api.getPlayerRecords(playerId, mode);
            
            if (!records || records.length === 0) {
                return { success: false, message: '无法获取该玩家的对局记录，订阅失败。' };
            }
            
            const latestRecord = records[0];
            
            // 调试：打印获取到的记录信息
            this._logger.debug(`[MajsoulSubscribeCore] 获取到记录: uuid=${latestRecord.uuid}, endTime=${latestRecord.endTime}`);
            
            const newSubscription = {
                id: playerId,
                uuid: latestRecord.uuid || '',
                endTime: latestRecord.endTime || Date.now() / 1000,
                gid: String(groupId),
                record_on: true,
                nickname: playerNickname
            };
            
            subscriptions.push(newSubscription);
            await this._saveSubscriptions(subscriptions, mode);
            
            this._logger.info(`[MajsoulSubscribeCore] 成功添加订阅: 群${groupId}, 玩家${playerNickname}(${playerId})`);
            
            return { 
                success: true, 
                message: `✅ 成功订阅玩家「${playerNickname}」的${mode === 4 ? '四麻' : '三麻'}对局。`,
                data: newSubscription
            };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 添加订阅失败: ${error.message}`);
            return { success: false, message: '订阅过程中出现错误。' };
        }
    }
    
    // 3. 取消/开启订阅
    async toggleSubscription(groupId, playerId, setActive, mode = 4) {
        try {
            const subscriptions = await this._loadSubscriptions(mode);
            const target = subscriptions.find(s => s.gid == groupId && s.id == playerId);
            
            if (!target) {
                return { success: false, message: '未找到该玩家在本群的订阅记录。' };
            }
            
            target.record_on = setActive;
            await this._saveSubscriptions(subscriptions, mode);
            
            const status = setActive ? '开启' : '关闭';
            const modeName = mode === 4 ? '四麻' : '三麻';
            
            this._logger.info(`[MajsoulSubscribeCore] ${status}订阅: 群${groupId}, 玩家${target.nickname || target.id}`);
            
            return { 
                success: true, 
                message: `✅ 已${status}玩家「${target.nickname || target.id}」的${modeName}订阅。`
            };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 切换订阅状态失败: ${error.message}`);
            return { success: false, message: '操作失败，请稍后重试。' };
        }
    }
    
    // 4. 删除订阅
    async removeSubscription(groupId, playerId, mode = 4) {
        try {
            const subscriptions = await this._loadSubscriptions(mode);
            const initialLength = subscriptions.length;
            
            const filtered = subscriptions.filter(s => !(s.gid == groupId && s.id == playerId));
            
            if (filtered.length === initialLength) {
                return { success: false, message: '未找到该玩家在本群的订阅记录。' };
            }
            
            await this._saveSubscriptions(filtered, mode);
            
            this._logger.info(`[MajsoulSubscribeCore] 删除订阅: 群${groupId}, 玩家${playerId}`);
            
            return { success: true, message: '✅ 已删除该玩家的订阅。' };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 删除订阅失败: ${error.message}`);
            return { success: false, message: '删除失败，请稍后重试。' };
        }
    }
    
    // 5. 查询群内订阅状态
    async getGroupSubscriptions(groupId, mode = 4) {
        try {
            const allSubs = await this._loadSubscriptions(mode);
            const groupSubs = allSubs.filter(s => s.gid == groupId);
            
            if (groupSubs.length === 0) {
                return { success: false, message: `本群暂无${mode === 4 ? '四麻' : '三麻'}对局订阅。` };
            }
            
            let message = `📋 本群${mode === 4 ? '四麻' : '三麻'}订阅状态 (共${groupSubs.length}个):\n`;
            
            for (let i = 0; i < groupSubs.length; i++) {
                const sub = groupSubs[i];
                const status = sub.record_on ? '🔔 开启' : '🔕 关闭';
                const nickname = sub.nickname || (await this.getNicknameById(sub.id, mode)) || `ID:${sub.id}`;
                message += `${i + 1}. ${nickname} (${sub.id}) - ${status}\n`;
            }
            
            message += '\n提示: 使用 #关闭雀魂订阅 [昵称] 可临时关闭播报。';
            
            return { success: true, message };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 查询订阅状态失败: ${error.message}`);
            return { success: false, message: '查询失败，请稍后重试。' };
        }
    }
    
    // 6. 定时任务：检查所有订阅的更新
    async checkAllSubscriptions() {
        const updates = [];
        
        // 检查四麻和三麻
        for (const mode of [4, 3]) {
            try {
                const subscriptions = await this._loadSubscriptions(mode);
                
                if (subscriptions.length === 0) {
                    continue;
                }
                
                this._logger.debug(`[MajsoulSubscribeCore] 检查${mode === 4 ? '四麻' : '三麻'}订阅，共${subscriptions.length}个`);
                
                for (const sub of subscriptions) {
                    if (!sub.record_on) continue;
                    
                    try {
                        // 获取该玩家最新的一场对局
                        this._logger.debug(`[MajsoulSubscribeCore] 检查玩家 ${sub.nickname || sub.id} 的更新...`);
                        const records = await this.api.getPlayerRecords(sub.id, mode);
                        
                        if (!records || records.length === 0) {
                            this._logger.debug(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 无对局记录`);
                            continue;
                        }
                        
                        const latestRecord = records[0];
                        
                        // 通过比对 endTime 判断是否为新对局
                        if (latestRecord.endTime > sub.endTime) {
                            this._logger.info(`[MajsoulSubscribeCore] 发现新对局: ${sub.nickname || sub.id}, 新endTime: ${latestRecord.endTime}, 旧endTime: ${sub.endTime}`);
                            
                            // 生成播报消息
                            const roomName = ROOM_LEVEL_MAP[latestRecord.modeId] || `未知房间(${latestRecord.modeId})`;
                            let msg = `🆕 ${mode === 4 ? '四麻' : '三麻'}对局播报\n`;
                            msg += `玩家: ${sub.nickname || sub.id}\n`;
                            msg += `房间: ${roomName}\n`;
                            msg += `牌谱: ${latestRecord.uuid}\n`;
                            msg += `时间: ${formatTime(latestRecord.endTime)}\n`;
                            msg += `得分: `;
                            
                            // 确保players存在
                            if (latestRecord.players && Array.isArray(latestRecord.players)) {
                                latestRecord.players.forEach((p, i) => {
                                    const prefix = p.score > 0 ? '+' : '';
                                    msg += `${p.nickname || `玩家${i+1}`}(${prefix}${p.score}) `;
                                });
                            } else {
                                msg += '玩家信息获取失败';
                            }
                            
                            updates.push({
                                groupId: sub.gid,
                                message: msg
                            });
                            
                            // 更新本地存储的记录
                            sub.uuid = latestRecord.uuid || sub.uuid;
                            sub.endTime = latestRecord.endTime || sub.endTime;
                            
                            this._logger.info(`[MajsoulSubscribeCore] 更新玩家 ${sub.nickname || sub.id} 的记录`);
                        }
                    } catch (error) {
                        this._logger.error(`[MajsoulSubscribeCore] 检查玩家 ${sub.id} 更新失败: ${error.message}`);
                        continue;
                    }
                }
                
                // 保存本轮检查后的状态（如果有更新）
                if (updates.length > 0) {
                    await this._saveSubscriptions(subscriptions, mode);
                }
            } catch (error) {
                this._logger.error(`[MajsoulSubscribeCore] 检查${mode === 4 ? '四麻' : '三麻'}订阅失败: ${error.message}`);
            }
        }
        
        this._logger.info(`[MajsoulSubscribeCore] 检查完成，发现 ${updates.length} 个更新`);
        return updates;
    }
    
    // 7. 根据ID获取玩家当前昵称
    async getNicknameById(playerId, mode = 4) {
        try {
            // 这里可以调用一个从ID反查昵称的API，或者用searchPlayer近似实现
            // 注意：此功能依赖牌谱屋是否有对应接口，可能需要调整
            const players = await this.api.searchPlayer(`id:${playerId}`, mode);
            if (players && players.length > 0) {
                return players[0].nickname;
            }
            return null;
        } catch (error) {
            this._logger.debug(`[MajsoulSubscribeCore] 获取昵称失败: ${error.message}`);
            return null;
        }
    }
    
    // 8. 获取所有订阅（用于调试）
    async getAllSubscriptions(mode = 4) {
        return await this._loadSubscriptions(mode);
    }
    
    // 9. 清空所有订阅（用于调试/重置）
    async clearAllSubscriptions(mode = 4) {
        try {
            await this._saveSubscriptions([], mode);
            return true;
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 清空订阅失败: ${error.message}`);
            return false;
        }
    }
}