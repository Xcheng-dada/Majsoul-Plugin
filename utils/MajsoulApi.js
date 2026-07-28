// plugins/Majsoul-Plugin/utils/MajsoulApi.js
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// 牌谱屋（amae-koromo 数据节点）Bearer token。
// 作者要求：作为标准 Bearer token 添加到请求 header，并保持最大 1 QPS。
// 注意：该 token 为【使用者个人所有】，需各自联系牌谱屋作者获取，切勿共用他人 token。
// 仅从 data/token.json 读取（{"token":"你的token"}），无任何代码内置默认值。
// 该 token 与 AI 牌谱分析功能无关，仅用于：玩家查询 / 对局订阅 / 对局记录 / 雀魂搜索。
// 未配置时返回 null（不注入 Authorization，部分接口可能受限或被拒）。
const PAIPU_TOKEN_PATH = path.resolve('./plugins/Majsoul-Plugin/data/token.json')

function readPaipuToken() {
    try {
        if (fs.existsSync(PAIPU_TOKEN_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(PAIPU_TOKEN_PATH, 'utf8'))
            if (cfg && cfg.token && String(cfg.token).trim()) return String(cfg.token).trim()
        }
    } catch (e) {
        // 忽略读取/解析错误
    }
    return null
}

// 写入牌谱屋 token 到 data/token.json（文件不存在则自动创建），内容形如 {"token":"xxx"}
// 返回是否写入成功
function savePaipuToken(token) {
    try {
        const value = String(token || '').trim()
        if (!value) return false
        fs.writeFileSync(PAIPU_TOKEN_PATH, JSON.stringify({ token: value }, null, 2), 'utf8')
        return true
    } catch (e) {
        return false
    }
}

// 未配置牌谱屋 token 时面向最终用户的提示（与 AI 牌谱分析无关，仅影响玩家查询/对局订阅/对局记录/雀魂搜索）
const TOKEN_HINT = '⚠️ 未配置牌谱屋 Bearer token，玩家查询 / 对局订阅 / 对局记录 / 雀魂搜索等功能不可用。\n请先自行联系牌谱屋（amae-koromo）作者获取专属 token，再【私聊机器人】发送：设置token [你的token] 完成配置。'

/**
 * 主机探测类 - 自动选择最优API节点
 * @class HostProber
 */
class HostProber {
    /**
     * @param {string[]} hosts - API主机列表
     * @param {object} [logger] - 日志记录器
     */
    constructor(hosts, logger = null) {
        this.hosts = hosts;
        this.currentHost = hosts[0];
        this.probeResults = [];
        this.logger = logger || console;
    }

    /**
     * 测试单个主机延迟和可用性
     * @param {string} host - 主机地址
     * @returns {Promise<{host: string, latency: number, success: boolean, error?: string}>}
     */
    async _testHost(host) {
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超时

        try {
            // 使用GET请求测试玩家搜索接口，因为HEAD请求可能被拒绝
            const response = await this._apiFetch(`https://${host}/api/v2/pl4/search_player/test`, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                    'Accept': 'application/json'
                }
            });
            clearTimeout(timeoutId);
            const latency = Date.now() - startTime;
            // 即使返回404也视为节点可用（只是测试连通性）
            return { host, latency, success: response.status !== 0 };
        } catch (error) {
            clearTimeout(timeoutId);
            return { 
                host, 
                latency: Infinity, 
                success: false,
                error: error.message 
            };
        }
    }

    /**
     * 探测所有主机，选择最优节点
     * @returns {Promise<string>} - 最优主机地址
     */
    async probe() {
        this.logger.info('[HostProber] 开始探测API节点...');
        
        // 并行测试所有主机，设置超时保护
        const promises = this.hosts.map(host => 
            Promise.race([
                this._testHost(host),
                new Promise(resolve => setTimeout(() => {
                    resolve({ host, latency: Infinity, success: false, error: 'timeout' });
                }, 10000))
            ])
        );
        
        this.probeResults = await Promise.all(promises);

        // 打印探测结果
        this.probeResults.forEach(result => {
            if (result.success) {
                this.logger.debug(`[HostProber] 节点 ${result.host} 可用，延迟: ${result.latency}ms`);
            } else {
                this.logger.debug(`[HostProber] 节点 ${result.host} 不可用: ${result.error || 'unknown'}`);
            }
        });

        // 过滤成功的节点并按延迟排序
        const successful = this.probeResults.filter(r => r.success);
        if (successful.length === 0) {
            this.logger.warn('[HostProber] 所有节点探测失败，使用默认节点');
            return this.hosts[0];
        }

        const best = successful.reduce((a, b) => a.latency < b.latency ? a : b);
        this.currentHost = best.host;
        
        this.logger.info(`[HostProber] 探测完成，最优节点: ${best.host} (延迟: ${best.latency}ms)`);
        return best.host;
    }

    /**
     * 选择下一个可用节点（排除当前节点）
     * @param {boolean} [excludeCurrent=true] - 是否排除当前节点
     * @returns {boolean} - 是否成功切换
     */
    selectNextHost(excludeCurrent = true) {
        const currentIndex = this.hosts.indexOf(this.currentHost);
        
        // 优先使用探测结果
        let candidates = this.probeResults
            .filter((r, i) => r.success && (!excludeCurrent || i !== currentIndex))
            .sort((a, b) => a.latency - b.latency);
        
        // 如果没有预先探测结果，使用完整列表，但跳过已知不可用的节点
        if (candidates.length === 0) {
            candidates = this.hosts
                .filter((_, i) => !excludeCurrent || i !== currentIndex)
                .map(h => ({ host: h, latency: 0, success: true }));
        }
        
        // 跳过无法解析的节点（记录在probeResults中失败的）
        const failedHosts = this.probeResults
            .filter(r => !r.success)
            .map(r => r.host);
        
        candidates = candidates.filter(c => !failedHosts.includes(c.host));
        
        // 如果没有候选节点，尝试所有未排除的节点（包括之前失败的）
        if (candidates.length === 0) {
            candidates = this.hosts
                .filter((_, i) => !excludeCurrent || i !== currentIndex)
                .map(h => ({ host: h, latency: 0, success: true }));
        }
        
        if (candidates.length > 0) {
            const prevHost = this.currentHost;
            this.currentHost = candidates[0].host;
            if (prevHost !== this.currentHost) {
                this.logger.info(`[HostProber] 切换到备用节点: ${this.currentHost}`);
            }
            return true;
        }
        
        this.logger.warn('[HostProber] 没有可用的备用节点');
        return false;
    }

    /**
     * 重新探测所有节点
     * @returns {Promise<string>} - 新的最优主机地址
     */
    async reProbe() {
        this.logger.info('[HostProber] 重新探测所有API节点...');
        return await this.probe();
    }
}

/**
 * 请求频率限制器
 * @class RateLimiter
 */
class RateLimiter {
    /**
     * @param {number} maxRequests - 时间窗口内最大请求数
     * @param {number} windowMs - 时间窗口（毫秒）
     * @param {object} [options] - 额外选项
     * @param {number} [options.maxWaitTime] - 最大等待时间（毫秒）
     * @param {object} [options.logger] - 日志记录器
     */
    constructor(maxRequests = 10, windowMs = 60000, options = {}) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = [];
        this.maxWaitTime = options.maxWaitTime || 30000; // 默认最大等待30秒
        this.logger = options.logger || console;
        this._queue = [];
        this._processing = false;
    }

    /**
     * 获取剩余可用请求数
     * @returns {number} - 剩余请求数
     */
    getRemaining() {
        const now = Date.now();
        this.requests = this.requests.filter(r => now - r < this.windowMs);
        return Math.max(0, this.maxRequests - this.requests.length);
    }

    /**
     * 获取下一个请求需要等待的时间（毫秒）
     * @returns {number} - 等待时间
     */
    getWaitTime() {
        const now = Date.now();
        this.requests = this.requests.filter(r => now - r < this.windowMs);

        if (this.requests.length < this.maxRequests) {
            return 0;
        }

        const oldestRequest = this.requests[0];
        const waitTime = this.windowMs - (now - oldestRequest) + 100;
        return Math.max(0, waitTime);
    }

    /**
     * 获取令牌（等待如果需要）
     * @returns {Promise<boolean>} - 是否成功获取令牌
     */
    async acquire() {
        const waitTime = this.getWaitTime();
        
        if (waitTime > 0) {
            // 检查是否超过最大等待时间
            if (waitTime > this.maxWaitTime) {
                this.logger.warn(`[RateLimiter] 等待时间 ${waitTime}ms 超过最大限制 ${this.maxWaitTime}ms`);
                return false;
            }

            this.logger.debug(`[RateLimiter] 等待 ${waitTime}ms 后获取令牌`);
            
            // 使用最小延迟和计算的等待时间
            const actualWait = Math.max(waitTime, 100); // 至少等待100ms避免频繁请求
            await new Promise(resolve => setTimeout(resolve, actualWait));
        }

        this.requests.push(Date.now());
        return true;
    }

    /**
     * 尝试立即获取令牌（不等待）
     * @returns {boolean} - 是否成功获取令牌
     */
    tryAcquire() {
        if (this.getRemaining() > 0) {
            this.requests.push(Date.now());
            return true;
        }
        return false;
    }

    /**
     * 重置请求计数器
     */
    reset() {
        this.requests = [];
        this.logger.debug('[RateLimiter] 请求计数器已重置');
    }

    /**
     * 获取当前状态信息
     * @returns {object} - 状态对象
     */
    getStatus() {
        const now = Date.now();
        this.requests = this.requests.filter(r => now - r < this.windowMs);
        return {
            currentRequests: this.requests.length,
            maxRequests: this.maxRequests,
            remaining: this.maxRequests - this.requests.length,
            waitTime: this.getWaitTime(),
            windowMs: this.windowMs
        };
    }
    
    /**
     * 带队列的获取方法（FIFO）
     * @returns {Promise<void>}
     */
    async acquireQueued() {
        return new Promise((resolve) => {
            const attempt = () => {
                if (this.tryAcquire()) {
                    resolve();
                } else {
                    const waitTime = this.getWaitTime();
                    setTimeout(attempt, Math.min(waitTime, 500));
                }
            };
            attempt();
        });
    }
}

/**
 * 错误码映射
 * @enum {string}
 */
const ERROR_CODES = {
    '-1': '未找到玩家',
    '-2': '查询超时，请稍后再试',
    '-3': 'API服务器错误',
    '-4': '参数错误',
    '-5': '请求被拒绝',
    '-6': '请求频率过高，请稍后再试',
    '-400': '请求参数错误',
    '-401': '未授权访问',
    '-403': '访问被拒绝',
    '-404': '资源未找到',
    '-408': '请求超时',
    '-429': '请求过于频繁',
    '-500': '服务器内部错误',
    '-502': '网关错误',
    '-503': '服务不可用',
    '-504': '网关超时',
    '-1000': '网络连接错误',
    '-1001': 'DNS解析失败',
    '-1002': '连接被拒绝',
    '-1003': 'SSL证书错误',
    '-2000': '数据解析错误',
    '-2001': '数据格式异常',
    '-2002': '数据不完整'
};

/**
 * API错误类
 * @class MajsoulApiError
 * @extends Error
 */
class MajsoulApiError extends Error {
    /**
     * @param {string} code - 错误码
     * @param {string} message - 错误消息
     * @param {Error} [cause] - 原始错误对象
     */
    constructor(code, message, cause = null) {
        super(message);
        this.name = 'MajsoulApiError';
        this.code = code;
        this.cause = cause;
        if (cause) {
            this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
        }
    }
}

/**
 * 创建API错误
 * @param {string|number} code - 错误码
 * @param {Error} [cause] - 原始错误
 * @returns {MajsoulApiError}
 */
function createApiError(code, cause = null) {
    const message = ERROR_CODES[code.toString()] || '未知错误';
    return new MajsoulApiError(code.toString(), message, cause);
}

/**
 * 处理API错误
 * @param {Error|number|string} error - 错误对象、错误码或错误消息
 * @returns {string} - 错误消息
 */
function handleApiError(error) {
    if (error instanceof MajsoulApiError) {
        return error.message;
    }
    
    if (typeof error === 'number' || typeof error === 'string') {
        return ERROR_CODES[error.toString()] || '未知错误';
    }
    
    if (error instanceof Error) {
        // 网络相关错误
        if (error.code === 'ETIMEDOUT' || 
            error.message.includes('timeout') || 
            error.message.includes('aborted')) {
            return ERROR_CODES['-2'];
        }
        
        // HTTP状态码错误
        if (error.message.includes('400')) return ERROR_CODES['-400'];
        if (error.message.includes('401')) return ERROR_CODES['-401'];
        if (error.message.includes('403')) return ERROR_CODES['-403'];
        if (error.message.includes('404')) return ERROR_CODES['-404'];
        if (error.message.includes('408')) return ERROR_CODES['-408'];
        if (error.message.includes('429')) return ERROR_CODES['-429'];
        if (error.message.includes('500')) return ERROR_CODES['-500'];
        if (error.message.includes('502')) return ERROR_CODES['-502'];
        if (error.message.includes('503')) return ERROR_CODES['-503'];
        if (error.message.includes('504')) return ERROR_CODES['-504'];
        
        // 网络连接错误
        if (error.code === 'ECONNREFUSED') return ERROR_CODES['-1002'];
        if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND') return ERROR_CODES['-1001'];
        if (error.code === 'ERR_SSL_CERTIFICATE_ERROR') return ERROR_CODES['-1003'];
        if (error.code === 'ECONNRESET') return ERROR_CODES['-1000'];
        if (error.code === 'ETIMEDOUT') return ERROR_CODES['-2'];
        
        return error.message || '未知错误';
    }
    
    return '未知错误';
}

/**
 * 段位信息接口
 * @typedef {Object} PlayerLevel
 * @property {number} id - 段位ID
 * @property {number} score - 当前分数
 * @property {number} delta - 分数变化
 * @property {string} [name] - 段位名称
 * @property {number} [majorRank] - 主段位
 * @property {number} [minorRank] - 子段位
 */

/**
 * 玩家信息接口
 * @typedef {Object} PlayerInfo
 * @property {number} id - 玩家ID
 * @property {string} nickname - 玩家昵称
 * @property {PlayerLevel} level - 段位信息
 * @property {number[]} played_modes - 玩过的模式列表
 * @property {string} [tag] - 玩家标签
 * @property {number} [level_id] - 段位ID（兼容字段）
 */

/**
 * 对局玩家信息
 * @typedef {Object} GamePlayer
 * @property {number} accountId - 玩家账号ID
 * @property {string} nickname - 玩家昵称
 * @property {number} score - 对局得分
 * @property {number} [gradingScore] - 段位分变化
 * @property {number} [delta] - 分数变化（兼容字段）
 * @property {number} [level] - 段位ID
 * @property {number} [seat] - 座位号
 * @property {number} [rank] - 排名
 */

/**
 * 对局记录接口
 * @typedef {Object} GameRecord
 * @property {string} uuid - 对局唯一标识
 * @property {number} modeId - 模式ID
 * @property {number} startTime - 开始时间戳（秒）
 * @property {number} endTime - 结束时间戳（秒）
 * @property {GamePlayer[]} players - 玩家列表
 * @property {number} [version] - 版本号
 * @property {number} [type] - 对局类型
 * @property {number} [round] - 局数
 */

/**
 * 玩家统计信息
 * @typedef {Object} PlayerStats
 * @property {number} count - 对局数
 * @property {string} nickname - 玩家昵称
 * @property {PlayerLevel} level - 当前段位
 * @property {number} [maxLevel] - 最高段位
 * @property {number} [avgRank] - 平均顺位
 * @property {number} [winRate] - 和牌率
 * @property {number} [rankRate] - 放铳率
 * @property {number} [selfDrawRate] - 自摸率
 * @property {number} [riichiRate] - 立直率
 */

/**
 * API响应结果
 * @typedef {Object} ApiResponse
 * @property {boolean} success - 是否成功
 * @property {any} [data] - 响应数据
 * @property {string} [error] - 错误消息
 * @property {string} [code] - 错误码
 */

/**
 * 请求选项
 * @typedef {Object} RequestOptions
 * @property {number} [timeout] - 超时时间（毫秒）
 * @property {boolean} [retry] - 是否重试
 * @property {number} [maxRetries] - 最大重试次数
 * @property {object} [headers] - 请求头
 */

/**
 * 限流器单例：所有 MajsoulApi 实例（订阅/搜索/对局记录/查询…）共用同一个牌谱屋 token，
 * 必须用同一个限流器，否则各实例预算叠加会远超 token 的真实限额（作者要求 max 1 QPS）。
 * 首次构造时按传入 options 创建，之后所有实例复用。
 * @type {RateLimiter|null}
 */
let sharedRateLimiter = null;

/**
 * 雀魂API封装类
 * @class MajsoulApi
 */
export default class MajsoulApi {
    /**
     * 构造函数
     * @param {object} [options] - 配置选项
     * @param {number} [options.timeout] - 请求超时时间（毫秒）
     * @param {number} [options.maxRequestsPerMinute] - 每分钟最大请求数
     * @param {string[]} [options.customHosts] - 自定义API主机列表
     */
    constructor(options = {}) {
        /** @type {console|object} */
        this.logger = global.logger || console;

        /** @type {string} 牌谱屋 Bearer token（请求时注入 Authorization 头） */
        this.token = options.token || readPaipuToken();
        // 未配置 token 时不在此打日志；相关功能入口会检测 this.token 并向用户提示，避免定时任务等自动场景反复刷日志。

        /** @type {string[]} API主机列表 */
        this.apiHosts = options.customHosts || [
            "5-data.amae-koromo.com",
            "1.data.amae-koromo.com",
            "4.data.amae-koromo.com",
            "ak-data-1.sapk.ch"
        ];

        /** @type {HostProber} 主机探测实例（传递logger） */
        this.hostProber = new HostProber(this.apiHosts, this.logger);
        
        /** @type {string} 当前API基础URL */
        this.baseUrl = `https://${this.hostProber.currentHost}/api/v2`;

        /** @type {number} 请求超时时间（毫秒） */
        this.timeout = options.timeout || 15000;

        // 所有请求共用同一个牌谱屋 token，必须使用全局唯一的限流器（单例）。
        // 默认 30 次/分钟，低于 token 作者要求的 max 1 QPS（60/min）以留余量。
        this.rateLimiter = sharedRateLimiter || (sharedRateLimiter = new RateLimiter(
            options.maxRequestsPerMinute || 30,
            60000,
            { logger: this.logger, maxWaitTime: 600000 }
        ));

        /** @type {string} 固定时间戳 (2010-01-01) */
        this.startDateTimestamp = '1262304000000';

        /** @type {string} 四麻模式参数 */
        this.mode4Params = '16.12.9.15.11.8';

        /** @type {string} 三麻模式参数 */
        this.mode3Params = '22.24.26.21.23.25';

        /** @type {boolean} 是否已完成初始化探测 */
        this._initialized = false;

        /** @type {boolean} 是否启用调试模式 */
        this.debug = options.debug || false;
    }

    /**
     * 统一的 fetch 封装：自动注入牌谱屋 Bearer token（Authorization 头）。
     * 所有对 amae-koromo 数据节点的请求都应走此方法。
     * @param {string} url 
     * @param {object} [options] 
     * @returns {Promise<Response>}
     */
    async _apiFetch(url, options = {}) {
        if (!this.token) {
            throw new MajsoulApiError('TOKEN_REQUIRED', TOKEN_HINT);
        }
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
            'Accept': 'application/json',
            ...(options.headers || {})
        }
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`
        return fetch(url, { ...options, headers })
    }

    /**
     * 初始化API（执行主机探测）
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this._initialized) return;
        try {
            const bestHost = await this.hostProber.probe();
            this.baseUrl = `https://${bestHost}/api/v2`;
            this._initialized = true;
            this.logger.info(`[MajsoulApi] API初始化完成，使用节点: ${bestHost}`);
        } catch (error) {
            this.logger.warn(`[MajsoulApi] 初始化探测失败，使用默认节点: ${error.message}`);
        }
    }

    /**
     * 切换到下一个API节点
     * @param {Error} [lastError] - 上一次请求失败的错误
     * @param {number} [retryCount=0] - 当前重试次数
     */
    async _switchEndpoint(lastError = null, retryCount = 0) {
        // 如果遇到DNS解析失败，立即重新探测所有节点
        if (lastError && (lastError.message.includes('ENOTFOUND') || lastError.message.includes('EAI_AGAIN'))) {
            this.logger.info('[MajsoulApi] 检测到DNS解析失败，重新探测所有节点...');
            await this.hostProber.reProbe();
            this.baseUrl = `https://${this.hostProber.currentHost}/api/v2`;
            this.logger.info(`[MajsoulApi] 切换到API节点: ${this.hostProber.currentHost}`);
            return;
        }
        
        // 如果遇到429，使用指数退避策略等待后重试（不切换节点，只等待）
        if (lastError && lastError.message.includes('HTTP 429')) {
            const baseWaitTime = 10000;
            const maxWaitTime = 300000;
            const waitTime = Math.min(baseWaitTime * Math.pow(2, retryCount), maxWaitTime);
            this.logger.debug(`[MajsoulApi] 请求过于频繁(429)，第 ${retryCount + 1} 次重试，等待 ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return;
        }
        
        const success = this.hostProber.selectNextHost();
        if (success) {
            this.baseUrl = `https://${this.hostProber.currentHost}/api/v2`;
            this.logger.info(`[MajsoulApi] 切换到API节点: ${this.hostProber.currentHost}`);
        } else {
            this.logger.warn('[MajsoulApi] 无法切换到备用节点');
        }
    }

    /**
     * 搜索玩家
     * @param {string} playerName - 玩家昵称
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @returns {Promise<PlayerInfo[]>} - 玩家信息数组
     */
    async searchPlayer(playerName, mode = 4) {
        const rateLimiter = this.rateLimiter;
        const maxRetries = this.apiHosts.length;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await rateLimiter.acquire();
                const modeStr = mode.toString();
                const url = `${this.baseUrl}/pl${modeStr}/search_player/${encodeURIComponent(playerName)}`;
                const params = new URLSearchParams({
                    limit: '10',
                    tag: 'all'
                });

                const fullUrl = `${url}?${params}`;

                this.logger.info(`[MajsoulApi] 搜索玩家请求 (${modeStr === '4' ? '四麻' : '三麻'}): ${fullUrl}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await this._apiFetch(fullUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                /** @type {PlayerInfo[]} */
                const data = await response.json();

                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        this.logger.warn(`[MajsoulApi] 未找到昵称为 "${playerName}" 的玩家`);
                        return [];
                    }
                    this.logger.info(`[MajsoulApi] 搜索到 ${data.length} 个玩家`);
                    return data;
                } else if (data && typeof data === 'object') {
                    if (data.error) {
                        throw new Error(`API返回错误: ${data.error}`);
                    }
                    if (data.players && Array.isArray(data.players)) {
                        return data.players;
                    }
                }

                throw new Error('API返回的数据格式不正确');

            } catch (error) {
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    const waitTime = Math.min(10000 * Math.pow(2, attempt), 300000);
                    this.logger.info(`[MajsoulApi] 搜索玩家遇到429限流，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                this.logger.warn(`[MajsoulApi] 搜索玩家失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }

        return [];
    }

    /**
     * 获取玩家对局记录
     * @param {number} playerId - 玩家ID
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @returns {Promise<Object[]>} - 对局记录数组
     */
    async getPlayerRecords(playerId, mode = 4, limit = 2) {
        const rateLimiter = this.rateLimiter;
        const MAX_429_RETRIES = 3;
        const maxRetries = this.apiHosts.length;
        let totalWaitTime = 0;
        const modeName = mode === 4 ? '四麻' : '三麻';

        for (let attempt = 0; ; attempt++) {
            try {
                // 每次实际请求都先过共享限流器（含重试），避免绕开限流把请求量堆高
                await rateLimiter.acquire();
                const modeStr = mode.toString();

                this.logger.info(`[MajsoulApi] 获取${modeName}玩家记录，玩家ID: ${playerId}`);

                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();

                // 步骤1: 获取统计信息得到count
                const statsUrl = `${this.baseUrl}/pl${modeStr}/player_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;
                this.logger.debug(`[MajsoulApi] 获取统计信息: ${statsUrl}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const statsResponse = await this._apiFetch(statsUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!statsResponse.ok) {
                    throw new Error(`获取统计信息失败: HTTP ${statsResponse.status}`);
                }

                const statsData = await statsResponse.json();
                const count = statsData.count || 'all';

                this.logger.debug(`[MajsoulApi] 统计信息count值: ${count}`);

                // 步骤2: 获取对局记录（限制2条，按时间降序）
                await rateLimiter.acquire();
                const recordsUrl = `${this.baseUrl}/pl${modeStr}/player_records/${playerId}/${currentTimestamp}/${this.startDateTimestamp}?limit=${limit}&mode=${modeParams}&descending=true&tag=${count}`;
                this.logger.debug(`[MajsoulApi] 获取对局记录: ${recordsUrl}`);

                const recordsController = new AbortController();
                const recordsTimeoutId = setTimeout(() => recordsController.abort(), this.timeout);

                const recordsResponse = await this._apiFetch(recordsUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: recordsController.signal
                });

                clearTimeout(recordsTimeoutId);

                if (!recordsResponse.ok) {
                    throw new Error(`获取对局记录失败: HTTP ${recordsResponse.status}`);
                }

                const recordsData = await recordsResponse.json();

                // 确保返回的是数组
                let records = [];
                if (Array.isArray(recordsData)) {
                    records = recordsData;
                } else if (recordsData.records && Array.isArray(recordsData.records)) {
                    records = recordsData.records;
                } else if (recordsData.games && Array.isArray(recordsData.games)) {
                    records = recordsData.games;
                } else if (recordsData.matches && Array.isArray(recordsData.matches)) {
                    records = recordsData.matches;
                } else if (recordsData) {
                    records = [recordsData];
                }

                this.logger.info(`[MajsoulApi] 成功获取玩家 ${playerId} 的${modeName}对局记录，记录数: ${records.length}`);

                return records;

            } catch (error) {
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${modeName}] 玩家 ${playerId} 对局记录连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查（下个周期再试）`);
                        throw new Error(handleApiError('-429'));
                    }
                    const waitTime = Math.min(10000 * Math.pow(2, Math.floor(attempt / 2)), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${modeName}] 玩家 ${playerId} 对局记录遇到429限流，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                this.logger.warn(`[MajsoulApi] 获取玩家记录失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (mode === 4) {
                    const waitTime = Math.min(5000 * Math.pow(2, attempt), 60000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [四麻] 玩家 ${playerId} 对局记录请求失败，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }
    }

    /**
     * 获取玩家昵称
     * @param {number} playerId - 玩家ID
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @returns {Promise<string|null>} - 玩家昵称
     */
    async getPlayerNickname(playerId, mode = 4) {
        const rateLimiter = this.rateLimiter;
        await rateLimiter.acquire();
        const maxRetries = this.apiHosts.length;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const modeStr = mode.toString();
                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();

                const url = `${this.baseUrl}/pl${modeStr}/player_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;

                this.logger.debug(`[MajsoulApi] 获取玩家昵称: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await this._apiFetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();

                if (data && data.nickname) {
                    return data.nickname;
                }

                throw new Error('未找到昵称信息');

            } catch (error) {
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    this.logger.debug(`[MajsoulApi] 获取玩家昵称遇到429限流，跳过重试: ${error.message}`);
                    return null;
                }
                
                this.logger.warn(`[MajsoulApi] 获取玩家昵称失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }

        return null;
    }

    /**
     * 获取玩家详细统计信息
     * @param {number} playerId - 玩家ID
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @returns {Promise<Object>} - 统计信息
     */
    async getPlayerStats(playerId, mode = 4) {
        const rateLimiter = this.rateLimiter;
        const MAX_429_RETRIES = 3;
        const maxRetries = this.apiHosts.length;
        let totalWaitTime = 0;

        for (let attempt = 0; ; attempt++) {
            try {
                await rateLimiter.acquire();
                const modeStr = mode.toString();
                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();

                const url = `${this.baseUrl}/pl${modeStr}/player_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;

                this.logger.debug(`[MajsoulApi] 获取玩家统计: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await this._apiFetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.status === 404) {
                    this.logger.debug(`[MajsoulApi] 玩家 ${playerId} 在${modeStr === '4' ? '四麻' : '三麻'}模式下无数据，返回404`);
                    throw new Error(handleApiError('-404'));
                }

                if (response.status === 429) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查`);
                        throw new Error(handleApiError('-429'));
                    }
                    const retryAfter = parseInt(response.headers.get('Retry-After')) || 10;
                    const waitTime = Math.min(retryAfter * 1000 * (attempt + 1), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 遇到429限流，Retry-After: ${retryAfter}s，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                if (attempt > 0 || totalWaitTime > 0) {
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 统计获取成功，共${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s`);
                }
                return result;

            } catch (error) {
                if (error.message === '资源未找到') {
                    throw error;
                }
                
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查`);
                        throw new Error(handleApiError('-429'));
                    }
                    const waitTime = Math.min(10000 * Math.pow(2, Math.floor(attempt / 2)), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 遇到429限流，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                this.logger.warn(`[MajsoulApi] 获取玩家统计失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (mode === 4) {
                    const waitTime = Math.min(5000 * Math.pow(2, attempt), 60000);
                    this.logger.debug(`[MajsoulApi] 四麻请求失败，等待 ${waitTime}ms 后重试`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }
    }

    /**
     * 获取玩家扩展统计信息
     * @param {number} playerId - 玩家ID
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @returns {Promise<Object>} - 扩展统计信息
     */
    async getPlayerExtendedStats(playerId, mode = 4) {
        const rateLimiter = this.rateLimiter;
        const MAX_429_RETRIES = 3;
        const maxRetries = this.apiHosts.length;
        let totalWaitTime = 0;

        for (let attempt = 0; ; attempt++) {
            try {
                await rateLimiter.acquire();
                const modeStr = mode.toString();
                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();

                const url = `${this.baseUrl}/pl${modeStr}/player_extended_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;

                this.logger.debug(`[MajsoulApi] 获取玩家扩展统计: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await this._apiFetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.status === 429) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查`);
                        throw new Error(handleApiError('-429'));
                    }
                    const retryAfter = parseInt(response.headers.get('Retry-After')) || 10;
                    const waitTime = Math.min(retryAfter * 1000 * (attempt + 1), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 扩展统计遇到429限流，Retry-After: ${retryAfter}s，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                if (attempt > 0 || totalWaitTime > 0) {
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 扩展统计获取成功，共${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s`);
                }
                return result;

            } catch (error) {
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查`);
                        throw new Error(handleApiError('-429'));
                    }
                    const waitTime = Math.min(10000 * Math.pow(2, Math.floor(attempt / 2)), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${mode === 4 ? '四麻' : '三麻'}] 玩家 ${playerId} 扩展统计遇到429限流，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                this.logger.warn(`[MajsoulApi] 获取玩家扩展统计失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (mode === 4) {
                    const waitTime = Math.min(5000 * Math.pow(2, attempt), 60000);
                    this.logger.debug(`[MajsoulApi] 四麻请求失败，等待 ${waitTime}ms 后重试`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }
    }

    /**
     * 获取玩家最近对局记录（可指定数量）
     * @param {number} playerId - 玩家ID
     * @param {number} [mode=4] - 模式（3=三麻，4=四麻）
     * @param {number} [limit=10] - 返回数量限制
     * @returns {Promise<Object[]>} - 对局记录数组
     */
    async getRecentRecords(playerId, mode = 4, limit = 10) {
        const rateLimiter = this.rateLimiter;
        const MAX_429_RETRIES = 3;
        const maxRetries = this.apiHosts.length;
        let totalWaitTime = 0;
        const modeName = mode === 4 ? '四麻' : '三麻';

        for (let attempt = 0; ; attempt++) {
            try {
                await rateLimiter.acquire();
                const modeStr = mode.toString();

                this.logger.info(`[MajsoulApi] 获取${modeName}玩家最近对局，玩家ID: ${playerId}，数量: ${limit}`);

                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();

                // 步骤1: 获取统计信息得到count
                const statsUrl = `${this.baseUrl}/pl${modeStr}/player_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;
                this.logger.debug(`[MajsoulApi] 获取统计信息: ${statsUrl}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const statsResponse = await this._apiFetch(statsUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!statsResponse.ok) {
                    throw new Error(`获取统计信息失败: HTTP ${statsResponse.status}`);
                }

                const statsData = await statsResponse.json();
                const count = statsData.count || 'all';

                this.logger.debug(`[MajsoulApi] 统计信息count值: ${count}`);

                // 步骤2: 获取对局记录（按指定数量限制）
                await rateLimiter.acquire();
                const recordsUrl = `${this.baseUrl}/pl${modeStr}/player_records/${playerId}/${currentTimestamp}/${this.startDateTimestamp}?limit=${limit}&mode=${modeParams}&descending=true&tag=${count}`;
                this.logger.debug(`[MajsoulApi] 获取对局记录: ${recordsUrl}`);

                const recordsController = new AbortController();
                const recordsTimeoutId = setTimeout(() => recordsController.abort(), this.timeout);

                const recordsResponse = await this._apiFetch(recordsUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                        'Accept': 'application/json'
                    },
                    signal: recordsController.signal
                });

                clearTimeout(recordsTimeoutId);

                if (!recordsResponse.ok) {
                    throw new Error(`获取对局记录失败: HTTP ${recordsResponse.status}`);
                }

                const recordsData = await recordsResponse.json();

                // 确保返回的是数组
                let records = [];
                if (Array.isArray(recordsData)) {
                    records = recordsData;
                } else if (recordsData.records && Array.isArray(recordsData.records)) {
                    records = recordsData.records;
                } else if (recordsData.games && Array.isArray(recordsData.games)) {
                    records = recordsData.games;
                } else if (recordsData.matches && Array.isArray(recordsData.matches)) {
                    records = recordsData.matches;
                } else if (recordsData) {
                    records = [recordsData];
                }

                this.logger.info(`[MajsoulApi] 成功获取玩家 ${playerId} 的${modeName}最近对局，记录数: ${records.length}`);

                return records;

            } catch (error) {
                if (error.code === 'TOKEN_REQUIRED') throw error;
                if (error.message.includes('HTTP 429')) {
                    if (attempt >= MAX_429_RETRIES) {
                        this.logger.error(`[MajsoulApi] [${modeName}] 玩家 ${playerId} 最近对局连续 ${MAX_429_RETRIES} 次遭遇429限流，放弃本次检查（下个周期再试）`);
                        throw new Error(handleApiError('-429'));
                    }
                    const waitTime = Math.min(10000 * Math.pow(2, Math.floor(attempt / 2)), 300000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [${modeName}] 玩家 ${playerId} 最近对局遇到429限流，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                this.logger.warn(`[MajsoulApi] 获取玩家最近对局失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);

                if (mode === 4) {
                    const waitTime = Math.min(5000 * Math.pow(2, attempt), 60000);
                    totalWaitTime += waitTime;
                    this.logger.info(`[MajsoulApi] [四麻] 玩家 ${playerId} 最近对局请求失败，等待 ${waitTime}ms 后重试 (第${attempt + 1}次尝试，累计等待${(totalWaitTime / 1000).toFixed(1)}s)`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                if (attempt < maxRetries - 1) {
                    await this._switchEndpoint(error, attempt);
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw new Error(handleApiError(error));
                }
            }
        }
    }
}

// 未配置 token 时的用户提示（静态挂在类上，便于各功能入口直接引用）
MajsoulApi.TOKEN_HINT = TOKEN_HINT;
// 写入 token.json 的静态方法
MajsoulApi.savePaipuToken = savePaipuToken;

// 导出辅助函数和类
export { 
    HostProber, 
    RateLimiter, 
    MajsoulApiError,
    ERROR_CODES, 
    handleApiError,
    createApiError 
};
