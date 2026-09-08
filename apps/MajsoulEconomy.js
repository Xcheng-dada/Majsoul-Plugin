// plugins/Majsoul-Plugin/apps/MajsoulEconomy.js
// 雀魂抽卡经济系统命令入口：签到、钱包、图鉴、信仰兑换、辉玉红包、奖励邮件、货币管理
import plugin from "../../../lib/plugins/plugin.js";
import { segment } from "oicq";
import GachaWallet, { CURRENCY_NAMES } from '../utils/GachaWallet.js';
import GachaCollection from '../utils/GachaCollection.js';
import GachaSign from '../utils/GachaSign.js';
import GachaRedpacket from '../utils/GachaRedpacket.js';
import GachaMail from '../utils/GachaMail.js';
import GachaCore from '../utils/GachaCore.js';
import { renderCurrencyCard, CURRENCY_ICONS } from '../utils/CurrencyCard.js';
import { getFeatureConfigItem } from '../utils/Config.js';

// 货币中文名 → key（设置货币命令用，长名优先）
const SET_NAME_TO_KEY = {
  '十连寻觅卷轴': 'ticket10',
  '寻觅卷轴': 'ticket',
  '十连寻觅券': 'ticket10',  // 兼容旧叫法
  '寻觅券': 'ticket',        // 兼容旧叫法
  '辉玉': 'jade',
  '星之粉尘': 'dust',
  '星之石': 'stone',
  '许愿石': 'wish',
  '信仰': 'faith'
};

export class MajsoulEconomy extends plugin {
    constructor() {
        super({
            name: '雀魂经济系统',
            dsc: '雀魂签到/钱包/图鉴/兑换/红包/邮件',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂签到$',
                    fnc: 'sign'
                },
                {
                    reg: '^#?雀魂钱包$',
                    fnc: 'wallet'
                },
                {
                    reg: '^#?雀魂图鉴(\\s+(角色|装扮))?(\\s+\\d+)?\\s*(\\[\\@.*\\])?$',
                    fnc: 'collection'
                },
                {
                    reg: '^#?雀魂兑换\\s+(.+)$',
                    fnc: 'exchange'
                },
                {
                    reg: '^#?发红包\\s+(\\d+)\\s+(\\d+)$',
                    fnc: 'sendRedpacket',
                    permission: 'master'
                },
                {
                    reg: '^#?抢红包$',
                    fnc: 'grabRedpacket'
                },
                {
                    reg: '^#?发送邮件\\s+(.+)$',
                    fnc: 'sendMail',
                    permission: 'master'
                },
                {
                    reg: '^#?雀魂邮件$',
                    fnc: 'claimMail'
                },
                {
                    reg: `^#?设置(${Object.keys(SET_NAME_TO_KEY).join('|')})\\s+(\\d+)\\s+(-?\\d+)$`,
                    fnc: 'setCurrency',
                    permission: 'master'
                }
            ]
        });
        this.walletMgr = new GachaWallet();
        this.gachaCore = new GachaCore();
        this.collectionMgr = new GachaCollection(this.gachaCore);
        this.signer = new GachaSign();
        this.redpacketMgr = new GachaRedpacket();
        this.mailMgr = new GachaMail();
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

    // #雀魂签到：文字 + 奖励图片输出
    async sign(e) {
        const result = await this.signer.sign(e.user_id);
        if (result.already) {
            await e.reply(`今天已经签到过啦~ 已连续签到 ${result.streak} 天，明天再来吧`, true);
            return true;
        }

        // 奖励入钱包（自动兑换链）
        const { converted } = await this.walletMgr.add(e.user_id, {
            jade: result.jade,
            ticket: result.ticket,
            ticket10: result.ticket10
        });

        // 渲染奖励卡片
        const items = [
            { icon: '辉玉', count: result.jade, extra: result.crit ? '暴击×2' : undefined },
            { icon: '寻觅卷轴', count: result.ticket, extra: result.welcome ? '欢迎礼包' : undefined }
        ];
        if (result.ticket10 > 0) {
            items.push({ icon: '十连寻觅卷轴', count: result.ticket10, extra: `连签${result.streak}天` });
        }
        const image = await renderCurrencyCard({ title: '签到奖励', items });

        let text = `签到成功，已连签 ${result.streak} 天（累计 ${result.totalDays} 天）`;
        if (converted.length > 0) {
            text += `\n自动兑换：${converted.join('；')}`;
        }
        await e.reply([text, segment.image(image)], true);
        return true;
    }

    // #雀魂钱包：余额图片输出（标题显示群名片）
    async wallet(e) {
        const w = await this.walletMgr.get(e.user_id);
        const items = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith'].map(key => ({
            icon: CURRENCY_ICONS[key],
            count: w[key]
        }));
        const name = (e.member?.card || e.member?.nickname || e.sender?.card || e.sender?.nickname || '雀魂玩家')
            .toString().trim().slice(0, 16);
        const image = await renderCurrencyCard({
            title: `${name}的钱包`,
            items,
            footer: '许愿石 1:1、星之石每10→5 星之粉尘、粉尘每50→1 寻觅卷轴，获得后自动兑换'
        });
        await e.reply(segment.image(image), true);
        return true;
    }

    // #雀魂图鉴 [角色/装扮] [页码]（可 @）
    async collection(e) {
        const match = e.msg.match(/^#?雀魂图鉴(?:\s+(角色|装扮))?(?:\s+(\d+))?\s*(?:\[@.*\])?$/);
        const kind = (match && match[1] === '装扮') ? 'decorations' : 'characters';
        const page = match && match[2] ? parseInt(match[2]) : 1;
        // @某人 时渲染对方图鉴
        let targetId = e.user_id;
        if (e.at) targetId = e.at;

        try {
            const image = await this.collectionMgr.renderImage(targetId, kind, page);
            await e.reply(segment.image(image), true);
        } catch (error) {
            logger.error('[雀魂经济] 图鉴渲染失败:', error);
            await e.reply('图鉴渲染失败，请联系维护者。', true);
        }
        return true;
    }

    // #雀魂兑换 雀士名：信仰直兑
    async exchange(e) {
        const match = e.msg.match(/^#?雀魂兑换\s+(.+)$/);
        if (!match) return false;
        const name = match[1].trim();

        // 在 gacha.json 全部池中查找
        let poolId = null;
        try {
            const pool = await this.gachaCore.gachaLoader();
            for (const [p, arr] of Object.entries(pool)) {
                if (p === 'purple_gift' || !Array.isArray(arr)) continue;
                if (arr.includes(name)) {
                    poolId = p;
                    break;
                }
            }
        } catch (error) {
            logger.error('[雀魂经济] 读取卡池配置失败:', error);
            await e.reply('兑换失败，系统异常', true);
            return true;
        }

        if (!poolId) {
            await e.reply(`没有找到雀士"${name}"，请检查名字是否正确（可在卡池中查看）`, true);
            return true;
        }

        const isLimited = poolId === 'xianding';
        const cost = isLimited
            ? Math.max(1, Number(getFeatureConfigItem('faithLimitedCost')) || 300)
            : Math.max(1, Number(getFeatureConfigItem('faithNormalCost')) || 150);

        const spendResult = await this.walletMgr.spend(e.user_id, { faith: cost });
        if (!spendResult.ok) {
            await e.reply(`信仰不足（需要 ${cost}，当前 ${spendResult.wallet.faith}）。\n每次寻觅可获得 1 点信仰，继续寻觅攒攒吧~`, true);
            return true;
        }

        // 兑换的雀士入图鉴（可能已是重复）
        const { isNew, count } = await this.collectionMgr.add(e.user_id, 'characters', name);
        const limitedText = isLimited ? '限定雀士' : '雀士';
        if (isNew) {
            await e.reply(`兑换成功！消耗信仰 ${cost}，获得${limitedText}「${name}」NEW!`);
        } else {
            await e.reply(`兑换成功！消耗信仰 ${cost}，获得${limitedText}「${name}」（图鉴已有 x${count}，重复无额外转化）`);
        }
        return true;
    }

    // #发红包 金额 数量（master 印钞）
    async sendRedpacket(e) {
        if (!e.group_id) {
            await e.reply('红包功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?发红包\s+(\d+)\s+(\d+)$/);
        const total = parseInt(match[1]);
        const count = parseInt(match[2]);

        const result = await this.redpacketMgr.create(e.group_id, e.user_id, total, count);
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        await e.reply(`红包来啦！共 ${total} 辉玉，${count} 个，发送"抢红包"开抢（5 分钟后过期）`);
        return true;
    }

    // #抢红包
    async grabRedpacket(e) {
        if (!e.group_id) {
            await e.reply('红包功能仅限群聊使用');
            return true;
        }
        const result = await this.redpacketMgr.grab(e.group_id, e.user_id);
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        // 入钱包
        const { converted } = await this.walletMgr.add(e.user_id, { jade: result.amount });
        let text = `抢到 ${result.amount} 辉玉！`;
        if (converted.length > 0) text += `\n自动兑换：${converted.join('；')}`;
        await e.reply(text, true);
        return true;
    }

    // #发送邮件 货币x数量...（master 群发当前群）
    async sendMail(e) {
        if (!e.group_id) {
            await e.reply('邮件功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?发送邮件\s+(.+)$/);
        const rewards = GachaMail.parseRewards(match[1]);
        if (!rewards) {
            await e.reply('未解析到有效奖励，示例：#发送邮件 星之粉尘5 寻觅卷轴1', true);
            return true;
        }

        const mail = await this.mailMgr.send(e.group_id, rewards, '雀魂官方兑换码奖励');
        await e.reply(`已向本群发放奖励邮件「${mail.title}」：${GachaMail.formatRewards(rewards)}\n成员发送"雀魂邮件"即可领取（30 天内有效）`);
        return true;
    }

    // #雀魂邮件：领取全部未领奖励，图片展示
    async claimMail(e) {
        if (!e.group_id) {
            await e.reply('邮件功能仅限群聊使用');
            return true;
        }
        const { mails, totals } = await this.mailMgr.claimAll(e.group_id, e.user_id);
        if (mails.length === 0) {
            await e.reply('暂无可领取的邮件奖励', true);
            return true;
        }

        // 奖励入钱包（自动兑换链）
        const { converted } = await this.walletMgr.add(e.user_id, totals);

        // 渲染邮件奖励卡片
        const items = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith']
            .filter(key => totals[key])
            .map(key => ({ icon: CURRENCY_ICONS[key], count: totals[key] }));
        const image = await renderCurrencyCard({ title: `邮件奖励（${mails.length} 封）`, items });

        let text = mails.map(m => `「${m.title}」${GachaMail.formatRewards(m.rewards)}`).join('\n');
        if (converted.length > 0) {
            text += `\n自动兑换：${converted.join('；')}`;
        }
        await e.reply([segment.image(image), '\n' + text], true);
        return true;
    }

    // #设置货币 [ID] [数量]（master）
    async setCurrency(e) {
        const match = e.msg.match(new RegExp(`^#?设置(${Object.keys(SET_NAME_TO_KEY).join('|')})\\s+(\\d+)\\s+(-?\\d+)$`));
        if (!match) return false;
        const key = SET_NAME_TO_KEY[match[1]];
        const targetUserId = match[2];
        const amount = parseInt(match[3]);

        const ok = await this.walletMgr.set(targetUserId, key, amount);
        if (ok) {
            const w = await this.walletMgr.get(targetUserId);
            await e.reply(`已将用户 ${targetUserId} 的${CURRENCY_NAMES[key]}设置为 ${w[key]}`);
        } else {
            await e.reply('设置失败，系统异常', true);
        }
        return true;
    }
}
