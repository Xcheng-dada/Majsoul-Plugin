// plugins/Majsoul-Plugin/apps/MajsoulGacha.js
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import path from 'path';
import GachaCore from '../utils/GachaCore.js';
import GachaCollection from '../utils/GachaCollection.js';
import GachaWallet from '../utils/GachaWallet.js';
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
                {
                    reg: '^#?切换雀魂卡池\\s+(.+)$',
                    fnc: 'changePool',
                    permission: 'admin'
                },
                {
                    reg: '^#?(查看雀魂卡池|当前雀魂卡池)$',
                    fnc: 'viewPool'
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
            const { imageBase64, results, hasGuaranteed } = await this.gachaCore.runGacha(e.group_id, times);

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

            // 货币自动兑换提示（许愿石→粉尘→寻觅卷轴、星之石→粉尘）
            const convertParts = [];
            const { wallet: newWallet, converted } = await this.wallet.add(e.user_id, gains);
            for (const line of converted) {
                if (!convertParts.includes(line)) convertParts.push(line);
            }

            // 纯图片输出：结果图 + 摘要条（拼接到结果图下方）
            const label = times === 1 ? '雀魂寻觅结果' : '十连寻觅结果';
            let titleLine = `${label}（${costDesc}）`;
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
                lines.push(`礼物：${giftParts.join('、')}`);
            }
            if (convertParts.length > 0) {
                lines.push(`转化：${convertParts.join('；')}`);
            }
            lines.push(`信仰 +${times}（当前 ${newWallet.faith}）｜寻觅卷轴 ${newWallet.ticket}｜辉玉 ${newWallet.jade}`);

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

    // 切换卡池
    async changePool(e) {
        const match = e.msg.match(/^#?切换雀魂卡池\s+(.+)$/);
        if (!match) {
            logger.error('[雀魂抽卡] 切换卡池指令格式错误:', e.msg);
            return false;
        }

        const input = match[1];
        const poolId = this.gachaCore.getPoolId(input);
        if (!poolId) {
            const supportedPools = "辉夜大小姐想让我告白、Fate、咲-saki-1、咲-saki-2、斗牌传说、反叛的鲁路修、狂赌之渊、银魂、常驻池、限定、魔法少女伊莉雅、蔚蓝档案、偶像大师闪耀色彩";
            await e.reply(`没有找到该名称的卡池，当前支持的卡池有：${supportedPools}`);
            return true;
        }

        try {
            const groupPool = await this.gachaCore.groupPoolLoader();
            const newGroupPool = [];
            let found = false;

            for (const item of groupPool) {
                if (item.gid === String(e.group_id)) {
                    newGroupPool.push({ ...item, poolname: poolId });
                    found = true;
                } else {
                    newGroupPool.push(item);
                }
            }
            if (!found) {
                newGroupPool.push({
                    gid: String(e.group_id),
                    poolname: poolId
                });
            }

            await this.gachaCore.saveGroupPool(newGroupPool);
            const poolName = this.gachaCore.getPoolName(poolId);
            await e.reply(`已成功将本群卡池切换到：${poolName}`);

        } catch (error) {
            logger.error('[雀魂抽卡] 切换卡池失败:', error);
            await e.reply('切换卡池失败，可能是配置文件读写错误。');
        }
        return true;
    }

    // 查看卡池
    async viewPool(e) {
        try {
            const groupPool = await this.gachaCore.groupPoolLoader();
            let currentPool = 'normal'; // 默认池改为normal
            for (const item of groupPool) {
                if (item.gid === String(e.group_id)) {
                    currentPool = item.poolname;
                    break;
                }
            }
            const poolName = this.gachaCore.getPoolName(currentPool);
            await e.reply(`本群启用的雀魂卡池为：${poolName}`);
        } catch (error) {
            logger.error('[雀魂抽卡] 查看卡池失败:', error);
            await e.reply('查看卡池失败，可能是配置文件读取错误。');
        }
        return true;
    }
}
