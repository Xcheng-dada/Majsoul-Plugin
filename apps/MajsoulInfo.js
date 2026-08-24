import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import { drawMajsInfoImg, NO_MAJSOUL_STATS } from '../components/render.js';
import { ROOM_FILTERS, matchRoomFilter } from './MajsoulRecords.js';
import MajsoulApi from '../utils/MajsoulApi.js';
import { PlayerLevel } from '../utils/PlayerLevel.js';
import { getPlayerBrief, getPlayerStatistics, resolveFriendId } from '../utils/MajsoulProtocolClient.js';

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
            
            // 范围词（友/友人/友人场、赛/赛事/比赛/比赛场）→ 文字版战绩摘要
            if (this.matchScope(msg)) {
                return await this.handleText(e);
            }
            
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
                logger.debug(`[MajsoulInfo] 搜索玩家昵称: ${playerName}`);
                const players = await api.searchPlayer(playerName, mode === '3' ? 3 : 4);
                logger.debug(`[MajsoulInfo] 搜索结果: ${JSON.stringify(players)}`);
                if (players && players.length > 0) {
                    uid = String(players[0].id);
                    searchPlayerName = players[0].nickname;
                    logger.debug(`[MajsoulInfo] 提取到UID: ${uid}, 昵称: ${searchPlayerName}`);
                } else {
                    // 不允许直接使用 UID 查询：昵称搜不到即提示，不当作 UID 使用
                    logger.debug(`[MajsoulInfo] 昵称搜索无结果: ${playerName}`);
                    // 兜底：纯数字输入按好友码走本地 API（覆盖无金之间对局的铜银玩家）
                    if (/^\d{6,12}$/.test(playerName)) {
                        return await this.handleFriendCodeFallback(e, playerName, mode);
                    }
                    await e.reply(`未找到玩家「${playerName}」，请确认昵称正确且该玩家在金之间以上有过对局记录；铜银玩家可改用好友码查询：#雀魂查询 好友码`);
                    return true;
                }
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
            
            // 走本地 API（Majsoul Pure Protocol API）取实时段位 PT，替代 BotLink。
            // 本地 API 与插件深度绑定，无需兜底；查询者需已登录（被查者无需好友）。
            let realtimePT = null;
            try {
                logger.debug(`[MajsoulInfo] 通过本地 API 获取实时段位PT, uid=${uid}`);
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
                    logger.debug(`[MajsoulInfo] 获取实时PT成功: ${JSON.stringify(realtimePT)}`);
                } else {
                    logger.warn(`[MajsoulInfo] 本地 API 未返回玩家 brief，将使用牌谱屋数据`);
                }
            } catch (err) {
                logger.warn(`[MajsoulInfo] 本地 API 获取实时PT失败: ${err.message || err}`);
            }
            
            const imgBuffer = await drawMajsInfoImg(uid, mode, realtimePT, roomFilter, searchPlayerName);
            
            if (imgBuffer === NO_MAJSOUL_STATS) {
                // 牌谱屋两个模式都无数据（无金之间对局）→ 转本地API文字兜底（段位场）
                logger.debug(`[MajsoulInfo] 牌谱屋无数据，走文字兜底 uid=${uid}`);
                const levelInfo = mode === '3'
                    ? (realtimePT && realtimePT.threePlayer ? { id: realtimePT.threePlayer.levelId, score: realtimePT.threePlayer.score } : null)
                    : (realtimePT && realtimePT.fourPlayer ? { id: realtimePT.fourPlayer.levelId, score: realtimePT.fourPlayer.score } : null);
                const nickname = (realtimePT && realtimePT.nickname) || searchPlayerName || '玩家';
                await e.reply(await this.buildRankTextReply(uid, mode, levelInfo, nickname));
                return true;
            }
            
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
    
    /**
     * 文字版玩家战绩摘要（#雀魂查询 友/友人/友人场 昵称、#雀魂查询 赛/赛事/比赛/比赛场 昵称、#查询三麻 友 昵称）
     * 数据范围：友人场(gameCategory=1) / 比赛场(gameCategory=4)，均来自本地 API statistics；
     * 段位信息仅用于首行展示（本地 API 实时段位）。
     * 有啥字段就写啥字段，没有的就不写。
     */
    async handleText(e) {
        try {
            const msg = e.msg.trim();
            // 模式仅由原指令前缀决定：查询三麻→三麻，其余（雀魂查询/查询四麻）→四麻
            const mode = msg.includes('查询三麻') ? '3' : '4';
            // 范围词 → 目标数据范围：friend=友人场(gc=1)，match=比赛场(gc=4)
            const scope = this.matchScope(msg) || 'friend';
            const scopeCfg = {
                friend: { gc: 1, label: '友人场' },
                match: { gc: 4, label: '比赛场' }
            };
            const cfg = scopeCfg[scope];
            
            let uid = null;
            let playerName = null;
            
            // 提取剩余参数：去掉指令前缀（#雀魂查询/#查询四麻/#查询三麻，含无空格写法）
            // 与范围词（友/友人/友人场、赛/赛事/比赛/比赛场），剩下即查询目标（昵称）
            let argsStr = msg.replace(/^#?(雀魂查询|查询四麻|查询三麻)\s*/i, '').trim();
            argsStr = argsStr.replace(/(?:友人场|友人|其他|其它|比赛场|赛事|比赛)/g, '').replace(/(?:^|\s)(?:友|赛)(?=\s|$)/g, '').trim();
            if (argsStr) {
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
                await e.reply('您还没有绑定雀魂UID，请先通过 #雀魂绑定 UID 绑定后才能使用；也可带昵称查询：#雀魂查询 友 昵称');
                return true;
            }
            
            // 昵称 → UID（仅支持昵称查询；绑定用户不带昵称时用绑定 UID）
            let searchPlayerName = null;
            if (playerName) {
                const players = await api.searchPlayer(playerName, mode === '3' ? 3 : 4);
                if (players && players.length > 0) {
                    uid = String(players[0].id);
                    searchPlayerName = players[0].nickname;
                } else {
                    await e.reply(`未找到玩家「${playerName}」，请确认昵称正确且该玩家有对局记录`);
                    return true;
                }
            } else if (uid) {
                searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 3 : 4);
                if (!searchPlayerName) {
                    searchPlayerName = await api.getPlayerNickname(uid, mode === '3' ? 4 : 3);
                }
            }
            
            // 本地 API：实时段位 + 统计（友人场/比赛场）
            let nickname = searchPlayerName;
            let levelInfo = null; // { id, score }
            let targetEntry = null;
            
            try {
                const brief = await getPlayerBrief(uid);
                if (brief) {
                    if (brief.nickname) nickname = brief.nickname;
                    levelInfo = mode === '3' ? (brief.level3 || null) : (brief.level || null);
                }
            } catch (err) {
                logger.warn(`[MajsoulInfo] 本地 API 获取实时段位失败: ${err.message || err}`);
            }
            
            try {
                const statRes = await getPlayerStatistics(uid);
                if (statRes && Array.isArray(statRes.entries)) {
                    const mc = mode === '3' ? 2 : 1;
                    // 优先 gameType=1（普通），再兜底其他 gameType；范围对应 gameCategory=cfg.gc
                    targetEntry = statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === cfg.gc && x.gameType === 1)
                        || statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === cfg.gc) || null;
                }
            } catch (err) {
                logger.warn(`[MajsoulInfo] 本地 API 获取统计失败: ${err.message || err}`);
            }
            
            const name = nickname || '玩家';
            const rankStr = levelInfo ? this.formatRankText(levelInfo) : null;
            
            const lines = [];
            const headPrefix = `${name}${rankStr ? `(${rankStr})` : ''} - `;
            
            if (targetEntry) {
                // 标题用统计窗口 roundCount（可能封顶100）；真实总对局数放「对战数」行（finalPositionCounts 求和）
                const total = this.getGameCount(targetEntry);
                const recent = targetEntry.roundCount || total;
                lines.push(`${headPrefix}${cfg.label}最近${Math.min(recent, total)}场`);
                lines.push(...this.buildStatLines(targetEntry, mode));
            } else {
                lines.push(`${headPrefix}暂无${mode === '3' ? '三麻' : '四麻'}${cfg.label}统计数据`);
            }
            
            await e.reply(lines.join('\n'));
        } catch (err) {
            logger.error(`[MajsoulInfo] 文字查询错误：${err.stack}`);
            await e.reply(`生成文字结果时发生错误：${err.message}`);
        }
        return true;
    }
    
    // 兜底：纯数字输入作为好友码，走本地 API 好友码→UID→段位场文字输出（覆盖无金之间对局的铜银玩家）
    async handleFriendCodeFallback(e, friendCode, mode) {
        try {
            logger.debug(`[MajsoulInfo] 尝试好友码解析: ${friendCode}`);
            const profile = await resolveFriendId(friendCode);
            if (!profile || profile.accountId == null) {
                await e.reply(`未找到玩家，好友码「${friendCode}」无法解析`);
                return true;
            }
            const uid = String(profile.accountId);
            const levelInfo = mode === '3' ? (profile.level3 || null) : (profile.level || null);
            await e.reply(await this.buildRankTextReply(uid, mode, levelInfo, profile.nickname || '玩家'));
        } catch (err) {
            logger.error(`[MajsoulInfo] 好友码兜底失败: ${err.stack || err}`);
            await e.reply(`本地API查询失败：${err.message}`);
        }
        return true;
    }
    
    // 段位场文字输出（本地统计 gameCategory=2），供好友码兜底与无牌谱屋数据兜底复用
    async buildRankTextReply(uid, mode, levelInfo, nickname) {
        // 本地统计：段位场(gameCategory=2)，覆盖铜银金玉全部对局
        const statRes = await getPlayerStatistics(uid);
        const mc = mode === '3' ? 2 : 1;
        let entry = null;
        if (statRes && Array.isArray(statRes.entries)) {
            entry = statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === 2 && x.gameType === 1)
                || statRes.entries.find(x => x.mahjongCategory === mc && x.gameCategory === 2) || null;
        }
        
        const name = nickname || '玩家';
        const rankStr = this.formatRankText(levelInfo);
        const lines = [];
        const headPrefix = `${name}${rankStr ? `(${rankStr})` : ''} - `;
        if (entry) {
            // 标题用统计窗口 roundCount（可能封顶100）；真实总对局数放「对战数」行（finalPositionCounts 求和）
            const total = this.getGameCount(entry);
            const recent = entry.roundCount || total;
            lines.push(`${headPrefix}段位场最近${Math.min(recent, total)}战`);
            lines.push(...this.buildStatLines(entry, mode));
        } else {
            lines.push(`${headPrefix}暂无${mode === '3' ? '三麻' : '四麻'}段位场统计数据`);
        }
        return lines.join('\n');
    }
    
    // 范围词识别：友/友人/友人场 → 'friend'；赛/赛事/比赛/比赛场 → 'match'；其余 → null
    matchScope(msg) {
        if (!msg) return null;
        const s = msg.replace(/^#?/, '');
        if (/(?:友人场|友人|(?:^|[\s，,])(?:友)(?:$|[\s，,]))/.test(s)) return 'friend';
        if (/(?:比赛场|赛事|(?:^|[\s，,])(?:比赛|赛)(?:$|[\s，,]))/.test(s)) return 'match';
        return null;
    }
    
    // 段位文本：雀士1 357/600（段位名用全名）
    formatRankText(levelInfo) {
        if (!levelInfo || levelInfo.id == null) return null;
        try {
            const pl = new PlayerLevel(levelInfo.id, levelInfo.score || 0);
            return `${pl.major_rank}${pl.minor_rank} ${pl.formatAdjustedScore()}`;
        } catch {
            return null;
        }
    }
    
    // 对战数：finalPositionCounts 求和（真实局数）优先，其次 roundCount，最后 recentGames 长度
    getGameCount(entry) {
        if (!entry) return 0;
        if (Array.isArray(entry.finalPositionCounts)) {
            const sum = entry.finalPositionCounts.reduce((a, b) => (a || 0) + (b || 0), 0);
            if (sum > 0) return sum;
        }
        if (entry.roundCount > 0) return entry.roundCount;
        if (Array.isArray(entry.recentGames)) return entry.recentGames.length;
        return 0;
    }
    
    buildStatLines(entry, mode) {
        const lines = [];
        
        // 最近战绩（取最近10局顺位，recentGames 为旧→新，取末尾再倒序使最新在前）
        if (Array.isArray(entry.recentGames) && entry.recentGames.length > 0) {
            const ranks = entry.recentGames.slice(-10).reverse().map(g => (g && g.rank != null) ? g.rank : 0).join('');
            lines.push(`最近战绩: [${ranks}]`);
        }
        
        // 对战数（真实总对局数，finalPositionCounts 求和）
        const count = this.getGameCount(entry);
        if (count > 0) {
            lines.push(`对战数: ${count}`);
        }
        
        // 顺位分布 + 均顺
        if (Array.isArray(entry.finalPositionCounts) && entry.finalPositionCounts.some(c => c > 0)) {
            const rankLine = this.formatRankRates(entry.finalPositionCounts, mode);
            if (rankLine) lines.push(rankLine);
        }
        
        // 和/铳（和=和牌率）+ 自摸率/荣和率
        const parts = [];
        if (entry.winRate != null && entry.dealInRate != null) {
            parts.push(`和/铳: ${this.pct(entry.winRate)}% / ${this.pct(entry.dealInRate)}%`);
        } else if (entry.winRate != null) {
            parts.push(`和: ${this.pct(entry.winRate)}%`);
        } else if (entry.dealInRate != null) {
            parts.push(`铳: ${this.pct(entry.dealInRate)}%`);
        }
        const extras = [];
        if (entry.tsumoRate != null) extras.push(`自摸率: ${this.pct(entry.tsumoRate)}%`);
        if (entry.ronRate != null) extras.push(`荣和率: ${this.pct(entry.ronRate)}%`);
        if (parts.length || extras.length) {
            let line = parts.join('  |  ');
            if (extras.length) line += (line ? '  |  ' : '') + extras.join('  ');
            lines.push(line);
        }
        
        return lines;
    }
    
    // 顺位分布百分比 + 均顺，如：1~4位: 29%, 27%, 21%, 23% (均顺2.37)
    formatRankRates(fpc, mode) {
        const arr = (mode === '3' ? fpc.slice(0, 3) : fpc.slice(0, 4));
        const sum = arr.reduce((a, b) => a + (b || 0), 0);
        if (sum <= 0) return null;
        const raw = arr.map(c => (c / sum) * 100);
        const rates = raw.map(v => Math.floor(v));
        let diff = 100 - rates.reduce((a, b) => a + b, 0);
        const remainders = raw.map((v, i) => ({ i, r: v - rates[i] })).sort((a, b) => b.r - a.r);
        for (let k = 0; k < diff; k++) {
            rates[remainders[k % remainders.length].i]++;
        }
        const avg = raw.reduce((acc, v, i) => acc + (i + 1) * v / 100, 0);
        const label = mode === '3' ? '1~3位' : '1~4位';
        return `${label}: ${rates.join('%, ')}% (均顺${avg.toFixed(2)})`;
    }
    
    // 比率(0~1) → 百分比文本（1位小数），如 0.194 → '19.4'
    pct(v) {
        if (v == null) return null;
        return (v * 100).toFixed(1);
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