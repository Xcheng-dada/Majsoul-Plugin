// plugins/Majsoul-Plugin/utils/GachaCore.js
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

// 物品类型常量定义 (提升到类级别，全局可用)
export const ITEM_TYPE = {
    GIFT_BLUE: 1,   // 蓝色礼物
    GIFT_PURPLE: 2, // 紫色礼物 (独立类别)
    DECORATION: 3,  // 装饰/装扮
    CHARACTER: 4    // 角色
};

export default class GachaCore {
    constructor() {
        // 计算插件资源目录的绝对路径
        const baseDir = path.dirname(fileURLToPath(import.meta.url));
        this.resourcesRoot = path.join(baseDir, '..', 'resources');
        // 初始化角色名到真实文件名的映射缓存
        this.characterFileMap = new Map();
    }
    
    /**
     * 构建角色名到真实文件名的映射
     * 扫描 person 目录，将 gacha.json 中的角色名映射到实际存在的文件
     */
    async _buildCharacterFileMap() {
        this.characterFileMap.clear();
        const personDir = path.join(this.resourcesRoot, 'person');
        try {
            const files = await fs.readdir(personDir);
            const supportedExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (supportedExt.includes(ext)) {
                    const nameWithoutExt = path.basename(file, ext);
                    this.characterFileMap.set(nameWithoutExt, file);
                }
            }
            logger.debug(`[GachaCore] 角色文件映射构建完成，共 ${this.characterFileMap.size} 个文件。`);
        } catch (error) {
            logger.error(`[GachaCore] 构建角色文件映射失败:`, error);
        }
    }

    // 获取抽卡开关状态
    async getGachaStatus(groupId) {
        try {
            const status = await redis.get(`Yunzai:majsoul_gacha:status:${groupId}`);
            return status === null || status === 'true'; // 默认为开启状态
        } catch (error) {
            logger.error(`[GachaCore] 获取抽卡开关状态失败:`, error);
            return true; // 出错时默认为开启
        }
    }

    // 设置抽卡开关状态
    async setGachaStatus(groupId, status) {
        try {
            const key = `Yunzai:majsoul_gacha:status:${groupId}`;
            await redis.set(key, status ? 'true' : 'false');
            logger.debug(`[GachaCore] 设置群 ${groupId} 抽卡状态为: ${status}`);
            return true;
        } catch (error) {
            logger.error(`[GachaCore] 设置抽卡开关状态失败:`, error);
            return false;
        }
    }

    // 读取指定资源目录下的图片文件列表
    async fileLoader(fileType, subDir = '') {
        const dirPath = path.join(this.resourcesRoot, fileType, subDir);
        try {
            await fs.access(dirPath);
            const files = await fs.readdir(dirPath);
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
            const imageFiles = [];
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (imageExtensions.includes(ext)) {
                    imageFiles.push(file);
                }
            }
            return imageFiles;
        } catch (error) {
            // 目录不存在或无权限访问，返回空数组
            return [];
        }
    }

    // 加载卡池配置 gacha.json（并合并自定义UP池 data/custom_up.json，池ID为 custom:<池名>）
    // 性别池：male=竹林之路、female=樱花之路，概率一致，仅雀士按性别区分
    // （装扮与礼物不分卡池）；名单为空时等同全部雀士
    async gachaLoader() {
        const filePath = path.join(this.resourcesRoot, '..', 'config', 'gacha.json');
        const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        const custom = await this.customPoolLoader();
        if (custom && typeof custom === 'object') {
            data.__customRates = {};
            data.__customBase = {};
            for (const [name, info] of Object.entries(custom)) {
                if (Array.isArray(info?.characters) && info.characters.length > 0) {
                    const poolId = `custom:${name}`;
                    data[poolId] = info.characters;
                    data.__customRates[poolId] = Number(info.upRate) || 59;
                    // 挂靠池：联动池与樱花（female）/竹林（male）合并，而非与常驻大混池
                    data.__customBase[poolId] = info.base === 'male' ? 'male' : 'female';
                }
            }
        }
        return data;
    }

    // 自定义UP池文件路径（格式：{ "池名": { characters: [雀士名], upRate: 20 } })
    get customPoolFile() {
        return path.join(this.resourcesRoot, '..', 'data', 'custom_up.json');
    }

    // 加载自定义UP池（不存在返回 null）
    async customPoolLoader() {
        try {
            const data = JSON.parse(await fs.readFile(this.customPoolFile, 'utf-8'));
            return data && typeof data === 'object' ? data : null;
        } catch {
            return null;
        }
    }

    // 保存自定义UP池
    async saveCustomPool(custom) {
        await fs.writeFile(this.customPoolFile, JSON.stringify(custom, null, 4), 'utf-8');
    }

    // 删除自定义UP池
    async removeCustomPool() {
        try {
            await fs.unlink(this.customPoolFile);
        } catch {}
    }

    // 校验卡池是否存在（性别池始终视为存在：名单为空时等同全部雀士）
    async poolExists(poolId) {
        if (poolId === 'male' || poolId === 'female') return true;
        const data = await this.gachaLoader();
        if (data[poolId]) return true;
        // 联动池变体：<主题池ID>|<female|male>（如 doupin|female）
        if (typeof poolId === 'string' && poolId.includes('|')) {
            const [themeId, gender] = poolId.split('|');
            return (gender === 'female' || gender === 'male') && !!data[themeId];
        }
        return false;
    }

    // 解析用户实际抽卡池：个人选择（校验存在）→ master 全局池 → 默认樱花之路
    // 全局池为联动池（主题池）时默认抽樱花变体，群友可 #切换卡池 <池名> 竹林 切换竹林变体
    async resolveUserPool(groupId, userId) {
        if (userId != null) {
            try {
                const userPick = await redis.get(`Yunzai:majsoul_gacha:userpool:${groupId}:${userId}`);
                if (userPick && await this.poolExists(userPick)) {
                    return userPick;
                }
            } catch (error) {
                logger.error(`[GachaCore] 读取用户卡池选择失败:`, error);
            }
        }
        try {
            // master 设置的全局池（对所有群生效）；联动池（主题池）默认抽樱花变体
            const globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
            if (globalPool) {
                if (globalPool === 'male' || globalPool === 'female') {
                    return globalPool;
                }
                if (await this.poolExists(globalPool)) {
                    if (!String(globalPool).startsWith('custom:')) {
                        return `${globalPool}|female`;
                    }
                    return globalPool;
                }
            }
        } catch (error) {
            logger.error(`[GachaCore] 读取全局卡池失败:`, error);
        }
        return 'female';
    }

    // 主抽卡函数
    async runGacha(groupId, times = 10, userId = null) {
        // 检查抽卡开关状态
        const isEnabled = await this.getGachaStatus(groupId);
        if (!isEnabled) {
            throw new Error('本群抽卡功能已关闭');
        }

        const pool = await this.gachaLoader();
        const poolName = await this.resolveUserPool(groupId, userId);

        // 执行抽卡
        const result = [];
        const purpleGift = pool.purple_gift || []; // 保底紫色礼物列表
        let purpleFlag = 0;
        let hasGuaranteed = false; // 保底标志（仅十连生效）

        for (let i = 0; i < times; i++) {
            const singleResult = await this.singlePull(pool, poolName);

            // 十连保底机制：仅十连时生效，如果前9抽都是普通礼物且第10抽也是蓝礼物，强制出紫
            if (times === 10 && i === times - 1 && purpleFlag === times - 1 && singleResult[0] === ITEM_TYPE.GIFT_BLUE) {
                singleResult[0] = ITEM_TYPE.GIFT_PURPLE; // 改为紫色礼物标识
                const randomIndex = Math.floor(Math.random() * purpleGift.length);

                // 如果 giftName 已经有 .jpg 后缀，就不再加
                let giftName = purpleGift[randomIndex];
                if (!giftName.toLowerCase().endsWith('.jpg') && !giftName.toLowerCase().endsWith('.jpeg')) {
                    giftName += '.jpg';
                }

                singleResult[1] = giftName;
                hasGuaranteed = true; // 设置保底标志
            }

            result.push(singleResult);

            // 保底计数逻辑：只有蓝色礼物(GIFT_BLUE)且不在紫色礼物列表中才计数
            if (singleResult[0] === ITEM_TYPE.GIFT_BLUE) {
                let giftName = singleResult[1];
                const extIndex = giftName.lastIndexOf('.');
                if (extIndex !== -1) {
                    giftName = giftName.substring(0, extIndex);
                }
                if (!purpleGift.includes(giftName + '.jpg') && !purpleGift.includes(giftName)) {
                    purpleFlag++;
                }
            }
        }

        // 4. 拼接图片并返回结果
        const imageBase64 = await this.concatImages(result, poolName);
        return {
            imageBase64: imageBase64,
            results: result,
            hasGuaranteed: hasGuaranteed, // 保底标志
            poolName: poolName            // 本次抽卡使用的卡池
        };
    }

    // 单次抽卡
    async singlePull(pool, poolName) {
        // --- 惰性初始化：确保角色文件映射已构建 ---
        if (this.characterFileMap.size === 0) {
            await this._buildCharacterFileMap();
        }

        // 1. 池名解析：支持联动池变体（<主题池ID>|<female|male>，如 doupin|female）
        let variantBase = null; // 联动池变体的挂靠性别池
        let actualPoolName = pool[poolName] ? poolName : null;
        if (!pool[poolName] && typeof poolName === 'string' && poolName.includes('|')) {
            const [themeId, gender] = poolName.split('|');
            if (pool[themeId] && (gender === 'female' || gender === 'male')) {
                actualPoolName = themeId;
                variantBase = gender;
            }
        }
        const upPool = actualPoolName
            ? pool[actualPoolName].map(name => this.characterFileMap.get(name)).filter(Boolean)
            : [];

        // 2. 异步读取其他目录
        const [blueGiftList, purpleGiftList, rawDecorationList] = await Promise.all([
            this.fileLoader('gift/intermediate'),
            this.fileLoader('gift/advanced'),
            this.fileLoader('decoration') // 基础装饰（decoration根目录）
        ]);

        // 装扮与礼物不分卡池：所有卡池装扮均为全量
        const baseDecorationList = rawDecorationList;

        // 3. 处理特殊卡池的UP装饰（联动池额外增加的装扮，49%概率UP）
        let upDecorationList = [];
        let otherDecorationList = [...baseDecorationList]; // 基础装饰作为其他装饰

        // 加载当前卡池的UP装扮（从decoration/卡池名目录；自定义UP池目录为纯池名，去掉 custom: 前缀）
        if (actualPoolName) {
            const decorDir = actualPoolName.startsWith('custom:') ? actualPoolName.slice('custom:'.length) : actualPoolName;
            const upDecor = await this.fileLoader('decoration', decorDir);
            upDecorationList.push(...upDecor);
        }
        
        // 特殊处理saki2卡池，它既有decoration/saki2文件夹（作为UP装饰）
        // 也有额外的装饰文件夹（如decoration/saki2的特殊装饰）

        // ========== 严格按照官方概率的两阶段随机 ==========
        const typeRoll = Math.random() * 100; // 第一阶段：决定大类
        let prop;
        let objInt;

        // 使用官方概率进行第一阶段判断
        if (typeRoll < 5) {
            // 5% 角色
            // 角色选择逻辑：如果up池存在且非空，按UP概率从UP池，否则从标配池
            // 自定义UP池按创建时指定概率（贵人20%/普通59%），联动池维持 59%
            // 性别池（竹林之路/樱花之路）为 100% 池内名单；名单为空或无效池时本次按礼物处理（不合并樱花竹林兜底）
            // 联动池变体（<主题池>|female/male）与自定义UP池未命中UP时，从挂靠的竹林/樱花名单抽，名单为空同样按礼物处理
            let rolePool = null;
            if (upPool.length > 0) {
                if (actualPoolName === 'male' || actualPoolName === 'female') {
                    rolePool = upPool;
                } else {
                    const customRate = pool.__customRates?.[actualPoolName];
                    const upRate = customRate ?? 59;
                    // 挂靠性别池：联动池变体自带，自定义UP池来自创建时的 base 配置
                    const baseKey = variantBase || pool.__customBase?.[actualPoolName];
                    const objIntPerson = Math.floor(Math.random() * 100) + 1;
                    if (objIntPerson <= upRate) {
                        rolePool = upPool;
                    } else if (baseKey && Array.isArray(pool[baseKey])) {
                        const baseList = pool[baseKey].map(name => this.characterFileMap.get(name)).filter(Boolean);
                        if (baseList.length > 0) rolePool = baseList;
                    }
                }
            }
            if (rolePool && rolePool.length > 0) {
                objInt = ITEM_TYPE.CHARACTER;
                prop = rolePool[Math.floor(Math.random() * rolePool.length)];
            } else {
                // 候选名单为空：不出角色，本次按礼物处理
                const giftRarityRoll = Math.random() * 100;
                if (giftRarityRoll < 93.75) {
                    objInt = ITEM_TYPE.GIFT_BLUE;
                    prop = blueGiftList[Math.floor(Math.random() * blueGiftList.length)];
                } else {
                    objInt = ITEM_TYPE.GIFT_PURPLE;
                    prop = purpleGiftList[Math.floor(Math.random() * purpleGiftList.length)];
                }
            }

        } else if (typeRoll < 20) { // 5% + 15% = 20%
            // 15% 装饰
            objInt = ITEM_TYPE.DECORATION;
            
            // 装饰选择逻辑：如果有UP装扮，则49%概率从UP装扮中选择，51%概率从其他装扮中选择
            if (upDecorationList.length > 0) {
                const decorationRoll = Math.floor(Math.random() * 100) + 1;
                if (decorationRoll <= 49) {
                    // 49% 概率：从UP装扮中选择
                    prop = upDecorationList[Math.floor(Math.random() * upDecorationList.length)];
                } else {
                    // 51% 概率：从其他装扮中选择
                    prop = otherDecorationList[Math.floor(Math.random() * otherDecorationList.length)];
                }
            } else {
                // 没有UP装扮时（如normal池），从所有装扮中随机选择
                prop = baseDecorationList[Math.floor(Math.random() * baseDecorationList.length)];
            }
            
        } else {
            // 80% 礼物
            // 第二阶段：在礼物内部决定蓝紫 (93.75%, 6.25%)
            const giftRarityRoll = Math.random() * 100;
            if (giftRarityRoll < 93.75) {
                // 93.75% 概率：蓝色礼物 (占礼物部分的93.75%，总概率的75%)
                objInt = ITEM_TYPE.GIFT_BLUE;
                prop = blueGiftList[Math.floor(Math.random() * blueGiftList.length)];
            } else {
                // 6.25% 概率：紫色礼物 (占礼物部分的6.25%，总概率的5%)
                objInt = ITEM_TYPE.GIFT_PURPLE;
                prop = purpleGiftList[Math.floor(Math.random() * purpleGiftList.length)];
            }
        }

        // 5. 安全检查：确保 prop 有值
        if (!prop) {
            const allFiles = [...blueGiftList, ...purpleGiftList, ...upDecorationList, ...otherDecorationList, ...Array.from(this.characterFileMap.values())];
            prop = allFiles.length > 0 ? allFiles[0] : 'fallback.png';
            logger.error(`[GachaCore] singlePull 未选中文件，使用兜底: ${prop}`);
        }

        // 返回格式 [objInt, prop]
        return [objInt, prop];
    }

    /**
     * 定位抽卡物品图片的完整路径（供拼图与图鉴复用）
     * @param {string} imgName 文件名（可含后缀）
     * @param {number} objInt 物品类型（ITEM_TYPE）
     * @param {string|null} poolName 卡池名（用于装扮优先查卡池子目录）
     * @returns {Promise<string|null>} 图片绝对路径，未找到返回 null
     */
    async resolveItemImage(imgName, objInt, poolName) {
        // 根据 objInt 判断图片所在目录
        let possibleDirs = [];

        if (objInt === ITEM_TYPE.GIFT_BLUE) {
            possibleDirs = ['gift/intermediate']; // 中级礼物目录
        } else if (objInt === ITEM_TYPE.GIFT_PURPLE) {
            possibleDirs = ['gift/advanced']; // 高级礼物目录
        } else if (objInt === ITEM_TYPE.DECORATION) {
            // 装饰图片：需要尝试多个目录
            possibleDirs = ['decoration'];
            // 特殊卡池子目录逻辑（自定义UP池目录为纯池名去掉 custom: 前缀；联动池变体去掉 |gender 后缀）
            if (poolName && poolName !== 'normal') {
                let decorDir = poolName.startsWith('custom:') ? poolName.slice('custom:'.length) : poolName;
                if (decorDir.includes('|')) decorDir = decorDir.split('|')[0];
                possibleDirs.unshift(path.join('decoration', decorDir));
            }
        } else if (objInt === ITEM_TYPE.CHARACTER) {
            possibleDirs = ['person'];
        } else {
            // 未知类型，尝试所有可能目录
            possibleDirs = ['gift', 'decoration', 'person'];
        }

        const supportedExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

        // 遍历可能的目录
        for (const dir of possibleDirs) {
            const baseDir = path.join(this.resourcesRoot, dir);

            // 情况A: imgName 已包含后缀，直接检查
            if (path.extname(imgName)) {
                const tryPath = path.join(baseDir, imgName);
                try {
                    await fs.access(tryPath);
                    return tryPath;
                } catch { continue; }
            }
            // 情况B: imgName 无后缀，尝试所有支持的后缀
            else {
                for (const ext of supportedExt) {
                    const tryPath = path.join(baseDir, imgName + ext);
                    try {
                        await fs.access(tryPath);
                        return tryPath;
                    } catch { continue; }
                }
            }
        }
        return null;
    }

    // 拼接图片（行数动态：单抽居中放大 400px，多抽 5列动态行数 256px）
    async concatImages(imageResults, poolName) {
        const count = imageResults.length;
        const TARGET_SIZE = count === 1 ? 400 : 256;

        // 1. 准备图片Buffer数组
        const imageBuffers = await Promise.all(
            imageResults.map(async ([objInt, imgName]) => {
                const finalImagePath = await this.resolveItemImage(imgName, objInt, poolName);

                // 如果未找到，抛出更清晰的错误
                if (!finalImagePath) {
                    throw new Error(`无法找到图片文件 "${imgName}"。`);
                }

                logger.debug(`[GachaCore] 图片加载: ${path.relative(this.resourcesRoot, finalImagePath)}`);
                return sharp(finalImagePath).resize(TARGET_SIZE, TARGET_SIZE).toBuffer();
            })
        );

        let canvasWidth, canvasHeight, positions;

        if (count === 1) {
            // 单抽：居中放大
            const UNIT = TARGET_SIZE + 20;
            canvasWidth = UNIT;
            canvasHeight = UNIT;
            positions = imageBuffers.map(buffer => ({
                input: buffer,
                top: 10,
                left: 10,
            }));
        } else {
            // 多抽：5列动态行数
            const COL = 5;
            const UNIT_SIZE = 266;
            const GAP = 10;
            const ROW = Math.ceil(count / COL);

            canvasWidth = UNIT_SIZE * COL + GAP;
            canvasHeight = UNIT_SIZE * ROW + GAP;
            positions = imageBuffers.map((buffer, index) => ({
                input: buffer,
                top: GAP + Math.floor(index / COL) * UNIT_SIZE,
                left: GAP + (index % COL) * UNIT_SIZE,
            }));
        }

        // 2. 创建画布并合成、输出为JPEG、转为base64
        const canvas = sharp({
            create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 3,
                background: { r: 255, g: 255, b: 255 }
            }
        });

        const outputBuffer = await canvas.composite(positions).jpeg({ quality: 75 }).toBuffer();
        const base64Str = outputBuffer.toString('base64');
        return `base64://${base64Str}`;
    }

    // 根据卡池名称获取ID
    getPoolId(name) {
        const map = {
            '辉夜大小姐想让我告白': 'huiye',
            '咲-saki-1': 'saki1',
            '咲-saki-2': 'saki2',
            '竹林之路': 'male',
            '樱花之路': 'female',
            '斗牌传说': 'douhun',
            '狂赌之渊': 'kuangdu',
            '反叛的鲁路修': 'luluxiu',
            'Fate': 'fate',
            '银魂': 'yinhun',
            '魔法少女伊莉雅': 'mofa',
            '蔚蓝档案': 'bluearchive',
            '偶像大师闪耀色彩': 'ouxiang',
            '刀剑神域': 'daojian'
        };
        // 处理包含关键词的情况
        if (name.includes('竹林')) return 'male';
        if (name.includes('樱花')) return 'female';
        if (name.includes('辉夜')) return 'huiye';
        if (name.includes('斗牌')) return 'douhun';
        if (name.includes('狂赌')) return 'kuangdu';
        if (name.includes('saki') && name.includes('1')) return 'saki1';
        if (name.includes('saki') && name.includes('2')) return 'saki2';
        if (name.includes('鲁鲁修')) return 'luluxiu';
        if (name.includes('魔法')) return 'mofa';
        if (name.includes('蔚蓝')) return 'bluearchive';
        if (name.includes('Fate')) return 'fate';
        if (name.includes('银魂')) return 'yinhun';
        if (name.includes('偶像')) return 'ouxiang'
        if (name.includes('刀剑')) return 'daojian'

        return map[name] || null;
    }

    // 根据卡池ID获取名称（自定义UP池ID为 custom:<池名>）
    getPoolName(id) {
        if (typeof id === 'string' && id.startsWith('custom:')) {
            return id.slice('custom:'.length);
        }
        const map = {
            'huiye': '辉夜大小姐想让我告白',
            'saki1': '咲-saki-1',
            'saki2': '咲-saki-2',
            'male': '竹林之路',
            'female': '樱花之路',
            'douhun': '斗牌传说',
            'kuangdu': '狂赌之渊',
            'luluxiu': '反叛的鲁路修',
            'fate': 'Fate',
            'yinhun': '银魂',
            'mofa': '魔法少女伊莉雅',
            'bluearchive': '蔚蓝档案',
            'ouxiang': '偶像大师闪耀色彩',
            'daojian': '刀剑神域',
            'guiren': '贵人限定'
        };
        return map[id] || '未知卡池';
    }

    // 获取抽卡结果标题用的池名
    // 自定义UP池/联动池变体：池名本身含"樱花/竹林"时直接显示池名（如：樱花烂漫Ⅰ），
    // 否则追加挂靠后缀（如：赤影骁歌（樱花特别寻觅）、斗牌传说（竹林特别寻觅））
    async getPoolDisplayTitle(poolId) {
        if (typeof poolId === 'string' && poolId.startsWith('custom:')) {
            const name = poolId.slice('custom:'.length);
            if (/樱花|竹林/.test(name)) {
                return name;
            }
            try {
                const custom = await this.customPoolLoader();
                const base = custom?.[name]?.base;
                return base === 'male' ? `${name}（竹林特别寻觅）` : `${name}（樱花特别寻觅）`;
            } catch {
                return name;
            }
        }
        // 联动池变体：<主题池ID>|<female|male>
        if (typeof poolId === 'string' && poolId.includes('|')) {
            const [themeId, gender] = poolId.split('|');
            const name = this.getPoolName(themeId);
            if (/樱花|竹林/.test(name)) return name;
            return gender === 'male' ? `${name}（竹林特别寻觅）` : `${name}（樱花特别寻觅）`;
        }
        if (poolId === 'male') return '竹林之路';
        if (poolId === 'female') return '樱花之路';
        return this.getPoolName(poolId);
    }

    // 获取当前可用池列表（群友可见）：性别池 + 活跃自定义UP池 + 已开启的联动池（樱花/竹林双变体）
    async getAvailablePools() {
        const data = await this.gachaLoader();
        const pools = [
            { id: 'male', name: '竹林之路' },
            { id: 'female', name: '樱花之路' }
        ];
        // 活跃自定义UP池（贵人/限时UP，带挂靠标注）
        const custom = await this.customPoolLoader();
        if (custom) {
            for (const [name, info] of Object.entries(custom)) {
                if (!Array.isArray(info?.characters) || info.characters.length === 0) continue;
                const base = info.base === 'male' ? '竹林' : '樱花';
                const tag = Number(info.upRate) === 20 ? '贵人' : 'UP';
                pools.push({ id: `custom:${name}`, name: `${name}（${base}·${tag}）` });
            }
        }
        // 已开启的联动池：池名含"樱花/竹林"只开对应单变体，否则樱花+竹林双变体
        try {
            const globalPool = await redis.get('Yunzai:majsoul_gacha:globalpool');
            if (globalPool && !String(globalPool).startsWith('custom:') && !['male', 'female', 'normal'].includes(globalPool) && data[globalPool]) {
                const name = this.getPoolName(globalPool);
                if (/樱花/.test(name)) {
                    pools.push({ id: `${globalPool}|female`, name });
                } else if (/竹林/.test(name)) {
                    pools.push({ id: `${globalPool}|male`, name });
                } else {
                    pools.push({ id: `${globalPool}|female`, name: `${name}（樱花特别寻觅）` });
                    pools.push({ id: `${globalPool}|male`, name: `${name}（竹林特别寻觅）` });
                }
            }
        } catch {}
        return pools;
    }
}