import * as vscode from 'vscode';
import axios from 'axios';
import { logWithTime, isRetryableError, getAdditionalSessionTokens, getTraeStorageAuthInfo } from '../common/utils';
import { TRAE_DEFAULT_HOST, API_TIMEOUT, MAX_RETRY_COUNT, RETRY_DELAY } from '../common/constants';
import { apiRequestWithRetry } from '../common/apiHelper';
import { TraeTokenResponse, TraeApiResponse } from './types';

export class TraeApiService {
    private static instance: TraeApiService;

    // Trae 专用缓存
    private cachedTraeToken: string | null = null;
    private cachedTraeHost: string | null = null;

    private constructor() { }

    public static getInstance(): TraeApiService {
        if (!TraeApiService.instance) {
            TraeApiService.instance = new TraeApiService();
        }
        return TraeApiService.instance;
    }

    /**
     * 自动获取 Token（优先从 storage.json 读取）
     * 如果 storage.json 中有有效 token，直接使用
     * 否则回退到传统的 Session ID 方式
     */
    public async getAutoToken(sessionId?: string, retryCount = 0, isManualRefresh = false): Promise<string | null> {
        // 1. 首先尝试从 storage.json 读取
        const storageAuthInfo = getTraeStorageAuthInfo();
        if (storageAuthInfo && storageAuthInfo.token) {
            logWithTime(`使用 storage.json 中的 Token (Region: ${storageAuthInfo.region}, Host: ${storageAuthInfo.host})`);
            // 缓存 host 和 token
            this.cachedTraeHost = storageAuthInfo.host;
            this.cachedTraeToken = storageAuthInfo.token;
            return storageAuthInfo.token;
        }

        // 2. 如果 storage.json 没有，尝试使用 session id（需要用户手动配置）
        if (sessionId) {
            logWithTime('storage.json 不可用，使用 Session ID 方式');
            return this.getTraeTokenFromSession(sessionId, retryCount, isManualRefresh);
        }

        // 3. 尝试从配置获取 session id
        const additionalTokens = getAdditionalSessionTokens();
        if (additionalTokens.length > 0) {
            logWithTime('storage.json 不可用，使用配置中的 Session ID');
            return this.getTraeTokenFromSession(additionalTokens[0], retryCount, isManualRefresh);
        }

        logWithTime('无法获取 Trae 认证 Token：storage.json 和 session 配置都不可用');
        return null;
    }

    /**
     * 获取 Trae 用户Token（从 Session ID，仅作为回退方案）
     */
    public async getTraeTokenFromSession(sessionId: string, retryCount = 0, isManualRefresh = false): Promise<string | null> {
        // 使用默认 host（仅当 storage.json 不可用时）
        const currentHost = this.cachedTraeHost || TRAE_DEFAULT_HOST;

        try {
            const url = `${currentHost}/cloudide/api/v3/common/GetUserToken`;
            const body = {};
            logWithTime(`[API Request] POST ${url} Body: ${JSON.stringify(body)}`);
            const response = await axios.post<TraeTokenResponse>(
                url,
                body,
                {
                    headers: {
                        'Cookie': `X-Cloudide-Session=${sessionId}`,
                        'Host': new URL(currentHost).hostname,
                        'Content-Type': 'application/json'
                    },
                    timeout: API_TIMEOUT
                }
            );
            logWithTime(`[API Response] POST ${url} => ${JSON.stringify(response.data)}`);
            this.cachedTraeToken = response.data.Result.Token;
            return this.cachedTraeToken;
        } catch (error) {
            return this.handleTraeTokenError(error, retryCount, isManualRefresh);
        }
    }

    /**
     * 处理 Trae Token 获取错误
     */
    private async handleTraeTokenError(
        error: any,
        retryCount: number,
        isManualRefresh: boolean = false
    ): Promise<string | null> {
        logWithTime(`获取 Trae Token 失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'}, ${error && typeof error === 'object' && 'message' in error ? error.message : 'unknown'}`);

        // 处理401认证失败情况
        if (error && typeof error === 'object' && 'response' in error && error.response?.status === 401) {
            logWithTime('检测到401认证失败，Token 或 Session ID 已过期');
            if (isManualRefresh) {
                vscode.window.showErrorMessage(
                    '认证失败：请重新登录 Trae',
                    '确定'
                );
            } else {
                vscode.window.showErrorMessage('Trae Usage: 认证失败，请重新登录 Trae');
            }
            return null;
        }

        // 可重试错误逻辑
        if (isRetryableError(error) && retryCount < MAX_RETRY_COUNT) {
            logWithTime(`Token获取失败，将在1秒后进行第${retryCount + 1}次重试`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            // 注意：这里无法直接重试，因为我们不知道原始的 sessionId
            // 只能返回 null
            return null;
        }

        if (isRetryableError(error) && retryCount >= MAX_RETRY_COUNT) {
            if (isManualRefresh) {
                vscode.window.showErrorMessage('Network unstable, please try again later');
            } else {
                vscode.window.showErrorMessage('Trae Usage: 网络不稳定，请稍后重试');
            }
        }

        return null;
    }

    /**
     * 获取 Trae 用户信息（使用缓存的 Token）
     */
    public async fetchTraeUserInfo(sessionId?: string): Promise<{ userId: string; email?: string }> {
        try {
            // 优先从 storage.json 获取
            const storageAuthInfo = getTraeStorageAuthInfo();
            if (storageAuthInfo) {
                return {
                    userId: storageAuthInfo.userId,
                    email: storageAuthInfo.account.email
                };
            }

            // 回退到 Session ID 方式
            let currentSessionId = sessionId;
            if (!currentSessionId) {
                const additionalTokens = getAdditionalSessionTokens();
                if (additionalTokens.length > 0) {
                    currentSessionId = additionalTokens[0];
                }
            }

            if (!currentSessionId) {
                throw new Error('Session ID not found');
            }

            const currentHost = this.cachedTraeHost || TRAE_DEFAULT_HOST;
            const url = `${currentHost}/cloudide/api/v3/common/GetUserToken`;
            const body = {};
            const traeTokenResponse = await apiRequestWithRetry(async () => {
                logWithTime(`[API Request] POST ${url} Body: ${JSON.stringify(body)}`);
                const response = await axios.post<TraeTokenResponse>(
                    url,
                    body,
                    {
                        headers: {
                            'Cookie': `X-Cloudide-Session=${currentSessionId}`,
                            'Host': new URL(currentHost).hostname,
                            'Content-Type': 'application/json'
                        },
                        timeout: API_TIMEOUT
                    }
                );
                logWithTime(`[API Response] POST ${url} => ${JSON.stringify(response.data)}`);
                return response.data;
            }, '获取 Trae 用户 Token 响应');

            return {
                userId: traeTokenResponse.Result.UserID,
                email: traeTokenResponse.Result.UserID
            };
        } catch (error) {
            logWithTime(`获取 Trae 用户信息失败: ${error}`);
            throw error;
        }
    }

    /**
     * 获取 Trae 用户当前权益列表
     */
    public async getTraeUserEntitlementList(authToken: string): Promise<TraeApiResponse | null> {
        try {
            const currentHost = this.cachedTraeHost || TRAE_DEFAULT_HOST;
            const url = `${currentHost}/trae/api/v1/pay/user_current_entitlement_list`;
            const body = {};

            const result = await apiRequestWithRetry(async () => {
                logWithTime(`[API Request] POST ${url} Body: ${JSON.stringify(body)}`);
                const response = await axios.post(
                    url,
                    body,
                    {
                        headers: {
                            'authorization': `Cloud-IDE-JWT ${authToken}`,
                            'Host': new URL(currentHost).hostname,
                            'Content-Type': 'application/json'
                        },
                        timeout: API_TIMEOUT
                    }
                );
                logWithTime(`[API Response] POST ${url} => ${JSON.stringify(response.data)}`);
                return response.data;
            }, '获取用户权益列表');

            return result;
        } catch (error) {
            logWithTime(`获取用户权益列表失败: ${error}`);
            throw error;
        }
    }

    /**
     * 清除 Trae 缓存
     */
    public clearTraeCache(): void {
        this.cachedTraeToken = null;
        this.cachedTraeHost = null;
    }
}

export function getTraeApiService(): TraeApiService {
    return TraeApiService.getInstance();
}















