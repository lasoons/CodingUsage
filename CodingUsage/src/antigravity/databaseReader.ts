import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import initSqlJs from 'sql.js';
import { QuotaSnapshot, ModelQuotaInfo } from './types';
import { logWithTime } from '../common/utils';

export interface AntigravityAuthStatus {
    name: string;
    email: string;
    apiKey: string;
    userStatusProtoBinaryBase64: string;
}

export class DatabaseReader {
    private readonly dbPath: string;
    private readonly wasmPath: string;

    constructor(wasmPath: string) {
        const platform = os.platform();
        let appData: string;
        
        if (platform === 'darwin') {
            // macOS: ~/Library/Application Support/Antigravity
            appData = path.join(os.homedir(), 'Library', 'Application Support');
        } else if (platform === 'win32') {
            // Windows: %APPDATA%/Antigravity
            appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        } else {
            // Linux: ~/.config/Antigravity
            appData = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        }
        
        this.dbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        this.wasmPath = wasmPath;
    }

    async readAuthStatus(): Promise<AntigravityAuthStatus | null> {
        try {
            // 检查数据库文件是否存在
            if (!await fs.pathExists(this.dbPath)) {
                logWithTime('[DatabaseReader] 数据库文件不存在!');
                return null;
            }

            const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
            const fileBuffer = await fs.readFile(this.dbPath);
            const db = new SQL.Database(fileBuffer);

            const res = db.exec(`SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';`);
            db.close();

            if (!res || res.length === 0 || !res[0].values || res[0].values.length === 0) {
                logWithTime('[DatabaseReader] 查询结果为空,数据库中没有 antigravityAuthStatus 键');
                return null;
            }

            const val = res[0].values[0][0];
            if (typeof val !== 'string') {
                logWithTime(`[DatabaseReader] 查询结果类型错误: ${typeof val}`);
                return null;
            }

            const data = JSON.parse(val);
            return {
                name: data.name,
                email: data.email,
                apiKey: data.apiKey,
                userStatusProtoBinaryBase64: data.userStatusProtoBinaryBase64
            };
        } catch (error) {
            logWithTime(`[DatabaseReader] 读取认证状态错误: ${error}`);
            if (error instanceof Error) {
                logWithTime(`[DatabaseReader] 错误消息: ${error.message}`);
                logWithTime(`[DatabaseReader] 错误堆栈: ${error.stack}`);
            }
            return null;
        }
    }

    parseUserStatusProto(base64Data: string): QuotaSnapshot | null {
        try {
            const buffer = Buffer.from(base64Data, 'base64');

            // Extract readable strings and parse model quota info
            // The proto format contains model configs with quota information
            const models = this.extractModelQuotas(buffer);
            const planName = this.extractPlanName(buffer);

            return {
                timestamp: new Date(),
                models,
                planName
            };
        } catch (error) {
            console.error('[DatabaseReader] Error parsing proto:', error);
            return null;
        }
    }

    private extractModelQuotas(buffer: Buffer): ModelQuotaInfo[] {
        const models: ModelQuotaInfo[] = [];
        const str = buffer.toString('binary');

        // Known model patterns in Antigravity
        const modelPatterns = [
            { pattern: /Claude Opus 4\.5 \(Thinking\)/g, label: 'Claude Opus 4.5 (Thinking)' },
            { pattern: /Claude Sonnet 4\.5 \(Thinking\)/g, label: 'Claude Sonnet 4.5 (Thinking)' },
            { pattern: /Claude Sonnet 4\.5(?! \()/g, label: 'Claude Sonnet 4.5' },
            { pattern: /Gemini 3 Pro \(High\)/g, label: 'Gemini 3 Pro (High)' },
            { pattern: /Gemini 3 Pro \(Low\)/g, label: 'Gemini 3 Pro (Low)' },
            { pattern: /Gemini 3 Flash/g, label: 'Gemini 3 Flash' },
            { pattern: /GPT-OSS 120B \(Medium\)/g, label: 'GPT-OSS 120B (Medium)' },
        ];

        // For now, create placeholder entries for detected models
        // We'll need to refine the proto parsing to extract actual quota values
        const detectedModels = new Set<string>();

        for (const { pattern, label } of modelPatterns) {
            if (pattern.test(str)) {
                detectedModels.add(label);
            }
        }

        // Parse quota information from proto binary
        // The proto contains fields like remainingFraction encoded as floats
        const quotaInfo = this.parseQuotaFields(buffer);

        for (const label of detectedModels) {
            const quota = quotaInfo.get(label);
            models.push({
                label,
                modelId: label.toLowerCase().replace(/[^a-z0-9]/g, '-'),
                remainingFraction: quota?.remainingFraction,
                remainingPercentage: quota?.remainingFraction !== undefined
                    ? quota.remainingFraction * 100
                    : undefined,
                isExhausted: quota?.remainingFraction === 0,
                resetTime: quota?.resetTime || new Date(),
                timeUntilReset: quota?.resetTime
                    ? quota.resetTime.getTime() - Date.now()
                    : 0,
                timeUntilResetFormatted: this.formatTimeUntilReset(
                    quota?.resetTime
                        ? quota.resetTime.getTime() - Date.now()
                        : 0
                )
            });
        }

        return models;
    }

    private parseQuotaFields(buffer: Buffer): Map<string, { remainingFraction?: number; resetTime?: Date }> {
        const quotaMap = new Map<string, { remainingFraction?: number; resetTime?: Date }>();
        const str = buffer.toString('binary');

        // Known model labels in Antigravity proto format
        const modelLabels = [
            'Claude Opus 4.5 (Thinking)',
            'Claude Sonnet 4.5 (Thinking)',
            'Claude Sonnet 4.5',
            'Gemini 3 Pro (High)',
            'Gemini 3 Pro (Low)',
            'Gemini 3 Flash',
            'GPT-OSS 120B (Medium)',
        ];

        const bufferLen = buffer.length;

        for (const label of modelLabels) {
            const idx = str.indexOf(label);
            if (idx !== -1) {
                // Search for Field 15 (0x7a) nearby
                let searchPtr = idx + label.length;
                // Limit search to 500 bytes after label
                const searchLimit = Math.min(bufferLen, searchPtr + 500);
                let foundForLabel = false;

                while (searchPtr < searchLimit) {
                    // 0x7a = Field 15, Wire 2
                    if (buffer[searchPtr] === 0x7a) {
                        try {
                            const { value: msgLen, bytesRead: lenBytes } = this.readVarintTuple(buffer, searchPtr + 1);
                            const msgStart = searchPtr + 1 + lenBytes;
                            const msgEnd = msgStart + msgLen;

                            if (msgEnd <= bufferLen) {
                                const parsed = this.parseInnerQuotaMessage(buffer, msgStart, msgEnd);
                                if (parsed.found) {
                                    let { remainingFraction, resetTime } = parsed;

                                    // Fix for 100% used (0 remaining) - default value omission
                                    if (remainingFraction === undefined && resetTime !== undefined) {
                                        remainingFraction = 0;
                                    }

                                    if (remainingFraction !== undefined || resetTime !== undefined) {
                                        quotaMap.set(label, { remainingFraction, resetTime });
                                        foundForLabel = true;
                                    }
                                    break; // Found for this label, stop searching 0x7a
                                }
                            }
                        } catch (e) {
                            // Ignore parsing errors and continue search
                        }
                    }
                    searchPtr++;
                }
            }
        }

        return quotaMap;
    }

    private parseInnerQuotaMessage(buffer: Buffer, start: number, end: number): { remainingFraction?: number; resetTime?: Date; found: boolean } {
        let remainingFraction: number | undefined;
        let resetTime: Date | undefined;
        let foundAny = false;

        let ptr = start;
        while (ptr < end) {
            const { value: tag, bytesRead: tagBytes } = this.readVarintTuple(buffer, ptr);
            ptr += tagBytes;

            const wireType = tag & 0x07;
            const fieldNum = tag >>> 3;

            if (fieldNum === 1 && wireType === 5) { // Field 1: float
                if (ptr + 4 <= end) {
                    remainingFraction = buffer.readFloatLE(ptr);
                    if (remainingFraction >= 0 && remainingFraction <= 1) {
                        foundAny = true;
                    } else {
                        remainingFraction = undefined;
                    }
                    ptr += 4;
                } else break;
            } else if (fieldNum === 2 && wireType === 2) { // Field 2: nested message
                const { value: innerLen, bytesRead: innerLenBytes } = this.readVarintTuple(buffer, ptr);
                ptr += innerLenBytes;
                const innerEnd = ptr + innerLen;
                if (innerEnd <= end) {
                    const rt = this.parseResetTimeMessage(buffer, ptr, innerEnd);
                    if (rt) {
                        resetTime = rt;
                        foundAny = true;
                    }
                    ptr = innerEnd;
                } else break;
            } else {
                const newPtr = this.skipField(buffer, ptr, wireType);
                if (newPtr === -1 || newPtr > end) break;
                ptr = newPtr;
            }
        }

        return { remainingFraction, resetTime, found: foundAny };
    }

    private parseResetTimeMessage(buffer: Buffer, start: number, end: number): Date | undefined {
        let ptr = start;
        while (ptr < end) {
            const { value: tag, bytesRead: tagBytes } = this.readVarintTuple(buffer, ptr);
            ptr += tagBytes;
            const wireType = tag & 0x07;
            const fieldNum = tag >>> 3;

            if (fieldNum === 1 && wireType === 0) { // Field 1: Varint timestamp
                const { value: ts, bytesRead: tsBytes } = this.readVarintTuple(buffer, ptr);
                ptr += tsBytes;
                // Sanity check (2024-2030)
                if (ts > 1704067200 && ts < 1900000000) {
                    return new Date(ts * 1000);
                }
            } else {
                const newPtr = this.skipField(buffer, ptr, wireType);
                if (newPtr === -1 || newPtr > end) break;
                ptr = newPtr;
            }
        }
        return undefined;
    }

    private skipField(buffer: Buffer, ptr: number, wireType: number): number {
        try {
            switch (wireType) {
                case 0: // Varint
                    const { bytesRead } = this.readVarintTuple(buffer, ptr);
                    return ptr + bytesRead;
                case 1: // 64-bit
                    return ptr + 8;
                case 2: // Length delim
                    const { value: len, bytesRead: lenBytes } = this.readVarintTuple(buffer, ptr);
                    return ptr + lenBytes + len;
                case 5: // 32-bit
                    return ptr + 4;
                default:
                    return -1;
            }
        } catch {
            return -1;
        }
    }

    private readVarintTuple(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
        let value = 0;
        let shift = 0;
        let i = offset;

        while (i < buffer.length && shift < 35) {
            const byte = buffer[i];
            value |= (byte & 0x7f) << shift;
            i++;
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }

        return { value, bytesRead: i - offset };
    }

    private extractPlanName(buffer: Buffer): string | undefined {
        const str = buffer.toString('binary');

        // Look for plan name patterns
        const planPatterns = [
            /Google AI Pro/,
            /Google AI Ultra/,
            /g1-pro-tier/,
            /g1-ultra-tier/,
        ];

        for (const pattern of planPatterns) {
            const match = str.match(pattern);
            if (match) {
                return match[0].includes('Ultra') ? 'Google AI Ultra' : 'Google AI Pro';
            }
        }

        return undefined;
    }

    private formatTimeUntilReset(ms: number): string {
        if (ms <= 0) return 'Unknown';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
}

