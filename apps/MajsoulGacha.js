// plugins/Majsoul-Plugin/apps/MajsoulGacha.js
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import path from 'path';
import GachaCore from '../utils/GachaCore.js';
import GachaCollection from '../utils/GachaCollection.js';
import GachaWallet from '../utils/GachaWallet.js';
import GachaStats from '../utils/GachaStats.js';
import PoolSchedule from '../utils/PoolSchedule.js';
import { ITEM_TYPE } from '../utils/GachaCore.js';
import { renderGachaResultCard } from '../utils/GachaResultCard.js';
import { renderPoolListCard, renderPoolScheduleCard } from '../utils/PoolListCard.js';
import { CURRENCY_ICONS } from '../utils/CurrencyCard.js';
import { getFeatureConfigItem } from '../utils/Config.js';
import { getSetting, setSetting, delSetting, getSettingsByPrefix } from '../utils/SettingsStore.js';

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
                    reg: '^#?查看卡池$',
                    fnc: 'viewPool'
                },
                {
                    reg: '^#?设置全局池\\s+(.+)$',
                    fnc: 'setGlobalPool'
                },
                // 卡池定时开关：每个卡池独立的开启/结束时间，到点自动执行（主人）
                {
                    reg: '^#?设置卡池开启\\s+(.+)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})$',
                    fnc: 'setPoolOpen',
                    permission: 'master'
                },
                {
                    reg: '^#?设置卡池关闭\\s+(.+)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})$',
                    fnc: 'setPoolClose',
                    permission: 'master'
                },
                {
                    reg: '^#?取消卡池开启\\s+(.+)$',
                    fnc: 'cancelPoolOpen',
                    permission: 'master'
                },
                {
                    reg: '^#?取消卡池关闭\\s+(.+)$',
                    fnc: 'cancelPoolClose',
                    permission: 'master'
                },
                {
                    reg: '^#?查看卡池计划$',
                    fnc: 'viewPoolSchedule',
                    permission: 'master'
                },
                // 自定义UP池（挂靠竹林/樱花）：主人创建后全局生效
                {
                    reg: '^#?创建UP池\\s+(.+)$',
                    fnc: 'createUpPool',
                    permission: 'master'
                },
                {
                    reg: '^#?解散UP池(?:\\s+(.+))?$',
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
        this.stats = new GachaStats();
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

        // 每 30 分钟寻觅次数上限（防刷屏，余额充足也不放行；配置为 0 表示不限制）
        const limitField = times === 1 ? 'halfHourSinglePullLimit' : 'halfHourTenPullLimit';
        const halfHourLimit = Math.max(0, Math.floor(Number(getFeatureConfigItem(limitField)) || 0));
        // 以自然半小时为窗口（整点/半点重置），slot 作 key 一部分，TTL 仅作垃圾回收
        const slot = Math.floor(Date.now() / (30 * 60 * 1000));
        const cntKey = `Yunzai:majsoul_pullcnt:${times === 1 ? 'single' : 'ten'}:${e.user_id}:${slot}`;
        let usedInWindow = 0;
        if (halfHourLimit > 0) {
            try {
                usedInWindow = Number(await redis.get(cntKey)) || 0;
            } catch {}
            if (usedInWindow >= halfHourLimit) {
                const remainMin = Math.max(1, Math.ceil(((slot + 1) * 30 * 60 * 1000 - Date.now()) / 60000));
                await e.reply(`寻觅太频繁啦，每 30 分钟限 ${halfHourLimit} 次，请 ${remainMin} 分钟后再试~`, true);
                return;
            }
        }

        const singleJade = Math.max(1, Number(getFeatureConfigItem('singleGachaJade')) || 200);
        const tenJade = Math.max(1, Number(getFeatureConfigItem('tenGachaJade')) || 1800);

        // 扣费：卷轴优先于辉玉；十连时单张寻觅卷轴不可用（需十连寻觅卷轴）
        let cost = null;
        if (times === 1) {
            const wallet = await this.wallet.get(e.user_id);
            if (wallet.ticket >= 1) {
                cost = { ticket: 1 };
            } else if (wallet.jade >= singleJade) {
                cost = { jade: singleJade };
            } else {
                await e.reply(`辉玉不足（需要 ${singleJade}，当前 ${wallet.jade}），且没有寻觅卷轴。\n每日签到可以获得辉玉和寻觅卷轴哦~`, true);
                return;
            }
        } else {
            const wallet = await this.wallet.get(e.user_id);
            if (wallet.ticket10 >= 1) {
                cost = { ticket10: 1 };
            } else if (wallet.jade >= tenJade) {
                cost = { jade: tenJade };
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

        // 扣费成功才计入本半小时次数（1 小时过期，窗口切换自动作废）
        if (halfHourLimit > 0) {
            try {
                await redis.set(cntKey, usedInWindow + 1, { EX: 3600 });
            } catch {}
        }

        try {
            // 只需 results / hasGuaranteed / poolName；结果图由 renderGachaResultCard 重新合成
            const { results, hasGuaranteed, poolName } = await this.gachaCore.runGacha(e.group_id, times, e.user_id);

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
            const walletBefore = spendResult.wallet;
            const { wallet: newWallet } = await this.wallet.add(e.user_id, gains);
            const ticketGain = Math.max(0, newWallet.ticket - walletBefore.ticket);

            // ---- 新的结果卡：官方素材三层合成（樱花背景 + 发光层 + 标题）----
            const poolTitle = await this.gachaCore.getPoolDisplayTitle(poolName);
            const totalPullsNow = await this.stats.add(e.user_id, times);
            let titleLine = `${poolTitle}｜累计寻觅 ${totalPullsNow} 次`;
            if (times === 10 && hasGuaranteed) titleLine += '｜含保底';

            // 物品列表：按抽取顺序逐项展示（十连即 10 个格子，重复物品不合并，与官方一致）
            const KIND_MAP = {
                [ITEM_TYPE.CHARACTER]: 'character',
                [ITEM_TYPE.DECORATION]: 'decoration',
                [ITEM_TYPE.GIFT_BLUE]: 'gift_blue',
                [ITEM_TYPE.GIFT_PURPLE]: 'gift_purple'
            };
            const tagOf = (fileName) => {
                // 重复转化标注：雀士→许愿石、装扮→星之石
                if (charConv[fileName]) return `已转换许愿石x${charConv[fileName]}`;
                if (decorConv[fileName]) return `已转换星之石x${decorConv[fileName]}`;
                return null;
            };
            const items = results.map(([objInt, fileName]) => ({
                name: fileName,
                kind: KIND_MAP[objInt],
                count: 1,
                tag: tagOf(fileName)
            }));

            // 货币行：只列本次真实变化的项（辉玉为消耗，显示负增量）
            const wallet = [];
            // 消耗的货币（cost 里非零项）
            for (const [key, spent] of Object.entries(cost || {})) {
                if (spent > 0) wallet.push({ icon: CURRENCY_ICONS[key], count: newWallet[key], delta: -spent });
            }
            // 获得的货币（gains 里非零项；信仰每次 +times，单抽 +1 / 十连 +10）
            for (const key of ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith']) {
                const g = gains[key] || 0;
                if (g > 0) wallet.push({ icon: CURRENCY_ICONS[key], count: newWallet[key], delta: g });
            }
            // 自动兑换产生的卷轴增量（ticketGain 与 gains.ticket 不同，来自粉尘/石头的兑换链）
            if (ticketGain > (gains.ticket || 0)) {
                wallet.push({ icon: CURRENCY_ICONS.ticket, count: newWallet.ticket, delta: ticketGain });
            }

            // UP / 限定名单（用于结果图角标）
            const upNames = await this._getUpCharacterList(poolName);
            const upDecorNames = await this._getUpDecorationList(poolName);
            const limitedNames = await this._getLimitedNames(poolName);

            const image = await renderGachaResultCard({
                title: titleLine,
                items,
                wallet,
                poolName,
                upNames,
                upDecorNames,
                limitedNames,
                nickname: (e.member?.card || e.member?.nickname || e.sender?.card || e.sender?.nickname || '雀魂玩家')
                    .toString().trim().slice(0, 16),
                avatar: `https://q1.qlogo.cn/g?b=qq&nk=${String(e.user_id).replace(/[^\d]/g, '')}&s=640`
            });
            // 不引用回复（quote=false）：结果图直接发出
            await e.reply(segment.image(image), false);

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

    // 查看卡池（图片呈现：当前卡池 + UP 雀士 + 可用卡池列表）
    async viewPool(e) {
        try {
            // 当前实际生效池：个人选择 > 全局池 > 默认樱花之路（联动池解析为对应变体）
            let current = 'female';
            try {
                current = await this.gachaCore.resolveUserPool(e.group_id, e.user_id);
            } catch {}
            const currentName = await this.gachaCore.getPoolDisplayTitle(current);
            // UP 雀士用头像呈现，取原始数组（不用拼接后的字符串）
            const upNames = await this._getUpCharacterList(current).catch(() => []);
            // 当前池的 UP 装扮（联动池/自定义UP池才有），同样显示在上方
            const upDecorNames = await this._getUpDecorationList(current).catch(() => []);

            // 当前可用池（联动池保留樱花/竹林变体后缀，两池都显示）
            // 未到开启时间的池只对主人可见（includePending），普通用户完全看不到
            const isMaster = !!e.isMaster;
            const poolList = await this.gachaCore.getAvailablePools(isMaster);
            const pools = [];
            const seen = new Set();
            for (const p of poolList) {
                const name = p.id.includes('|') ? p.name : p.name.replace(/（[^）]*）/, '');
                if (seen.has(name)) continue;
                seen.add(name);
                const st = (p.id !== 'male' && p.id !== 'female')
                    ? await this._poolScheduleState(p.id)
                    : { state: 'none', text: '' };
                // 未开启的池（仅主人可见）不显示「剩余时间」，用「X后开启」文字
                const isPending = p.pending || st.state === 'pending';
                // 非当前池也要列出 UP 雀士/装扮，方便用户判断该切到哪个池
                const rowUpChars = await this._getUpCharacterList(p.id).catch(() => []);
                const rowUpDecor = await this._getUpDecorationList(p.id).catch(() => []);
                pools.push({
                    name,
                    // 池 id（装扮目录名用它定位，显示名与目录名不同）
                    id: p.id,
                    countdown: isPending ? '' : (st.state === 'open' ? st.text : ''),
                    pendingText: isPending ? st.text : '',
                    // 联动池 id 形如 saki1|female；贵人池为 custom:<池名>，两者需区分
                    // 贵人池暂无「特定装扮UP」，只有联动池带该标签
                    isCollab: p.id.includes('|'),
                    isCurrent: p.id === current,
                    upNames: rowUpChars,
                    upDecorNames: rowUpDecor
                });
            }
            // 候选中没命中当前池时（如自定义UP池），补一行当前池，保证列表里有高亮项
            if (currentName && !pools.some(p => p.isCurrent)) {
                pools.unshift({
                    name: currentName,
                    id: current,
                    countdown: '',
                    isCurrent: true,
                    upNames,
                    upDecorNames
                });
            }

            const image = await renderPoolListCard({
                currentName,
                // 当前池 id（UP 装扮目录名用它定位）
                currentPoolId: current,
                upNames,
                upDecorNames,
                // 当前池的剩余时间（限时池才显示在「当前使用」旁边）
                currentCountdown: (() => {
                    const cur = pools.find(p => p.isCurrent);
                    return cur ? (cur.countdown || cur.pendingText || '') : '';
                })(),
                pools,
                // 卡池是个人选择，图上标注是谁的卡池
                nickname: (e.member?.card || e.member?.nickname || e.sender?.card || e.sender?.nickname || '雀魂玩家')
                    .toString().trim().slice(0, 16),
                avatar: `https://q1.qlogo.cn/g?b=qq&nk=${String(e.user_id).replace(/[^\d]/g, '')}&s=640`,
                footer: '切换：切换竹林 / 切换樱花 / 切换卡池 <池名> / 重置卡池'
            });
            await e.reply(segment.image(image), false);
        } catch (error) {
            logger.error('[雀魂抽卡] 查看卡池失败:', error);
            await e.reply('查看卡池失败，可能是配置文件读取错误。');
        }
        return true;
    }

    // 获取池子的UP雀士名单（自定义UP池/联动池变体），无则返回 null
    async _getUpCharacters(poolId) {
        const list = await this._getUpCharacterList(poolId);
        return list.length > 0 ? list.join('、') : null;
    }

    // 同上，但返回数组（结果图贴 UP! 角标用，避免 join/split 破坏含顿号的名称）
    async _getUpCharacterList(poolId) {
        try {
            if (typeof poolId === 'string' && poolId.startsWith('custom:')) {
                const custom = await this.gachaCore.customPoolLoader();
                const ups = Array.isArray(custom?.[poolId.slice('custom:'.length)]?.characters)
                    ? custom[poolId.slice('custom:'.length)].characters : [];
                return ups;
            }
            if (typeof poolId === 'string' && poolId.includes('|')) {
                poolId = poolId.split('|')[0];
            }
            if (typeof poolId === 'string' && poolId && poolId !== 'male' && poolId !== 'female'
                && !poolId.startsWith('custom:')) {
                const pool = await this.gachaCore.gachaLoader();
                const ups = Array.isArray(pool[poolId]) ? pool[poolId] : [];
                return ups;
            }
        } catch {}
        return [];
    }

    // 获取池子的 UP 装扮名单（联动池/自定义UP池的 decoration/<池名>/ 目录）
    async _getUpDecorationList(poolId) {
        try {
            let key = String(poolId || '');
            if (key.includes('|')) key = key.split('|')[0];
            if (!key) return [];
            // 自定义UP池目录为纯池名（去掉 custom: 前缀），与 GachaCore 抽取逻辑一致
            const dir = key.startsWith('custom:') ? key.slice('custom:'.length) : key;
            if (!dir || dir === 'male' || dir === 'female') return [];
            const files = await this.gachaCore.fileLoader('decoration', dir).catch(() => []);
            if (!Array.isArray(files) || files.length === 0) return [];
            // 统一成「文件名去后缀」，与结果卡里 path.basename 的规则一致
            return files.map(f => path.basename(String(f), path.extname(String(f))));
        } catch {
            return [];
        }
    }

    // 限定名单：所有贵人均为限定；联动池的雀士与 UP 装扮也标限定
    async _getLimitedNames(poolId) {
        try {
            const pool = await this.gachaCore.gachaLoader();
            const list = [];
            // 贵人恒为限定
            if (Array.isArray(pool.guiren)) list.push(...pool.guiren);
            // 联动池（非 male/female/custom/guiren 的自定义键）的雀士与装扮
            let key = String(poolId || '');
            if (key.includes('|')) key = key.split('|')[0];
            const isCollab = key && !key.startsWith('custom:')
                && key !== 'male' && key !== 'female' && key !== 'guiren'
                && Array.isArray(pool[key]);
            if (isCollab) {
                list.push(...pool[key]);
                const decor = await this._getUpDecorationList(key);
                list.push(...decor);
            }
            return [...new Set(list)];
        } catch {
            return [];
        }
    }

    // 卡池倒计时文本（按池）：未到开启时间返回"X后开启"，已开启且设了结束时间返回"X后关闭"，无排期返回空串
    // 联动池变体 id（theme|female/male）按主题 id 查排期
    // 卡池排期状态
    //   state: 'none' 无排期 / 'pending' 尚未到开启时间 / 'open' 开放中（有结束时间）
    //   text : open → 仅剩余时长（如「2小时」，不再赘述「后关闭」，界面上已有「剩余时间」标签）
    //          pending → 「3天后开启」
    async _poolScheduleState(poolId) {
        try {
            let key = String(poolId || '');
            if (key.includes('|')) key = key.split('|')[0];
            const sched = await this.poolSchedule.get(key);
            if (!sched) return { state: 'none', text: '' };
            const now = Date.now();
            if (sched.startAt != null && now < sched.startAt) {
                const t = this._formatDuration(sched.startAt - now);
                return { state: 'pending', text: t ? `${t}后开启` : '' };
            }
            if (sched.endAt != null && now < sched.endAt) {
                const t = this._formatDuration(sched.endAt - now);
                return { state: 'open', text: t || '' };
            }
            return { state: 'none', text: '' };
        } catch {
            return { state: 'none', text: '' };
        }
    }

    // 剩余时长文本（如：2天5小时 / 3小时 / 不足1小时）
    _formatDuration(ms) {
        const hours = Math.floor(ms / 3600000);
        const days = Math.floor(hours / 24);
        const h = hours % 24;
        if (days > 0) return `${days}天${h}小时`;
        if (hours > 0) return `${hours}小时`;
        return '不足1小时';
    }

    // 群员个人卡池选择（SQLite 设置表：userpool:{gid}:{uid}，仅对个人生效）
    async _setUserPool(e, poolId) {
        if (!e.group_id) {
            await e.reply('此功能仅限群聊使用');
            return false;
        }
        try {
            setSetting(`userpool:${e.group_id}:${e.user_id}`, poolId);
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
                globalPool = getSetting('globalpool');
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
            delSetting(`userpool:${e.group_id}:${e.user_id}`);
            await e.reply('已重置，将跟随全局池（未设置全局池时为樱花之路）', true);
        } catch (error) {
            logger.error('[雀魂抽卡] 重置个人卡池失败:', error);
            await e.reply('重置失败，系统异常', true);
        }
        return true;
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

            // 该池若已排期且开启时间在未来：先不设为全局，到点由排期自动开启
            const sched = await this.poolSchedule.get(poolId);
            const scheduledFuture = sched?.startAt != null && sched.startAt > Date.now();

            // 全局默认池：仅在当前无活跃自定义UP池、且该池未排期待开启时自动设置（多池并存时新池不覆盖旧池）
            let currentGlobal = null;
            try {
                currentGlobal = getSetting('globalpool');
            } catch {}
            let globalChanged = true;
            let activeGlobalName = null;
            if (currentGlobal && currentGlobal.startsWith('custom:')) {
                activeGlobalName = currentGlobal.slice('custom:'.length);
                if (custom[activeGlobalName]) {
                    globalChanged = false; // 已有活跃UP池为全局默认，保持不变
                }
            }
            if (globalChanged && scheduledFuture) {
                globalChanged = false; // 已排期的池窗口外不可用，不能设为全局默认
                delSetting('globalpool:auto'); // master 手动创建动作，清除自动接管标记
            }
            if (globalChanged) {
                setSetting('globalpool', poolId);
                delSetting('globalpool:auto');
            }

            const globalText = scheduledFuture
                ? `该池已排期，到点自动开启并全局生效（当前全局默认池不变）`
                : globalChanged
                    ? `该池已全局生效（机器人所在所有群默认抽该池）`
                    : `当前全局默认池仍为「${activeGlobalName}」，群员可 #切换卡池 ${poolName} 切换到新池`;
            await e.reply(
                `UP池「${poolName}」已创建：${names.join('、')}\n` +
                `挂靠：${baseText}（未命中UP时从${baseText}抽雀士，不与常驻混池）\n` +
                `类型：${typeText}（UP雀士概率 ${upRate}%）\n` +
                globalText + '\n' +
                `可搭配 #设置卡池开启/关闭 <池名> 时间 定时自动开关，或 #查看卡池计划 查看排期`,
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
            // 同步清除该池的定时排期
            await this.poolSchedule.remove(poolId);

            // 清理指向该池的用户个人选择（跟随全局池）
            let userAffected = 0;
            try {
                for (const { key, value } of getSettingsByPrefix('userpool:')) {
                    if (value === poolId) {
                        delSetting(key);
                        userAffected++;
                    }
                }
            } catch (error) {
                logger.error('[雀魂抽卡] 清理个人卡池选择失败:', error);
            }

            // 全局池若指向该池，退回樱花之路
            try {
                if (getSetting('globalpool') === poolId) {
                    setSetting('globalpool', 'female');
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
    // UP率为主题池内置 59%，可搭配 #设置卡池关闭 <池名> 时间 定时退回
    async openCollab(e) {
        const match = e.msg.match(/^#?开启联动\s+(.+)$/);
        if (!match) return false;

        const input = match[1].trim().split(/[\s,，、]+/)[0];
        const poolId = this.gachaCore.getPoolId(input);
        if (!poolId || ['male', 'female', 'normal'].includes(poolId) || poolId.startsWith('custom:')) {
            await e.reply('没有找到该联动池\n格式：#开启联动 <联动池名>', true);
            return true;
        }

        try {
            const data = await this.gachaCore.gachaLoader();
            if (!data[poolId]) {
                await e.reply('没有找到该联动池\n格式：#开启联动 <联动池名>', true);
                return true;
            }
            setSetting(`collabopen:${poolId}`, '1'); // 开放标记（支持多个联动池同时开放）
            setSetting('globalpool', poolId);
            delSetting('globalpool:auto'); // master 手动开启，清除自动接管标记
            const name = this.gachaCore.getPoolName(poolId);
            const dual = !/樱花|竹林/.test(name);
            const poolInfo = dual
                ? `默认抽 ${name}（樱花特别寻觅），群友可 #切换卡池 ${input} 竹林 切到 ${name}（竹林特别寻觅）`
                : `默认抽 ${name}`;
            // 已有未来开启排期时提醒：手动开启属于提前开，想等排期需关闭后重设
            let schedWarn = '';
            try {
                const sched = await this.poolSchedule.get(poolId);
                if (sched?.startAt != null && sched.startAt > Date.now()) {
                    schedWarn = `\n⚠️ 该池已排期 ${this._fmtTime(sched.startAt)} 自动开启，本次属于提前手动开启；若只想等排期，请 #关闭联动 后重新设置排期（关闭会清除排期）`;
                }
            } catch {}
            await e.reply(
                `联动池「${name}」已开启并全局生效（樱花与竹林两池都开）：${poolInfo}\n` +
                `UP雀士概率 59%，未命中UP时从对应性别池抽雀士（不与常驻混池）\n` +
                `可搭配 #设置卡池关闭 ${input} 时间 到点自动关闭，或 #关闭联动 立即关闭` +
                schedWarn,
                true
            );
        } catch (error) {
            logger.error('[雀魂抽卡] 开启联动失败:', error);
            await e.reply('开启联动失败，系统异常', true);
        }
        return true;
    }

    // 关闭联动池（主人）：全局池退回樱花之路，同步清除开放标记与该池排期
    async closeCollab(e) {
        try {
            const globalPool = getSetting('globalpool');
            if (globalPool && globalPool.startsWith('custom:')) {
                await e.reply('当前全局池是自定义UP池，请用 #解散UP池 <池名> 关闭', true);
                return true;
            }
            if (globalPool && globalPool !== 'female' && globalPool !== 'male') {
                delSetting(`collabopen:${globalPool}`);
                await this.poolSchedule.remove(globalPool);
                setSetting('globalpool', 'female');
                // 清理指向该联动池（含变体）的个人选择
                let userAffected = 0;
                for (const { key, value } of getSettingsByPrefix('userpool:')) {
                    if (value === globalPool || String(value).startsWith(`${globalPool}|`)) {
                        delSetting(key);
                        userAffected++;
                    }
                }
                const extra = userAffected > 0 ? `，${userAffected} 位群友的个人选择已重置` : '';
                await e.reply(`联动池「${this.gachaCore.getPoolName(globalPool)}」已关闭，全局池退回樱花之路${extra}`, true);
            } else {
                await e.reply('当前没有开启的联动池', true);
            }
        } catch (error) {
            logger.error('[雀魂抽卡] 关闭联动失败:', error);
            await e.reply('关闭联动失败，系统异常', true);
        }
        return true;
    }

    // ==================== 卡池定时开关（每池独立排期，SQLite majsoul_pool_schedules） ====================

    // 解析排期目标池：自定义UP池名 → custom:<名>；联动池名/ID → 主题池ID
    // 允许预设尚未创建的自定义UP池名（先排期后创建，到点时池不存在则排期作废）
    async _resolveSchedulePoolId(input) {
        const name = String(input || '').trim();
        if (!name) return null;
        if (name.startsWith('custom:')) return name;
        try {
            const custom = await this.gachaCore.customPoolLoader();
            if (custom && custom[name]) return `custom:${name}`;
        } catch {}
        const themeId = this.gachaCore.getPoolId(name);
        if (themeId && !['male', 'female', 'normal'].includes(themeId)) {
            try {
                const data = await this.gachaCore.gachaLoader();
                if (data[themeId]) return themeId;
            } catch {}
        }
        return `custom:${name}`;
    }

    // #设置卡池开启 <池名> <时间>：到点自动加入可用池（全局池为常驻/空/调度器设置时接管为全局默认）
    // 时间支持个位月/日/时/分（如 2026-9-25 0:00），回复统一回显规范化时间
    async setPoolOpen(e) {
        const match = e.msg.match(/^#?设置卡池开启\s+(.+)\s+(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2})$/);
        if (!match) {
            if (/^#?设置卡池开启\s+/.test(e.msg || '')) {
                await e.reply('格式：#设置卡池开启 <池名> <YYYY-MM-DD HH:mm>\n如：#设置卡池开启 赤影骁歌 2026-09-25 10:00', true);
                return true;
            }
            return false;
        }
        const poolId = await this._resolveSchedulePoolId(match[1]);
        const result = await this.poolSchedule.set(poolId, { startAt: match[2] });
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        // 该池当前是全局默认池时：设置未来开启时间意味着它先关闭，全局池先退回樱花之路
        try {
            if (getSetting('globalpool') === poolId) {
                setSetting('globalpool', 'female');
                setSetting('globalpool:auto', '1');
            }
        } catch {}
        const sched = await this.poolSchedule.get(poolId);
        const name = this.gachaCore.getPoolName(poolId);
        const startText = this._fmtTime(sched.startAt);
        const endText = sched?.endAt != null ? `\n关闭时间：${this._fmtTime(sched.endAt)}` : '';
        const collabHint = poolId.startsWith('custom:') ? '' : '\n联动池无需手动 #开启联动，到点会自动开启并接管全局';
        await e.reply(
            `已设置卡池「${name}」于 ${startText} 自动开启\n` +
            `到点自动加入可用池；若届时全局默认池为常驻池或由排期设置，将自动接管为全局默认池` +
            endText + collabHint +
            `\n取消：#取消卡池开启 ${match[1].trim()}`,
            true
        );
        return true;
    }

    // #设置卡池关闭 <池名> <时间>：到点自动下架（自定义池删除、联动池移除开放标记），全局池退回樱花之路
    async setPoolClose(e) {
        const match = e.msg.match(/^#?设置卡池关闭\s+(.+)\s+(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2})$/);
        if (!match) {
            if (/^#?设置卡池关闭\s+/.test(e.msg || '')) {
                await e.reply('格式：#设置卡池关闭 <池名> <YYYY-MM-DD HH:mm>\n如：#设置卡池关闭 赤影骁歌 2026-10-01 22:00', true);
                return true;
            }
            return false;
        }
        const poolId = await this._resolveSchedulePoolId(match[1]);
        const result = await this.poolSchedule.set(poolId, { endAt: match[2] });
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        const sched = await this.poolSchedule.get(poolId);
        const name = this.gachaCore.getPoolName(poolId);
        await e.reply(
            `已设置卡池「${name}」于 ${this._fmtTime(sched.endAt)} 自动关闭\n` +
            `到点自动下架，全局池若指向该池将退回樱花之路，处于该池的个人选择同步重置\n` +
            `取消：#取消卡池关闭 ${match[1].trim()}`,
            true
        );
        return true;
    }

    // #取消卡池开启 <池名>
    async cancelPoolOpen(e) {
        const match = e.msg.match(/^#?取消卡池开启\s+(.+)$/);
        if (!match) return false;
        const poolId = await this._resolveSchedulePoolId(match[1]);
        const result = await this.poolSchedule.cancel(poolId, 'start');
        await e.reply(result.ok ? `已取消卡池「${this.gachaCore.getPoolName(poolId)}」的定时开启` : result.reason, true);
        return true;
    }

    // #取消卡池关闭 <池名>
    async cancelPoolClose(e) {
        const match = e.msg.match(/^#?取消卡池关闭\s+(.+)$/);
        if (!match) return false;
        const poolId = await this._resolveSchedulePoolId(match[1]);
        const result = await this.poolSchedule.cancel(poolId, 'end');
        await e.reply(result.ok ? `已取消卡池「${this.gachaCore.getPoolName(poolId)}」的定时关闭` : result.reason, true);
        return true;
    }

    // #查看卡池计划：列出所有排期
    async viewPoolSchedule(e) {
        const rows = await this.poolSchedule.getAll();
        if (rows.length === 0) {
            await e.reply('当前没有卡池排期\n设置：#设置卡池开启/关闭 <池名> <YYYY-MM-DD HH:mm>', true);
            return true;
        }
        const now = Date.now();
        const items = rows.map(r => {
            const name = this.gachaCore.getPoolName(r.poolId);
            let status = 'open';
            // 联动池可能已被手动提前开启（#开启联动 立即生效），排期状态需反映真实开放状态
            if (r.startAt != null && now < r.startAt) {
                let openedEarly = false;
                try {
                    openedEarly = getSetting(`collabopen:${r.poolId}`) === '1' || getSetting('globalpool') === r.poolId;
                } catch {}
                status = openedEarly ? 'early' : 'pending';
            }
            // 时间文本：尚未开启显示「开 → 关」，已开启只显示关闭时间
            const endPart = r.endAt != null ? `关闭 ${this._fmtTime(r.endAt)}` : '未设关闭时间';
            const timeText = status === 'pending'
                ? `${this._fmtTime(r.startAt)} 开启 · ${endPart}`
                : (status === 'early'
                    ? `已手动开启 · ${endPart}`
                    : endPart);
            return { name, status, timeText };
        });
        const image = await renderPoolScheduleCard({
            rows: items,
            footer: '设置：#设置卡池开启/关闭 <池名> <YYYY-MM-DD HH:mm>'
        });
        await e.reply(segment.image(image), false);
        return true;
    }

    // #设置全局池 <池名>：master 手动指定全局默认池（无个人选择的群友默认抽该池）
    // 手动设置会清除自动接管标记（globalpool:auto），到点的定时开启不会抢占手动指定的全局池
    async setGlobalPool(e) {
        const match = e.msg.match(/^#?设置全局池\s+(.+)$/);
        if (!match) return false;
        const input = match[1].trim();
        // 常驻池别名（含简写）
        let poolId;
        if (/^樱花(之路)?$/.test(input)) poolId = 'female';
        else if (/^竹林(之路)?$/.test(input)) poolId = 'male';
        else poolId = await this._resolveSchedulePoolId(input);

        // 池必须存在且当前可用（排期窗口外/未开放的联动池不允许直接设为全局）
        if (poolId !== 'male' && poolId !== 'female' && !(await this.gachaCore.poolExists(poolId))) {
            const sched = await this.poolSchedule.get(poolId);
            if (sched?.startAt != null && sched.startAt > Date.now()) {
                await e.reply(
                    `卡池「${this.gachaCore.getPoolName(poolId)}」尚未到开启时间（${this._fmtTime(sched.startAt)} 自动开启）\n` +
                    `到点会自动接管全局默认池，无需手动设置`,
                    true
                );
            } else {
                await e.reply(
                    `没有找到可用卡池「${input}」\n` +
                    `可用 #查看卡池 查看当前可用池列表；未开放的联动池需先 #开启联动，未到开启时间的UP池将按排期自动接管`,
                    true
                );
            }
            return true;
        }

        setSetting('globalpool', poolId);
        delSetting('globalpool:auto'); // master 手动设置，清除自动接管标记
        const name = this.gachaCore.getPoolName(poolId);
        const isCollab = poolId !== 'male' && poolId !== 'female' && !poolId.startsWith('custom:');
        await e.reply(
            `全局默认池已设为「${name}」（无个人选择的群友默认抽该池）\n` +
            `群员个人选择不受影响，可 #切换卡池 自行切换\n` +
            (isCollab ? `联动池默认抽樱花特别寻觅，群员可 #切换卡池 ${input} 竹林 切换竹林变体\n` : '') +
            `恢复默认：#设置全局池 樱花`,
            true
        );
        return true;
    }

    // epoch ms → "YYYY-MM-DD HH:mm"
    _fmtTime(ms) {
        const d = new Date(ms);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

}
