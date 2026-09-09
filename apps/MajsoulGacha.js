// plugins/Majsoul-Plugin/apps/MajsoulGacha.js
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import path from 'path';
import GachaCore from '../utils/GachaCore.js';
import GachaCollection from '../utils/GachaCollection.js';
import GachaWallet from '../utils/GachaWallet.js';
import PoolSchedule from '../utils/PoolSchedule.js';
import { ITEM_TYPE } from '../utils/GachaCore.js';
import { appendSummary } from '../utils/CurrencyCard.js';
import { getFeatureConfigItem } from '../utils/Config.js';

export class MajsoulGacha extends plugin {
    constructor() {
        super({
            name: '雀魂抽卡',
            dsc: '雀魂模拟抽卡插件',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂寻觅$',
                    fnc: 'singleGacha'
                },
                {
                    reg: '^#?雀魂十连$',
                    fnc: 'tenGacha'
                },
                // 群员个人卡池切换（仅对个人生效）
                {
                    reg: '^#?(切换|使用)竹林(之路)?$',
                    fnc: 'selectMalePool'
                },
                {
                    reg: '^#?(切换|使用)樱花(之路)?$',
                    fnc: 'selectFemalePool'
                },
                {
                    reg: '^#?切换卡池\\s+(.+)$',
                    fnc: 'selectCustomPool'
                },
                {
                    reg: '^#?重置卡池$',
                    fnc: 'resetUserPool'
                },
                {
                    reg: '^#?我的卡池$',
                    fnc: 'myPool'
                },
                // UP池定时关闭：到点自动退回樱花之路（主人）
                {
                    reg: '^#?设置UP池关闭\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})$',
                    fnc: 'setUpPoolClose',
                    permission: 'master'
                },
                {
                    reg: '^#?取消UP池关闭$',
                    fnc: 'cancelUpPoolClose',
                    permission: 'master'
                },
                // 自定义UP池（挂靠竹林/樱花）：主人创建后全局生效
                {
                    reg: '^#?创建UP池\\s+(.+)$',
                    fnc: 'createUpPool',
                    permission: 'master'
                },
                {
                    reg: '^#?解散UP池$',
                    fnc: 'destroyUpPool',
                    permission: 'master'
                },
                // 联动池开关：联动池（主题池）预先配置，master 开启时指定挂靠樱花/竹林
                {
                    reg: '^#?开启联动\\s+(.+)$',
                    fnc: 'openCollab',
                    permission: 'master'
                },
                {
                    reg: '^#?关闭联动$',
                    fnc: 'closeCollab',
                    permission: 'master'
                },
                {
                    reg: '^#?查看联动池$',
                    fnc: 'viewCollab',
                    permission: 'master'
                },
                // 抽卡开关功能
                {
                    reg: '^#?(开启|关闭)雀魂抽卡$',
                    fnc: 'toggleGacha',
                    permission: 'admin'
                },
                // 查询抽卡开关状态
                {
                    reg: '^#?雀魂抽卡状态$',
                    fnc: 'checkGachaStatus'
                }
            ]
        });
        this.gachaCore = new GachaCore();
        this.collection = new GachaCollection(this.gachaCore);
        this.wallet = new GachaWallet();
        this.poolSchedule = new PoolSchedule(this.gachaCore);
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

    // 单抽（#雀魂寻觅）
    async singleGacha(e) {
        await this._doGacha(e, 1);
        return true;
    }

    // 十连抽卡
    async tenGacha(e) {
        await this._doGacha(e, 10);
        return true;
    }

    /**
     * 统一抽卡流程：检查开关 → 扣费 → 抽卡 → 重复转化与图鉴 → 信仰入账 → 摘要输出
     * @param {object} e
     * @param {1|10} times
     */
    async _doGacha(e, times) {
        if (!e.group_id) {
            await e.reply('雀魂抽卡功能仅限群聊使用');
            return;
        }

        // 检查抽卡开关状态
        try {
            const isEnabled = await this.gachaCore.getGachaStatus(e.group_id);
            if (!isEnabled) {
                await e.reply('本群雀魂抽卡功能已关闭，请联系管理员开启');
                return;
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 检查开关状态失败:', error);
        }

        const singleJade = Math.max(1, Number(getFeatureConfigItem('singleGachaJade')) || 200);
        const tenJade = Math.max(1, Number(getFeatureConfigItem('tenGachaJade')) || 1800);

        // 扣费：卷轴优先于辉玉；十连时单张寻觅卷轴不可用（需十连寻觅卷轴）
        let cost = null;
        let costDesc = '';
        if (times === 1) {
            const wallet = await this.wallet.get(e.user_id);
            if (wallet.ticket >= 1) {
                cost = { ticket: 1 };
                costDesc = '寻觅卷轴 x1';
            } else if (wallet.jade >= singleJade) {
                cost = { jade: singleJade };
                costDesc = `辉玉 x${singleJade}`;
            } else {
                await e.reply(`辉玉不足（需要 ${singleJade}，当前 ${wallet.jade}），且没有寻觅卷轴。\n每日签到可以获得辉玉和寻觅卷轴哦~`, true);
                return;
            }
        } else {
            const wallet = await this.wallet.get(e.user_id);
            if (wallet.ticket10 >= 1) {
                cost = { ticket10: 1 };
                costDesc = '十连寻觅卷轴 x1';
            } else if (wallet.jade >= tenJade) {
                cost = { jade: tenJade };
                costDesc = `辉玉 x${tenJade}`;
            } else {
                const ticketHint = wallet.ticket >= 1 ? '（单张寻觅卷轴无法十连，寻觅卷轴仅可用于单抽）' : '';
                await e.reply(`辉玉不足（需要 ${tenJade}，当前 ${wallet.jade}），且没有十连寻觅卷轴。${ticketHint}\n每日签到可以获得辉玉和寻觅卷轴哦~`, true);
                return;
            }
        }

        const spendResult = await this.wallet.spend(e.user_id, cost);
        if (!spendResult.ok) {
            await e.reply(`${spendResult.lack}不足，无法寻觅~`, true);
            return;
        }

        try {
            const { imageBase64, results, hasGuaranteed, poolName } = await this.gachaCore.runGacha(e.group_id, times, e.user_id);

            // 处理结果：礼物直接转粉尘；装扮/雀士首入图鉴、重复转石/许愿石
            const gains = { jade: 0, ticket: 0, ticket10: 0, dust: 0, stone: 0, wish: 0, faith: times };
            const charCounts = {};
            const decorCounts = {};
            const charConv = {};   // 重复雀士转化的许愿石数量（按名字累计）
            const decorConv = {};  // 重复装扮转化的星之石数量（按名字累计）
            const giftCounts = { blue: 0, purple: 0 };

            for (const [objInt, fileName] of results) {
                const name = path.parse(fileName).name;
                if (objInt === ITEM_TYPE.GIFT_BLUE) {
                    giftCounts.blue++;
                    gains.dust += 5;
                } else if (objInt === ITEM_TYPE.GIFT_PURPLE) {
                    giftCounts.purple++;
                    gains.dust += 25;
                } else if (objInt === ITEM_TYPE.DECORATION) {
                    decorCounts[name] = (decorCounts[name] || 0) + 1;
                    const { isNew } = await this.collection.add(e.user_id, 'decorations', name);
                    if (!isNew) {
                        decorConv[name] = (decorConv[name] || 0) + 5; // 重复装扮 → 5 星之石
                        gains.stone += 5;
                    }
                } else if (objInt === ITEM_TYPE.CHARACTER) {
                    charCounts[name] = (charCounts[name] || 0) + 1;
                    const { isNew } = await this.collection.add(e.user_id, 'characters', name);
                    if (!isNew) {
                        // 重复雀士：限定 150 / 普通 75 许愿石
                        const isLimited = await this.collection.isLimitedCharacter(name);
                        const amount = isLimited ? 150 : 75;
                        charConv[name] = (charConv[name] || 0) + amount;
                        gains.wish += amount;
                    }
                }
            }

            // 聚合展示（去重并标注次数，重复项内联标注转换结果）
            const mergeShow = (counts, convMap, convName) => Object.entries(counts).map(([n, c]) => {
                const tag = convMap[n] ? `（已转换${convName}x${convMap[n]}）` : '';
                return c > 1 ? `${n}x${c}${tag}` : `${n}${tag}`;
            });
            const charShown = mergeShow(charCounts, charConv, '许愿石');
            const decorShown = mergeShow(decorCounts, decorConv, '星之石');

            // 货币入账（自动兑换在后台静默完成，不外显转化过程，仅体现寻觅卷轴数量变化）
            const ticketBefore = spendResult.wallet.ticket;
            const { wallet: newWallet } = await this.wallet.add(e.user_id, gains);
            const ticketGain = Math.max(0, newWallet.ticket - ticketBefore);

            // 纯图片输出：结果图 + 摘要条（拼接到结果图下方）
            const poolTitle = await this.gachaCore.getPoolDisplayTitle(poolName);
            const label = times === 1 ? '单次寻觅结果' : '十连寻觅结果';
            let titleLine = `${poolTitle}｜${label}（${costDesc}）`;
            if (times === 10 && hasGuaranteed) {
                titleLine += '｜含保底';
            }
            const lines = [];
            if (charShown.length > 0) {
                lines.push(`雀士：${charShown.join('、')}`);
            }
            if (decorShown.length > 0) {
                lines.push(`装饰：${decorShown.join('、')}`);
            }
            if (giftCounts.blue + giftCounts.purple > 0) {
                const giftParts = [];
                if (giftCounts.blue > 0) giftParts.push(`中级礼物x${giftCounts.blue}`);
                if (giftCounts.purple > 0) giftParts.push(`高级礼物x${giftCounts.purple}`);
                const giftDust = giftCounts.blue * 5 + giftCounts.purple * 25;
                lines.push(`礼物：${giftParts.join('、')}（已全部奉纳为星之粉尘x${giftDust}）`);
            }
            lines.push(`信仰 +${times}（当前 ${newWallet.faith}）｜寻觅卷轴 ${newWallet.ticket}${ticketGain > 0 ? `（+${ticketGain}）` : ''}｜辉玉 ${newWallet.jade}`);

            const finalImage = await appendSummary(imageBase64, titleLine, lines);
            await e.reply(segment.image(finalImage), true);

        } catch (error) {
            logger.error('[雀魂抽卡] 抽卡失败:', error);
            // 抽卡失败，原路退还
            await this.wallet.refund(e.user_id, cost);
            if (error.message && error.message.includes('抽卡功能已关闭')) {
                await e.reply('本群雀魂抽卡功能已关闭，请联系管理员开启');
            } else {
                await e.reply('抽卡过程出现异常，已退还本次消耗，请联系维护者。', true);
            }
        }
    }

    // 开关抽卡功能
    async toggleGacha(e) {
        const match = e.msg.match(/^#?(开启|关闭)雀魂抽卡$/);
        if (!match || !e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }

        const action = match[1];
        const isEnable = action === '开启';

        try {
            const success = await this.gachaCore.setGachaStatus(e.group_id, isEnable);
            if (success) {
                const statusText = isEnable ? '开启' : '关闭';
                await e.reply(`已${statusText}本群雀魂抽卡功能`);

                // 如果是关闭操作，额外提示
                if (!isEnable) {
                    await e.reply('提示：关闭后，所有成员将无法使用雀魂抽卡功能');
                }
            } else {
                await e.reply('操作失败，请重试或联系维护者');
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 切换开关失败:', error);
            await e.reply('操作失败，系统异常');
        }
        return true;
    }

    // 查询抽卡开关状态
    async checkGachaStatus(e) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }

        try {
            const isEnabled = await this.gachaCore.getGachaStatus(e.group_id);
            const statusText = isEnabled ? '开启' : '关闭';
            const replyMsg = [
                `群 ${e.group_id} 雀魂抽卡功能状态：`,
                `${statusText}`,
                '',
                isEnabled
                    ? '成员可以使用 #雀魂寻觅 / #雀魂十连 进行抽卡'
                    : '抽卡功能已禁用，请联系管理员开启'
            ].join('\n');

            await e.reply(replyMsg);
        } catch (error) {
            logger.error('[雀魂抽卡] 查询状态失败:', error);
            await e.reply('查询失败，系统异常');
        }
        return true;
    }

    // 查看卡池（全局池 + 个人当前卡池 + 当前可用池列表）
    async viewPool(e) {
        try {
            let userPick = null;
            try {
                if (e.group_id && e.user_id) {
                    userPick = await redis.get(`Yunzai:majsoul_gacha:userpool:${e.group_id}:${e.user_id}`);
                }
            } catch {}
            let globalPool = null;
            try {
                globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
            } catch {}
            // 当前生效池：个人选择 > 全局池 > 默认樱花之路
            const current = userPick || globalPool || 'female';
            const parts = [`当前卡池：${await this.gachaCore.getPoolDisplayTitle(current)}`];
            const ups = await this._getUpCharacters(current);
            if (ups) parts.push(`UP雀士：${ups}`);
            // 当前可用池（仅池名，去重；临时池带关闭倒计时）
            const countdown = await this._poolCountdownText();
            const pools = (await this.gachaCore.getAvailablePools()).map(p => {
                const name = p.name.replace(/（[^）]*）/, '');
                const isTemp = p.id !== 'male' && p.id !== 'female';
                return isTemp && countdown ? `${name}（${countdown}后关闭）` : name;
            });
            parts.push(`当前可用池：${[...new Set(pools)].join('、')}`);
            parts.push('切换命令：切换竹林 / 切换樱花 / 切换卡池 <池名> / 重置卡池');
            await e.reply(parts.join('\n'), true);
        } catch (error) {
            logger.error('[雀魂抽卡] 查看卡池失败:', error);
            await e.reply('查看卡池失败，可能是配置文件读取错误。');
        }
        return true;
    }

    // 获取池子的UP雀士名单（自定义UP池/联动池变体），无则返回 null
    async _getUpCharacters(poolId) {
        try {
            if (typeof poolId === 'string' && poolId.startsWith('custom:')) {
                const custom = await this.gachaCore.customPoolLoader();
                const ups = Array.isArray(custom?.[poolId.slice('custom:'.length)]?.characters)
                    ? custom[poolId.slice('custom:'.length)].characters : [];
                return ups.length > 0 ? ups.join('、') : null;
            }
            if (typeof poolId === 'string' && poolId.includes('|')) {
                poolId = poolId.split('|')[0];
            }
            if (typeof poolId === 'string' && poolId && poolId !== 'male' && poolId !== 'female'
                && !poolId.startsWith('custom:')) {
                const pool = await this.gachaCore.gachaLoader();
                const ups = Array.isArray(pool[poolId]) ? pool[poolId] : [];
                return ups.length > 0 ? ups.join('、') : null;
            }
        } catch {}
        return null;
    }

    // UP池关闭倒计时文本（如：2天5小时），未设置或已过期返回空串
    async _poolCountdownText() {
        try {
            const schedule = await this.poolSchedule.get();
            if (!schedule?.endAt) return '';
            const ms = new Date(String(schedule.endAt).replace('-', '/')).getTime() - Date.now();
            if (ms <= 0) return '';
            const hours = Math.floor(ms / 3600000);
            const days = Math.floor(hours / 24);
            const h = hours % 24;
            if (days > 0) return `${days}天${h}小时`;
            if (hours > 0) return `${hours}小时`;
            return '不足1小时';
        } catch {
            return '';
        }
    }

    // 群员个人卡池选择（Redis：Yunzai:majsoul_gacha:userpool:{gid}:{uid}，仅对个人生效）
    async _setUserPool(e, poolId) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return false;
        }
        try {
            await redis.set(`Yunzai:majsoul_gacha:userpool:${e.group_id}:${e.user_id}`, poolId);
            return true;
        } catch (error) {
            logger.error('[雀魂抽卡] 保存个人卡池选择失败:', error);
            await e.reply('切换失败，系统异常', true);
            return false;
        }
    }

    // #切换竹林
    async selectMalePool(e) {
        if (await this._setUserPool(e, 'male')) {
            await e.reply(`已切换到${this.gachaCore.getPoolName('male')}`, true);
        }
        return true;
    }

    // #切换樱花
    async selectFemalePool(e) {
        if (await this._setUserPool(e, 'female')) {
            await e.reply(`已切换到${this.gachaCore.getPoolName('female')}`, true);
        }
        return true;
    }

    // #切换卡池 <池名>（自定义UP池或已开启联动的樱花/竹林特别寻觅）
    async selectCustomPool(e) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?切换卡池\s+(.+)$/);
        const tokens = match?.[1]?.trim().split(/[\s,，、]+/).filter(Boolean) || [];
        const name = tokens[0];
        let custom = null;
        try {
            custom = await this.gachaCore.customPoolLoader();
        } catch (error) {
            logger.error('[雀魂抽卡] 读取UP池配置失败:', error);
        }

        // 自定义UP池
        if (name && custom && custom[name]) {
            if (await this._setUserPool(e, `custom:${name}`)) {
                const ups = Array.isArray(custom[name].characters) ? custom[name].characters.join('、') : '';
                await e.reply(`已切换到「${name}」${ups ? `，UP雀士：${ups}` : ''}`, true);
            }
            return true;
        }

        // 联动池变体：#切换卡池 <联动池名> <樱花/竹林>（联动开启时可用）
        if (name && tokens.length >= 2 && /^(樱花|竹林)$/.test(tokens[1])) {
            const poolId = this.gachaCore.getPoolId(name);
            let globalPool = null;
            try {
                globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
            } catch {}
            if (poolId && poolId === globalPool && !poolId.startsWith('custom:')) {
                const variant = tokens[1] === '樱花' ? 'female' : 'male';
                if (await this._setUserPool(e, `${poolId}|${variant}`)) {
                    const title = await this.gachaCore.getPoolDisplayTitle(`${poolId}|${variant}`);
                    const ups = await this._getUpCharacters(`${poolId}|${variant}`);
                    await e.reply(`已切换到 ${title}${ups ? `，UP雀士：${ups}` : ''}`, true);
                }
                return true;
            }
            if (poolId) {
                await e.reply(`联动池「${this.gachaCore.getPoolName(poolId)}」未开启，等主人开启后才能切换`, true);
                return true;
            }
        }

        const existing = custom ? Object.keys(custom) : [];
        await e.reply(
            existing.length > 0
                ? `没有找到UP池「${name || ''}」，现有：${existing.join('、')}\n联动池变体切换：#切换卡池 <联动池名> <樱花/竹林>`
                : '当前没有UP池，可联系管理员用 #创建UP池 创建\n联动开启时可用 #切换卡池 <联动池名> <樱花/竹林> 切换联动池',
            true
        );
        return true;
    }

    // #重置卡池（回全局池；未设全局池时为默认樱花之路）
    async resetUserPool(e) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }
        try {
            await redis.del(`Yunzai:majsoul_gacha:userpool:${e.group_id}:${e.user_id}`);
            await e.reply('已重置，将跟随全局池（未设置全局池时为樱花之路）', true);
        } catch (error) {
            logger.error('[雀魂抽卡] 重置个人卡池失败:', error);
            await e.reply('重置失败，系统异常', true);
        }
        return true;
    }

    // #我的卡池
    async myPool(e) {
        return await this.viewPool(e);
    }

    // 创建自定义UP池（主人）：#创建UP池 <池名> <樱花|竹林> [贵人] <雀士名>...
    // 挂靠性别池：未命中UP时从挂靠的竹林/樱花名单抽（不与常驻大混池）
    // 全局默认池仅在无活跃UP池时自动设置（多池并存不覆盖）；装扮与礼物全量一致
    async createUpPool(e) {
        const match = e.msg.match(/^#?创建UP池\s+(.+)$/);
        if (!match) return false;

        const tokens = match[1].trim().split(/[\s,，、]+/).filter(Boolean);
        if (tokens.length < 3) {
            await e.reply('格式：#创建UP池 <池名> <樱花/竹林> [贵人] <雀士名>...\n' +
                '如：#创建UP池 Fate联动 樱花 贵人 阿尔托莉雅（挂樱花，20%UP）\n' +
                '或：#创建UP池 春活 樱花 五十岚阳菜（挂樱花，缺省普通 59%UP）', true);
            return true;
        }

        const poolName = tokens[0];
        // 挂靠池：必须指定 樱花 或 竹林
        let base = null;
        let nameTokens = tokens.slice(1);
        if (nameTokens[0] === '樱花') {
            base = 'female';
        } else if (nameTokens[0] === '竹林') {
            base = 'male';
        } else {
            await e.reply('请指定挂靠池：樱花 或 竹林（联动池未命中UP时将从该池抽雀士/装扮）\n格式：#创建UP池 <池名> <樱花/竹林> [贵人] <雀士名>...', true);
            return true;
        }
        nameTokens = nameTokens.slice(1);

        let upRate = 59;
        let typeText = '普通';
        if (/^(贵人|限定)$/.test(nameTokens[0])) {
            upRate = 20;
            typeText = '贵人';
            nameTokens = nameTokens.slice(1);
        } else if (/^(联动|普通)$/.test(nameTokens[0])) {
            upRate = 59;
            nameTokens = nameTokens.slice(1);
        }
        const names = [...new Set(nameTokens)];
        if (names.length === 0) {
            await e.reply('请指定至少一个雀士名，雀士名需与雀士文件名一致', true);
            return true;
        }

        try {
            await this.gachaCore._buildCharacterFileMap();
            const fileMap = this.gachaCore.characterFileMap;
            const invalid = names.filter(name => !fileMap.get(name));
            if (invalid.length > 0) {
                await e.reply(`以下雀士名无法识别（需与雀士文件名一致）：${invalid.join('、')}`, true);
                return true;
            }

            const custom = (await this.gachaCore.customPoolLoader()) || {};
            custom[poolName] = { characters: names, upRate, base };
            await this.gachaCore.saveCustomPool(custom);

            const poolId = `custom:${poolName}`;
            const baseText = base === 'female' ? '樱花之路' : '竹林之路';

            // 全局默认池：仅在当前无活跃自定义UP池时自动设置（多池并存时新池不覆盖旧池）
            let currentGlobal = null;
            try {
                currentGlobal = await redis.get('Yunzai:majsoul_gacha:globalpool');
            } catch {}
            let globalChanged = true;
            let activeGlobalName = null;
            if (currentGlobal && currentGlobal.startsWith('custom:')) {
                activeGlobalName = currentGlobal.slice('custom:'.length);
                if (custom[activeGlobalName]) {
                    globalChanged = false; // 已有活跃UP池为全局默认，保持不变
                }
            }
            if (globalChanged) {
                await redis.set('Yunzai:majsoul_gacha:globalpool', poolId);
            }

            const globalText = globalChanged
                ? `该池已全局生效（机器人所在所有群默认抽该池）`
                : `当前全局默认池仍为「${activeGlobalName}」，群员可 #切换卡池 ${poolName} 切换到新池`;
            await e.reply(
                `UP池「${poolName}」已创建：${names.join('、')}\n` +
                `挂靠：${baseText}（未命中UP时从${baseText}抽雀士，不与常驻混池）\n` +
                `类型：${typeText}（UP雀士概率 ${upRate}%）\n` +
                globalText + '\n' +
                `可搭配 #设置UP池关闭 时间 到点自动退回樱花之路`,
                true
            );
        } catch (error) {
            logger.error('[雀魂抽卡] 创建UP池失败:', error);
            await e.reply('创建UP池失败，系统异常', true);
        }
        return true;
    }

    // 解散自定义UP池：#解散UP池 <池名>，个人选择与全局池指向该池时退回樱花之路
    async destroyUpPool(e) {
        const match = e.msg.match(/^#?解散UP池(?:\s+(.+))?$/);
        const poolName = match?.[1]?.trim();
        try {
            const custom = (await this.gachaCore.customPoolLoader()) || {};
            const existing = Object.keys(custom);
            if (existing.length === 0) {
                await e.reply('当前没有UP池', true);
                return true;
            }
            if (!poolName || !custom[poolName]) {
                await e.reply(`请指定要解散的池名，现有：${existing.join('、')}\n如：#解散UP池 ${existing[0]}`, true);
                return true;
            }

            delete custom[poolName];
            if (Object.keys(custom).length === 0) {
                await this.gachaCore.removeCustomPool();
            } else {
                await this.gachaCore.saveCustomPool(custom);
            }

            const poolId = `custom:${poolName}`;

            // 清理指向该池的用户个人选择（跟随全局池）
            let userAffected = 0;
            try {
                const keys = await redis.keys('Yunzai:majsoul_gacha:userpool:*');
                for (const k of keys) {
                    if (await redis.get(k) === poolId) {
                        await redis.del(k);
                        userAffected++;
                    }
                }
            } catch (error) {
                logger.error('[雀魂抽卡] 清理个人卡池选择失败:', error);
            }

            // 全局池若指向该池，退回樱花之路并清理挂靠配置
            try {
                if (await redis.get('Yunzai:majsoul_gacha:globalpool') === poolId) {
                    await redis.set('Yunzai:majsoul_gacha:globalpool', 'female');
                    await redis.del('Yunzai:majsoul_gacha:globalbase');
                }
            } catch (error) {
                logger.error('[雀魂抽卡] 清理全局卡池失败:', error);
            }

            const extra = [];
            if (userAffected > 0) extra.push(`${userAffected} 位群友的个人选择已重置`);
            await e.reply(`UP池「${poolName}」已解散${extra.length > 0 ? `，${extra.join('，')}` : ''}`, true);
        } catch (error) {
            logger.error('[雀魂抽卡] 解散UP池失败:', error);
            await e.reply('解散UP池失败，系统异常', true);
        }
        return true;
    }

    // 开启联动池（主人）：联动池（主题池）资源已预先配置
    // 开启后樱花+竹林双池同时可用（池名自带"樱花/竹林"的只开对应单池），全局默认抽樱花变体
    // UP率为主题池内置 59%，可搭配 #设置UP池关闭 定时退回
    async openCollab(e) {
        const match = e.msg.match(/^#?开启联动\s+(.+)$/);
        if (!match) return false;

        const input = match[1].trim().split(/[\s,，、]+/)[0];
        const poolId = this.gachaCore.getPoolId(input);
        if (!poolId || ['male', 'female', 'normal'].includes(poolId) || poolId.startsWith('custom:')) {
            await e.reply('没有找到该联动池，可用 #查看联动池 查看已配置的联动池\n格式：#开启联动 <联动池名>', true);
            return true;
        }

        try {
            const data = await this.gachaLoader();
            if (!data[poolId]) {
                await e.reply('没有找到该联动池，可用 #查看联动池 查看已配置的联动池\n格式：#开启联动 <联动池名>', true);
                return true;
            }
            await redis.set('Yunzai:majsoul_gacha:globalpool', poolId);
            await redis.del('Yunzai:majsoul_gacha:globalbase');
            const name = this.gachaCore.getPoolName(poolId);
            const dual = !/樱花|竹林/.test(name);
            const poolInfo = dual
                ? `默认抽 ${name}（樱花特别寻觅），群友可 #切换卡池 ${input} 竹林 切到 ${name}（竹林特别寻觅）`
                : `默认抽 ${name}`;
            await e.reply(
                `联动池「${name}」已开启并全局生效（樱花与竹林两池都开）：${poolInfo}\n` +
                `UP雀士概率 59%，未命中UP时从对应性别池抽雀士（不与常驻混池）\n` +
                `可搭配 #设置UP池关闭 时间 到点自动退回樱花之路，或 #关闭联动 立即关闭`,
                true
            );
        } catch (error) {
            logger.error('[雀魂抽卡] 开启联动失败:', error);
            await e.reply('开启联动失败，系统异常', true);
        }
        return true;
    }

    // 关闭联动池（主人）：全局池退回樱花之路
    async closeCollab(e) {
        try {
            const globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
            if (globalPool && globalPool !== 'female' && globalPool !== 'male') {
                await redis.set('Yunzai:majsoul_gacha:globalpool', 'female');
                await redis.del('Yunzai:majsoul_gacha:globalbase');
                await e.reply(`联动池「${this.gachaCore.getPoolName(globalPool)}」已关闭，全局池退回樱花之路`, true);
            } else {
                await e.reply('当前没有开启的联动池', true);
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 关闭联动失败:', error);
            await e.reply('关闭联动失败，系统异常', true);
        }
        return true;
    }

    // 查看已配置的联动池（主题池）列表
    async viewCollab(e) {
        const data = await this.gachaCore.gachaLoader();
        const known = ['male', 'female', 'normal', 'purple_gift'];
        const names = Object.keys(data).filter(id => !known.includes(id) && !id.startsWith('custom:') && !id.startsWith('__'));
        if (names.length === 0) {
            await e.reply('没有已配置的联动池');
            return true;
        }
        // 标注当前开启的联动
        let globalPool = null;
        try {
            globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
        } catch {}
        const lines = names.map(id => {
            const on = id === globalPool ? '【开启中】' : '';
            return `${on}${this.gachaCore.getPoolName(id)}（${id}）：UP雀士 ${(data[id] || []).join('、')}`;
        });
        await e.reply(lines.join('\n'));
        return true;
    }

    // 设置UP池关闭时间（到点自动把全局池退回樱花之路）
    async setUpPoolClose(e) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?设置UP池关闭\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/);
        if (!match) return false;

        const result = await this.poolSchedule.set(match[1]);
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        await e.reply(`已设置：${result.endAt} 自动关闭UP池，届时全局池将退回樱花之路，处于UP池的个人选择同步重置`, true);
        return true;
    }

    // 取消UP池定时关闭
    async cancelUpPoolClose(e) {
        await this.poolSchedule.cancel();
        await e.reply('已取消UP池定时关闭', true);
        return true;
    }

}
