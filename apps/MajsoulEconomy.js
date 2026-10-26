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
import { CURRENCY_ICONS } from '../utils/CurrencyCard.js';
import { renderPacketCover, renderGrabCard } from '../utils/RedpacketCard.js';
import { renderExchangeCard } from '../utils/ExchangeCard.js';
import { renderSignCard } from '../utils/SignCard.js';
import { renderWarehouseCard } from '../utils/WarehouseCard.js';
import { renderMailCard } from '../utils/MailCard.js';
import { getSetting } from '../utils/SettingsStore.js';
import { getFeatureConfigItem } from '../utils/Config.js';

// 货币中文名 → key（设置货币命令用，长名优先）
const SET_NAME_TO_KEY = {
  '十连寻觅卷轴': 'ticket10',
  '寻觅卷轴': 'ticket',
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
            dsc: '雀魂签到/仓库/寮舍/兑换/红包/邮件',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '^#?雀魂签到$',
                    fnc: 'sign'
                },
                {
                    // 雀魂仓库
                    reg: '^#?雀魂仓库$',
                    fnc: 'wallet'
                },
                {
                    // 雀魂寮舍
                    reg: '^#?雀魂寮舍(\\s+(角色|装扮))?(\\s+\\d+)?\\s*(\\[\\@.*\\])?$',
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
                    reg: '^#?删除邮件(?:\\s+(\\d+|全部))?$',
                    fnc: 'deleteMail',
                    permission: 'master'
                },
                {
                    reg: `^#?设置(?:货币\\s*)?(${Object.keys(SET_NAME_TO_KEY).join('|')})\\s+(\\d+)\\s+(-?\\d+)$`,
                    fnc: 'setCurrency',
                    permission: 'master'
                },
                {
                    reg: '^#?保存数据$',
                    fnc: 'saveData',
                    permission: 'master'
                },
                {
                    reg: '^#?设置全员辉玉\\s+(\\d+)$',
                    fnc: 'setAllJade',
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

    // 群名片/昵称（截断 16 字），用于图片标题展示
    _displayName(e) {
        return (e.member?.card || e.member?.nickname || e.sender?.card || e.sender?.nickname || '雀魂玩家')
            .toString().trim().slice(0, 16);
    }

    // QQ 头像 URL（非 QQ 适配器或加载失败时由渲染层自动跳过）
    _avatarUrl(e) {
        try {
            const id = String(e.user_id).replace(/[^\d]/g, '');
            return id ? `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640` : '';
        } catch {
            return '';
        }
    }

    // #雀魂签到：官方木质公告栏卡片（不引用回复）
    async sign(e) {
        const result = await this.signer.sign(e.user_id);
        // 今天已签到：用 bg1 模板（右侧自带「明天再来吧」文案），左侧仍显示头像昵称
        if (result.already) {
            const image = await renderSignCard({
                nickname: this._displayName(e),
                avatar: this._avatarUrl(e),
                streak: result.streak,
                totalDays: result.totalDays,
                alreadySigned: true
            });
            await e.reply(segment.image(image), false);
            return true;
        }

        // 奖励入钱包（自动兑换链）
        const { converted } = await this.walletMgr.add(e.user_id, {
            jade: result.jade,
            ticket: result.ticket,
            ticket10: result.ticket10
        });

        // 奖励图标：暴击/欢迎礼包/连签十连卷轴
        const items = [
            { icon: '辉玉', count: result.jade, extra: result.crit ? '暴击×2' : undefined },
            { icon: '寻觅卷轴', count: result.ticket, extra: result.welcome ? '欢迎礼包' : undefined }
        ];
        if (result.ticket10 > 0) {
            items.push({ icon: '十连寻觅卷轴', count: result.ticket10, extra: `连签${result.streak}天` });
        }
        // 自动兑换提示作为附加说明补在末尾（如星之粉尘兑换成卷轴）
        if (converted.length > 0) {
            items.push({ icon: '信仰', count: result.streak, extra: converted.join('；') });
        }

        const image = await renderSignCard({
            nickname: this._displayName(e),
            avatar: this._avatarUrl(e),
            streak: result.streak,
            totalDays: result.totalDays,
            items
        });
        await e.reply(segment.image(image), false);
        return true;
    }

    // #雀魂仓库：indoor 背景 + 金框（不引用回复）
    async wallet(e) {
        const w = await this.walletMgr.get(e.user_id);
        // 许愿石入账即 1:1 全额转粉尘，余额恒为 0，不展示（数据层与兑换链保留）
        const NAMES = {
            jade: '辉玉', ticket: '寻觅卷轴', ticket10: '十连寻觅卷轴',
            dust: '星之粉尘', stone: '星之石', faith: '信仰'
        };
        const items = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'faith'].map(key => ({
            icon: CURRENCY_ICONS[key],
            count: w[key],
            name: NAMES[key]
        }));
        const image = await renderWarehouseCard({
            title: `${this._displayName(e)}的仓库`,
            avatar: this._avatarUrl(e),
            items,
            footer: '许愿石 1:1、星之石每10→5 星之粉尘、粉尘每50→1 寻觅卷轴，获得后自动兑换'
        });
        await e.reply(segment.image(image), false);
        return true;
    }

    // #雀魂寮舍 [角色/装扮] [页码]（可 @）：标题显示被查用户的群名片，不引用回复
    async collection(e) {
        const match = e.msg.match(/^#?雀魂寮舍(?:\s+(角色|装扮))?(?:\s+(\d+))?\s*(?:\[@.*\])?$/);
        const kind = (match && match[1] === '装扮') ? 'decorations' : 'characters';
        const page = match && match[2] ? parseInt(match[2]) : 1;
        // @某人 时渲染对方图鉴（@全体成员视为未@）
        let targetId = e.user_id;
        if (e.at && e.at !== 'all') targetId = e.at;

        // 标题用户名：默认查自己用本人群名片；@别人时尝试取对方的群名片
        let name = this._displayName(e);
        if (targetId !== e.user_id) {
            try {
                // 数字 QQ 号转 Number，避免字符串键与成员缓存 gml 的数字键不匹配取不到名片
                const uid = /^\d+$/.test(String(targetId)) ? Number(targetId) : targetId;
                const member = await e.group?.pickMember?.(uid);
                let targetName = member?.card || member?.nickname;
                // 缓存未命中时主动拉取成员信息
                if (!targetName && member?.getInfo) {
                    const info = await member.getInfo();
                    targetName = info?.card || info?.nickname;
                }
                if (targetName) name = targetName.toString().trim().slice(0, 16);
            } catch { }
        }

        try {
            const image = await this.collectionMgr.renderImage(targetId, kind, page, name);
            await e.reply(segment.image(image));
        } catch (error) {
            logger.error('[雀魂经济] 寮舍渲染失败:', error);
            await e.reply('寮舍渲染失败，请联系维护者。');
        }
        return true;
    }

    // #雀魂兑换 雀士名：信仰直兑（仅限当前开放池：竹林/樱花、活跃自定义UP池、已开启的联动池）
    async exchange(e) {
        const match = e.msg.match(/^#?雀魂兑换\s+(.+)$/);
        if (!match) return false;
        const name = match[1].trim();

        // 操作者信息（卡面底部标识是谁兑换的）
        const userName = this._displayName(e);
        const userAvatar = this._avatarUrl(e);

        // 收集当前开放池的雀士名单
        let openNames = [];
        try {
            const pool = await this.gachaCore.gachaLoader();
            // 常驻开放：竹林之路 + 樱花之路
            openNames.push(...(pool.male || []), ...(pool.female || []));
            // 活跃自定义UP池（贵人/限时UP）的UP雀士
            const custom = await this.gachaCore.customPoolLoader();
            if (custom) {
                for (const info of Object.values(custom)) {
                    if (Array.isArray(info?.characters)) openNames.push(...info.characters);
                }
            }
            // 已开启的联动池（master 当前全局池为主题池时）
            let globalPool = null;
            try {
                globalPool = getSetting('globalpool');
            } catch {}
            if (globalPool && Array.isArray(pool[globalPool])) {
                openNames.push(...pool[globalPool]);
            }
        } catch (error) {
            logger.error('[雀魂经济] 读取卡池配置失败:', error);
            await e.reply('兑换失败，系统异常', true);
            return true;
        }
        openNames = [...new Set(openNames)];

        // 立绘是否存在 == 该雀士名是否有效（找不到图就是名字写错了/不存在）
        const portraitPath = await this.collectionMgr.getCharacterPortrait(name).catch(() => null);
        const isLimited = await this.collectionMgr.isLimitedCharacter(name);
        const cost = isLimited
            ? Math.max(1, Number(getFeatureConfigItem('faithLimitedCost')) || 300)
            : Math.max(1, Number(getFeatureConfigItem('faithNormalCost')) || 150);

        // ① 雀士名不匹配：只在头像位置显示「雀士未找到」
        if (!portraitPath) {
            try {
                const image = await renderExchangeCard({ name, state: 'notfound', nickname: userName, avatar: userAvatar });
                await e.reply(segment.image(image), false);
            } catch {
                await e.reply(`未找到雀士「${name}」，请检查名字是否正确`, true);
            }
            return true;
        }

        // ② 雀士存在但当前池未开启：灰度头像 + 「未开启兑换」
        if (!openNames.includes(name)) {
            try {
                const w = await this.walletMgr.get(e.user_id);
                const image = await renderExchangeCard({
                    name,
                    isLimited,
                    cost,
                    faith: w.faith,
                    portraitPath,
                    state: 'unopened',
                    nickname: userName,
                    avatar: userAvatar
                });
                await e.reply(segment.image(image), false);
            } catch {
                await e.reply(`「${name}」当前不在开放池中，无法兑换。\n当前可兑换：竹林之路 / 樱花之路 / 当前UP池与联动池雀士`, true);
            }
            return true;
        }

        // ③ 已拥有的角色不能兑换（图鉴里已有该雀士）
        // 注：不显示拥有数量 —— 雀士不可重复拥有，count 恒为 1；
        // 旧库中残留的 count>1 是历史 bug 产物（add 曾对雀士累加），无展示意义。
        try {
            const coll = await this.collectionMgr.get(e.user_id);
            if (coll?.characters?.[name]) {
                // 已拥有：灰色按钮 + 「已拥有」印章
                try {
                    const w = await this.walletMgr.get(e.user_id);
                    const image = await renderExchangeCard({
                        name,
                        isLimited,
                        cost,
                        faith: w.faith,
                        portraitPath,
                        state: 'owned',
                    nickname: userName,
                    avatar: userAvatar
                    });
                    await e.reply(segment.image(image), false);
                } catch {
                    await e.reply(`「${name}」已经在你的寮舍里啦，无需兑换`, true);
                }
                return true;
            }
        } catch { }

        const spendResult = await this.walletMgr.spend(e.user_id, { faith: cost });
        if (!spendResult.ok) {
            // 信仰不足：灰色按钮，数字红色
            try {
                const image = await renderExchangeCard({
                    name,
                    isLimited,
                    cost,
                    faith: spendResult.wallet.faith,
                    portraitPath,
                    state: 'insufficient',
                    nickname: userName,
                    avatar: userAvatar
                });
                await e.reply(segment.image(image), false);
            } catch {
                await e.reply(`信仰不足（需要 ${cost}，当前 ${spendResult.wallet.faith}）。\n每次寻觅可获得 1 点信仰，继续寻觅攒攒吧~`, true);
            }
            return true;
        }

        // 兑换的雀士入图鉴（必为新获得：已拥有在上面拦截）
        await this.collectionMgr.add(e.user_id, 'characters', name);
        const limitedText = isLimited ? '限定雀士' : '雀士';
        try {
            const image = await renderExchangeCard({
                name,
                isLimited,
                cost,
                faith: spendResult.wallet.faith,
                portraitPath: await this.collectionMgr.getCharacterPortrait(name),
                nickname: userName,
                avatar: userAvatar
            });
            await e.reply(segment.image(image));
        } catch (error) {
            // 图片渲染失败退回文字，不影响兑换本身（雀士已入图鉴）
            logger.error('[雀魂经济] 兑换卡片渲染失败:', error);
            await e.reply(`兑换成功！消耗信仰 ${cost}，获得${limitedText}「${name}」，快去寮舍看看吧`);
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
        // 封面显示实际发放总额（含公共池注入部分）
        const image = await renderPacketCover(result.total, count);
        // 不引用回复发红包人
        await e.reply(segment.image(image));
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
        const userName = e.sender?.card || e.sender?.nickname || String(e.user_id);
        const note = converted.length > 0 ? `自动兑换：${converted.join('；')}` : '';
        const image = await renderGrabCard(userName, result.amount, note);
        await e.reply(segment.image(image));
        return true;
    }

    // #发送邮件 货币x数量...（master 群发当前群）
    async sendMail(e) {
        if (!e.group_id) {
            await e.reply('邮件功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?发送邮件\s+(.+)$/);
        const parsed = GachaMail.parseRewards(match[1]);
        if (!parsed) {
            await e.reply('未解析到有效奖励，示例：#发送邮件 星之粉尘5 寻觅卷轴1\n可在奖励前加标题，如：#发送邮件 新春活动 辉玉100000\n可指定有效期，如：#发送邮件 活动奖励 辉玉100 有效7天（未指定默认 30 天）', true);
            return true;
        }

        const mail = await this.mailMgr.send(e.group_id, parsed.rewards, parsed.title, parsed.ttlDays);
        const days = Math.round((mail.expireAt - mail.createdAt) / 86400000);
        // 发放回执出图：单个邮件 + 奖励明细（复用邮件卡风格）
        const items = Object.entries(parsed.rewards || {})
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => ({ icon: CURRENCY_ICONS[k] || k, count: Number(v) }));
        try {
            const image = await renderMailCard({
                mails: [{ title: mail.title, expireAt: mail.expireAt }],
                items,
                // 发送回执：不显示操作者头像昵称；右栏用自绘「奖励一览」金字；信封用未读态
                rewardTitle: 'rewardlist',
                unread: true,
                hideUser: true,
                footerHint: `已发放到本群　·　${days} 天内有效　·　成员发送 #雀魂邮件 领取`
            });
            await e.reply(segment.image(image), false);
        } catch (error) {
            logger.error('[雀魂经济] 发送邮件回执渲染失败:', error);
            await e.reply(`已向本群发放奖励邮件「${mail.title}」：${GachaMail.formatRewards(parsed.rewards)}\n成员发送"雀魂邮件"即可领取（${days} 天内有效）`);
        }
        return true;
    }

    // #雀魂邮件：领取全部未领奖励，图片展示
    async claimMail(e) {
        if (!e.group_id) {
            await e.reply('邮件功能仅限群聊使用');
            return true;
        }
        const { mails, totals } = await this.mailMgr.claimAll(e.group_id, e.user_id);
        const nickname = this._displayName(e);
        const avatar = this._avatarUrl(e);
        // 没有可领取的邮件：出官方空状态图（「暂无邮件」/「什么都没有...」）
        if (mails.length === 0) {
            const image = await renderMailCard({ mails: [], items: [], nickname, avatar });
            await e.reply(segment.image(image), false);
            return true;
        }

        // 奖励入钱包（自动兑换链）
        await this.walletMgr.add(e.user_id, totals);

        // 奖励为空/数据异常时仅发文字提示，避免渲染崩溃
        const items = ['jade', 'ticket', 'ticket10', 'dust', 'stone', 'wish', 'faith']
            .filter(key => totals[key])
            .map(key => ({ icon: CURRENCY_ICONS[key], count: totals[key] }));
        if (items.length === 0) {
            await e.reply('该邮件无有效奖励内容，可用 #删除邮件 清理', true);
            return true;
        }

        // 图片已含邮件标题列表与奖励明细，左下角带头像与昵称，因此不引用回复
        const image = await renderMailCard({
            mails,
            items,
            nickname: this._displayName(e),
            avatar: this._avatarUrl(e)
        });
        await e.reply(segment.image(image), false);
        return true;
    }

    // #删除邮件 [序号/全部]（master）：列出邮件或删除指定邮件
    async deleteMail(e) {
        if (!e.group_id) {
            await e.reply('邮件功能仅限群聊使用');
            return true;
        }
        const match = e.msg.match(/^#?删除邮件(?:\s+(\d+|全部))?$/);
        const target = match?.[1];

        // 不带参数：列出全部邮件
        if (!target) {
            const mails = await this.mailMgr.list(e.group_id);
            if (mails.length === 0) {
                await e.reply('当前没有邮件', true);
                return true;
            }
            const lines = mails.map((m, i) =>
                `${i + 1}. 「${m.title}」${GachaMail.formatRewards(m.rewards)}（已领 ${Array.isArray(m.claimed) ? m.claimed.length : 0} 人）`
            );
            await e.reply(`共 ${mails.length} 封邮件：\n${lines.join('\n')}\n删除：#删除邮件 <序号>，全部删除：#删除邮件 全部`);
            return true;
        }

        const result = await this.mailMgr.remove(e.group_id, target);
        if (!result.ok) {
            await e.reply(result.reason, true);
            return true;
        }
        if (target === '全部') {
            await e.reply(`已删除全部 ${result.removed} 封邮件`);
        } else {
            await e.reply(`已删除邮件「${result.mail.title}」：${GachaMail.formatRewards(result.mail.rewards)}`);
        }
        return true;
    }

    // #设置<货币名> [ID] [数量]（master）
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

    // #保存数据（master）：业务数据已实时落盘 SQLite，此命令仅对 Redis 临时数据做快照兜底
    async saveData(e) {
        try {
            await redis.sendCommand(['BGSAVE']);
            await e.reply('已请求 Redis 存盘（临时数据快照）。仓库/寮舍/绑定等业务数据实时写入 SQLite，无需手动保存');
        } catch (error) {
            logger.error('[雀魂经济] 手动存盘失败:', error);
            await e.reply('存盘失败，系统异常', true);
        }
        return true;
    }

    // #设置全员辉玉 <数量>（master）：批量把所有有钱包记录的用户辉玉设为固定值（校正数据用）
    async setAllJade(e) {
        const match = e.msg.match(/^#?设置全员辉玉\s+(\d+)$/);
        if (!match) return false;
        const amount = parseInt(match[1]);
        const count = await this.walletMgr.setAll('jade', amount);
        if (count > 0) {
            await e.reply(`已将 ${count} 位有钱包记录用户的辉玉统一设置为 ${amount}`);
        } else {
            await e.reply('没有找到任何钱包记录，无人可设置', true);
        }
        return true;
    }
}

