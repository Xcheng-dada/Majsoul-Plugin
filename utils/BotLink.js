class BotLink {
    constructor() {
        this.BOT_QQ = 3889346598;
        this.COMMAND_PREFIX = '/mspt';
        this.timeout = 15000;
        this.listeners = new Map();
        this._initListener();
    }

    _initListener() {
        if (typeof global.Bot !== 'undefined') {
            global.Bot.on('message.group', (e) => {
                this._handleMessage(e);
            });
        } else if (typeof global.Bots !== 'undefined') {
            for (const [, bot] of Object.entries(global.Bots)) {
                bot.on('message.group', (e) => {
                    this._handleMessage(e);
                });
            }
        }
    }

    _handleMessage(e) {
        if (!e || !e.user_id || e.user_id !== this.BOT_QQ) return;
        
        const groupId = e.group_id;
        const key = `group_${groupId}`;
        const listener = this.listeners.get(key);
        
        if (listener) {
            let text = '';
            
            if (e.raw_message && typeof e.raw_message === 'string') {
                text = e.raw_message;
            } else if (Array.isArray(e.message)) {
                text = e.message.map(item => {
                    if (item.type === 'text') return item.data?.text || '';
                    if (item.type === 'at') return `[CQ:at,qq=${item.data?.qq}]`;
                    return '';
                }).join('');
            } else if (typeof e.message === 'string') {
                text = e.message;
            } else if (e.message?.toString) {
                const str = e.message.toString();
                if (str !== '[object Object]') {
                    text = str;
                }
            }
            
            console.log('[BotLink] 获取到的文本:', text);
            
            const parsed = this._parsePTResponse(text);
            listener.resolve(parsed);
            this.listeners.delete(key);
        }
    }

    _decodeHtmlEntities(text) {
        const entities = {
            '&#91;': '[',
            '&#93;': ']',
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"'
        };
        return text.replace(/&#?[a-zA-Z0-9]+;/g, match => entities[match] || match);
    }

    _parsePTResponse(text) {
        if (!text) return null;
        
        try {
            text = this._decodeHtmlEntities(text);
            text = text.replace(/\[CQ:[^\]]+\]/g, '').trim();
            
            console.log('[BotLink] 原始文本:', text);
            
            const result = {
                nickname: '',
                uid: '',
                fourPlayer: null,
                threePlayer: null,
                isRealTime: false
            };
            
            const nicknameMatch = text.match(/(.+?)\s*\(?(\d+)\)?/);
            if (nicknameMatch) {
                result.nickname = nicknameMatch[1].trim().replace(/[（）()]/g, '');
                result.uid = nicknameMatch[2];
            }
            
            console.log('[BotLink] 昵称匹配:', nicknameMatch);
            
            const rankPattern = /\[(.+?)\s+(\d+)\/(\d+)\]/g;
            let match;
            let rankCount = 0;
            
            while ((match = rankPattern.exec(text)) !== null) {
                console.log('[BotLink] 段位匹配:', match);
                const rankInfo = {
                    rank: match[1].trim(),
                    score: parseInt(match[2]),
                    maxScore: parseInt(match[3])
                };
                
                if (rankCount === 0) {
                    result.fourPlayer = rankInfo;
                } else {
                    result.threePlayer = rankInfo;
                }
                rankCount++;
            }
            
            if (text.includes('实时') || text.includes('同步')) {
                result.isRealTime = true;
            }
            
            console.log('[BotLink] 解析结果:', JSON.stringify(result));
            
            if (result.fourPlayer || result.threePlayer) {
                return result;
            }
            return null;
        } catch (e) {
            console.error('[BotLink] 解析PT响应失败:', e);
            return null;
        }
    }

    async queryPT(playerName, groupId) {
        return new Promise((resolve) => {
            const key = `group_${groupId}`;
            
            if (this.listeners.has(key)) {
                this.listeners.get(key).reject(new Error('已有查询进行中'));
            }
            
            let timeoutId;
            
            const listener = {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    resolve(data);
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    resolve(null);
                }
            };
            
            this.listeners.set(key, listener);
            
            timeoutId = setTimeout(() => {
                this.listeners.delete(key);
                resolve(null);
            }, this.timeout);
            
            this._sendCommand(playerName, groupId);
        });
    }

    async _sendCommand(playerName, groupId) {
        try {
            const command = `${this.COMMAND_PREFIX} ${playerName}`;
            
            if (typeof global.segment === 'object') {
                const atSegment = global.segment.at(this.BOT_QQ);
                const msgChain = [atSegment, ' ', command];
                
                if (typeof global.Bot === 'object' && typeof global.Bot.sendGroupMsg === 'function') {
                    await global.Bot.sendGroupMsg(parseInt(groupId), msgChain);
                } else if (typeof global.Bots === 'object') {
                    for (const [, bot] of Object.entries(global.Bots)) {
                        if (typeof bot.sendGroupMsg === 'function') {
                            await bot.sendGroupMsg(parseInt(groupId), msgChain);
                            break;
                        }
                    }
                } else {
                    console.error('[BotLink] 无法发送命令，没有可用的Bot实例');
                }
            } else {
                console.error('[BotLink] 无法发送命令，segment对象不可用');
            }
        } catch (e) {
            console.error('[BotLink] 发送命令失败:', e);
        }
    }
}

export default new BotLink();