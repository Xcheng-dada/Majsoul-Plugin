import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import { drawMajsInfoImg } from '../components/render.js';
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
            
            if (!uid && !playerName) {
                const qid = String(e.user_id);
                uid = await this.getMainUid(qid);
            }
            
            if (!uid && !playerName) {
                await e.reply('您尚未绑定雀魂UID，请先使用【#雀魂绑定 + UID】进行绑定\n例如：#雀魂绑定 123456');
                return true;
            }
            
            let searchPlayerName = playerName;
            if (playerName) {
                logger.info(`[MajsoulInfo] 搜索玩家昵称: ${playerName}`);
                const players = await api.searchPlayer(playerName, mode === '3' ? 3 : 4);
                logger.info(`[MajsoulInfo] 搜索结果: ${JSON.stringify(players)}`);
                if (!players || players.length === 0) {
                    await e.reply(`未找到名为"${playerName}"的玩家`);
                    return true;
                }
                uid = String(players[0].id);
                searchPlayerName = players[0].nickname;
                logger.info(`[MajsoulInfo] 提取到UID: ${uid}, 昵称: ${searchPlayerName}`);
            } else if (uid) {
                searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 3 : 4);
                if (searchPlayerName) {
                    logger.info(`[MajsoulInfo] 通过UID获取昵称: ${searchPlayerName}`);
                }
            }
            
            let realtimePT = null;
            if (e.group_id) {
                logger.info(`[MajsoulInfo] 尝试获取实时PT数据...`);
                realtimePT = await BotLink.queryPT(searchPlayerName || uid, e.group_id);
                if (realtimePT) {
                    logger.info(`[MajsoulInfo] 获取实时PT成功: ${JSON.stringify(realtimePT)}`);
                } else {
                    logger.info(`[MajsoulInfo] 获取实时PT失败，使用API数据`);
                    await e.reply('⚠️ 未收到THsBot回复，请检查群内是否存在THsBot机器人或THsBot暂不可用，将以牌谱屋数据输出段位PT（非实时数据）');
                }
            }
            
            const imgBuffer = await drawMajsInfoImg(uid, mode, realtimePT);
            
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