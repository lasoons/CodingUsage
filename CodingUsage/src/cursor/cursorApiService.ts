import axios from 'axios';
import { logWithTime } from '../common/utils';
import { CURSOR_API_BASE_URL, API_TIMEOUT } from '../common/constants';
import { UsageSummaryResponse, UserInfoResponse, BillingCycleResponse, AggregatedUsageResponse } from './types';

export class CursorApiService {
    private static instance: CursorApiService;

    private constructor() { }

    public static getInstance(): CursorApiService {
        if (!CursorApiService.instance) {
            CursorApiService.instance = new CursorApiService();
        }
        return CursorApiService.instance;
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
        const response = await axios.get<UsageSummaryResponse>(
            `${CURSOR_API_BASE_URL}/usage-summary`,
            {
                headers: this.createCursorHeaders(sessionToken, 'https://cursor.com'),
                timeout: API_TIMEOUT
            }
        );
        logWithTime('获取 Cursor 使用汇总成功');
        return response.data;
    }

    /**
     * 获取 Cursor 用户信息
     */
    public async fetchCursorUserInfo(sessionToken: string): Promise<UserInfoResponse> {
        const response = await axios.get(
            `${CURSOR_API_BASE_URL}/dashboard/get-me`,
            {
                headers: this.createCursorHeaders(sessionToken, 'https://cursor.com'),
                timeout: API_TIMEOUT
            }
        );
        return response.data;
    }

    /**
     * 获取 Cursor 当前账单周期
     */
    public async fetchCursorBillingCycle(sessionToken: string): Promise<BillingCycleResponse> {
        const response = await axios.post<BillingCycleResponse>(
            `${CURSOR_API_BASE_URL}/dashboard/get-current-billing-cycle`,
            {},
            {
                headers: this.createCursorHeaders(sessionToken),
                timeout: API_TIMEOUT
            }
        );
        logWithTime('获取 Cursor 账单周期成功');
        return response.data;
    }

    /**
     * 获取 Cursor 聚合使用事件
     */
    public async fetchCursorAggregatedUsage(sessionToken: string, startDateEpochMillis: number): Promise<AggregatedUsageResponse> {
        const response = await axios.post<AggregatedUsageResponse>(
            `${CURSOR_API_BASE_URL}/dashboard/get-aggregated-usage-events`,
            {
                teamId: -1,
                startDate: startDateEpochMillis
            },
            {
                headers: this.createCursorHeaders(sessionToken),
                timeout: API_TIMEOUT
            }
        );
        logWithTime('获取 Cursor 聚合使用数据成功');
        return response.data;
    }
}

export function getCursorApiService(): CursorApiService {
    return CursorApiService.getInstance();
}



