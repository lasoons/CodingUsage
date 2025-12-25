import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import { QuotaSnapshot, ModelQuotaInfo } from './types';

const execAsync = promisify(exec);

export interface AntigravityAuthStatus {
    name: string;
    email: string;
    apiKey: string;
    userStatusProtoBinaryBase64: string;
}

export class DatabaseReader {
    private readonly dbPath: string;

    constructor() {
        // Antigravity stores data in %APPDATA%/Antigravity on Windows
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        this.dbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }

    async readAuthStatus(): Promise<AntigravityAuthStatus | null> {
        try {
            const command = `sqlite3 "${this.dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"`;
            const { stdout } = await execAsync(command, { timeout: 5000 });

            if (!stdout.trim()) {
                return null;
            }

            const data = JSON.parse(stdout.trim());
            return {
                name: data.name,
                email: data.email,
                apiKey: data.apiKey,
                userStatusProtoBinaryBase64: data.userStatusProtoBinaryBase64
            };
        } catch (error) {
            console.error('[DatabaseReader] Error reading auth status:', error);
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

        for (const label of modelLabels) {
            const idx = str.indexOf(label);
            if (idx !== -1) {
                const searchStart = idx + label.length;
                const searchEnd = Math.min(buffer.length, searchStart + 100);
                
                let remainingFraction: number | undefined;
                let resetTime: Date | undefined;
                
                // Search for quota float value after the model name
                // Pattern: 0x7a 0x0d 0x0d followed by 4-byte float
                for (let i = searchStart; i < searchEnd - 6; i++) {
                    if (buffer[i] === 0x7a && buffer[i + 1] === 0x0d && buffer[i + 2] === 0x0d) {
                        try {
                            const floatVal = buffer.readFloatLE(i + 3);
                            // Valid remaining fraction should be between 0 and 1
                            if (floatVal >= 0 && floatVal <= 1) {
                                remainingFraction = floatVal;
                                break;
                            }
                        } catch {
                            // Ignore read errors
                        }
                    }
                }
                
                // Search for resetTime timestamp after the model name
                // Pattern: 0x12 0x06 0x08 followed by varint timestamp
                for (let i = searchStart; i < searchEnd - 8; i++) {
                    if (buffer[i] === 0x12 && buffer[i + 1] === 0x06 && buffer[i + 2] === 0x08) {
                        const timestamp = this.readVarint(buffer, i + 3);
                        // Valid timestamp should be in reasonable range (2024-2030)
                        if (timestamp > 1704067200 && timestamp < 1900000000) {
                            resetTime = new Date(timestamp * 1000);
                            break;
                        }
                    }
                }
                
                if (remainingFraction !== undefined || resetTime !== undefined) {
                    quotaMap.set(label, { remainingFraction, resetTime });
                }
            }
        }

        return quotaMap;
    }

    private readVarint(buffer: Buffer, offset: number): number {
        let value = 0;
        let shift = 0;
        let i = offset;
        
        while (i < buffer.length && shift < 35) {
            const byte = buffer[i];
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
            i++;
        }
        
        return value;
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

