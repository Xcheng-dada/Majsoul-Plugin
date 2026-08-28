import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import { drawMajsInfoImg } from '../components/render.js';
import { ROOM_FILTERS, matchRoomFilter } from './MajsoulRecords.js';
import MajsoulApi from '../utils/MajsoulApi.js';
import { getPlayerBrief, resolveFriendId } from '../utils/MajsoulProtocolClient.js';

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
            
            // 范围词（友/友人/友人场、赛/赛事/比赛/比赛场）→ 友人场/比赛场本地图卡
            const scope = this.matchScope(msg);
            
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
            
            // 提取剩余参数：去掉指令前缀（#查询三麻 / #查询四麻 / #雀魂查询，含无空格写法）
            // 与段位房筛选词后的部分即查询目标（昵称或UID）
            let argsStr = msg.replace(/^#?(查询三麻|查询四麻|雀魂查询)\s*/i, '').trim();
            if (roomKey) argsStr = argsStr.replace(roomKey, '').trim();
            argsStr = argsStr.replace(/三麻|四麻/g, '').trim();
            // 友人场/比赛场：剔除范围词（友/友人/友人场、赛/赛事/比赛/比赛场），剩下即查询目标
            if (scope) argsStr = argsStr.replace(/(?:友人场|友人|比赛场|赛事|比赛)/g, '').replace(/(?:^|\s)(?:友|赛)(?=\s|$)/g, '').trim();
            
            // 指令必须使用昵称查询（雀魂昵称本身可为纯数字，如 "55555235"，一律按昵称搜索）；
            // 仅绑定 UID 的用户（不带昵称参数）才直接使用绑定的 UID 查询。
            if (argsStr && argsStr.length > 0) {
                playerName = argsStr;
            }
            
            if (!api.token) {
                await e.reply(MajsoulApi.TOKEN_HINT);
                return true;
            }
            if (!playerName) {
                const qid = String(e.user_id);
                uid = await this.getMainUid(qid);
            }
            
            if (!uid && !playerName) {
                await e.reply('您还没有绑定雀魂UID，请先通过 #雀魂绑定 UID 绑定后才能使用；也可带昵称查询：#雀魂查询 昵称');
                return true;
            }
            
            let searchPlayerName = null;
            if (playerName) {
                const players = await api.searchPlayer(playerName, mode === '3' ? 3 : 4);
                if (players && players.length > 0) {
                    uid = String(players[0].id);
                    searchPlayerName = players[0].nickname;
                } else {
                    // 不允许直接使用 UID 查询：昵称搜不到即提示，不当作 UID 使用
                    // 兜底：纯数字输入按好友码走本地 API（覆盖无金之间对局的铜银玩家）
                    if (/^\d{6,12}$/.test(playerName)) {
                        return await this.handleFriendCodeFallback(e, playerName, mode);
                    }
                    await e.reply(`未找到玩家「${playerName}」，请确认昵称正确且该玩家在金之间以上有过对局记录；没有金之间对局记录的玩家可改用好友码查询：#雀魂查询 好友码`);
                    return true;
                }
            } else if (uid) {
                searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 3 : 4);
                // 明确模式查询时，若主模式无数据（刚上段 0 场金之间等）接口会 404 拿不到昵称，
                // 用另一模式接口兜底拿真实昵称，避免渲染成 "Player"
                if (!searchPlayerName) {
                    searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 4 : 3);
                }
            }
            
            // 走本地 API（Majsoul Pure Protocol API）取实时段位 PT，替代 BotLink。
            // 本地 API 与插件深度绑定，无需兜底；查询者需已登录（被查者无需好友）。
            let realtimePT = null;
            try {
                const brief = await getPlayerBrief(uid);
                if (brief) {
                    realtimePT = {
                        nickname: brief.nickname,
                        uid: String(brief.accountId),
                        avatarId: brief.avatarId,
                        isRealTime: true,
                        fourPlayer: brief.level ? { levelId: brief.level.id, score: brief.level.score } : null,
                        threePlayer: brief.level3 ? { levelId: brief.level3.id, score: brief.level3.score } : null
                    };
                } else {
                    logger.warn(`[MajsoulInfo] 本地 API 未返回玩家 brief，将使用牌谱屋数据`);
                }
            } catch (err) {
                logger.warn(`[MajsoulInfo] 本地 API 获取实时PT失败: ${err.message || err}`);
            }
            
            const imgBuffer = await drawMajsInfoImg(uid, mode, realtimePT, roomFilter, searchPlayerName, scope);
            
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
    
    // 兜底：纯数字输入作为好友码，走本地 API 好友码→UID→段位场图卡（覆盖无金之间对局的铜银玩家）
    async handleFriendCodeFallback(e, friendCode, mode) {
        try {
            const profile = await resolveFriendId(friendCode);
            if (!profile || profile.accountId == null) {
                await e.reply(`未找到玩家，好友码「${friendCode}」无法解析`);
                return true;
            }
            const uid = String(profile.accountId);
            // 构造实时段位 PT（本地 API 返回的实时段位），供图卡顶部展示
            const realtimePT = {
                nickname: profile.nickname || '玩家',
                uid,
                avatarId: profile.avatarId,
                isRealTime: true,
                fourPlayer: profile.level ? { levelId: profile.level.id, score: profile.level.score } : null,
                threePlayer: profile.level3 ? { levelId: profile.level3.id, score: profile.level3.score } : null
            };
            const imgBuffer = await drawMajsInfoImg(uid, mode, realtimePT, null, profile.nickname || null, null);
            if (typeof imgBuffer === 'string') {
                await e.reply(imgBuffer);
            } else {
                await e.reply(segment.image(imgBuffer));
            }
        } catch (err) {
            logger.error(`[MajsoulInfo] 好友码兜底失败: ${err.stack || err}`);
            await e.reply(`本地API查询失败：${err.message}`);
        }
        return true;
    }
    
    // 范围词识别：友/友人/友人场 → 'friend'；赛/赛事/比赛/比赛场 → 'match'；其余 → null
    matchScope(msg) {
        if (!msg) return null;
        const s = msg.replace(/^#?/, '');
        if (/(?:友人场|友人|(?:^|[\s，,])(?:友)(?:$|[\s，,]))/.test(s)) return 'friend';
        if (/(?:比赛场|赛事|(?:^|[\s，,])(?:比赛|赛)(?:$|[\s，,]))/.test(s)) return 'match';
        return null;
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