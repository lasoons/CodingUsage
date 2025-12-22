export interface ModelQuotaInfo {
    label: string;
    modelId: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: number;
    timeUntilResetFormatted: string;
}

export interface PromptCreditsInfo {
    available: number;
    monthly: number;
    usedPercentage: number;
    remainingPercentage: number;
}

export interface QuotaSnapshot {
    timestamp: Date;
    models: ModelQuotaInfo[];
    promptCredits?: PromptCreditsInfo;
    planName?: string;
}

export interface AntigravityProcessInfo {
    extensionPort: number;
    connectPort: number;
    csrfToken: string;
}
