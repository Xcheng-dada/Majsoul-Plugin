// plugins/Majsoul-Plugin/apps/MajsoulRecords.js
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import { createCanvas } from '@napi-rs/canvas';
import { loadResImage, drawText, drawRoundRect, drawPartialRoundRect } from '../components/canvas.js';
import { getRankImg } from '../components/render.js';
import MajsoulApi from '../utils/MajsoulApi.js';
import { PlayerLevel, ROOM_LEVEL_MAP_3P, ROOM_LEVEL_MAP_4P } from '../utils/PlayerLevel.js';

// 段位房筛选：关键词 -> { name(显示名), ids: { 4:[四麻modeId], 3:[三麻modeId] }, aliases(模糊匹配词) }
// modeId 取自 utils/PlayerLevel.js 的 ROOM_LEVEL_MAP
export const ROOM_FILTERS = {
  '铜之间': { name: '铜之间', ids: { 4: [2, 3], 3: [17, 18] }, aliases: ['铜之间', '铜间', '铜'] },
  '银之间': { name: '银之间', ids: { 4: [5, 6], 3: [19, 20] }, aliases: ['银之间', '银间', '银'] },
  '金之间': { name: '金之间', ids: { 4: [8, 9], 3: [21, 22] }, aliases: ['金之间', '金间', '金'] },
  '玉之间': { name: '玉之间', ids: { 4: [11, 12], 3: [23, 24] }, aliases: ['玉之间', '玉间', '玉'] },
  '王座间': { name: '王座间', ids: { 4: [15, 16], 3: [25, 26] }, aliases: ['王座之间', '王座间', '王座'] },
};

// 在文本中模糊匹配段位房（支持别名：金/金间/金之间、玉/玉间/玉之间、王座/王座间/王座之间 等）
// 返回 { roomFilter, matched }；matched 为实际命中的别名，用于从昵称中剔除
// 注意：铜之间/银之间定义保留以备后续牌谱屋支持，但当前受 API 限制不允许作为查询筛选条件
// 仅禁用段位筛选匹配，玩家昵称中若本身含有“铜”/“银”字样不受影响，不会被过滤或剔除
const DISABLED_ROOM_FILTERS = new Set(['铜之间', '银之间']);
export function matchRoomFilter(text) {
  for (const rf of Object.values(ROOM_FILTERS)) {
    // 跳过当前禁用的段位（铜/银之间）
    if (DISABLED_ROOM_FILTERS.has(rf.name)) continue;
    // 单房间内按别名长度降序匹配，优先命中更完整的词（如 “金之间” 优先于 “金”）
    for (const alias of rf.aliases.slice().sort((a, b) => b.length - a.length)) {
      if (text.includes(alias)) {
        return { roomFilter: rf, matched: alias };
      }
    }
  }
  return { roomFilter: null, matched: null };
}

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
        this.redisPrefix = 'majsoul:user:';
    }
    
    /**
     * 统一的指令处理方法
     * @param {object} e - 事件对象
     * @returns {Promise<boolean>}
     */
    async handle(e) {
        try {
            const msg = e.msg;
            let playerName, mode, fromBinding = false;
            
            // 识别指令前缀，确定模式（三麻/四麻），默认四麻
            const prefixMatch = msg.match(/^#?(雀魂对局|雀魂牌谱|雀魂最近对局|四麻对局|三麻对局)/);
            if (!prefixMatch) return false;
            const cmd = prefixMatch[1];
            mode = (cmd === '三麻对局') ? 3 : 4;

            // 提取剩余参数（昵称 + 可选的段位房筛选词，如 “金之间”）
            let argsStr = msg.slice(prefixMatch[0].length).trim();

            // 段位房筛选（模糊别名：金/金间/金之间、玉/玉间/玉之间、王座/王座间/王座之间 等）
            let roomFilter = null;
            const rm = matchRoomFilter(argsStr);
            if (rm.roomFilter) {
                roomFilter = rm.roomFilter;
                argsStr = argsStr.replace(rm.matched, '').trim();
            }

            playerName = argsStr;

            // 如果没有输入昵称，尝试从绑定中获取
            if (!playerName || playerName.length === 0) {
                const qid = String(e.user_id);
                const boundUid = await this.getMainUid(qid);
                
                if (!boundUid) {
                    await e.reply('您还没有绑定雀魂UID，请先通过 #雀魂绑定 UID 绑定后才能使用；也可带昵称查询：#雀魂对局 昵称');
                    return true;
                }
                
                playerName = boundUid;
                fromBinding = true;
            }
            
            // 查询对局记录（可附带段位房筛选）
            const result = await this._getRecords(playerName, mode, 5, fromBinding, roomFilter);
            
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
    async _getRecords(playerName, mode = 4, limit = 5, isUid = false, roomFilter = null) {
        try {
            if (!this.api.token) {
                return { success: false, message: MajsoulApi.TOKEN_HINT };
            }
            if (!playerName || playerName.trim().length === 0) {
                return { success: false, message: '请输入玩家昵称' };
            }
            
            if (limit < 1) limit = 1;
            if (limit > 20) limit = 20;
            
            const modeName = mode === 4 ? '四麻' : '三麻';
            
            // 步骤1: 搜索玩家
            // isUid=true 表示传入的是绑定UID，直接按ID查询；否则一律按昵称搜索（含纯数字昵称）
            let players;
            if (isUid) {
                const stats = await this.api.getPlayerStats(playerName, mode);
                if (!stats || !stats.nickname) {
                    return { success: false, message: `未找到ID为 ${playerName} 的玩家或API暂时不可用` };
                }
                players = [{ id: parseInt(playerName), nickname: stats.nickname }];
            } else {
                players = await this.api.searchPlayer(playerName.trim(), mode);
                if (!players || players.length === 0) {
                    return { success: false, message: `未找到昵称包含 "${playerName}" 的玩家\n提示：需要在金之间有对局记录才能被搜索到，或API暂时不可用` };
                }
            }
            
            const player = players[0];
            const playerId = player.id;
            
            // 步骤2: 获取最近对局记录（带段位房筛选时多抓一批以保证数量）
            const fetchLimit = roomFilter ? Math.min(Math.max(limit * 4, 20), 20) : limit;
            let records = await this.api.getRecentRecords(playerId, mode, fetchLimit);

            const roomLabel = roomFilter ? roomFilter.name : '';

            // 按段位房筛选（金之间/玉之间/王座间等）
            if (roomFilter) {
                const ids = roomFilter.ids[mode] || [];
                let filtered = (records || []).filter(r => ids.includes(r.modeId));
                // 若一次抓取不足 limit 场，再补抓到最多 20 场凑足
                if (filtered.length < limit) {
                    const more = await this.api.getRecentRecords(playerId, mode, 20);
                    const seen = new Set(filtered.map(r => r.uuid || r.startTime));
                    for (const r of (more || [])) {
                        if (ids.includes(r.modeId) && !seen.has(r.uuid || r.startTime)) {
                            filtered.push(r);
                            seen.add(r.uuid || r.startTime);
                        }
                    }
                }
                records = filtered.slice(0, limit);
            }

            if (!records || records.length === 0) {
                return {
                    success: true,
                    message: `${player.nickname} 在${modeName}${roomLabel}暂无对局记录`,
                    records: [],
                    modeName: modeName,
                    roomName: roomLabel,
                    playerName: player.nickname
                };
            }
            
            // 步骤3: 构建图片数据
            const imageData = this._buildImageData(player.nickname, modeName, records, playerId);
            
            // 构建文字消息（备用）
            let message = `📊 ${player.nickname} 的${modeName}${roomLabel ? roomLabel + ' ' : ''}最近${records.length}场对局\n\n`;
            
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                const sortedPlayers = [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0));
                
                message += `【第${i + 1}局】\n`;
                
                for (let j = 0; j < sortedPlayers.length; j++) {
                    const p = sortedPlayers[j];
                    const isTarget = p.accountId === playerId || p.id === playerId;
                    const ptChange = p.gradingScore || p.delta || 0;
                    const ptSign = ptChange > 0 ? '+' : '';
                    const level = new PlayerLevel(p.level || 0, 0);
                    
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
                modeName: modeName,
                roomName: roomLabel
            };
            
        } catch (error) {
            logger.error(`[MajsoulRecords] 查询对局失败: ${error.message}`);
            return { 
                success: false, 
                message: `查询对局时出现错误：${error.message}\n请稍后重试` 
            };
        }
    }
    
    _buildImageData(playerName, modeName, records, playerId) {
        return records.map((record, index) => {
            const sortedPlayers = [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0));
            
            const players = sortedPlayers.map((p, j) => {
                const isTarget = p.accountId === playerId || p.id === playerId;
                const ptChange = p.gradingScore || p.delta || 0;
                const level = new PlayerLevel(p.level || 0, 0);
                
                return {
                    rank: j + 1,
                    nickname: p.nickname,
                    level: level.getTag(),
                    majorRank: level.major_rank,
                    minorRank: level.minor_rank,
                    score: p.score || 0,
                    pt: ptChange,
                    ptText: ptChange === 0 ? '±0' : (ptChange > 0 ? `+${ptChange}` : ptChange.toString()),
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
    
    async _drawRankIcon(ctx, majorRank, mode, x, y, size = 40) {
        try {
            const rankIcon = await loadResImage(`info_texture/${majorRank}_${mode}.png`);
            ctx.drawImage(rankIcon, x, y, size, size);
        } catch(e) {}
    }

    async _generateImage(result) {
        const { playerName, modeName, records, roomName = '' } = result;
        const mode = modeName === '四麻' ? '4' : '3';
        
        const CARD_WIDTH = 720;
        const PADDING = 16;
        const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
        const CARD_HEADER_HEIGHT = 60;
        const TABLE_HEADER_HEIGHT = 36;
        const PLAYER_ROW_HEIGHT = 56;
        const CARD_GAP = 16;
        const HEADER_CARD_GAP = 0;
        const FOOTER_HEIGHT = 30;
        
        const LEVEL_COL_CENTER = PADDING + 475;
        const LEVEL_ICON_SIZE = 40;
        const LEVEL_TEXT_OFFSET = LEVEL_ICON_SIZE + 8;
        
        const COL_X = {
            rank: PADDING + 30,
            name: PADDING + 100,
            level: LEVEL_COL_CENTER,
            score: PADDING + 590,
            pt: PADDING + 650
        };
        
        let titleImage = null;
        let HEADER_HEIGHT = 80;
        try {
            titleImage = await loadResImage('info_texture/title.png');
            const titleScale = CARD_WIDTH / titleImage.width;
            const titleHeight = titleImage.height * titleScale;
            const CROP_BOTTOM = 14;
            HEADER_HEIGHT = titleHeight - CROP_BOTTOM;
        } catch(e) {}
        
        const totalHeight = HEADER_HEIGHT + HEADER_CARD_GAP +
            records.reduce((sum, record) => sum + CARD_HEADER_HEIGHT + TABLE_HEADER_HEIGHT + record.players.length * PLAYER_ROW_HEIGHT, 0) + 
            (records.length - 1) * CARD_GAP + FOOTER_HEIGHT;
        
        const canvas = createCanvas(CARD_WIDTH, totalHeight);
        const ctx = canvas.getContext('2d');
        
        try {
            const bgImage = await loadResImage('bg.jpg');
            const scale = Math.max(CARD_WIDTH / bgImage.width, totalHeight / bgImage.height);
            const x = (CARD_WIDTH - bgImage.width * scale) / 2;
            const y = (totalHeight - bgImage.height * scale) / 2;
            ctx.drawImage(bgImage, x, y, bgImage.width * scale, bgImage.height * scale);
        } catch(e) {
            ctx.fillStyle = '#0d1117';
            ctx.fillRect(0, 0, CARD_WIDTH, totalHeight);
        }
        
        if (titleImage) {
            const titleWidth = CARD_WIDTH;
            const titleScale = titleWidth / titleImage.width;
            const titleHeight = titleImage.height * titleScale;
            ctx.drawImage(titleImage, 0, 0, titleWidth, titleHeight);
            drawText(ctx, `${playerName}的最近${records.length}场${modeName}${roomName}对局`, CARD_WIDTH / 2, HEADER_HEIGHT - 70, 20, '#ffffff', 'center', 'bold');
        } else {
            drawText(ctx, `${playerName} 的${modeName}${roomName}对局记录`, CARD_WIDTH / 2, HEADER_HEIGHT / 2 - 10, 28, '#ffd700', 'center', 'bold');
            drawText(ctx, `最近 ${records.length} 场对局`, CARD_WIDTH / 2, HEADER_HEIGHT / 2 + 15, 14, '#6e7681', 'center');
        }
        
        let currentY = HEADER_HEIGHT + HEADER_CARD_GAP;
        
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const cardHeight = CARD_HEADER_HEIGHT + TABLE_HEADER_HEIGHT + record.players.length * PLAYER_ROW_HEIGHT;
            
            drawRoundRect(ctx, PADDING, currentY, CONTENT_WIDTH, cardHeight, 12, '#1c2128');
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#30363d';
            ctx.stroke();
            
            const headerGradient = ctx.createLinearGradient(PADDING, currentY, CARD_WIDTH - PADDING, currentY + CARD_HEADER_HEIGHT);
            headerGradient.addColorStop(0, '#1e3a5f');
            headerGradient.addColorStop(1, '#0d1b2a');
            ctx.fillStyle = headerGradient;
            
            ctx.save();
            drawPartialRoundRect(ctx, PADDING + 1, currentY + 1, CONTENT_WIDTH - 2, CARD_HEADER_HEIGHT - 2, 11, true, true, false, false, null);
            ctx.clip();
            ctx.fillRect(PADDING + 1, currentY + 1, CONTENT_WIDTH - 2, CARD_HEADER_HEIGHT - 2);
            ctx.restore();
            
            drawRoundRect(ctx, PADDING + 20, currentY + 15, 60, 30, 4, '#ffd700');
            ctx.fillStyle = '#1a1a2e';
            ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('段位场', PADDING + 50, currentY + 30);
            
            drawText(ctx, record.roomName, PADDING + 100, currentY + 30, 14, '#e6edf3', 'left', '500');
            
            drawText(ctx, record.startTime, CARD_WIDTH - PADDING - 20, currentY + 22, 11, '#8b949e', 'right');
            drawText(ctx, record.endTime, CARD_WIDTH - PADDING - 20, currentY + 38, 11, '#58a6ff', 'right');
            
            currentY += CARD_HEADER_HEIGHT;
            
            ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
            
            ctx.fillRect(PADDING, currentY, CONTENT_WIDTH, TABLE_HEADER_HEIGHT);
            
            drawText(ctx, '排名', COL_X.rank, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
            drawText(ctx, '参赛玩家', COL_X.name, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'left', '500');
            drawText(ctx, '段位', LEVEL_COL_CENTER + 20, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
            drawText(ctx, '点数', COL_X.score, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
            drawText(ctx, 'PT', COL_X.pt, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
            
            currentY += TABLE_HEADER_HEIGHT;
            
            for (const player of record.players) {
                if (player.isTarget) {
                    ctx.fillStyle = 'rgba(255, 215, 0, 0.06)';
                    ctx.fillRect(PADDING, currentY, CONTENT_WIDTH, PLAYER_ROW_HEIGHT);
                    
                    ctx.fillStyle = '#ffd700';
                    ctx.fillRect(PADDING, currentY + 4, 3, PLAYER_ROW_HEIGHT - 8);
                }
                
                const rankColors = {
                    1: ['#ffd700', '#ffaa00'],
                    2: ['#c0c0c0', '#a0a0a0'],
                    3: ['#cd7f32', '#b87333'],
                    4: ['#4a5568', '#2d3748']
                };
                const rc = rankColors[player.rank] || rankColors[4];
                const rankGradient = ctx.createRadialGradient(COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 0, COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 14);
                rankGradient.addColorStop(0, rc[0]);
                rankGradient.addColorStop(1, rc[1]);
                drawRoundRect(ctx, COL_X.rank - 14, currentY + PLAYER_ROW_HEIGHT / 2 - 14, 28, 28, 14, rankGradient);
                
                drawText(ctx, player.rank.toString(), COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 13, '#ffffff', 'center', 'bold');
                
                drawText(ctx, player.nickname, COL_X.name, currentY + PLAYER_ROW_HEIGHT / 2, 13, '#e6edf3', 'left', '500');
                
                const LEVEL_IMG_SIZE = 46;
                let levelImg = null;
                try {
                    levelImg = await getRankImg(player.majorRank, player.minorRank, mode, LEVEL_IMG_SIZE, 0);
                } catch (e) {}
                if (levelImg) {
                    ctx.drawImage(levelImg, LEVEL_COL_CENTER - LEVEL_IMG_SIZE / 2, currentY + (PLAYER_ROW_HEIGHT - LEVEL_IMG_SIZE) / 2);
                    drawText(ctx, player.level, LEVEL_COL_CENTER + LEVEL_TEXT_OFFSET / 2, currentY + PLAYER_ROW_HEIGHT / 2, 12, '#e6edf3', 'left', '500');
                } else {
                    drawText(ctx, player.level, LEVEL_COL_CENTER, currentY + PLAYER_ROW_HEIGHT / 2, 12, '#e6edf3', 'center', '500');
                }
                
                drawText(ctx, player.score.toString(), COL_X.score, currentY + PLAYER_ROW_HEIGHT / 2, 14, '#e6edf3', 'center', 'bold');
                
                let ptColor = '#6e7681';
                if (player.pt > 0) ptColor = '#3fb950';
                else if (player.pt < 0) ptColor = '#f85149';
                drawText(ctx, player.ptText, COL_X.pt, currentY + PLAYER_ROW_HEIGHT / 2, 12, ptColor, 'center', '500');
                
                currentY += PLAYER_ROW_HEIGHT;
            }
            
            if (i < records.length - 1) {
                currentY += CARD_GAP;
            }
        }
        
        drawText(ctx, 'Majsoul-Plugin by 小橙c | Data: amae-koromo', CARD_WIDTH / 2, totalHeight - 12, 12, '#ffffff', 'center', 'bold');
        
        return canvas.toBuffer('image/png');
    }
    
    /**
     * 获取用户绑定的主UID（从Redis获取）
     * @param {string} qid - 用户QQ号
     * @returns {Promise<string|null>} - 主UID或null
     */
    async getMainUid(qid) {
        try {
            // 确保 redis 对象可用（Yunzai 框架全局对象）
            if (typeof redis === 'undefined') {
                console.error('[MajsoulRecords] redis 对象未定义！');
                return null;
            }
            
            // 1. 尝试获取设置的主UID
            let mainUid = await redis.get(`${this.redisPrefix}${qid}:main`);
            
            if (mainUid) {
                return mainUid;
            }
            
            // 2. 如果没有设置main键，尝试获取第一个绑定作为默认主账号
            const key = `${this.redisPrefix}${qid}:bindings`;
            const bindingsStr = await redis.get(key);
            const bindings = bindingsStr ? JSON.parse(bindingsStr) : [];
            
            if (bindings.length > 0) {
                return bindings[0];
            }
            
            return null;
            
        } catch (error) {
            console.error('[MajsoulRecords] 获取主绑定UID失败:', error);
            return null;
        }
    }
}
