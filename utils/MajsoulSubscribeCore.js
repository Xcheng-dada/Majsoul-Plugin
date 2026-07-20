// plugins/Majsoul-Plugin/utils/MajsoulSubscribeCore.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import MajsoulApi from './MajsoulApi.js';
import { getRoomName, isThreePlayerMode, PlayerLevel } from './PlayerLevel.js';

async function loadResImage(subPath) {
    const fullPath = path.resolve('./plugins/Majsoul-Plugin/resources', subPath);
    return await loadImage(fullPath);
}

// 获取当前文件所在目录，用于构建绝对路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data/subscribe');
const FILE_4P = path.join(DATA_DIR, 'account_4p.json');
const FILE_3P = path.join(DATA_DIR, 'account_3p.json');

// 工具函数：格式化时间戳
function formatTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
        return new Date(timestamp * 1000).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (error) {
        return '未知时间';
    }
}

// 工具函数：生成牌谱链接
function generatePaipuUrl(uuid) {
    if (!uuid) return '暂无链接';
    return `https://game.maj-soul.net/1/?paipu=${uuid}`;
}

// 工具函数：生成玩家信息字符串
function formatPlayerInfo(player) {
    if (!player) return '未知玩家';
    
    const nickname = player.nickname || player.name || '未知玩家';
    const score = player.score || 0;
    const gradingScore = player.gradingScore || player.delta || 0;
    const prefix = gradingScore > 0 ? '+' : '';
    
    return `${nickname}：${score}（${prefix}${gradingScore}）`;
}

async function generateSubscribeImage(record, targetPlayerId = null) {
    try {
        const mode = isThreePlayerMode(record.modeId) ? '3' : '4';
        const roomName = getRoomName(record.modeId);
        const startTime = formatTime(record.startTime);
        const endTime = formatTime(record.endTime);
        
        const sortedPlayers = record.players && Array.isArray(record.players) 
            ? [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0)) 
            : [];
        
        const CARD_WIDTH = 720;
        const PADDING = 16;
        const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
        const CARD_HEADER_HEIGHT = 60;
        const TABLE_HEADER_HEIGHT = 36;
        const PLAYER_ROW_HEIGHT = 56;
        const FOOTER_HEIGHT = 40;
        
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
        
        const totalHeight = CARD_HEADER_HEIGHT + TABLE_HEADER_HEIGHT + 
            sortedPlayers.length * PLAYER_ROW_HEIGHT + FOOTER_HEIGHT;
        
        const canvas = createCanvas(CARD_WIDTH, totalHeight);
        const ctx = canvas.getContext('2d');
        
        try {
            const bgImage = await loadResImage('utils_texture/bg.jpg');
            const scale = Math.max(CARD_WIDTH / bgImage.width, totalHeight / bgImage.height);
            const x = (CARD_WIDTH - bgImage.width * scale) / 2;
            const y = (totalHeight - bgImage.height * scale) / 2;
            ctx.drawImage(bgImage, x, y, bgImage.width * scale, bgImage.height * scale);
        } catch(e) {
            ctx.fillStyle = '#0d1117';
            ctx.fillRect(0, 0, CARD_WIDTH, totalHeight);
        }
        
        let currentY = 0;
        
        drawRoundRect(ctx, PADDING, currentY, CONTENT_WIDTH, 
            totalHeight - FOOTER_HEIGHT, 12, '#1c2128');
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#30363d';
        ctx.stroke();
        
        const headerGradient = ctx.createLinearGradient(PADDING, currentY, CARD_WIDTH - PADDING, currentY + CARD_HEADER_HEIGHT);
        headerGradient.addColorStop(0, '#1e3a5f');
        headerGradient.addColorStop(1, '#0d1b2a');
        ctx.fillStyle = headerGradient;
        
        ctx.save();
        drawRoundRect(ctx, PADDING + 1, currentY + 1, CONTENT_WIDTH - 2, CARD_HEADER_HEIGHT - 2, 11, null);
        ctx.clip();
        ctx.fillRect(PADDING + 1, currentY + 1, CONTENT_WIDTH - 2, CARD_HEADER_HEIGHT - 2);
        ctx.restore();
        
        drawRoundRect(ctx, PADDING + 20, currentY + 15, 60, 30, 4, '#ffd700');
        ctx.fillStyle = '#1a1a2e';
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('段位场', PADDING + 50, currentY + 30);
        
        drawText(ctx, roomName, PADDING + 100, currentY + 30, 14, '#e6edf3', 'left', '500');
        
        drawText(ctx, startTime, CARD_WIDTH - PADDING - 20, currentY + 22, 11, '#8b949e', 'right');
        drawText(ctx, endTime, CARD_WIDTH - PADDING - 20, currentY + 38, 11, '#58a6ff', 'right');
        
        currentY += CARD_HEADER_HEIGHT;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.save();
        drawRoundRect(ctx, PADDING, currentY, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, 11, null);
        ctx.clip();
        ctx.fillRect(PADDING, currentY, CONTENT_WIDTH, TABLE_HEADER_HEIGHT);
        ctx.restore();
        
        drawText(ctx, '排名', COL_X.rank, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
        drawText(ctx, '参赛玩家', COL_X.name, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'left', '500');
        drawText(ctx, '段位', LEVEL_COL_CENTER + 20, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
        drawText(ctx, '点数', COL_X.score, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
        drawText(ctx, 'PT', COL_X.pt, currentY + TABLE_HEADER_HEIGHT / 2, 11, '#6e7681', 'center', '500');
        
        currentY += TABLE_HEADER_HEIGHT;
        
        for (let i = 0; i < sortedPlayers.length; i++) {
            const player = sortedPlayers[i];
            const rank = i + 1;
            
            const isTarget = targetPlayerId && (player.id === targetPlayerId || player.playerId === targetPlayerId);
            if (isTarget) {
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
            const rc = rankColors[rank] || rankColors[4];
            const rankGradient = ctx.createRadialGradient(COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 0, COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 14);
            rankGradient.addColorStop(0, rc[0]);
            rankGradient.addColorStop(1, rc[1]);
            drawRoundRect(ctx, COL_X.rank - 14, currentY + PLAYER_ROW_HEIGHT / 2 - 14, 28, 28, 14, rankGradient);
            
            drawText(ctx, rank.toString(), COL_X.rank, currentY + PLAYER_ROW_HEIGHT / 2, 13, '#ffffff', 'center', 'bold');
            
            const nickname = player.nickname || player.name || '未知玩家';
            drawText(ctx, nickname, COL_X.name, currentY + PLAYER_ROW_HEIGHT / 2, 13, '#e6edf3', 'left', '500');
            
            let levelText = '';
            let majorRank = '';
            if (player.level !== undefined) {
                const level = new PlayerLevel(player.level, player.gradingScore || 0);
                levelText = level.full_tag;
                majorRank = level.major_rank;
            }
            
            const levelIconX = LEVEL_COL_CENTER - LEVEL_TEXT_OFFSET / 2;
            try {
                const rankIcon = await loadResImage(`info_texture/${majorRank}_${mode}.png`);
                ctx.drawImage(rankIcon, levelIconX, currentY + PLAYER_ROW_HEIGHT / 2 - LEVEL_ICON_SIZE / 2, LEVEL_ICON_SIZE, LEVEL_ICON_SIZE);
            } catch(e) {}
            
            drawText(ctx, levelText, LEVEL_COL_CENTER + LEVEL_TEXT_OFFSET / 2, currentY + PLAYER_ROW_HEIGHT / 2, 12, '#e6edf3', 'left', '500');
            
            const score = player.score || 0;
            drawText(ctx, score.toString(), COL_X.score, currentY + PLAYER_ROW_HEIGHT / 2, 14, '#e6edf3', 'center', 'bold');
            
            const gradingScore = player.gradingScore || player.delta || 0;
            const prefix = gradingScore > 0 ? '+' : '';
            let ptColor = '#6e7681';
            if (gradingScore > 0) ptColor = '#3fb950';
            else if (gradingScore < 0) ptColor = '#f85149';
            drawText(ctx, `${prefix}${gradingScore}`, COL_X.pt, currentY + PLAYER_ROW_HEIGHT / 2, 12, ptColor, 'center', '500');
            
            currentY += PLAYER_ROW_HEIGHT;
        }
        
        drawText(ctx, 'Majsoul-Plugin by 小橙c | Data: amae-koromo', CARD_WIDTH / 2, totalHeight - 20, 12, '#ffffff', 'center', 'bold');
        
        return canvas.toBuffer('image/png');
    } catch (error) {
        console.error('[MajsoulSubscribeCore] 生成订阅图片失败:', error);
        return null;
    }
}

function drawText(ctx, text, x, y, size = 30, color = '#FFFFFF', align = 'center', weight = 'normal', family = 'Microsoft YaHei, sans-serif') {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
}

function drawRoundRect(ctx, x, y, width, height, radius, fillStyle) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.arcTo(x + width, y, x + width, y + radius, radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    ctx.lineTo(x + radius, y + height);
    ctx.arcTo(x, y + height, x, y + height - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
    
    if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
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
    
    // 6. 定时任务：检查指定模式的订阅更新（单独检查四麻或三麻）
    async checkSubscriptionsByMode(mode = 4) {
        const updates = [];
        const modeName = mode === 4 ? '四麻' : '三麻';
        let successCount = 0;
        let failCount = 0;
        
        try {
            const subscriptions = await this._loadSubscriptions(mode);
            
            if (subscriptions.length === 0) {
                this._logger.info(`[MajsoulSubscribeCore] ${modeName}暂无订阅`);
                return updates;
            }
            
            this._logger.info(`[MajsoulSubscribeCore] 开始检查${modeName}订阅，共${subscriptions.length}个订阅`);
            
            // 筛选出需要检查的订阅
            const activeSubscriptions = subscriptions.filter(s => s.record_on);
            this._logger.debug(`[MajsoulSubscribeCore] ${modeName}活跃订阅数: ${activeSubscriptions.length}`);
            
            for (const sub of activeSubscriptions) {
                try {
                    // 获取该玩家最新的一场对局
                    this._logger.info(`[MajsoulSubscribeCore] 正在检测更新${sub.nickname || sub.id}的${modeName}对局数据`);
                    
                    const records = await this.api.getPlayerRecords(sub.id, mode);
                    
                    if (!records || records.length === 0) {
                        this._logger.info(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 无对局记录`);
                        successCount++;
                        continue;
                    }
                    
                    const latestRecord = records[0];
                    
                    // 验证数据完整性
                    if (!latestRecord.endTime) {
                        this._logger.warn(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 的对局记录时间为空`);
                        successCount++;
                        continue;
                    }
                    
                    // 通过比对 endTime 判断是否为新对局
                    if (latestRecord.endTime > sub.endTime) {
                        this._logger.info(`[MajsoulSubscribeCore] 发现新对局: ${sub.nickname || sub.id}`);
                        
                        // 生成播报消息（使用工具函数）
                        const msg = await this._generateBroadcastMessage(latestRecord, sub);
                        
                        updates.push({
                            groupId: sub.gid,
                            message: msg.text,
                            image: msg.image,
                            playerId: sub.id,
                            playerNickname: sub.nickname,
                            uuid: latestRecord.uuid
                        });
                        
                        // 更新本地存储的记录
                        sub.uuid = latestRecord.uuid || sub.uuid;
                        sub.endTime = latestRecord.endTime || sub.endTime;
                        
                        this._logger.info(`[MajsoulSubscribeCore] 更新玩家 ${sub.nickname || sub.id} 的记录`);
                    }
                    
                    successCount++;
                } catch (error) {
                    failCount++;
                    this._logger.error(`[MajsoulSubscribeCore] 检查玩家 ${sub.id} 更新失败: ${error.message}`);
                    // 不中断循环，继续检查下一个玩家
                    continue;
                }
            }
            
            // 保存本轮检查后的状态（如果有更新）
            if (updates.length > 0) {
                try {
                    await this._saveSubscriptions(subscriptions, mode);
                    this._logger.info(`[MajsoulSubscribeCore] ${modeName}订阅数据已保存`);
                } catch (saveError) {
                    this._logger.error(`[MajsoulSubscribeCore] 保存${modeName}订阅数据失败: ${saveError.message}`);
                }
            }
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 检查${modeName}订阅失败: ${error.message}`);
        }
        
        this._logger.info(`[MajsoulSubscribeCore] ${modeName}检查完成，发现 ${updates.length} 个新对局 (成功: ${successCount}, 失败: ${failCount})`);
        return updates;
    }
    
    // 生成播报消息
    async _generateBroadcastMessage(record, sub) {
        try {
            const roomName = getRoomName(record.modeId);
            const paipuUrl = generatePaipuUrl(record.uuid);
            const startTime = formatTime(record.startTime);
            const endTime = formatTime(record.endTime);
            
            let fullMsg = `本群侦测到新的对局：\n`;
            fullMsg += `对局场次：${roomName}\n`;
            fullMsg += `牌谱链接：${paipuUrl}\n`;
            
            if (record.players && Array.isArray(record.players)) {
                const sortedPlayers = [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0));
                for (const player of sortedPlayers) {
                    fullMsg += `${formatPlayerInfo(player)}\n`;
                }
            } else {
                fullMsg += '玩家信息获取失败\n';
            }
            
            fullMsg += `对局开始时间：${startTime}\n`;
            fullMsg += `对局结束时间：${endTime}`;
            
            const imageBuffer = await generateSubscribeImage(record, sub.id);
            
            return {
                text: imageBuffer ? `牌谱链接：${paipuUrl}` : fullMsg,
                image: imageBuffer
            };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 生成播报消息失败: ${error.message}`);
            return {
                text: '对局信息获取失败',
                image: null
            };
        }
    }
    
    // 7. 定时任务：检查所有订阅的更新（四麻+三麻）
    async checkAllSubscriptions() {
        const updates4p = await this.checkSubscriptionsByMode(4);
        const updates3p = await this.checkSubscriptionsByMode(3);
        return [...updates4p, ...updates3p];
    }
    
    // 8. 根据ID获取玩家当前昵称（与Majsoul_bot一致，使用player_stats接口）
    async getNicknameById(playerId, mode = 4) {
        try {
            // 使用player_stats接口获取玩家信息，与Majsoul_bot保持一致
            const nickname = await this.api.getPlayerNickname(playerId, mode);
            return nickname;
        } catch (error) {
            this._logger.debug(`[MajsoulSubscribeCore] 获取昵称失败: ${error.message}`);
            return null;
        }
    }
    
    // 9. 获取所有订阅（用于调试）
    async getAllSubscriptions(mode = 4) {
        return await this._loadSubscriptions(mode);
    }
    
    // 10. 清空所有订阅（用于调试/重置）
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