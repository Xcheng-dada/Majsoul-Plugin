// plugins/Majsoul-Plugin/utils/MajsoulApi.js
import fetch from 'node-fetch';
export default class MajsoulApi {
    constructor() {
        this.baseUrl = "https://5-data.amae-koromo.com/api/v2";
        this.timeout = 10000; // 10秒超时
    }
    
    // 搜索玩家
    async searchPlayer(playerName, mode = '4', limit = 4) {
        try {
            const url = `${this.baseUrl}/pl${mode}/search_player/${encodeURIComponent(playerName)}`;
            const params = new URLSearchParams({
                limit: limit.toString(),
                tag: 'all'
            });
            
            const response = await fetch(`${url}?${params}`, {
                method: 'GET',
                timeout: this.timeout
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
            
        } catch (error) {
            logger.error('[MajsoulApi] 搜索玩家失败:', error);
            throw error;
        }
    }
    
    // 获取玩家统计
    async getPlayerStats(playerId, mode = '4') {
        try {
            const timestamp = Date.now();
            const url = `${this.baseUrl}/pl${mode}/player_stats/${playerId}/${timestamp}`;
            
            // 四麻和三麻的模式参数不同
            const modeParam = mode === '4' 
                ? '12,11,8,9,16,15'  // 四麻模式
                : '22,21,24,23,26,25'; // 三麻模式
            
            const params = new URLSearchParams({
                mode: modeParam,
                tag: '473317'
            });
            
            const response = await fetch(`${url}?${params}`, {
                method: 'GET',
                timeout: this.timeout
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
            
        } catch (error) {
            logger.error('[MajsoulApi] 获取玩家统计失败:', error);
            throw error;
        }
    }
    
    // 获取玩家扩展数据
    async getPlayerExtended(playerId, mode = '4') {
        try {
            const timestamp = Date.now();
            const url = `${this.baseUrl}/pl${mode}/player_extended_stats/${playerId}/${timestamp}`;
            
            const modeParam = mode === '4' 
                ? '12,11,8,9,16,15'
                : '22,21,24,23,26,25';
            
            const params = new URLSearchParams({
                mode: modeParam,
                tag: '473317'
            });
            
            const response = await fetch(`${url}?${params}`, {
                method: 'GET',
                timeout: this.timeout
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
            
        } catch (error) {
            logger.error('[MajsoulApi] 获取玩家扩展数据失败:', error);
            throw error;
        }
    }
    
    // 获取玩家对局记录
    async getPlayerRecords(playerId, limit = 16, mode = '4') {
        try {
            const timestamp = Date.now();
            const url = `${this.baseUrl}/pl${mode}/player_records/${playerId}/${timestamp}`;
            
            const modeParam = mode === '4' 
                ? '12,11,8,9,16,15'
                : '22,21,24,23,26,25';
            
            const params = new URLSearchParams({
                limit: limit.toString(),
                mode: modeParam,
                tag: '54',
                descending: 'true'
            });
            
            const response = await fetch(`${url}?${params}`, {
                method: 'GET',
                timeout: this.timeout
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return await response.json();
            
        } catch (error) {
            logger.error('[MajsoulApi] 获取玩家对局记录失败:', error);
            throw error;
        }
    }
    
    // 批量获取玩家信息（可选）
    async batchGetPlayers(playerIds, mode = '4') {
        try {
            const promises = playerIds.map(id => this.getPlayerStats(id, mode));
            return await Promise.all(promises);
        } catch (error) {
            logger.error('[MajsoulApi] 批量获取玩家信息失败:', error);
            throw error;
        }
    }
}