import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import { drawMajsInfoImg } from '../components/render.js';
import { ROOM_FILTERS, matchRoomFilter } from './MajsoulRecords.js';
import MajsoulApi from '../utils/MajsoulApi.js';
import BotLink from '../utils/BotLink.js';

const api = new MajsoulApi();

export class MajsoulInfo extends plugin {
    constructor() {
        super({
            name: '雀魂玩家信息查询',
            dsc: '查询雀魂玩家详细战绩信息并生成图片',
            event: 'message',
            priority: 500,
            rule: []
        });
    }
    
    async handle(e) {
        try {
            const msg = e.msg.trim();
            let mode = '4';
            
            if (msg.includes('三麻')) {
                mode = '3';
            }

            // 段位房筛选（模糊别名：金/金间/金之间、玉/玉间/玉之间、王座/王座间/王座之间 等）
            // 注意：铜之间/银之间定义保留但当前禁用，不会作为筛选条件（受牌谱屋 API 限制），同时把房间词从昵称中剔除
            let roomFilter = null, roomKey = null;
            const rm = matchRoomFilter(msg);
            if (rm.roomFilter) {
                roomFilter = rm.roomFilter;
                roomKey = rm.matched;
            }
            
            let uid = null;
            let playerName = null;
            
            const uidMatch = msg.match(/\d+/);
            if (uidMatch) {
                uid = uidMatch[0];
            } else {
                const nameMatch = msg.match(/^#?\S+\s+(.+)$/);
                if (nameMatch) {
                    playerName = nameMatch[1].trim();
                }
            }

            if (playerName) {
                let p = playerName;
                if (roomKey) p = p.replace(roomKey, '');
                p = p.replace(/三麻|四麻/g, '').trim();
                playerName = p;
            }
            
            if (!api.token) {
                await e.reply(MajsoulApi.TOKEN_HINT);
                return true;
            }
            if (!uid && !playerName) {
                const qid = String(e.user_id);
                uid = await this.getMainUid(qid);
            }
            
            if (!uid && !playerName) {
                await e.reply('您还没有绑定雀魂UID，请先通过 #雀魂绑定 UID 绑定后才能使用；也可带昵称查询：#雀魂查询 昵称');
                return true;
            }
            
            let searchPlayerName = playerName;
            if (playerName) {
                logger.debug(`[MajsoulInfo] 搜索玩家昵称: ${playerName}`);
                const players = await api.searchPlayer(playerName, mode === '3' ? 3 : 4);
                logger.debug(`[MajsoulInfo] 搜索结果: ${JSON.stringify(players)}`);
                if (!players || players.length === 0) {
                    await e.reply(`未找到名为"${playerName}"的玩家`);
                    return true;
                }
                uid = String(players[0].id);
                searchPlayerName = players[0].nickname;
                logger.debug(`[MajsoulInfo] 提取到UID: ${uid}, 昵称: ${searchPlayerName}`);
            } else if (uid) {
                searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 3 : 4);
                // 明确模式查询时，若主模式无数据（刚上段 0 场金之间等）接口会 404 拿不到昵称，
                // 用另一模式接口兜底拿真实昵称，避免渲染成 "Player"
                if (!searchPlayerName) {
                    searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 4 : 3);
                }
                if (searchPlayerName) {
                    logger.debug(`[MajsoulInfo] 通过UID获取昵称: ${searchPlayerName}`);
                }
            }
            
            let realtimePT = null;
            if (e.group_id) {
                logger.debug(`[MajsoulInfo] 尝试获取实时PT数据...`);
                realtimePT = await BotLink.queryPT(searchPlayerName || uid, e.group_id);
                if (realtimePT) {
                    logger.debug(`[MajsoulInfo] 获取实时PT成功: ${JSON.stringify(realtimePT)}`);
                } else {
                    logger.debug(`[MajsoulInfo] 获取实时PT失败，使用API数据`);
                    await e.reply('⚠️ 未收到THsBot回复，请检查群内是否存在THsBot机器人或THsBot暂不可用，将以牌谱屋数据输出段位PT（非实时数据）');
                }
            }
            
            const imgBuffer = await drawMajsInfoImg(uid, mode, realtimePT, roomFilter, searchPlayerName);
            
            if (typeof imgBuffer === 'string') {
                // 如果返回了字符串，说明是错误提示
                await e.reply(imgBuffer);
                return true;
            }
            
            await e.reply(segment.image(imgBuffer));
            
        } catch (err) {
            logger.error(`[MajsoulInfo] 绘图错误：${err.stack}`);
            await e.reply(`生成图片时发生错误：${err.message}`);
        }
        
        return true;
    }
    
    async getMainUid(qid) {
        try {
            if (typeof redis === 'undefined') {
                return null;
            }
            let mainUid = await redis.get(`majsoul:user:${qid}:main`);
            if (mainUid) return mainUid;
            const key = `majsoul:user:${qid}:bindings`;
            const bindingsStr = await redis.get(key);
            const bindings = bindingsStr ? JSON.parse(bindingsStr) : [];
            if (bindings.length > 0) return bindings[0];
            return null;
        } catch (error) {
            return null;
        }
    }
}