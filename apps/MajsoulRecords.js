// plugins/Majsoul-Plugin/apps/MajsoulRecords.js
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import MajsoulApi from '../utils/MajsoulApi.js';
import PlayerLevel, { ROOM_LEVEL_MAP_3P, ROOM_LEVEL_MAP_4P } from '../utils/PlayerLevel.js';
import Renderer from '../../../lib/renderer/loader.js';

export class MajsoulRecords extends plugin {
    constructor() {
        super({
            name: '雀魂对局查询',
            dsc: '查询雀魂玩家最近对局记录',
            event: 'message',
            priority: 500,
            rule: []
        });
        
        this.api = new MajsoulApi();
        this.renderer = null;
    }
    
    /**
     * 初始化渲染器
     */
    async initRenderer() {
        if (!this.renderer) {
            this.renderer = await Renderer.getRenderer();
        }
        return this.renderer;
    }
    
    /**
     * 统一的指令处理方法
     * @param {object} e - 事件对象
     * @returns {Promise<boolean>}
     */
    async handle(e) {
        try {
            const msg = e.msg;
            let playerName, mode;
            
            // 四麻对局查询 - 雀魂对局/雀魂牌谱/雀魂最近对局
            let match = msg.match(/^#?(雀魂对局|雀魂牌谱|雀魂最近对局)\s+(.+)$/);
            if (match) {
                playerName = match[2].trim();
                mode = 4;
            }
            
            // 四麻对局查询 - 四麻对局
            if (!playerName) {
                match = msg.match(/^#?四麻对局\s+(.+)$/);
                if (match) {
                    playerName = match[1].trim();
                    mode = 4;
                }
            }
            
            // 三麻对局查询
            if (!playerName) {
                match = msg.match(/^#?三麻对局\s+(.+)$/);
                if (match) {
                    playerName = match[1].trim();
                    mode = 3;
                }
            }
            
            if (!playerName) {
                return false;
            }
            
            // 查询对局记录
            const result = await this._getRecords(playerName, mode, 5);
            
            if (!result.success) {
                await e.reply(result.message);
                return true;
            }
            
            // 如果没有记录，直接回复文字
            if (!result.records || result.records.length === 0) {
                await e.reply(result.message);
                return true;
            }
            
            // 生成图片并回复
            try {
                const img = await this._generateImage(result);
                if (img) {
                    await e.reply(segment.image(img));
                } else {
                    // 如果图片生成失败，回退到文字模式
                    await e.reply(result.message);
                }
            } catch (imgError) {
                logger.error('[MajsoulRecords] 生成图片失败:', imgError);
                await e.reply(result.message);
            }
            
            return true;
        } catch (error) {
            logger.error('[MajsoulRecords] 处理指令失败:', error);
            await e.reply('查询对局时出现错误，请稍后重试');
            return true;
        }
    }
    
    /**
     * 编码玩家ID用于生成牌谱链接
     * @param {number} accountId - 玩家账号ID
     * @returns {number} - 编码后的ID
     */
    _encodeAccountId(accountId) {
        return 1358437 + ((7 * accountId + 1117113) ^ 86216345);
    }
    
    /**
     * 生成牌谱链接
     * @param {string} uuid - 对局UUID
     * @param {number} playerId - 玩家ID
     * @returns {string} - 牌谱链接
     */
    _getRecordLink(uuid, playerId) {
        const trailer = `_a${this._encodeAccountId(playerId)}`;
        return `https://game.maj-soul.net/1/?paipu=${uuid}${trailer}`;
    }
    
    /**
     * 格式化时间戳（用于消息输出）
     * @param {number} timestamp - 时间戳（毫秒）
     * @returns {string} - 格式化的时间字符串（包含年份）
     */
    _formatTime(timestamp) {
        try {
            const ts = timestamp.toString().length >= 13 ? timestamp : timestamp * 1000;
            const date = new Date(ts);
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return '未知时间';
        }
    }
    
    /**
     * 获取房间名称
     * @param {number} modeId - 模式ID
     * @param {number} playerCount - 玩家数量（3或4）
     * @returns {string} - 房间名称
     */
    _getRoomName(modeId, playerCount) {
        const roomMap = playerCount === 4 ? ROOM_LEVEL_MAP_4P : ROOM_LEVEL_MAP_3P;
        return roomMap[modeId] || `房间${modeId}`;
    }
    
    /**
     * 查询对局记录（通用方法）
     * @param {string} playerName - 玩家昵称或ID
     * @param {number} mode - 模式（3=三麻，4=四麻）
     * @param {number} limit - 返回数量限制
     * @returns {Promise<{success: boolean, message: string, records?: Array, playerName?: string, modeName?: string}>}
     */
    async _getRecords(playerName, mode = 4, limit = 5) {
        try {
            if (!playerName || playerName.trim().length === 0) {
                return { success: false, message: '请输入玩家昵称' };
            }
            
            if (limit < 1) limit = 1;
            if (limit > 20) limit = 20;
            
            const modeName = mode === 4 ? '四麻' : '三麻';
            
            // 步骤1: 搜索玩家
            let players;
            const isNumeric = /^\d+$/.test(playerName.trim());
            
            if (isNumeric) {
                const stats = await this.api.getPlayerStats(playerName, mode);
                if (!stats || !stats.nickname) {
                    return { success: false, message: `未找到ID为 ${playerName} 的玩家` };
                }
                players = [{ id: parseInt(playerName), nickname: stats.nickname }];
            } else {
                players = await this.api.searchPlayer(playerName.trim(), mode);
                if (!players || players.length === 0) {
                    return { success: false, message: `未找到昵称包含 "${playerName}" 的玩家\n提示：需要在金之间有对局记录才能被搜索到` };
                }
            }
            
            const player = players[0];
            const playerId = player.id;
            
            // 步骤2: 获取对局记录
            const records = await this.api.getRecentRecords(playerId, mode, limit);
            
            if (!records || records.length === 0) {
                return { 
                    success: true, 
                    message: `${player.nickname} 在${modeName}暂无对局记录`,
                    playerName: player.nickname,
                    modeName: modeName,
                    records: []
                };
            }
            
            // 步骤3: 构建图片数据
            const imageData = this._buildImageData(player.nickname, modeName, records, playerId);
            
            // 构建文字消息（备用）
            let message = `📊 ${player.nickname} 的${modeName}最近${records.length}场对局\n\n`;
            
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                const sortedPlayers = [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0));
                
                message += `【第${i + 1}局】\n`;
                
                for (let j = 0; j < sortedPlayers.length; j++) {
                    const p = sortedPlayers[j];
                    const isTarget = p.accountId === playerId || p.id === playerId;
                    const ptChange = p.gradingScore || p.delta || 0;
                    const ptSign = ptChange > 0 ? '+' : '';
                    const level = new PlayerLevel(p.level || 0, p.score || 0);
                    
                    message += `  ${isTarget ? '⭐' : ''}#${j + 1} [${level.getTag()}]${p.nickname}  ${p.score} (${ptSign}${ptChange})\n`;
                }
                
                const roomName = this._getRoomName(record.modeId, mode);
                message += `  🎮 ${roomName}\n`;
                message += `  ⏰ ${this._formatTime(record.startTime)}\n`;
                
                if (record.uuid) {
                    message += `  🔗 ${this._getRecordLink(record.uuid, playerId)}\n`;
                }
                
                message += '\n';
            }
            
            return {
                success: true,
                message: message.trim(),
                records: imageData,
                playerName: player.nickname,
                modeName: modeName
            };
            
        } catch (error) {
            logger.error(`[MajsoulRecords] 查询对局失败: ${error.message}`);
            return { 
                success: false, 
                message: `查询对局时出现错误：${error.message}\n请稍后重试` 
            };
        }
    }
    
    /**
     * 构建图片模板数据
     * @param {string} playerName - 玩家昵称
     * @param {string} modeName - 模式名称
     * @param {Array} records - 对局记录数组
     * @param {number} playerId - 玩家ID
     * @returns {Array} - 格式化后的记录数据
     */
    _buildImageData(playerName, modeName, records, playerId) {
        return records.map((record, index) => {
            // 排序玩家
            const sortedPlayers = [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0));
            
            // 格式化玩家数据
            const players = sortedPlayers.map((p, j) => {
                const isTarget = p.accountId === playerId || p.id === playerId;
                const ptChange = p.gradingScore || p.delta || 0;
                const level = new PlayerLevel(p.level || 0, p.score || 0);
                
                return {
                    rank: j + 1,
                    nickname: p.nickname,
                    level: level.getTag(),
                    score: p.score || 0,
                    pt: ptChange,
                    ptText: ptChange === 0 ? '±0' : (ptChange > 0 ? `+${ptChange}` : ptChange.toString()),
                    ptClass: ptChange > 0 ? 'pt-positive' : (ptChange < 0 ? 'pt-negative' : 'pt-neutral'),
                    isTarget: isTarget
                };
            });
            
            return {
                index: index,
                roomName: this._getRoomName(record.modeId, modeName === '四麻' ? 4 : 3),
                startTime: this._formatTime(record.startTime),
                endTime: this._formatTime(record.endTime),
                link: record.uuid ? this._getRecordLink(record.uuid, playerId) : '',
                players: players
            };
        });
    }
    
    /**
     * 生成图片
     * @param {object} result - 查询结果
     * @returns {Promise<string|Buffer|null>} - 图片路径或Buffer
     */
    async _generateImage(result) {
        const renderer = await this.initRenderer();
        
        const data = {
            playerName: result.playerName,
            modeName: result.modeName,
            totalCount: result.records.length,
            records: result.records
        };
        
        const tplPath = `${process.cwd()}/plugins/Majsoul-Plugin/resources/templates/records.html`;
        
        const img = await renderer.render('majsoul_records', {
            tplFile: tplPath,
            saveId: `records_${Date.now()}`,
            ...data
        });
        
        return img;
    }
}