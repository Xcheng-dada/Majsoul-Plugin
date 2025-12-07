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

    // 主抽卡函数：对应原 run_gacha 函数
    async runGacha(groupId) {
        const pool = await this.gachaLoader();
        const groupPool = await this.groupPoolLoader();

        let poolName = null;
        const newGroupPool = [];

        // 1. 查找并确定当前群组的卡池
        for (const item of groupPool) {
            if (item.gid === String(groupId)) {
                poolName = item.poolname;
                newGroupPool.push(item);
            } else {
                newGroupPool.push(item);
            }
        }

        // 2. 如果该群未设置卡池，使用默认“up”池并保存
        if (poolName === null) {
            poolName = 'up';
            newGroupPool.push({
                gid: String(groupId),
                poolname: 'up'
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
            // 【重要修正】保底判断逻辑：根据新的ITEM_TYPE标识判断
            // 只有蓝色礼物(GIFT_BLUE)且不在紫色礼物列表中才计数
            if (singleResult[0] === ITEM_TYPE.GIFT_BLUE && !purpleGift.includes(singleResult[1])) {
                purpleFlag++;
            }
        }

    // 修改 runGacha 方法中的保底逻辑部分：
    // 十连保底机制：如果前9抽都是普通礼物(蓝礼物且非紫礼物)，第10抽强制出紫
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
    }

        // 5. 拼接图片并返回结果
        const imageBase64 = await this.concatImages(result, poolName);
        return {
            imageBase64: imageBase64,
            results: result
        };
    }

    // 单次抽卡：完整复刻原 single_pull 函数逻辑
    async singlePull(pool, poolName) {
        // --- 惰性初始化：确保角色文件映射已构建 ---
        if (this.characterFileMap.size === 0) {
            await this._buildCharacterFileMap();
        }

        // 1. 构建角色池
        const upPool = pool[poolName]
            ? pool[poolName].map(name => this.characterFileMap.get(name)).filter(Boolean)
            : [];
        const normalPool = pool.normal
            ? pool.normal.map(name => this.characterFileMap.get(name)).filter(Boolean)
            : [];

        // 2. 异步读取其他目录
        // 【注意】需要先创建 resources/gift/blue/ 和 resources/gift/purple/ 目录
        const [blueGiftList, purpleGiftList, baseDecorationList] = await Promise.all([
        this.fileLoader('gift/blue'),
        this.fileLoader('gift/purple'),
        this.fileLoader('decoration')
        ]);

        // 3. 处理特殊卡池的额外装饰
        let decorationList = [...baseDecorationList];
        if (!['normal', 'up', 'kuangdu', 'douhun'].includes(poolName)) {
            const extraDecor = await this.fileLoader('decoration', poolName);
            decorationList.push(...extraDecor);
        }
        if (poolName === 'up') {
            const saki2Decor = await this.fileLoader('decoration', 'saki2');
            decorationList.push(...saki2Decor);
        }

        // ========== 【核心修改】严格按照官方概率的两阶段随机 ==========
        const typeRoll = Math.random() * 100; // 第一阶段：决定大类
        let prop;
        let objInt;

        // 使用官方概率进行第一阶段判断
        if (typeRoll < 5) {
            // 5% 角色
            objInt = ITEM_TYPE.CHARACTER;
            // 角色选择逻辑：51%概率从UP池，49%概率从标配池
            const objIntPerson = Math.floor(Math.random() * 100) + 1;
            let rolePool;
            if (objIntPerson <= 51 && upPool.length > 0) {
                rolePool = upPool;
            } else {
                rolePool = normalPool;
            }
            prop = rolePool[Math.floor(Math.random() * rolePool.length)];
            
        } else if (typeRoll < 20) { // 5% + 15% = 20%
            // 15% 装饰
            objInt = ITEM_TYPE.DECORATION;
            prop = decorationList[Math.floor(Math.random() * decorationList.length)];
            
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
                prop = purpleGiftList[Math.floor(Math.random() * purpleGiftList.length)]; // 临时
            }
        }

        // 5. 安全检查：确保 prop 有值
        if (!prop) {
            const allFiles = [...blueGiftList, ...purpleGiftList, ...decorationList, ...Array.from(this.characterFileMap.values())];
            prop = allFiles.length > 0 ? allFiles[0] : 'fallback.png';
            logger.error(`[GachaCore] singlePull 未选中文件，使用兜底: ${prop}`);
        }

        // 返回格式 [objInt, prop]
        return [objInt, prop];
    }

    // 拼接图片：对应原 concat_images 函数
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
                    if (poolName && poolName !== 'up') {
                        possibleDirs.unshift(path.join('decoration', poolName));
                    } else if (poolName === 'up') {
                        possibleDirs.unshift(path.join('decoration', 'saki2'));
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

    // 根据卡池名称获取ID：对应原 get_pool_id 函数
    getPoolId(name) {
        const map = {
            'up': 'up',
            '当前up池': 'up',
            '辉夜up池': 'huiye',
            '天麻up池1': 'saki1',
            '天麻up池2': 'saki2',
            '标配池': 'normal',
            '斗牌传说up池': 'douhun',
            '狂赌up池': 'kuangdu'
        };
        // 处理包含关键词的情况（原逻辑）
        if (name.includes('辉夜')) return 'huiye';
        if (name.includes('标配')) return 'normal';
        if (name.includes('斗牌')) return 'douhun';
        if (name.includes('狂赌')) return 'kuangdu';

        return map[name] || null;
    }

    // 根据卡池ID获取名称：对应原 get_pool_name 函数
    getPoolName(id) {
        const map = {
            'up': '当前up池',
            'huiye': '辉夜up池',
            'saki1': '天麻up池1',
            'saki2': '天麻up池2',
            'normal': '标配池',
            'douhun': '斗牌传说up池',
            'kuangdu': '狂赌up池'
        };
        return map[id] || '未知卡池';
    }
}