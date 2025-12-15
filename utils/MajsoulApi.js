// plugins/Majsoul-Plugin/utils/MajsoulApi.js
import fetch from 'node-fetch';

// 移除导入 logger，改为使用全局 logger
// import { logger } from '#logger';

export default class MajsoulApi {
    constructor() {
        // 使用全局 logger 或 console
        this.logger = global.logger || console;
        
        // 使用多个备选API地址
        this.apiEndpoints = [
            "https://ak-data-1.sapk.ch/api/v2",
            "https://ak-data-2.sapk.ch/api/v2",
            "https://5-data.amae-koromo.com/api/v2"
        ];
        this.currentEndpointIndex = 0;
        this.baseUrl = this.apiEndpoints[this.currentEndpointIndex];
        this.timeout = 15000;
        
        // 固定时间戳 (2010-01-01)
        this.startDateTimestamp = '1262304000000';
        
        // 模式参数（使用点分隔符）
        this.mode4Params = '16.12.9.15.11.8'; // 四麻
        this.mode3Params = '22.24.26.21.23.25'; // 三麻
    }
    
    // 切换API端点
    _switchEndpoint() {
        this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.apiEndpoints.length;
        this.baseUrl = this.apiEndpoints[this.currentEndpointIndex];
        this.logger.info(`[MajsoulApi] 切换到API端点: ${this.baseUrl}`);
    }
    
    // 搜索玩家功能
    async searchPlayer(playerName, mode = 4) {
        const maxRetries = this.apiEndpoints.length;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const modeStr = mode.toString();
                const url = `${this.baseUrl}/pl${modeStr}/search_player/${encodeURIComponent(playerName)}`;
                const params = new URLSearchParams({
                    limit: '5',
                    tag: 'all'
                });
                
                const fullUrl = `${url}?${params}`;
                
                this.logger.info(`[MajsoulApi] 搜索玩家请求 (${modeStr === '4' ? '四麻' : '三麻'}): ${fullUrl}`);

                const response = await fetch(fullUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    },
                    timeout: this.timeout
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
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
                this.logger.warn(`[MajsoulApi] 搜索玩家失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);
                
                if (attempt < maxRetries - 1) {
                    this._switchEndpoint();
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw error;
                }
            }
        }
        
        return [];
    }
    
    // 获取玩家对局记录
    async getPlayerRecords(playerId, mode = 4) {
        const maxRetries = this.apiEndpoints.length;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const modeStr = mode.toString();
                const modeName = modeStr === '4' ? '四麻' : '三麻';
                
                this.logger.info(`[MajsoulApi] 获取${modeName}玩家记录，玩家ID: ${playerId}`);
                
                // 根据模式选择参数
                const modeParams = modeStr === '4' ? this.mode4Params : this.mode3Params;
                const currentTimestamp = Date.now();
                
                // 步骤1: 获取统计信息得到count
                const statsUrl = `${this.baseUrl}/pl${modeStr}/player_stats/${playerId}/${this.startDateTimestamp}/${currentTimestamp}?mode=${modeParams}`;
                this.logger.debug(`[MajsoulApi] 获取统计信息: ${statsUrl}`);
                
                const statsResponse = await fetch(statsUrl, { 
                    timeout: this.timeout,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                
                if (!statsResponse.ok) {
                    throw new Error(`获取统计信息失败: HTTP ${statsResponse.status}`);
                }
                
                const statsData = await statsResponse.json();
                const count = statsData.count || 'all';
                
                this.logger.debug(`[MajsoulApi] 统计信息count值: ${count}`);
                
                // 步骤2: 获取对局记录（限制2条，按时间降序）
                const recordsUrl = `${this.baseUrl}/pl${modeStr}/player_records/${playerId}/${currentTimestamp}/${this.startDateTimestamp}?limit=2&mode=${modeParams}&descending=true&tag=${count}`;
                this.logger.debug(`[MajsoulApi] 获取对局记录: ${recordsUrl}`);
                
                const recordsResponse = await fetch(recordsUrl, { 
                    timeout: this.timeout,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                
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
                    // 如果返回的是单个对象，包装成数组
                    records = [recordsData];
                }
                
                this.logger.info(`[MajsoulApi] 成功获取玩家 ${playerId} 的${modeName}对局记录，记录数: ${records.length}`);
                
                return records;
                
            } catch (error) {
                this.logger.warn(`[MajsoulApi] 获取玩家记录失败 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}`);
                
                if (attempt < maxRetries - 1) {
                    this._switchEndpoint();
                } else {
                    this.logger.error('[MajsoulApi] 所有API端点都尝试失败');
                    throw error;
                }
            }
        }
        
        return [];
    }
}