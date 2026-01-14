export interface BillingCycleResponse {
    startDateEpochMillis: string;
    endDateEpochMillis: string;
}

export interface UsageSummaryResponse {
    billingCycleStart: string;
    billingCycleEnd: string;
    membershipType: string;
    limitType?: string;
    isUnlimited?: boolean;
    autoModelSelectedDisplayMessage?: string;
    namedModelSelectedDisplayMessage?: string;
    individualUsage: {
        plan: {
            enabled: boolean;
            used: number;
            limit: number;
            remaining: number;
            breakdown?: {
                included: number;
                bonus: number;
                total: number;
            };
            // 使用百分比（新 API 格式）
            autoPercentUsed?: number;
            apiPercentUsed?: number;
            totalPercentUsed?: number;
        };
        onDemand?: {
            enabled: boolean;
            used: number;
            limit: number | null;
            remaining: number | null;
        };
    };
    teamUsage?: Record<string, unknown>;
}

// Cursor 聚合使用事件
export interface AggregatedUsageEvent {
    modelIntent: string;
    inputTokens?: string;
    outputTokens?: string;
    cacheWriteTokens?: string;
    cacheReadTokens?: string;
    totalCents: number;
}

export interface AggregatedUsageResponse {
    aggregations: AggregatedUsageEvent[];
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheWriteTokens: string;
    totalCacheReadTokens: string;
    totalCostCents: number;
}

export interface UserInfoResponse {
    authId: string;
    userId: number;
    email: string;
    workosId: string;
    createdAt: string;
    isEnterpriseUser: boolean;
}

export interface SecondaryAccountData {
    summary: UsageSummaryResponse;
    billingCycle: BillingCycleResponse | null;
    aggregatedData: AggregatedUsageResponse | null;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalCents: number;
}

export interface UsageEvent {
    timestamp: string;
    model: string;
    kind: string;
    maxMode: boolean;
    requestsCosts: number;
    usageBasedCosts: string;
    isTokenBasedCall: boolean;
    tokenUsage: TokenUsage;
    owningUser: string;
    cursorTokenFee: number;
    isChargeable: boolean;
}

export interface FilteredUsageEventsResponse {
    totalUsageEventsCount: number;
    usageEventsDisplay: UsageEvent[];
}

export interface GenerationItem {
    unixMs: number;
    generationUUID: string;
    type: string;
    textDescription: string;
}























