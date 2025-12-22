import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppType } from './types';

export { AppType };

// ==================== Trae Storage 自动读取 ====================
export interface TraeStorageAuthInfo {
    token: string;
    refreshToken: string;
    expiredAt: string;
    refreshExpiredAt: string;
    tokenReleaseAt: string;
    userId: string;
    aiRegion: string;
    region: string;
    host: string;
    account: {
        username: string;
        email: string;
    };
}

/**
 * 从 Trae 的 storage.json 文件中读取认证信息
 * 路径: %APPDATA%\Trae\User\globalStorage\storage.json
 */
export function getTraeStorageAuthInfo(): TraeStorageAuthInfo | null {
    try {
        // 获取 Trae storage.json 路径
        const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const storageJsonPath = path.join(appDataPath, 'Trae', 'User', 'globalStorage', 'storage.json');

        if (!fs.existsSync(storageJsonPath)) {
            logWithTime(`Trae storage.json 不存在: ${storageJsonPath}`);
            return null;
        }

        const storageContent = fs.readFileSync(storageJsonPath, 'utf-8');
        const storageData = JSON.parse(storageContent);

        // 查找 iCubeAuthInfo 键
        const authInfoKey = 'iCubeAuthInfo://icube.cloudide';
        const authInfoStr = storageData[authInfoKey];

        if (!authInfoStr) {
            logWithTime('Trae storage.json 中未找到 iCubeAuthInfo');
            return null;
        }

        const authInfo = JSON.parse(authInfoStr);

        // 检查 token 是否过期
        if (authInfo.expiredAt) {
            const expiredAt = new Date(authInfo.expiredAt);
            if (expiredAt < new Date()) {
                logWithTime('Trae storage token 已过期');
                return null;
            }
        }

        logWithTime(`成功从 Trae storage.json 读取认证信息, userId: ${authInfo.userId}`);
        return {
            token: authInfo.token,
            refreshToken: authInfo.refreshToken,
            expiredAt: authInfo.expiredAt,
            refreshExpiredAt: authInfo.refreshExpiredAt,
            tokenReleaseAt: authInfo.tokenReleaseAt,
            userId: authInfo.userId,
            aiRegion: authInfo.aiRegion,
            region: authInfo.region,
            host: authInfo.host,
            account: {
                username: authInfo.account?.username || '',
                email: authInfo.account?.email || ''
            }
        };
    } catch (error) {
        logWithTime(`读取 Trae storage.json 失败: ${error}`);
        return null;
    }
}

// 获取当前应用类型
export function getAppType(): AppType {
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (appName.includes('trae')) return 'trae';
    if (appName.includes('antigravity')) return 'antigravity';
    return 'unknown';
}

// 获取当前应用名称（用于显示）
export function getAppDisplayName(): string {
    const appType = getAppType();
    switch (appType) {
        case 'cursor': return 'Cursor';
        case 'trae': return 'Trae';
        default: return vscode.env.appName || 'Coding';
    }
}

// ==================== 配置管理 ====================
const CONFIG_PREFIX = 'cursorUsage';

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_PREFIX);
}

// 获取额外的 Session Tokens（最多 3 个副账号）
export function getAdditionalSessionTokens(): string[] {
    const tokens = getConfig().get<string[]>('additionalSessionTokens') || [];
    return tokens.slice(0, 3).filter(t => t && t.trim().length > 0);
}

// 获取团队服务器 URL
export function getTeamServerUrl(): string {
    return getConfig().get<string>('teamServerUrl') || '';
}

// 获取客户端 API Key
export function getClientApiKey(): string {
    return getConfig().get<string>('clientApiKey') || '';
}

// 设置客户端 API Key
export async function setClientApiKey(apiKey: string): Promise<void> {
    await getConfig().update('clientApiKey', apiKey, vscode.ConfigurationTarget.Global);
}

// 设置团队服务器 URL
export async function setTeamServerUrl(url: string): Promise<void> {
    await getConfig().update('teamServerUrl', url, vscode.ConfigurationTarget.Global);
}

// 检查是否启用投递
export function isReportingEnabled(): boolean {
    return getConfig().get<boolean>('enableReporting') || false;
}

// ==================== 输出通道管理 ====================
let outputChannel: vscode.OutputChannel;

export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Coding Usage');
    }
    return outputChannel;
}

export function setOutputChannel(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

export function disposeOutputChannel(): void {
    if (outputChannel) {
        outputChannel.dispose();
    }
}

// ==================== 日志工具 ====================
export function logWithTime(message: string): void {
    const timestamp = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    getOutputChannel().appendLine(logMessage);
}

// ==================== 格式化工具 ====================
// 格式化时间戳（Cursor 使用毫秒，Trae 使用秒）
export function formatTimestamp(timestamp: number, isSeconds: boolean = false): string {
    const ms = isSeconds ? timestamp * 1000 : timestamp;
    return new Date(ms).toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

// 格式化时间戳（不显示年份，格式：MM/DD HH:mm）
export function formatTimeWithoutYear(timestamp: number, isSeconds: boolean = false): string {
    const ms = isSeconds ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const hh = date.getHours().toString().padStart(2, '0');
    const min = date.getMinutes().toString().padStart(2, '0');
    return `${mm}/${dd} ${hh}:${min}`;
}

export function formatTokensInMillions(tokens: number): string {
    return `${(tokens / 1000000).toFixed(2)}M`;
}

// ==================== 错误处理工具 ====================
export function isRetryableError(error: any): boolean {
    return error && (
        error.code === 'ECONNABORTED' ||
        error.message?.includes('timeout') ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNRESET' ||
        error.message?.includes('Failed to establish a socket connection to proxies') ||
        error.message?.includes('proxy')
    );
}

// ==================== 剪贴板匹配模式 ====================
// 获取剪贴板检测的正则表达式
export function getClipboardTokenPattern(): RegExp {
    const appType = getAppType();
    if (appType === 'cursor') {
        return /WorkosCursorSessionToken=([^\n\s;]+)/;
    } else if (appType === 'trae') {
        return /X-Cloudide-Session=([^\s;]+)/;
    }
    // 支持两种格式
    return /(?:WorkosCursorSessionToken|X-Cloudide-Session)=([^\n\s;]+)/;
}

// ==================== 数据库监控字段 ====================
export function getDbMonitorKey(): string {
    const appType = getAppType();
    if (appType === 'cursor') {
        return 'composer.composerData';
    } else if (appType === 'trae') {
        return 'icube-ai-agent-storage-input-history';
    }
    return 'composer.composerData';
}

// ==================== Dashboard URL ====================
export function getDashboardUrl(): string {
    const appType = getAppType();
    if (appType === 'cursor') {
        return 'https://cursor.com/dashboard?tab=usage';
    } else if (appType === 'trae') {
        return 'https://www.trae.ai/account-setting#usage';
    }
    return 'https://cursor.com/dashboard?tab=usage';
}



