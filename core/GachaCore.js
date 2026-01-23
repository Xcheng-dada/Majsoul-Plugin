// plugins/Majsoul-Plugin/core/GachaCore.js
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

// 获取当前文件的目录（ES Module 写法）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // 加载卡池配置 gacha.json
    async gachaLoader() {
        const filePath = path.join(this.resourcesRoot, 'gacha.json');
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    }

    // 加载群组卡池配置 group_pool.json
    async groupPoolLoader() {
        const filePath = path.join(this.resourcesRoot, 'group_pool.json');
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            // 如果文件不存在，返回空数组
            return [];
        }
    }

    // 保存群组卡池配置（用于切换卡池时调用）
    async saveGroupPool(data) {
        const filePath = path.join(this.resourcesRoot, 'group_pool.json');
        await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');
    }

    // 主抽卡函数
    async runGacha(groupId) {
        // 检查抽卡开关状态
        const isEnabled = await this.getGachaStatus(groupId);
        if (!isEnabled) {
            throw new Error('本群抽卡功能已关闭');
        }
        
        const pool = await this.gachaLoader();
        const groupPool = await this.groupPoolLoader();

        let poolName = null;
        const newGroupPool = [];
        let hasGuaranteed = false; // 新增：保底标志

        // 1. 查找并确定当前群组的卡池
        for (const item of groupPool) {
            if (item.gid === String(groupId)) {
                poolName = item.poolname;
                // 检查卡池是否存在，如果不存在则使用normal池
                if (!pool[poolName]) {
                    poolName = 'normal';
                    item.poolname = 'normal';
                }
                newGroupPool.push(item);
            } else {
                newGroupPool.push(item);
            }
        }

        // 2. 如果该群未设置卡池，使用默认"normal"池并保存
        if (poolName === null) {
            poolName = 'normal';
            newGroupPool.push({
                gid: String(groupId),
                poolname: 'normal'
            });
            await this.saveGroupPool(newGroupPool);
        }

        // 3. 执行十连抽卡
        const result = [];
        const purpleGift = pool.purple_gift || []; // 保底紫色礼物列表
        let purpleFlag = 0;

        for (let i = 0; i < 10; i++) {
            const singleResult = await this.singlePull(pool, poolName);
            result.push(singleResult);
            // 保底判断逻辑：只有蓝色礼物(GIFT_BLUE)且不在紫色礼物列表中才计数
            if (singleResult[0] === ITEM_TYPE.GIFT_BLUE) {
                // 获取礼物名称（不带扩展名）
                let giftName = singleResult[1];
                const extIndex = giftName.lastIndexOf('.');
                if (extIndex !== -1) {
                    giftName = giftName.substring(0, extIndex);
                }
                // 检查是否在紫色礼物列表中
                if (!purpleGift.includes(giftName + '.jpg') && !purpleGift.includes(giftName)) {
                    purpleFlag++;
                }
            }
        }

        // 4. 十连保底机制：如果前10抽都是普通礼物(蓝礼物且非紫礼物)，第10抽强制出紫
        if (purpleFlag === 10 && result[9][0] === ITEM_TYPE.GIFT_BLUE) {
            result[9][0] = ITEM_TYPE.GIFT_PURPLE; // 改为紫色礼物标识
            const randomIndex = Math.floor(Math.random() * purpleGift.length);
            
            // 修复：确保不重复添加 .jpg 后缀
            let giftName = purpleGift[randomIndex];
            
            // 如果 giftName 已经有 .jpg 后缀，就不再加
            if (!giftName.toLowerCase().endsWith('.jpg') && !giftName.toLowerCase().endsWith('.jpeg')) {
                giftName += '.jpg';
            }
            
            result[9][1] = giftName;
            hasGuaranteed = true; // 设置保底标志
        }

        // 5. 拼接图片并返回结果
        const imageBase64 = await this.concatImages(result, poolName);
        return {
            imageBase64: imageBase64,
            results: result,
            hasGuaranteed: hasGuaranteed // 新增：返回保底标志
        };
    }

    // 单次抽卡
    async singlePull(pool, poolName) {
        // --- 惰性初始化：确保角色文件映射已构建 ---
        if (this.characterFileMap.size === 0) {
            await this._buildCharacterFileMap();
        }

        // 1. 构建角色池
        const actualPoolName = pool[poolName] ? poolName : 'normal';
        const upPool = pool[actualPoolName]
            ? pool[actualPoolName].map(name => this.characterFileMap.get(name)).filter(Boolean)
            : [];
        const normalPool = pool.normal
            ? pool.normal.map(name => this.characterFileMap.get(name)).filter(Boolean)
            : [];

        // 2. 异步读取其他目录
        const [blueGiftList, purpleGiftList, baseDecorationList] = await Promise.all([
            this.fileLoader('gift/blue'),
            this.fileLoader('gift/purple'),
            this.fileLoader('decoration') // 基础装饰（decoration根目录）
        ]);

        // 3. 处理特殊卡池的UP装饰
        let upDecorationList = [];
        let otherDecorationList = [...baseDecorationList]; // 基础装饰作为其他装饰
        
        // 加载当前卡池的UP装饰（从decoration/卡池名目录）
        if (actualPoolName !== 'normal') {
            // 特殊卡池（如huiye、saki1、saki2等）有自己的UP装饰文件夹
            const upDecor = await this.fileLoader('decoration', actualPoolName);
            upDecorationList.push(...upDecor);
        }
        
        // 特殊处理saki2卡池，它既有decoration/saki2文件夹（作为UP装饰）
        // 也有额外的装饰文件夹（如decoration/saki2的特殊装饰）
        if (actualPoolName === 'saki2') {
            // saki2的UP装饰已经在上面加载了
            // 如果有额外的saki2装饰，可以额外加载
            // const extraSaki2Decor = await this.fileLoader('decoration', 'saki2_extra');
            // upDecorationList.push(...extraSaki2Decor);
        }

        // ========== 严格按照官方概率的两阶段随机 ==========
        const typeRoll = Math.random() * 100; // 第一阶段：决定大类
        let prop;
        let objInt;

        // 使用官方概率进行第一阶段判断
        if (typeRoll < 5) {
            // 5% 角色
            objInt = ITEM_TYPE.CHARACTER;
            // 角色选择逻辑：如果up池存在且非空，59%概率从UP池，41%概率从标配池
            let rolePool;
            if (upPool.length > 0) {
                const objIntPerson = Math.floor(Math.random() * 100) + 1;
                if (objIntPerson <= 59) {
                    rolePool = upPool;
                } else {
                    rolePool = normalPool;
                }
            } else {
                rolePool = normalPool; // up池不存在时，全从normal池抽
            }
            prop = rolePool[Math.floor(Math.random() * rolePool.length)];
            
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

    // 拼接图片
    async concatImages(imageResults, poolName) {
        const COL = 5;
        const ROW = 2;
        const UNIT_SIZE = 266;
        const GAP = 10;
        const TARGET_SIZE = 256;

        // 1. 准备图片Buffer数组
        const imageBuffers = await Promise.all(
            imageResults.map(async ([objInt, imgName]) => {
                // 根据 objInt 判断图片所在目录
                let possibleDirs = [];
                
                if (objInt === ITEM_TYPE.GIFT_BLUE) {
                    possibleDirs = ['gift/blue']; // 蓝色礼物目录
                } else if (objInt === ITEM_TYPE.GIFT_PURPLE) {
                    possibleDirs = ['gift/purple']; // 紫色礼物目录
                } else if (objInt === ITEM_TYPE.DECORATION) {
                    // 装饰图片：需要尝试多个目录
                    possibleDirs = ['decoration'];
                    // 特殊卡池子目录逻辑
                    if (poolName && poolName !== 'normal') {
                        possibleDirs.unshift(path.join('decoration', poolName));
                    }
                } else if (objInt === ITEM_TYPE.CHARACTER) {
                    possibleDirs = ['person'];
                } else {
                    // 未知类型，尝试所有可能目录
                    possibleDirs = ['gift', 'decoration', 'person'];
                }

                // 2. 动态查找文件
                let finalImagePath = null;
                const supportedExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

                // 遍历可能的目录
                for (const dir of possibleDirs) {
                    if (finalImagePath) break;
                    const baseDir = path.join(this.resourcesRoot, dir);

                    // 情况A: imgName 已包含后缀，直接检查
                    if (path.extname(imgName)) {
                        const tryPath = path.join(baseDir, imgName);
                        try {
                            await fs.access(tryPath);
                            finalImagePath = tryPath;
                            break;
                        } catch { continue; }
                    } 
                    // 情况B: imgName 无后缀，尝试所有支持的后缀
                    else {
                        for (const ext of supportedExt) {
                            const tryPath = path.join(baseDir, imgName + ext);
                            try {
                                await fs.access(tryPath);
                                finalImagePath = tryPath;
                                break;
                            } catch { continue; }
                        }
                    }
                }

                // 3. 如果未找到，抛出更清晰的错误
                if (!finalImagePath) {
                    const searchedDirs = possibleDirs.map(d => `"${d}"`).join(', ');
                    throw new Error(`无法找到图片文件 "${imgName}"。在目录 [${searchedDirs}] 中均未发现。`);
                }

                // 4. 使用找到的路径进行处理
                logger.debug(`[GachaCore] 图片加载: ${path.relative(this.resourcesRoot, finalImagePath)}`);
                return sharp(finalImagePath).resize(TARGET_SIZE, TARGET_SIZE).toBuffer();
            })
        );

        // 2. 创建画布并拼接
        const canvasWidth = UNIT_SIZE * COL + GAP;
        const canvasHeight = UNIT_SIZE * ROW + GAP;

        const canvas = sharp({
            create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 3,
                background: { r: 255, g: 255, b: 255 }
            }
        });

        // 3. 设置每张小图的位置
        const compositeInputs = imageBuffers.map((buffer, index) => ({
            input: buffer,
            top: GAP + Math.floor(index / COL) * UNIT_SIZE,
            left: GAP + (index % COL) * UNIT_SIZE,
        }));

        // 4. 合成、输出为JPEG、转为base64
        const outputBuffer = await canvas.composite(compositeInputs).jpeg({ quality: 75 }).toBuffer();
        const base64Str = outputBuffer.toString('base64');
        return `base64://${base64Str}`;
    }

    // 根据卡池名称获取ID
    getPoolId(name) {
        const map = {
            '辉夜大小姐想让我告白': 'huiye',
            '咲-saki-1': 'saki1',
            '咲-saki-2': 'saki2',
            '常驻池': 'normal',
            '斗牌传说': 'douhun',
            '狂赌之渊': 'kuangdu',
            '反叛的鲁路修': 'luluxiu',
            'Fate': 'fate',
            '银魂': 'yinhun',
            '限定': 'xianding',
            '魔法少女伊莉雅': 'mofa',
            '蔚蓝档案': 'bluearchive',
            '偶像大师闪耀色彩': 'ouxiang'
        };
        // 处理包含关键词的情况
        if (name.includes('辉夜')) return 'huiye';
        if (name.includes('常驻')) return 'normal';
        if (name.includes('斗牌')) return 'douhun';
        if (name.includes('狂赌')) return 'kuangdu';
        if (name.includes('saki') && name.includes('1')) return 'saki1';
        if (name.includes('saki') && name.includes('2')) return 'saki2';
        if (name.includes('鲁鲁修')) return 'luluxiu';
        if (name.includes('魔法')) return 'mofa';
        if (name.includes('限定')) return 'xianding';
        if (name.includes('蔚蓝')) return 'bluearchive';
        if (name.includes('Fate')) return 'fate';
        if (name.includes('银魂')) return 'yinhun';
        if (name.includes('偶像')) return 'ouxiang'

        return map[name] || null;
    }

    // 根据卡池ID获取名称
    getPoolName(id) {
        const map = {
            'huiye': '辉夜大小姐想让我告白',
            'saki1': '咲-saki-1',
            'saki2': '咲-saki-2',
            'normal': '常驻池',
            'douhun': '斗牌传说',
            'kuangdu': '狂赌之渊',
            'luluxiu': '反叛的鲁路修',
            'fate': 'Fate',
            'yinhun': '银魂',
            'xianding': '限定',
            'mofa': '魔法少女伊莉雅',
            'bluearchive': '蔚蓝档案',
            'ouxiang': '偶像大师闪耀色彩'
        };
        return map[id] || '未知卡池';
    }
}