import axios from 'axios';
import { logWithTime } from '../common/utils';
import { CURSOR_API_BASE_URL, API_TIMEOUT } from '../common/constants';
import { UsageSummaryResponse, UserInfoResponse, BillingCycleResponse, AggregatedUsageResponse } from './types';

export class CursorApiService {
    private static instance: CursorApiService;

    // 缓存：key 为 sessionToken，value 为响应数据
    private userInfoCache: Map<string, UserInfoResponse> = new Map();
    private billingCycleCache: Map<string, BillingCycleResponse> = new Map();

    private constructor() { }

    public static getInstance(): CursorApiService {
        if (!CursorApiService.instance) {
            CursorApiService.instance = new CursorApiService();
        }
        return CursorApiService.instance;
    }

    /**
     * 清除所有缓存（如需手动刷新时调用）
     */
    public clearCache(): void {
        this.userInfoCache.clear();
        this.billingCycleCache.clear();
    }

    /**
     * 创建 Cursor 请求头
     */
    private createCursorHeaders(sessionToken: string, referer: string = 'https://cursor.com/dashboard') {
        return {
            'Cookie': `WorkosCursorSessionToken=${sessionToken}`,
            'Content-Type': 'application/json',
            'Origin': 'https://cursor.com',
            'Referer': referer
        };
    }

    /**
     * 获取 Cursor 使用摘要
     */
    public async fetchCursorUsageSummary(sessionToken: string): Promise<UsageSummaryResponse> {
        const url = `${CURSOR_API_BASE_URL}/usage-summary`;
        logWithTime(`[API Request] GET ${url}`);
        const response = await axios.get<UsageSummaryResponse>(
            url,
            {
                headers: this.createCursorHeaders(sessionToken, 'https://cursor.com'),
                timeout: API_TIMEOUT
            }
        );
        logWithTime(`[API Response] GET ${url} => ${JSON.stringify(response.data)}`);
        return response.data;
    }

    /**
     * 获取 Cursor 用户信息（带缓存）
     */
    public async fetchCursorUserInfo(sessionToken: string): Promise<UserInfoResponse> {
        // 检查缓存
        const cached = this.userInfoCache.get(sessionToken);
        if (cached) {
            return cached;
        }

        const url = `${CURSOR_API_BASE_URL}/dashboard/get-me`;
        logWithTime(`[API Request] GET ${url}`);
        const response = await axios.get(
            url,
            {
                headers: this.createCursorHeaders(sessionToken, 'https://cursor.com'),
                timeout: API_TIMEOUT
            }
        );
        logWithTime(`[API Response] GET ${url} => ${JSON.stringify(response.data)}`);

        // 存入缓存
        this.userInfoCache.set(sessionToken, response.data);
        return response.data;
    }

    /**
     * 获取 Cursor 当前账单周期（带缓存）
     */
    public async fetchCursorBillingCycle(sessionToken: string): Promise<BillingCycleResponse> {
        // 检查缓存
        const cached = this.billingCycleCache.get(sessionToken);
        if (cached) {
            return cached;
        }

        const url = `${CURSOR_API_BASE_URL}/dashboard/get-current-billing-cycle`;
        const body = {};
        logWithTime(`[API Request] POST ${url} Body: ${JSON.stringify(body)}`);
        const response = await axios.post<BillingCycleResponse>(
            url,
            body,
            {
                headers: this.createCursorHeaders(sessionToken),
                timeout: API_TIMEOUT
            }
        );
        logWithTime(`[API Response] POST ${url} => ${JSON.stringify(response.data)}`);

        // 存入缓存
        this.billingCycleCache.set(sessionToken, response.data);
        return response.data;
    }

    /**
     * 获取 Cursor 聚合使用事件
     */
    public async fetchCursorAggregatedUsage(sessionToken: string, startDateEpochMillis: number): Promise<AggregatedUsageResponse> {
        const url = `${CURSOR_API_BASE_URL}/dashboard/get-aggregated-usage-events`;
        const body = {
            teamId: -1,
            startDate: startDateEpochMillis
        };
        logWithTime(`[API Request] POST ${url} Body: ${JSON.stringify(body)}`);
        const response = await axios.post<AggregatedUsageResponse>(
            url,
            body,
            {
                headers: this.createCursorHeaders(sessionToken),
                timeout: API_TIMEOUT
            }
        );
        logWithTime(`[API Response] POST ${url} => ${JSON.stringify(response.data)}`);
        return response.data;
    }
}

export function getCursorApiService(): CursorApiService {
    return CursorApiService.getInstance();
}















