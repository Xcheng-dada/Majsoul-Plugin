// plugins/Majsoul-Plugin/utils/MajsoulSubscribeCore.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import MajsoulApi from './MajsoulApi.js';
import { getRoomName, isThreePlayerMode, PlayerLevel } from './PlayerLevel.js';
import { drawRankBadge, drawRankLabel, numFontSize, drawNumText, drawPtChange } from './RankBadge.js';
import { FONT } from '../components/fonts.js';

async function loadResImage(subPath) {
    const fullPath = path.resolve('./plugins/Majsoul-Plugin/resources', subPath);
    // @napi-rs/canvas 在 Windows 下不认本地路径字符串，须读 Buffer 再解码
    return await loadImage(await fs.readFile(fullPath));
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

export async function generateSubscribeImage(record, targetPlayerId = null) {
    try {
        const mode = isThreePlayerMode(record.modeId) ? '3' : '4';
        const roomName = getRoomName(record.modeId);
        const startTime = formatTime(record.startTime);
        const endTime = formatTime(record.endTime);
        
        const sortedPlayers = record.players && Array.isArray(record.players) 
            ? [...record.players].sort((a, b) => (b.score || 0) - (a.score || 0)) 
            : [];
        // ---- 尺寸与字号（与「雀魂对局」卡保持一致）----
        const CARD_WIDTH = 720;
        const PADDING = 16;
        const CONTENT_WIDTH = CARD_WIDTH - PADDING * 2;
        // 底板按宽度等比缩放（不拉伸），卡片高度由底板比例决定
        const cardBg = await loadResImage(mode === '4' ? 'ui/paipu_bg4.png' : 'ui/paipu_bg3.png').catch(() => null);
        const rowShadow = await loadResImage('ui/paipu_row_shadow.png').catch(() => null);
        const BAND_H_FALLBACK = 38;
        const HEAD_H = 26;
        const ROW_H = 32;
        const bgH = cardBg ? Math.round(cardBg.height * CONTENT_WIDTH / cardBg.width) : 0;
        const cardH = bgH || (BAND_H_FALLBACK + HEAD_H + ROW_H * sortedPlayers.length + 8);
        // 底板缩放比例：暗色带在原图 y=4~52（高 48、中心 24），按此比例换算
        const bgScale = cardBg ? cardH / cardBg.height : 1;
        const BAND_TOP = Math.round(4 * bgScale);
        const BAND_H = Math.round(48 * bgScale);
        const BAND_CY = BAND_TOP + BAND_H / 2;

        // 字号层级：昵称/位次 > 点数/PT > 时间 > 表头
        // 注：HYWenHei 无真 bold（bold 会合成加粗使字形变大），数字统一 normal 同字号
        const NAME_SIZE = 16;
        const NUM_SIZE = 14;
        // 汉仪文黑数字墨迹仅占字号 73%，需补偿到与汉字等视觉高
        const NUM_FONT = numFontSize(NUM_SIZE);
        const TIME_FONT = numFontSize(12);
        const HEAD_SIZE = 12;

        const LEVEL_ICON_SIZE = 34;
        // 列位置（四列：位次 / 玩家 / 段位 / PT变动 / 点数，PT 独立成列便于对齐）
        const COL_X = {
            rank: PADDING + 16,
            name: PADDING + 78,
            levelIcon: PADDING + 300,
            pt: PADDING + 470,
            score: PADDING + 600
        };

        const baseHeight = cardH;
        const TOP_PADDING_PERCENT = 0.04;
        const topPadding = Math.floor(baseHeight * TOP_PADDING_PERCENT);
        // 底部必须给页脚留足空间（原先按 4% 算，小卡片时页脚会压进卡片里）
        const FOOTER_SPACE = 22;
        const bottomPadding = FOOTER_SPACE;
        const totalHeight = baseHeight + topPadding + bottomPadding;
        
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
        
        let currentY = topPadding;
        
        if (cardBg) {
            // 等比绘制：宽度贴合 CONTENT_WIDTH，高度按原生比例（不拉伸变形）
            ctx.drawImage(cardBg, PADDING, currentY, CONTENT_WIDTH, cardH);
        } else {
            drawRoundRect(ctx, PADDING, currentY, CONTENT_WIDTH, cardH, 12, '#1c2128');
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#30363d';
            ctx.stroke();
        }
        
        // 标题带：整行金色（官方「段位场 · 比赛场 · 四人南」全部金色），文字红豆大黑体
        // 注：roomName 本身已是「比赛场 · 四人南」，只补「段位场 · 」前缀（含尾空格）
        // 暗色带在原图 y=4~52，等比缩放后中心 y≈20，标题与时间都按此居中
        const bandCy = currentY + BAND_CY;
        const prefix = '段位场 · ';
        ctx.font = `normal 17px ${FONT.name}`;
        const prefixW = ctx.measureText(prefix).width;
        drawText(ctx, prefix, PADDING + 22, bandCy, 17, '#E8C87E', 'left', 'normal', FONT.name);
        drawText(ctx, roomName, PADDING + 22 + prefixW, bandCy, 17, '#E8C87E', 'left', 'normal', FONT.name);
        // 时间为数字，用汉仪文黑；结束时间用暗色与开始区分，与标题同一基线
        drawNumText(ctx, startTime, Math.round(CARD_WIDTH / 2) + 30, bandCy, TIME_FONT, '#DCE7F7', 'center');
        drawNumText(ctx, endTime, CARD_WIDTH - PADDING - 20, bandCy, TIME_FONT, '#7E93B4', 'right');
        
        // 表头（四列：玩家 / 段位 / PT变动 / 点数）
        const headerCy = currentY + BAND_TOP + BAND_H + HEAD_H / 2;
        drawText(ctx, '玩家', COL_X.name, headerCy, HEAD_SIZE, '#7E93B4', 'left', 'normal', FONT.name);
        drawText(ctx, '段位', COL_X.levelIcon, headerCy, HEAD_SIZE, '#7E93B4', 'left', 'normal', FONT.name);
        drawText(ctx, 'PT变动', COL_X.pt, headerCy, HEAD_SIZE, '#7E93B4', 'left', 'normal', FONT.name);
        drawText(ctx, '点数', COL_X.score, headerCy, HEAD_SIZE, '#7E93B4', 'left', 'normal', FONT.name);
        
        let rowY = currentY + BAND_TOP + BAND_H + HEAD_H;
        
        for (let i = 0; i < sortedPlayers.length; i++) {
            const player = sortedPlayers[i];
            const rank = i + 1;
            const rowCy = rowY + ROW_H / 2;
            
            const isTarget = targetPlayerId && (player.id === targetPlayerId || player.playerId === targetPlayerId);
            
            // 目标玩家整行高亮：官方 list_at_the_bottom 阴影（左侧实心向右渐隐）
            if (isTarget) {
                if (rowShadow) {
                    const sx = PADDING + 6;
                    const sw = CONTENT_WIDTH - 12;
                    const SOLID_SRC = 40;
                    const SOLID_DST = Math.round(SOLID_SRC * ROW_H / rowShadow.height);
                    ctx.drawImage(rowShadow, 0, 0, SOLID_SRC, rowShadow.height, sx, rowY, SOLID_DST, ROW_H);
                    ctx.drawImage(rowShadow, SOLID_SRC, 0, rowShadow.width - SOLID_SRC, rowShadow.height,
                        sx + SOLID_DST, rowY, sw - SOLID_DST, ROW_H);
                } else {
                    ctx.fillStyle = 'rgba(10, 18, 40, 0.55)';
                    ctx.fillRect(PADDING + 6, rowY, CONTENT_WIDTH - 12, ROW_H);
                }
            }
            
            // 名次：官方艺术字素材「1位」~「4位」（不用文字排版）
            await drawRankLabel(ctx, rank, COL_X.rank, rowCy, 18);
            
            // 昵称（红豆大黑体，主信息）
            const nameColor = isTarget ? '#FFFFFF' : '#C5D2E8';
            const nickname = player.nickname || player.name || '未知玩家';
            const nameMaxW = COL_X.levelIcon - COL_X.name - 16;
            ctx.font = `normal ${NAME_SIZE}px ${FONT.name}`;
            let nick = String(nickname);
            while (nick.length > 1 && ctx.measureText(nick).width > nameMaxW) nick = nick.slice(0, -1);
            if (nick !== nickname) nick = nick.slice(0, -1) + '…';
            drawText(ctx, nick, COL_X.name, rowCy, NAME_SIZE, nameColor, 'left', 'normal', FONT.name);
            
            // 段位徽章 + 右侧星级 / LvN
            let majorRank = '';
            let minorRank = 0;
            let levelText = '';
            if (player.level !== undefined) {
                const level = new PlayerLevel(player.level, 0);
                levelText = level.full_tag;
                majorRank = level.major_rank;
                minorRank = level.minor_rank;
            }
            let afterIconX = COL_X.levelIcon;
            try {
                afterIconX = await drawRankBadge(
                    ctx,
                    { majorRank, minorRank, level: levelText },
                    mode, COL_X.levelIcon, rowCy, LEVEL_ICON_SIZE, nameColor
                );
            } catch (e) {
                drawText(ctx, levelText || '-', COL_X.levelIcon, rowCy, HEAD_SIZE, nameColor, 'left', 'normal', FONT.name);
                afterIconX = COL_X.levelIcon + 64;
            }
            
            // PT 变动（独立列，左对齐，正绿负红）
            const gradingScore = player.gradingScore || player.delta || 0;
            const ptPrefix = gradingScore > 0 ? '+' : '';
            let ptColor = '#8FA9CC';
            if (gradingScore > 0) ptColor = '#4ADE80';
            else if (gradingScore < 0) ptColor = '#F87171';
            await drawPtChange(ctx, { pt: gradingScore, ptText: `${ptPrefix}${gradingScore}`, majorRank }, COL_X.pt, rowCy, NUM_FONT, ptColor);
            
            // 点数：全部金色，高亮行（阴影条内）用亮金，其余用暗金
            const score = player.score || 0;
            drawNumText(ctx, String(score), COL_X.score, rowCy, NUM_FONT, isTarget ? '#F2D89A' : '#A8894F', 'left');
            
            rowY += ROW_H;
        }
        
        // 页脚：署名与数据来源（保持原样）
        ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Majsoul-Plugin by 小橙c | Data: amae-koromo', CARD_WIDTH / 2, totalHeight - 3);
        
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

// 模块级单例：无论被 new 多少次（插件启动、热重载、订阅/定时两个入口），
// 核心只真正初始化一次，避免重复打"初始化完成"日志、重复建目录。
let _instance = null;

export function getSubscribeCoreInstance() {
    if (!_instance) _instance = new MajsoulSubscribeCore();
    return _instance;
}

export default class MajsoulSubscribeCore {
    constructor() {
        // 防御：若已有单例，直接复用其已初始化的状态，避免二次初始化
        if (_instance && _instance !== this) return _instance;
        this.api = new MajsoulApi();
        // 使用全局 logger 或 console
        this._logger = global.logger || console;
        
        // 初始化数据目录
        this._initialize();
        // 标记单例（构造函数内赋值，确保后续 new 复用）
        _instance = this;
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
            if (error && error.code === 'TOKEN_REQUIRED') {
                return { success: false, message: MajsoulApi.TOKEN_HINT };
            }
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
            if (error && error.code === 'TOKEN_REQUIRED') {
                return { success: false, message: MajsoulApi.TOKEN_HINT };
            }
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
                return { success: false, message: `本群暂无${mode === 4 ? '四麻' : '三麻'}对局订阅。`, subs: [] };
            }
            
            const subs = [];
            let message = `📋 本群${mode === 4 ? '四麻' : '三麻'}订阅状态 (共${groupSubs.length}个):\n`;
            
            for (let i = 0; i < groupSubs.length; i++) {
                const sub = groupSubs[i];
                const status = sub.record_on ? '🔔 开启' : '🔕 关闭';
                const nickname = sub.nickname || (await this.getNicknameById(sub.id, mode)) || `ID:${sub.id}`;
                subs.push({ id: String(sub.id), nickname, active: !!sub.record_on });
                message += `${i + 1}. ${nickname} (${sub.id}) - ${status}\n`;
            }
            
            message += '\n提示: 使用 #关闭雀魂订阅 [昵称] 可临时关闭播报。';
            
            return { success: true, message, subs };
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 查询订阅状态失败: ${error.message}`);
            return { success: false, message: '查询失败，请稍后重试。' };
        }
    }
    
    // 该模式是否存在订阅（供定时任务快速短路：无订阅时不打日志、不请求 API）
    async hasSubscriptions(mode = 4) {
        const subscriptions = await this._loadSubscriptions(mode);
        return subscriptions.length > 0;
    }

    // 6. 定时任务：检查指定模式的订阅更新（单独检查四麻或三麻）
    async checkSubscriptionsByMode(mode = 4) {
        // 未配置牌谱屋 token 时静默跳过，避免定时任务反复刷日志/报错
        if (!this.api.token) return [];
        const updates = [];
        const modeName = mode === 4 ? '四麻' : '三麻';
        let successCount = 0;
        let failCount = 0;
        
        try {
            const subscriptions = await this._loadSubscriptions(mode);
            
            if (subscriptions.length === 0) {
                this._logger.debug(`[MajsoulSubscribeCore] ${modeName}暂无订阅`);
                return updates;
            }
            
            this._logger.debug(`[MajsoulSubscribeCore] 开始检查${modeName}订阅，共${subscriptions.length}个订阅`);
            
            // 筛选出需要检查的订阅
            const activeSubscriptions = subscriptions.filter(s => s.record_on);
            this._logger.debug(`[MajsoulSubscribeCore] ${modeName}活跃订阅数: ${activeSubscriptions.length}`);
            
            for (const sub of activeSubscriptions) {
                try {
                    // 获取该玩家最新的一场对局
                    this._logger.debug(`[MajsoulSubscribeCore] 正在检测更新${sub.nickname || sub.id}的${modeName}对局数据`);
                    
                    const records = await this.api.getPlayerRecords(sub.id, mode, 5);
                    
                    if (!records || records.length === 0) {
                        this._logger.debug(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 无对局记录`);
                        successCount++;
                        continue;
                    }
                    
                    // 收集所有比本地 endTime 更新的对局（按时间升序：旧->新），逐场补发，避免长期离线后中间场次漏报
                    const newRecords = records
                        .filter(r => r && r.endTime && (!sub.endTime || r.endTime > sub.endTime))
                        .sort((a, b) => a.endTime - b.endTime);
                    
                    if (newRecords.length === 0) {
                        successCount++;
                        continue;
                    }
                    
                    // 单轮补发上限，避免长期离线后一次性消息轰炸（与对局记录查询的"最近5场"保持一致）
                    const MAX_BACKFILL = 5;
                    const toSend = newRecords.slice(0, MAX_BACKFILL);
                    for (const rec of toSend) {
                        // 生成播报消息（使用工具函数）
                        const msg = await this._generateBroadcastMessage(rec, sub);
                        updates.push({
                            groupId: sub.gid,
                            message: msg.text,
                            image: msg.image,
                            playerId: sub.id,
                            playerNickname: sub.nickname,
                            uuid: rec.uuid,
                            endTime: rec.endTime,
                            mode: mode
                        });
                    }
                    
                    this._logger.info(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 待播报新对局 ${newRecords.length} 场（本轮 ${toSend.length} 场）`);
                    if (newRecords.length > MAX_BACKFILL) {
                        this._logger.warn(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 积压 ${newRecords.length} 场，单轮仅补 ${MAX_BACKFILL} 场，剩余将在后续轮次继续补发`);
                    }
                    
                    successCount++;
                } catch (error) {
                    failCount++;
                    this._logger.error(`[MajsoulSubscribeCore] 检查玩家 ${sub.id} 更新失败: ${error.message}`);
                    // 不中断循环，继续检查下一个玩家
                    continue;
                }
            }
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 检查${modeName}订阅失败: ${error.message}`);
        }
        
        if (updates.length > 0) {
            this._logger.info(`[MajsoulSubscribeCore] ${modeName}检查完成，发现 ${updates.length} 个新对局 (成功: ${successCount}, 失败: ${failCount})`);
        } else {
            this._logger.debug(`[MajsoulSubscribeCore] ${modeName}例行检查完成 (成功: ${successCount}, 失败: ${failCount})`);
        }
        return updates;
    }
    
    // 播报发送成功后标记该对局已处理（仅成功才更新 endTime，避免漏报）
    async markBroadcasted(update) {
        try {
            const subscriptions = await this._loadSubscriptions(update.mode);
            const sub = subscriptions.find(s => s.id === update.playerId && String(s.gid) === String(update.groupId));
            if (sub) {
                sub.uuid = update.uuid || sub.uuid;
                sub.endTime = update.endTime;
                await this._saveSubscriptions(subscriptions, update.mode);
                this._logger.info(`[MajsoulSubscribeCore] 玩家 ${sub.nickname || sub.id} 的播报已确认送达`);
            }
        } catch (error) {
            this._logger.error(`[MajsoulSubscribeCore] 标记已播报失败: ${error.message}`);
        }
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
            
            // 有图片时，图片下方只附一行牌谱链接（避免与图片内容重复、且不要多余空行）
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
    
    
}





