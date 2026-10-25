// plugins/Majsoul-Plugin/apps/MajsoulUser.js
import plugin from "../../../lib/plugins/plugin.js";
import MajsoulApi from '../utils/MajsoulApi.js';
import { getPlayerBrief, resolveFriendId, getPlayerState } from '../utils/MajsoulProtocolClient.js';
import { drawSearchResultImg } from '../components/render.js';
import { renderBindingsCard } from '../utils/BindingsCard.js';
import {
  getUserBindings as lookupUserBindings,
  addUserBinding as saveUserBinding,
  removeUserBinding as deleteUserBinding,
  clearUserBindings as wipeUserBindings,
  setMainUid,
  getMainUid as lookupMainUid,
  getUserBindingsDetailed
} from '../utils/MajsoulBindings.js';

export class MajsoulUser extends plugin {
    constructor() {
        super({
            name: '雀魂用户管理',
            dsc: '雀魂玩家搜索与UID绑定管理',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂搜索\\s+(.+)$',
                    fnc: 'searchPlayer'
                },
                {
                    reg: '^#?雀魂绑定\\s+(\\d+)$',
                    fnc: 'bindUid'
                },
                {
                    reg: '^#?雀魂切换\\s+(\\d+)$',
                    fnc: 'switchUid'
                },
                {
                    reg: '^#?雀魂解绑(?:\\s+(\\d+))?$',
                    fnc: 'unbindUid'
                },
                {
                    reg: '^#?雀魂我的绑定$',
                    fnc: 'myBindings'
                },
                {
                    reg: '^#?设置token\\s+(\\S+)$',
                    fnc: 'setPaipuToken'
                }
            ]
        });
        
        this.api = new MajsoulApi();
    }

    /**
     * 统一的指令处理方法（按 this.rule 分发）
     * @param {object} e - 事件对象
     * @returns {Promise<boolean>}
     */
    async handle(e) {
        for (const r of this.rule) {
            if (e.msg && e.msg.match(r.reg)) {
                return await this[r.fnc](e);
            }
        }
        return false;
    }
    
    // 搜索玩家
    async searchPlayer(e) {
        try {
            const match = e.msg.match(/^#?雀魂搜索\s+(.+)$/);
            if (!match) return false;
            
            const playerName = match[1].trim();
            if (!this.api.token) {
                await e.reply(MajsoulApi.TOKEN_HINT);
                return true;
            }
            if (!playerName) {
                await e.reply('请输入要搜索的玩家名称');
                return true;
            }
            
            const [players4, players3] = await Promise.all([
                this.api.searchPlayer(playerName, 4).catch(() => []),
                this.api.searchPlayer(playerName, 3).catch(() => [])
            ]);
            
            const mergedPlayers = {};
            
            for (const p of players4) {
                const uid = p.id.toString();
                const level4 = p.level && p.level.id >= 10000 && p.level.id < 20000 ? { ...p.level } : null;
                if (!mergedPlayers[uid]) {
                    mergedPlayers[uid] = {
                        id: p.id,
                        nickname: p.nickname,
                        level4: level4,
                        level3: null,
                        playedModes4: p.played_modes || [],
                        playedModes3: [],
                        latest_timestamp: p.latest_timestamp
                    };
                } else {
                    mergedPlayers[uid].level4 = level4;
                    mergedPlayers[uid].playedModes4 = p.played_modes || [];
                    if (p.latest_timestamp > (mergedPlayers[uid].latest_timestamp || 0)) {
                        mergedPlayers[uid].latest_timestamp = p.latest_timestamp;
                    }
                }
            }
            
            for (const p of players3) {
                const uid = p.id.toString();
                const level3 = p.level && p.level.id >= 20000 && p.level.id < 30000 ? { ...p.level } : null;
                if (!mergedPlayers[uid]) {
                    mergedPlayers[uid] = {
                        id: p.id,
                        nickname: p.nickname,
                        level4: null,
                        level3: level3,
                        playedModes4: [],
                        playedModes3: p.played_modes || [],
                        latest_timestamp: p.latest_timestamp
                    };
                } else {
                    mergedPlayers[uid].level3 = level3;
                    mergedPlayers[uid].playedModes3 = p.played_modes || [];
                    if (p.latest_timestamp > (mergedPlayers[uid].latest_timestamp || 0)) {
                        mergedPlayers[uid].latest_timestamp = p.latest_timestamp;
                    }
                }
            }
            
            let players = Object.values(mergedPlayers);
            
            // 兜底：牌谱屋搜不到（无金之间对局）时，纯数字输入按好友码走本地 API resolve
            if (players.length === 0 && /^\d{6,12}$/.test(playerName)) {
                const profile = await resolveFriendId(playerName);
                if (profile && profile.accountId != null) {
                    const uid = String(profile.accountId);
                    const merged = {};
                    merged[uid] = {
                        id: profile.accountId,
                        nickname: profile.nickname,
                        level4: profile.level && profile.level.id >= 10000 && profile.level.id < 20000 ? { ...profile.level } : null,
                        level3: profile.level3 && profile.level3.id >= 20000 && profile.level3.id < 30000 ? { ...profile.level3 } : null,
                        playedModes4: [],
                        playedModes3: [],
                        latest_timestamp: 0
                    };
                    players = Object.values(merged);
                }
            }
            
            if (players.length === 0) {
                await e.reply('暂未搜索到该玩家ID噢~\n提示: 该玩家需在金之间有一定数量的对局才能被搜索到；也可使用好友码搜索（#雀魂搜索 <好友码>）');
                return true;
            }
            
            for (const player of players) {
                const level4Backup = player.level4;
                const level3Backup = player.level3;
                
                player.level4 = null;
                player.level3 = null;
                
                if (level4Backup) {
                    try {
                        const stats4 = await this.api.getPlayerStats(player.id, 4);
                        if (stats4 && stats4.level) {
                            const levelId4 = stats4.level.id;
                            if (levelId4 >= 10000 && levelId4 < 20000) {
                                player.level4 = stats4.level;
                            } else {
                                player.level4 = level4Backup;
                            }
                        } else {
                            player.level4 = level4Backup;
                        }
                    } catch (e) {
                        player.level4 = level4Backup;
                    }
                } else {
                    player.level4 = null;
                }
                
                if (level3Backup) {
                    try {
                        const stats3 = await this.api.getPlayerStats(player.id, 3);
                        if (stats3 && stats3.level) {
                            const levelId3 = stats3.level.id;
                            if (levelId3 >= 20000 && levelId3 < 30000) {
                                player.level3 = stats3.level;
                            } else {
                                player.level3 = level3Backup;
                            }
                        } else {
                            player.level3 = level3Backup;
                        }
                    } catch (e) {
                        player.level3 = level3Backup;
                    }
                } else {
                    player.level3 = null;
                }
            }
            
            // 搜索卡片用实时段位（本地 API），订阅播报卡片另由 MajsoulSubscribeCore 渲染，不含实时段位
            const realtimeData = {};
            for (const player of players) {
                try {
                    const brief = await getPlayerBrief(player.id);
                    if (!brief) continue;
                    // 在线状态：仅好友才返回真实值，非好友/查询失败一律 null → 卡片按白色处理。
                    // 用 catch 兜住，避免个别玩家查状态失败拖垮整个搜索卡片。
                    let online = false;
                    try {
                        const st = await getPlayerState(brief.accountId);
                        online = !!(st && st.online);
                    } catch { online = false; }
                    realtimeData[String(brief.accountId)] = {
                        nickname: brief.nickname,
                        uid: String(brief.accountId),
                        isRealTime: true,
                        online,
                        fourPlayer: brief.level ? { levelId: brief.level.id, score: brief.level.score } : null,
                        threePlayer: brief.level3 ? { levelId: brief.level3.id, score: brief.level3.score } : null
                    };
                } catch (error) {
                    logger.warn(`[MajsoulUser] 获取玩家 ${player.id} 实时PT失败:`, error);
                }
            }
            
            const imgBuffer = await drawSearchResultImg(players, realtimeData);
            
            await e.reply(segment.image(imgBuffer));
            
        } catch (error) {
            logger.error('[MajsoulUser] 搜索玩家失败:', error);
            await e.reply('搜索玩家时出现错误，请稍后重试');
        }
        return true;
    }
    
    // 绑定UID
    async bindUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂绑定\s+(\d+)$/);
            if (!match) return false;
            
            const uid = match[1];
            const qid = e.user_id;
            
            // 验证UID格式（支持5-10位数字）
            if (uid.length < 5 || uid.length > 10) {
                await e.reply('UID格式不正确，应为5-10位数字');
                return true;
            }
            
            // 检查是否已绑定
            const existingBind = await this.getUserBindings(qid);
            if (existingBind.includes(uid)) {
                await e.reply(`UID ${uid} 已经绑定过了！`);
                return true;
            }
            
            // 保存绑定
            await this.addUserBinding(qid, uid, e.nickname || '未知用户');
            
            await e.reply(`✅ 成功绑定雀魂UID: ${uid}\n使用【雀魂查询】查看详细数据`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 绑定UID失败:', error);
            await e.reply('绑定UID时出现错误');
        }
        return true;
    }
    
    // 切换绑定
    async switchUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂切换\s+(\d+)$/);
            if (!match) return false;
            
            const uid = match[1];
            const qid = e.user_id;
            
            // 获取当前绑定
            const bindings = await this.getUserBindings(qid);
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何UID');
                return true;
            }
            
            // 检查目标UID是否在绑定列表中
            if (!bindings.includes(uid)) {
                await e.reply(`您尚未绑定UID ${uid}，无法切换\n当前已绑定的UID：${bindings.join(', ')}`);
                return true;
            }
            
            // 设置为主UID
            await setMainUid(qid, uid);
            
            await e.reply(`✅ 已切换主UID为: ${uid}`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 切换UID失败:', error);
            await e.reply('切换UID时出现错误');
        }
        return true;
    }
    
    // 解绑UID
    async unbindUid(e) {
        try {
            const match = e.msg.match(/^#?雀魂解绑(?:\s+(\d+))?$/);
            if (!match) return false;
            
            const targetUid = match[1];
            const qid = e.user_id;
            
            // 获取当前绑定
            const bindings = await this.getUserBindings(qid);
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何UID');
                return true;
            }
            
            // 如果没有指定UID，解绑所有
            if (!targetUid) {
                await this.clearUserBindings(qid);
                await e.reply('✅ 已解绑所有UID');
                return true;
            }
            
            // 解绑指定UID
            if (!bindings.includes(targetUid)) {
                await e.reply(`您尚未绑定UID ${targetUid}`);
                return true;
            }
            
            await this.removeUserBinding(qid, targetUid);
            await e.reply(`✅ 已解绑UID: ${targetUid}\n剩余绑定: ${bindings.filter(id => id !== targetUid).join(', ')}`);
            
        } catch (error) {
            logger.error('[MajsoulUser] 解绑UID失败:', error);
            await e.reply('解绑UID时出现错误');
        }
        return true;
    }
    
    // 查看我的绑定
    async myBindings(e) {
        try {
            const qid = e.user_id;
            const bindings = await this.getUserBindings(qid);
            
            if (bindings.length === 0) {
                await e.reply('您还没有绑定任何雀魂UID\n使用【雀魂绑定+UID】进行绑定');
                return true;
            }
            
            let message = '📋 您的雀魂绑定：\n\n';
            const mainUid = await this.getMainUid(qid); // 修正为调用新的 getMainUid

            // 出图：绑定列表（主账号高亮）+ 头像昵称 + 指令提示
            let cardList = null;
            try {
                const list = bindings.map(uid => ({ uid, isMain: String(uid) === String(mainUid) }));
                // 补雀魂昵称：DB 里存过就直接用，否则按 UID 现查（并发 + 超时保护，查不到就只显示 UID）
                await this._fillMajsoulNames(list, qid);
                cardList = list;
                const nickname = (e.member?.card || e.member?.nickname || e.sender?.card || e.sender?.nickname || '雀魂玩家')
                    .toString().trim().slice(0, 16);
                const image = await renderBindingsCard({
                    bindings: list,
                    nickname,
                    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${String(qid).replace(/[^\d]/g, '')}&s=640`,
                    footer: '切换：#雀魂切换 <UID>　解绑：#雀魂解绑 [UID]'
                });
                await e.reply(segment.image(image), false);
                return true;
            } catch (error) {
                // 渲染失败退回文字，不影响功能
                logger.error('[MajsoulUser] 绑定卡片渲染失败:', error);
            }

            for (let i = 0; i < bindings.length; i++) {
                const uid = bindings[i];
                const isMain = uid === mainUid;
                const name = cardList?.[i]?.name;
                message += `${isMain ? '⭐ ' : '  '}${i + 1}. ${name ? `${name}（UID: ${uid}）` : `UID: ${uid}`}`;
                if (isMain) message += ' (主账号)';
                message += '\n';
            }
            
            message += '\n💡 指令：\n';
            message += '【雀魂切换+UID】切换主账号\n';
            message += '【雀魂解绑+UID】解绑指定账号\n';
            message += '【雀魂解绑】解绑所有账号';
            
            await e.reply(message);
            
        } catch (error) {
            logger.error('[MajsoulUser] 查看绑定失败:', error);
            await e.reply('查看绑定信息时出现错误');
        }
        return true;
    }

    /**
     * 给绑定列表补上雀魂昵称：DB 里存过就直接用，否则按 UID 现查。
     * 并发查询 + 单个 2.5s 超时，查不到就保持只有 UID，不影响出图。
     * @param {Array<{uid:string, name?:string, isMain?:boolean}>} list
     * @param {string|number} qid
     */
    async _fillMajsoulNames(list, qid) {
        if (!Array.isArray(list) || list.length === 0) return;
        const stored = new Map();
        try {
            const rows = await getUserBindingsDetailed(qid);
            for (const r of rows) if (r.nickname) stored.set(String(r.uid), r.nickname);
        } catch { }

        await Promise.all(list.map(async (b) => {
            const uid = String(b.uid);
            if (stored.has(uid)) { b.name = stored.get(uid); return; }
            // 未登录雀魂时不做现查，避免无谓等待
            if (!this.api?.token) return;
            try {
                const brief = await Promise.race([
                    getPlayerBrief(uid),
                    new Promise(resolve => setTimeout(() => resolve(null), 2500))
                ]);
                if (brief?.nickname) b.name = String(brief.nickname);
            } catch { }
        }));
    }

    // ========== 数据库操作方法（委托 utils/MajsoulBindings.js，SQLite 持久化） ==========

    // 获取用户的所有绑定
    async getUserBindings(qid) {
        return lookupUserBindings(qid);
    }

    // 添加绑定
    async addUserBinding(qid, uid, nickname = '') {
        return saveUserBinding(qid, uid, nickname);
    }

    // 移除绑定
    async removeUserBinding(qid, uid) {
        return deleteUserBinding(qid, uid);
    }

    // 清除所有绑定
    async clearUserBindings(qid) {
        return wipeUserBindings(qid);
    }

    // ========== 新增：获取主绑定 UID 方法 ==========
    /**
     * @description 获取用户的主绑定 UID，如果未设置主账号则返回第一个绑定
     * @param {string} qid QQ号
     * @returns {Promise<string|null>} 主UID 或 null
     */
    async getMainUid(qid) {
        return lookupMainUid(qid);
    }

    // 设置牌谱屋 Bearer token（仅机器人主人 master 私聊可操作，写入 data/token.json，避免群聊泄露）
    async setPaipuToken(e) {
        try {
            if (e.message_type !== 'private') {
                await e.reply('⚠️ 为安全起见，设置 token 仅支持私聊机器人使用');
                return true;
            }
            if (!e.isMaster) {
                await e.reply('⚠️ 该指令仅机器人主人可使用');
                return true;
            }
            const token = e.msg.match(/^#?设置token\s+(\S+)$/)[1].trim();
            if (!token) {
                await e.reply('请输入有效的 token，格式：设置token [你的token]');
                return true;
            }
            const ok = MajsoulApi.savePaipuToken(token);
            if (ok) {
                // 立即刷新当前实例的 token，无需重启
                this.api.token = token;
                await e.reply('✅ 牌谱屋 token 已保存至 data/token.json\n玩家查询 / 对局订阅 / 对局记录 / 雀魂搜索等功能已生效。');
            } else {
                await e.reply('❌ token 保存失败，请检查插件 data 目录写入权限。');
            }
        } catch (error) {
            logger.error('[MajsoulUser] 设置 token 失败:', error);
            await e.reply('设置 token 时出现错误');
        }
        return true;
    }
}