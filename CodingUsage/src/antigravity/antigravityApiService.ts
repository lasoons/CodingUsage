import * as https from 'https';
import { ModelQuotaInfo, QuotaSnapshot, PromptCreditsInfo, AntigravityProcessInfo } from './types';

export class AntigravityApiService {
    private static instance: AntigravityApiService;
    private processInfo: AntigravityProcessInfo | null = null;

    private constructor() { }

    public static getInstance(): AntigravityApiService {
        if (!AntigravityApiService.instance) {
            AntigravityApiService.instance = new AntigravityApiService();
        }
        return AntigravityApiService.instance;
    }

    public setProcessInfo(info: AntigravityProcessInfo) {
        this.processInfo = info;
    }

    public async fetchQuota(): Promise<QuotaSnapshot | null> {
        if (!this.processInfo) return null;

        try {
            const response = await this.makeRequest(
                '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                {}
            );
            return this.parseGetUserStatusResponse(response);
        } catch (error) {
            console.error('[AntigravityApiService] fetchQuota error:', error);
            return null;
        }
    }

    private async makeRequest(path: string, body: any): Promise<any> {
        if (!this.processInfo) throw new Error('No process info');

        const requestBody = JSON.stringify({
            ...body,
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en'
            }
        });

        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port: this.processInfo.connectPort,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': this.processInfo.csrfToken
            },
            rejectUnauthorized: false,
            timeout: 5000
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP error: ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse response'));
                    }
                });
            });
            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });
    }

    private parseGetUserStatusResponse(response: any): QuotaSnapshot {
        const userStatus = response?.userStatus;
        if (!userStatus) {
            return { timestamp: new Date(), models: [] };
        }

        const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        const models: ModelQuotaInfo[] = modelConfigs
            .filter((config: any) => config.quotaInfo)
            .map((config: any) => this.parseModelQuota(config));

        // Parse prompt credits if available
        const planStatus = userStatus.planStatus;
        const monthlyCredits = planStatus?.planInfo?.monthlyPromptCredits;
        const availableCredits = planStatus?.availablePromptCredits;

        let promptCredits: PromptCreditsInfo | undefined;
        if (monthlyCredits && availableCredits !== undefined) {
            const monthly = Number(monthlyCredits);
            const available = Number(availableCredits);
            if (monthly > 0) {
                promptCredits = {
                    available,
                    monthly,
                    usedPercentage: ((monthly - available) / monthly) * 100,
                    remainingPercentage: (available / monthly) * 100
                };
            }
        }

        return {
            timestamp: new Date(),
            models,
            promptCredits,
            planName: planStatus?.planInfo?.planName
        };
    }

    private parseModelQuota(config: any): ModelQuotaInfo {
        const quotaInfo = config.quotaInfo;
        const remainingFraction = quotaInfo?.remainingFraction;
        const resetTime = new Date(quotaInfo.resetTime);
        const timeUntilReset = resetTime.getTime() - Date.now();

        return {
            label: config.label,
            modelId: config.modelOrAlias.model,
            remainingFraction,
            remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
            isExhausted: remainingFraction === undefined || remainingFraction === 0,
            resetTime,
            timeUntilReset,
            timeUntilResetFormatted: this.formatTimeUntilReset(timeUntilReset)
        };
    }

    private formatTimeUntilReset(ms: number): string {
        if (ms <= 0) return 'Expired';
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

export function getAntigravityApiService(): AntigravityApiService {
    return AntigravityApiService.getInstance();
}
