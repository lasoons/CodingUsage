import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import initSqlJs from 'sql.js';
import {
    logWithTime,
    formatTimeWithoutYear,
    getAdditionalSessionTokens,
    isShowAllProvidersEnabled,
    filterTokensByIdeType,
    getRecentEventsLimit,
} from '../common/utils';
import {
    DOUBLE_CLICK_DELAY,
    FETCH_TIMEOUT
} from '../common/constants';
import {
    IUsageProvider
} from '../common/types';
import {
    UsageSummaryResponse,
    BillingCycleResponse,
    AggregatedUsageResponse,
    SecondaryAccountData
} from './types';
import { getCursorApiService } from './cursorApiService';
import { TeamServerClient } from '../teamServerClient';
import { getOutputChannel } from '../common/utils';

// ==================== Token 自动检测 Helpers ====================
async function getGlobalStorageDbPath(): Promise<string> {
    const platform = os.platform();
    const homeDir = os.homedir();
    const appFolderName = 'Cursor';

    switch (platform) {
        case 'win32': {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
            return path.join(appData, appFolderName, 'User', 'globalStorage', 'state.vscdb');
        }
        case 'darwin':
            return path.join(homeDir, 'Library', 'Application Support', appFolderName, 'User', 'globalStorage', 'state.vscdb');
        default:
            return path.join(homeDir, '.config', appFolderName, 'User', 'globalStorage', 'state.vscdb');
    }
}

async function getWorkspaceStorageDbPathForCurrentWorkspace(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }
    const workspaceDir = workspaceFolders[0].uri.fsPath;
    try {
        if (!(await fs.pathExists(workspaceDir))) {
            return null;
        }
        const stats = await fs.stat(workspaceDir);
        const ctime = (stats as any).birthtimeMs || (stats as any).ctimeMs;
        const normalizedPath = os.platform() === 'win32'
            ? workspaceDir.replace(/^([A-Z]):/, (_match, letter) => (letter as string).toLowerCase() + ':')
            : workspaceDir;
        const hashInput = normalizedPath + Math.floor(ctime).toString();
        const workspaceId = crypto.createHash('md5').update(hashInput, 'utf8').digest('hex');

        let baseStoragePath: string;
        const platform = os.platform();
        const homeDir = os.homedir();
        const appFolderName = vscode.env.appName || 'Cursor';

        switch (platform) {
            case 'win32': {
                const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
                baseStoragePath = path.join(appData, appFolderName, 'User', 'workspaceStorage');
                break;
            }
            case 'darwin':
                baseStoragePath = path.join(homeDir, 'Library', 'Application Support', appFolderName, 'User', 'workspaceStorage');
                break;
            default:
                baseStoragePath = path.join(homeDir, '.config', appFolderName, 'User', 'workspaceStorage');
                break;
        }

        const stateDbPath = path.join(baseStoragePath, workspaceId, 'state.vscdb');
        if (await fs.pathExists(stateDbPath)) {
            return stateDbPath;
        }
        return null;
    } catch {
        return null;
    }
}

function formatTimeToSecond(epochMs: number): string {
    const date = new Date(epochMs);
    const hh = date.getHours().toString().padStart(2, '0');
    const mm = date.getMinutes().toString().padStart(2, '0');
    const ss = date.getSeconds().toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

async function readAccessTokenFromDb(context: vscode.ExtensionContext): Promise<string | null> {
    try {
        const wasmPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'sql-wasm.wasm').fsPath;
        const dbPath = await getGlobalStorageDbPath();

        if (!await fs.pathExists(dbPath)) {
            logWithTime(`数据库文件不存在: ${dbPath}`);
            return null;
        }

        const SQL = await initSqlJs({ locateFile: () => wasmPath });
        const fileBuffer = await fs.readFile(dbPath);
        const db = new SQL.Database(fileBuffer);
        const res = db.exec(`SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';`);
        db.close();

        if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
            const val = res[0].values[0][0];
            return typeof val === 'string' ? val : null;
        }
        return null;
    } catch (error) {
        logWithTime(`读取 accessToken 失败: ${error}`);
        return null;
    }
}

async function readGenerationsFromDb(context: vscode.ExtensionContext): Promise<import('./types').GenerationItem[]> {
    try {
        const wasmPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'sql-wasm.wasm').fsPath;
        const workspaceDbPath = await getWorkspaceStorageDbPathForCurrentWorkspace();
        const dbPath = workspaceDbPath || await getGlobalStorageDbPath();

        if (!await fs.pathExists(dbPath)) {
            return [];
        }

        const SQL = await initSqlJs({ locateFile: () => wasmPath });
        const fileBuffer = await fs.readFile(dbPath);
        const db = new SQL.Database(fileBuffer);
        const res = db.exec(`SELECT value FROM ItemTable WHERE key = 'aiService.generations';`);
        db.close();

        if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
            const val = res[0].values[0][0];
            const raw = typeof val === 'string' ? val : JSON.stringify(val);
            try {
                return JSON.parse(raw) as import('./types').GenerationItem[];
            } catch {
                return [];
            }
        }
        return [];
    } catch (error) {
        logWithTime(`读取 generations 失败: ${error}`);
        return [];
    }
}

function getCacheType(cacheWriteTokens: number, cacheReadTokens: number): string {
    const write = cacheWriteTokens || 0;
    const read = cacheReadTokens || 0;
    const total = write + read;
    if (total === 0) return 'UNKNOWN';
    const writeRatio = write / total;
    if (writeRatio < 0.1) {
        return 'HIGH_HIT';
    }
    if (writeRatio > 0.6) {
        return 'COLD_WRITE';
    }
    return 'INCREMENTAL';
}

function constructSessionToken(accessToken: string): string | null {
    try {
        const parts = accessToken.split('.');
        if (parts.length !== 3) {
            logWithTime('accessToken 不是有效的 JWT 格式');
            return null;
        }
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const sub = payload.sub;
        if (!sub || !sub.includes('|')) {
            logWithTime(`JWT sub 字段格式不正确: ${sub}`);
            return null;
        }
        const userId = sub.split('|')[1];
        return `${userId}%3A%3A${accessToken}`;
    } catch (error) {
        logWithTime(`解析 JWT 失败: ${error}`);
        return null;
    }
}

async function readCachedEmailFromDbLocal(context: vscode.ExtensionContext): Promise<string | null> {
    try {
        const wasmPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'sql-wasm.wasm').fsPath;
        const dbPath = await getGlobalStorageDbPath();

        if (!await fs.pathExists(dbPath)) {
            return null;
        }

        const SQL = await initSqlJs({ locateFile: () => wasmPath });
        const fileBuffer = await fs.readFile(dbPath);
        const db = new SQL.Database(fileBuffer);
        const res = db.exec(`SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail';`);
        db.close();

        if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
            const val = res[0].values[0][0];
            return typeof val === 'string' ? val : null;
        }
        return null;
    } catch (error) {
        logWithTime(`读取 cachedEmail 失败: ${error}`);
        return null;
    }
}

function getStringDisplayWidth(str: string): number {
    let width = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // ASCII 字符 (0-127) 算 1 个宽度，其他（主要是中文/全角符号）算 2 个宽度
        width += code >= 0 && code <= 127 ? 1 : 2;
    }
    return width;
}

export class CursorProvider implements IUsageProvider {
    private billingCycleData: BillingCycleResponse | null = null;
    private summaryData: UsageSummaryResponse | null = null;
    private aggregatedUsageData: AggregatedUsageResponse | null = null;
    private secondaryAccountsData: Map<string, SecondaryAccountData> = new Map();
    private recentEvents: any[] = [];
    private primaryEmail: string | null = null;

    private retryTimer: NodeJS.Timeout | null = null;
    private clickTimer: NodeJS.Timeout | null = null;
    private fetchTimeoutTimer: NodeJS.Timeout | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private apiService = getCursorApiService();
    private clickCount = 0;
    private isRefreshing = false;
    private isManualRefresh = false;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = this.createStatusBarItem();
        this.initialize();
    }

    private createStatusBarItem(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        item.command = 'cursorUsage.handleCursorClick';
        item.show();
        return item;
    }

    public initialize(): void {
        this.updateStatusBar();
        this.fetchData();
    }

    public refresh(): void {
        logWithTime('手动刷新开始');
        this.isManualRefresh = true;
        this.isRefreshing = true;
        this.setLoadingState();
        this.apiService.clearCache();
        this.fetchData();
    }

    public safeRefresh(): void {
        if (this.isRefreshing) {
            logWithTime('重置可能卡住的刷新状态');
            this.resetRefreshState();
        }
        this.fetchData();
    }

    public isInRefreshingState(): boolean {
        return this.isRefreshing;
    }

    public isAuthenticated(): boolean {
        return this.summaryData !== null;
    }

    public handleStatusBarClick(): void {
        if (this.isRefreshing) {
            logWithTime('当前正在刷新中，忽略点击');
            return;
        }

        this.clickCount++;

        if (this.clickTimer) {
            this.clearClickTimer();
            vscode.commands.executeCommand('cursorUsage.updateSession');
        } else {
            this.clickTimer = setTimeout(() => {
                if (this.clickCount === 1) {
                    this.refresh();
                }
                this.clearClickTimer();
            }, DOUBLE_CLICK_DELAY);
        }
    }

    private clearClickTimer(): void {
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = null;
        }
        this.clickCount = 0;
    }

    public showOutput(): void {
        const outputChannel = getOutputChannel();
        outputChannel.show();
    }

    public async showDetailedUsage(): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'cursorDetailedUsage',
            'Cursor Recent Usage',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = '<div style="padding: 20px;">Loading data...</div>';

        try {
            const accessToken = await readAccessTokenFromDb(this.context);
            const sessionToken = accessToken ? constructSessionToken(accessToken) : null;
            const events = await this.getCombinedRecentEventsInternal(sessionToken);
            panel.webview.html = this.generateUsageHtml(events);
        } catch (e) {
            panel.webview.html = `<div style="padding: 20px; color: red;">Error loading data: ${e}</div>`;
        }
    }

    private async getCombinedRecentEventsInternal(sessionToken: string | null): Promise<any[]> {
        const generations = await readGenerationsFromDb(this.context);

        let usageEvents: import('./types').UsageEvent[] = [];
        if (sessionToken) {
            const now = new Date();
            const endDate = now.getTime().toString();
            const startDate = (now.getTime() - 30 * 24 * 60 * 60 * 1000).toString();

            try {
                const resp = await this.apiService.fetchFilteredUsageEvents(sessionToken, startDate, endDate, 1, 100);
                if (resp && resp.usageEventsDisplay) {
                    usageEvents = resp.usageEventsDisplay;
                }
            } catch (e) {
                logWithTime(`Fetch usage events failed: ${e}`);
            }
        }

        const combined = [];

        for (const gen of generations) {
            combined.push({
                unixMs: gen.unixMs,
                type: 'generation',
                details: gen
            });
        }

        for (const evt of usageEvents) {
            combined.push({
                unixMs: parseInt(evt.timestamp),
                type: 'usage',
                details: evt
            });
        }

        combined.sort((a, b) => b.unixMs - a.unixMs);

        return combined;
    }

    private async getCombinedRecentEvents(): Promise<any[]> {
        const accessToken = await readAccessTokenFromDb(this.context);
        const sessionToken = accessToken ? constructSessionToken(accessToken) : null;
        return this.getCombinedRecentEventsInternal(sessionToken);
    }

    private generateUsageHtml(events: any[]): string {
        let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Cursor Usage</title>
            <style>
                body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                .event-item { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; }
                .time { font-size: 0.9em; color: var(--vscode-descriptionForeground); min-width: 150px; flex-shrink: 0; }
                .content { flex: 1; margin-left: 10px; display: flex; align-items: center; min-width: 0; }
                .text-ellipsis { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
                .bold { font-weight: bold; }
                .tooltip { position: relative; display: inline-flex; max-width: 100%; cursor: help; border-bottom: 1px dotted var(--vscode-textLink-foreground); }
                .tooltip .tooltiptext {
                    visibility: hidden;
                    min-width: 200px;
                    max-width: 400px;
                    width: max-content;
                    background-color: var(--vscode-editorHoverWidget-background);
                    color: var(--vscode-editorHoverWidget-foreground);
                    text-align: left;
                    border: 1px solid var(--vscode-editorHoverWidget-border);
                    border-radius: 4px;
                    padding: 8px;
                    position: absolute;
                    z-index: 100;
                    bottom: 125%;
                    left: 50%;
                    transform: translateX(-50%);
                    opacity: 0;
                    transition: opacity 0.3s;
                    font-size: 0.9em;
                    white-space: pre-wrap;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.4);
                }
                .tooltip:hover .tooltiptext { visibility: visible; opacity: 1; }
                .tag { font-size: 0.8em; padding: 2px 6px; border-radius: 4px; margin-right: 5px; font-weight: bold; flex-shrink: 0; }
                .tag-gen { background-color: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                .tag-usage { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
                h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="events-list">
                <div class="event-item" style="font-weight: bold; border-bottom: 2px solid var(--vscode-panel-border);">
                    <div class="time">Event Time</div>
                    <div class="content">Event Detail</div>
                </div>
        `;

        events.forEach(item => {
            const date = new Date(item.unixMs);
            const timeStr = date.toLocaleString('zh-CN', { hour12: false }); // Use local time format

            if (item.type === 'generation') {
                const gen = item.details as import('./types').GenerationItem;
                const desc = gen.textDescription || '';
                let displayDesc = desc;
                if (desc.length > 30) {
                    displayDesc = desc.substring(0, 30) + `... (${desc.length - 30})`;
                }

                html += `
                <div class="event-item">
                    <div class="time">${timeStr}</div>
                    <div class="content">
                        <span class="tag tag-gen">GEN</span>
                        <span class="text-ellipsis" title="${desc.replace(/"/g, '&quot;')}">${displayDesc}</span>
                    </div>
                </div>
                `;
            } else {
                const evt = item.details as import('./types').UsageEvent;
                const tokenUsage = evt.tokenUsage;
                const totalTokens = tokenUsage ? (tokenUsage.inputTokens + tokenUsage.outputTokens + tokenUsage.cacheWriteTokens + tokenUsage.cacheReadTokens) : 0;

                let cacheHitRatio = "0%";
                let cacheType = "UNKNOWN";
                let totalCents = 0;

                if (tokenUsage) {
                    const cacheTotal = tokenUsage.cacheWriteTokens + tokenUsage.cacheReadTokens;
                    if (cacheTotal > 0) {
                        cacheHitRatio = ((tokenUsage.cacheReadTokens / cacheTotal) * 100).toFixed(1) + "%";
                    }
                    cacheType = getCacheType(tokenUsage.cacheWriteTokens, tokenUsage.cacheReadTokens);
                    totalCents = tokenUsage.totalCents || 0;
                }

                const isColdWrite = cacheType === 'COLD_WRITE';
                const styleClass = isColdWrite ? 'bold' : '';

                const tooltipContent = `Model: ${evt.model}
Total Tokens: ${totalTokens}
Input: ${tokenUsage?.inputTokens || 0}
Output: ${tokenUsage?.outputTokens || 0}
Cache Write: ${tokenUsage?.cacheWriteTokens || 0}
Cache Read: ${tokenUsage?.cacheReadTokens || 0}
Hit Ratio: ${cacheHitRatio}
Cost: ${totalCents > 0 ? totalCents.toFixed(4) + ' cents' : '0'}
Type: ${cacheType}`;

                html += `
                <div class="event-item ${styleClass}">
                    <div class="time">${timeStr}</div>
                    <div class="content">
                        <span class="tag tag-usage">USE</span>
                        <div class="tooltip">
                            <span class="text-ellipsis">${evt.model} (Total: ${totalTokens})</span>
                            <span class="tooltiptext">${tooltipContent}</span>
                        </div>
                    </div>
                </div>
                `;
            }
        });

        html += `
            </div>
        </body>
        </html>
        `;

        return html;
    }

    public dispose(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.clearClickTimer();
        this.clearFetchTimeout();
        this.statusBarItem.dispose();
    }

    private setLoadingState(): void {
        this.statusBarItem.text = '$(loading~spin) Loading...';
        this.statusBarItem.tooltip = 'Refreshing usage data...';
        this.statusBarItem.color = undefined;
    }

    private resetRefreshState(): void {
        this.isManualRefresh = false;
        this.isRefreshing = false;
        this.clearFetchTimeout();
    }

    private async fetchData(retryCount = 0): Promise<void> {
        this.clearFetchTimeout();
        this.fetchTimeoutTimer = setTimeout(() => {
            logWithTime('fetchData 超时，强制重置状态');
            this.resetRefreshState();
            this.updateStatusBar();
            if (this.isManualRefresh) {
                vscode.window.showErrorMessage('Request timeout. Please try again.');
            }
        }, FETCH_TIMEOUT);

        try {
            const accessToken = await readAccessTokenFromDb(this.context);
            const primaryToken = accessToken ? constructSessionToken(accessToken) : null;

            if (!primaryToken) {
                logWithTime('无法从 DB 获取主账号 token，请确保已登录 Cursor');
                this.showNotConfiguredStatus();
                this.resetRefreshState();
                return;
            }

            this.primaryEmail = await readCachedEmailFromDbLocal(this.context);
            logWithTime(`主账号邮箱: ${this.primaryEmail}`);

            await this.fetchCursorData(primaryToken);
            await this.fetchSecondaryAccountsData();

            this.clearFetchTimeout();
            this.resetRefreshState();
            this.updateStatusBar();
        } catch (error) {
            logWithTime(`fetchData 发生错误: ${error}`);
            this.clearFetchTimeout();
            if (retryCount < 3) {
                setTimeout(() => this.fetchData(retryCount + 1), 1000);
            } else {
                this.resetRefreshState();
                this.updateStatusBar();
            }
        }
    }

    private async fetchCursorData(sessionToken: string): Promise<void> {
        const summary = await this.apiService.fetchCursorUsageSummary(sessionToken);
        const startMillis = new Date(summary.billingCycleStart).getTime();
        const endMillis = new Date(summary.billingCycleEnd).getTime();

        this.billingCycleData = {
            startDateEpochMillis: String(startMillis),
            endDateEpochMillis: String(endMillis)
        };
        this.summaryData = summary;

        try {
            this.recentEvents = await this.getCombinedRecentEventsInternal(sessionToken);
        } catch (e) {
            logWithTime(`获取 recent events 失败: ${e}`);
            this.recentEvents = [];
        }

        try {
            const billingCycle = await this.apiService.fetchCursorBillingCycle(sessionToken);
            const billingStartMillis = parseInt(billingCycle.startDateEpochMillis);
            const aggregatedUsage = await this.apiService.fetchCursorAggregatedUsage(sessionToken, billingStartMillis);
            this.aggregatedUsageData = aggregatedUsage;
        } catch (e) {
            logWithTime(`获取聚合数据失败: ${e}`);
        }

        await TeamServerClient.submitCursorUsage(sessionToken, summary, this.billingCycleData, this.aggregatedUsageData);
    }

    private async fetchSecondaryAccountsData(): Promise<void> {
        const allTokens = getAdditionalSessionTokens();
        // 只过滤出 Cursor 格式的 token，避免把 Trae 的 token 当作 Cursor 的来处理
        const additionalTokens = filterTokensByIdeType(allTokens, 'cursor');
        logWithTime(`副账号 token 过滤: 总计 ${allTokens.length} 个, Cursor 格式 ${additionalTokens.length} 个`);
        this.secondaryAccountsData.clear();

        for (let i = 0; i < additionalTokens.length; i++) {
            const token = additionalTokens[i];
            try {
                const userInfo = await this.apiService.fetchCursorUserInfo(token);
                const email = userInfo.email || `Account ${i + 2}`;

                const summary = await this.apiService.fetchCursorUsageSummary(token);
                let billingCycle: BillingCycleResponse | null = null;
                let aggregatedData: AggregatedUsageResponse | null = null;

                try {
                    billingCycle = await this.apiService.fetchCursorBillingCycle(token);
                    const billingStartMillis = parseInt(billingCycle.startDateEpochMillis);
                    aggregatedData = await this.apiService.fetchCursorAggregatedUsage(token, billingStartMillis);
                } catch (e) { }

                this.secondaryAccountsData.set(email, { summary, billingCycle, aggregatedData });
            } catch (e) {
                logWithTime(`获取副账号数据失败: ${e}`);
            }
        }
    }

    private clearFetchTimeout(): void {
        if (this.fetchTimeoutTimer) {
            clearTimeout(this.fetchTimeoutTimer);
            this.fetchTimeoutTimer = null;
        }
    }

    private updateStatusBar(): void {
        if (!this.summaryData || !this.billingCycleData) {
            return;
        }
        this.showCursorUsageStatus();
    }

    private showNotConfiguredStatus(): void {
        const showAll = isShowAllProvidersEnabled();
        if (showAll) {
            // In Show All mode, hide unauthenticated providers
            this.statusBarItem.hide();
            return;
        }
        this.statusBarItem.show();
        this.statusBarItem.text = `$(warning) Cursor: Not Logged In`;
        this.statusBarItem.color = undefined;
        this.statusBarItem.tooltip = 'Click to configure\n\nSingle click: Refresh\nDouble click: Configure';
    }

    private showCursorUsageStatus(): void {
        if (!this.summaryData || !this.billingCycleData) return;

        const membershipType = this.summaryData.membershipType.toUpperCase();
        const plan = this.summaryData.individualUsage.plan;
        const showAll = isShowAllProvidersEnabled();

        const apiPercentUsed = plan.apiPercentUsed ?? 0;
        const totalPercentUsed = plan.totalPercentUsed ?? 0;

        const { apiUsageCents, autoUsageCents } = this.calculateUsageFromAggregated();
        const apiLimitCents = apiPercentUsed > 0 ? (apiUsageCents / apiPercentUsed) * 100 : 0;

        if (apiPercentUsed > 0 || (plan.autoPercentUsed ?? 0) > 0) {
            const apiUsageDollars = apiUsageCents / 100;
            const apiLimitDollars = apiLimitCents / 100;
            if (showAll) {
                this.statusBarItem.text = `$(cursor-logo) ${Math.round(apiPercentUsed)}%`;
            } else {
                this.statusBarItem.text = `$(cursor-logo) ${membershipType}: $${apiUsageDollars.toFixed(2)}/${apiLimitDollars.toFixed(0)} (${apiPercentUsed.toFixed(1)}%)`;
            }
        } else {
            const usedCents = plan.breakdown?.total ?? plan.used;
            const usedDollars = usedCents / 100;
            const limitDollars = plan.limit / 100;
            if (showAll) {
                this.statusBarItem.text = `$(cursor-logo) ${Math.round(totalPercentUsed)}%`;
            } else {
                this.statusBarItem.text = `$(cursor-logo) ${membershipType}: $${usedDollars.toFixed(2)}/${limitDollars.toFixed(0)} (${totalPercentUsed.toFixed(1)}%)`;
            }
        }

        this.statusBarItem.color = undefined;
        this.statusBarItem.tooltip = this.buildCursorDetailedTooltip();
        this.statusBarItem.show();
    }

    private calculateUsageFromAggregated() {
        return CursorProvider.calculateUsageFromAggregatedStatic(this.aggregatedUsageData);
    }

    public static calculateUsageFromAggregatedStatic(aggregatedData: AggregatedUsageResponse | null): { apiUsageCents: number; autoUsageCents: number } {
        if (!aggregatedData || !aggregatedData.aggregations) {
            return { apiUsageCents: 0, autoUsageCents: 0 };
        }

        let apiUsageCents = 0;
        let autoUsageCents = 0;

        for (const event of aggregatedData.aggregations) {
            if (event.modelIntent === 'default') {
                autoUsageCents += event.totalCents || 0;
            } else {
                apiUsageCents += event.totalCents || 0;
            }
        }

        return { apiUsageCents, autoUsageCents };
    }

    private buildCursorDetailedTooltip(): vscode.MarkdownString {
        return CursorProvider.buildCursorTooltipFromData(
            this.summaryData,
            this.billingCycleData,
            this.aggregatedUsageData,
            this.secondaryAccountsData,
            this.primaryEmail,
            new Date(),
            this.recentEvents
        );
    }

    public static buildCursorTooltipFromData(
        summary: UsageSummaryResponse | null,
        billing: BillingCycleResponse | null,
        aggregatedData: AggregatedUsageResponse | null,
        secondaryAccounts?: Map<string, SecondaryAccountData>,
        primaryEmail?: string | null,
        currentTime?: Date,
        recentEvents?: any[]
    ): vscode.MarkdownString {
        if (!summary || !billing) {
            return new vscode.MarkdownString('Primary account not detected. Please ensure you are logged in to Cursor.\n\nSingle click: Refresh\nDouble click: Settings');
        }

        const membershipType = summary.membershipType.toUpperCase();
        const label = CursorProvider.getCursorSubscriptionTypeLabel(membershipType);
        const plan = summary.individualUsage.plan;
        const startTime = formatTimeWithoutYear(Number(billing.startDateEpochMillis));
        const endTime = formatTimeWithoutYear(Number(billing.endDateEpochMillis));
        const billingPeriod = `${startTime}-${endTime}`;

        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = true;

        const { apiUsageCents, autoUsageCents } = CursorProvider.calculateUsageFromAggregatedStatic(aggregatedData);

        const apiPercentUsed = plan.apiPercentUsed ?? 0;
        const autoPercentUsed = plan.autoPercentUsed ?? 0;
        const totalPercentUsed = plan.totalPercentUsed ?? 0;

        const apiLimitCents = apiPercentUsed > 0 ? (apiUsageCents / apiPercentUsed) * 100 : 0;
        const autoLimitCents = autoPercentUsed > 0 ? (autoUsageCents / autoPercentUsed) * 100 : 0;

        const hintText = TeamServerClient.isTeamHintActive() ? "✅Connect " : "";
        const now = currentTime || new Date();
        const mm = (now.getMonth() + 1).toString().padStart(2, '0');
        const dd = now.getDate().toString().padStart(2, '0');
        const hh = now.getHours().toString().padStart(2, '0');
        const min = now.getMinutes().toString().padStart(2, '0');
        const updateTime = `🕐${mm}/${dd} ${hh}:${min}`;

        if (apiPercentUsed > 0) {
            const apiUsageDollars = apiUsageCents / 100;
            const apiLimitDollars = apiLimitCents / 100;
            const apiProgressInfo = CursorProvider.buildProgressBarFromPercent(apiPercentUsed);

            md.appendMarkdown(`${label}  📅${billingPeriod}\u00A0\u00A0${hintText}${updateTime}\n\n`);
            md.appendMarkdown(`API ($${apiUsageDollars.toFixed(2)}/${apiLimitDollars.toFixed(0)}) \u00A0\u00A0\u00A0[${apiProgressInfo.progressBar}] ${apiPercentUsed.toFixed(1)}%\n`);
        }

        if (autoPercentUsed > 0) {
            const autoUsageDollars = autoUsageCents / 100;
            const autoLimitDollars = autoLimitCents / 100;
            const autoProgressInfo = CursorProvider.buildProgressBarFromPercent(autoPercentUsed);

            md.appendMarkdown('\n');
            md.appendMarkdown(`Auto($${autoUsageDollars.toFixed(2)}/${autoLimitDollars.toFixed(0)}) [${autoProgressInfo.progressBar}] ${autoPercentUsed.toFixed(1)}%\n`);
        }

        if (apiPercentUsed === 0 && autoPercentUsed === 0) {
            const usedDollars = (plan.breakdown?.total ?? plan.used) / 100;
            const limitDollars = plan.limit / 100;
            const progressInfo = CursorProvider.buildProgressBar(usedDollars, limitDollars);

            md.appendMarkdown(`${label} ($${usedDollars.toFixed(2)}/${limitDollars.toFixed(0)})  📅${billingPeriod}\u00A0\u00A0${hintText}${updateTime}\n`);
            md.appendMarkdown(`[${progressInfo.progressBar}] ${totalPercentUsed.toFixed(1)}%\n`);
        }

        const onDemand = summary.individualUsage.onDemand;
        if (onDemand && onDemand.enabled && onDemand.limit !== null) {
            const onDemandUsedDollars = onDemand.used / 100;
            const onDemandLimitDollars = onDemand.limit / 100;
            const onDemandPercent = onDemand.limit > 0 ? (onDemand.used / onDemand.limit) * 100 : 0;
            const onDemandProgressInfo = CursorProvider.buildProgressBarFromPercent(onDemandPercent);

            md.appendMarkdown('\n');
            md.appendMarkdown(`ODM ($${onDemandUsedDollars.toFixed(2)}/${onDemandLimitDollars.toFixed(0)}) [${onDemandProgressInfo.progressBar}] ${onDemandPercent.toFixed(1)}%\n`);
        }

        if (aggregatedData && aggregatedData.aggregations && aggregatedData.aggregations.length > 0) {
            const headers = ['Model', 'In', 'Out', 'Write', 'Read', 'Cost'];
            const rows: string[][] = [];
            const sortedAggregations = [...aggregatedData.aggregations].sort((a, b) => b.totalCents - a.totalCents);

            for (const agg of sortedAggregations) {
                const modelName = CursorProvider.shortenModelName(agg.modelIntent);
                const inputTokens = parseInt(agg.inputTokens || '0');
                const outputTokens = parseInt(agg.outputTokens || '0');
                const cacheWriteTokens = parseInt(agg.cacheWriteTokens || '0');
                const cacheReadTokens = parseInt(agg.cacheReadTokens || '0');
                const costDollars = (agg.totalCents || 0) / 100;

                rows.push([
                    modelName,
                    CursorProvider.formatTokenCount(inputTokens),
                    CursorProvider.formatTokenCount(outputTokens),
                    CursorProvider.formatTokenCount(cacheWriteTokens),
                    CursorProvider.formatTokenCount(cacheReadTokens),
                    `$${costDollars.toFixed(2)}`
                ]);
            }

            const totalInput = parseInt(aggregatedData.totalInputTokens || '0');
            const totalOutput = parseInt(aggregatedData.totalOutputTokens || '0');
            const totalCacheWrite = parseInt(aggregatedData.totalCacheWriteTokens || '0');
            const totalCacheRead = parseInt(aggregatedData.totalCacheReadTokens || '0');
            const totalCost = aggregatedData.totalCostCents / 100;

            rows.push([
                'Total',
                CursorProvider.formatTokenCount(totalInput),
                CursorProvider.formatTokenCount(totalOutput),
                CursorProvider.formatTokenCount(totalCacheWrite),
                CursorProvider.formatTokenCount(totalCacheRead),
                `$${totalCost.toFixed(2)}`
            ]);

            md.appendMarkdown('\n');
            md.appendCodeblock(CursorProvider.generateMultiRowAsciiTable(headers, rows), 'text');
        }

        const eventsLimit = getRecentEventsLimit();
        if (eventsLimit > 0 && recentEvents && recentEvents.length > 0) {
            md.appendMarkdown('\n---\n');

            const eventsToShow = recentEvents.slice(0, eventsLimit);
            for (const item of eventsToShow) {
                const date = new Date(Number(item.unixMs));
                const dateStr = date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
                const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

                if (item.type === 'generation') {
                    const gen = item.details as import('./types').GenerationItem;
                    const desc = (gen.textDescription || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
                    let displayDesc = desc;
                    if (desc.length > 30) {
                        displayDesc = desc.substring(0, 30) + '...';
                    }
                    md.appendMarkdown(`[${dateStr}, ${timeStr}] [user] ${displayDesc}\n\n`);
                } else {
                    const evt = item.details as import('./types').UsageEvent;
                    const tokenUsage = evt.tokenUsage;
                    const modelName = CursorProvider.shortenModelName(evt.model || 'unknown');

                    const inputTokens = Number((tokenUsage as any)?.inputTokens ?? 0);
                    const outputTokens = Number((tokenUsage as any)?.outputTokens ?? 0);
                    const cacheWriteTokens = Number((tokenUsage as any)?.cacheWriteTokens ?? 0);
                    const cacheReadTokens = Number((tokenUsage as any)?.cacheReadTokens ?? 0);
                    const totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;

                    const cacheTotal = cacheWriteTokens + cacheReadTokens;
                    const cacheReadRatio = cacheTotal > 0 ? ((cacheReadTokens / cacheTotal) * 100).toFixed(1) + '%' : '0%';
                    const totalCents = Number((tokenUsage as any)?.totalCents ?? 0);
                    const tokensStr = CursorProvider.formatTokenCount(totalTokens);

                    md.appendMarkdown(`[${dateStr}, ${timeStr}] [${modelName}] [Cost] ${totalCents.toFixed(1)} [Token] ${tokensStr} [Cache Rate] ${cacheReadRatio}\n\n`);
                }
            }
        }

        if (secondaryAccounts && secondaryAccounts.size > 0) {
            md.appendMarkdown('\n---\n');
            md.appendMarkdown('**Additional Accounts**\n\n');

            secondaryAccounts.forEach((accData, email) => {
                const accSummary = accData.summary;
                const accBilling = accData.billingCycle;
                const accAggregated = accData.aggregatedData;
                const accPlan = accSummary.individualUsage.plan;
                const shortEmail = email.length > 25 ? email.substring(0, 22) + '...' : email;
                const accMembership = accSummary.membershipType.toUpperCase();
                const accLabel = CursorProvider.getCursorSubscriptionTypeLabel(accMembership);

                let billingPeriod = '';
                if (accBilling) {
                    const startTime = formatTimeWithoutYear(Number(accBilling.startDateEpochMillis));
                    const endTime = formatTimeWithoutYear(Number(accBilling.endDateEpochMillis));
                    billingPeriod = ` 📅${startTime}-${endTime}`;
                }

                const apiPercent = accPlan.apiPercentUsed ?? 0;
                const autoPercent = accPlan.autoPercentUsed ?? 0;
                const totalPercent = accPlan.totalPercentUsed ?? 0;

                let apiUsedCents = 0;
                let autoUsedCents = 0;
                if (accAggregated && accAggregated.aggregations) {
                    for (const event of accAggregated.aggregations) {
                        if (event.modelIntent === 'default') {
                            autoUsedCents += event.totalCents || 0;
                        } else {
                            apiUsedCents += event.totalCents || 0;
                        }
                    }
                }

                const apiLimitCents = apiPercent > 0 ? (apiUsedCents / apiPercent) * 100 : 0;
                const autoLimitCents = autoPercent > 0 ? (autoUsedCents / autoPercent) * 100 : 0;

                md.appendMarkdown(`**${shortEmail}** (${accLabel})${billingPeriod}\n\n`);

                if (apiPercent > 0) {
                    const apiUsageDollars = apiUsedCents / 100;
                    const apiLimitDollars = apiLimitCents / 100;
                    const apiProgressInfo = CursorProvider.buildProgressBarFromPercent(apiPercent);
                    md.appendMarkdown(`API ($${apiUsageDollars.toFixed(2)}/${apiLimitDollars.toFixed(0)}) \u00A0\u00A0\u00A0[${apiProgressInfo.progressBar}] ${apiPercent.toFixed(1)}%\n\n`);
                }

                if (autoPercent > 0) {
                    const autoUsageDollars = autoUsedCents / 100;
                    const autoLimitDollars = autoLimitCents / 100;
                    const autoProgressInfo = CursorProvider.buildProgressBarFromPercent(autoPercent);
                    md.appendMarkdown(`Auto($${autoUsageDollars.toFixed(2)}/${autoLimitDollars.toFixed(0)}) [${autoProgressInfo.progressBar}] ${autoPercent.toFixed(1)}%\n\n`);
                }

                if (apiPercent === 0 && autoPercent === 0 && totalPercent > 0) {
                    const totalUsedCents = accPlan.breakdown?.total ?? accPlan.used ?? 0;
                    const totalLimitCents = accPlan.limit ?? 0;
                    const usedDollars = totalUsedCents / 100;
                    const limitDollars = totalLimitCents / 100;
                    const totalProgressInfo = CursorProvider.buildProgressBarFromPercent(totalPercent);
                    md.appendMarkdown(`Total ($${usedDollars.toFixed(2)}/${limitDollars.toFixed(0)}) [${totalProgressInfo.progressBar}] ${totalPercent.toFixed(1)}%\n\n`);
                }

                const onDemand = accSummary.individualUsage.onDemand;
                if (onDemand && onDemand.enabled && onDemand.limit !== null) {
                    const odmUsedDollars = onDemand.used / 100;
                    const odmLimitDollars = onDemand.limit / 100;
                    const odmPercent = onDemand.limit > 0 ? (onDemand.used / onDemand.limit) * 100 : 0;
                    const odmProgressInfo = CursorProvider.buildProgressBarFromPercent(odmPercent);
                    md.appendMarkdown(`ODM ($${odmUsedDollars.toFixed(2)}/${odmLimitDollars.toFixed(0)}) [${odmProgressInfo.progressBar}] ${odmPercent.toFixed(1)}%\n\n`);
                }
            });
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('[Refresh](command:cursorUsage.refresh) \u00A0\u00A0 [Settings](command:cursorUsage.updateSession)');

        return md;
    }

    public static getCursorSubscriptionTypeLabel(membershipType: string): string {
        switch (membershipType.toUpperCase()) {
            case 'PRO':
                return 'Pro Plan';
            case 'ULTRA':
                return 'Ultra Plan';
            default:
                return membershipType || 'Unknown';
        }
    }

    public static buildProgressBarFromPercent(percent: number): { progressBar: string; percentage: number } {
        const progressBarLength = 30;
        const filledLength = Math.round((percent / 100) * progressBarLength);
        const clampedFilled = Math.max(0, Math.min(filledLength, progressBarLength));
        const progressBar = '█'.repeat(clampedFilled) + '░'.repeat(progressBarLength - clampedFilled);
        return { progressBar, percentage: Math.round(percent) };
    }

    public static buildProgressBar(used: number, limit: number): { progressBar: string; percentage: number } {
        const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
        const progressBarLength = 15;
        const filledLength = limit > 0 ? Math.round((used / limit) * progressBarLength) : 0;
        const clampedFilled = Math.max(0, Math.min(filledLength, progressBarLength));
        const progressBar = '█'.repeat(clampedFilled) + '░'.repeat(progressBarLength - clampedFilled);
        return { progressBar, percentage };
    }

    public static shortenModelName(modelIntent: string): string {
        const mappings: Record<string, string> = {
            'claude-4.5-opus-high-thinking': 'opus-4.5',
            'claude-4.5-sonnet-thinking': 'sonnet-4.5',
            'claude-4-opus-thinking': 'opus-4',
            'claude-4-sonnet-thinking': 'sonnet-4',
            'claude-3.5-sonnet': 'sonnet-3.5',
            'claude-3-5-sonnet': 'sonnet-3.5',
            'claude-3-opus': 'opus-3',
            'gpt-5.2': 'gpt-5.2',
            'gpt-4-turbo': 'gpt-4t',
            'gpt-4o': 'gpt-4o',
            'gpt-4o-mini': 'gpt-4o-m',
            'default': 'auto'
        };

        if (mappings[modelIntent]) {
            return mappings[modelIntent];
        }
        if (modelIntent.length > 12) {
            return modelIntent.substring(0, 10) + '..';
        }
        return modelIntent;
    }

    public static formatTokenCount(count: number): string {
        if (count >= 1000000) {
            return `${(count / 1000000).toFixed(2)}M`;
        } else if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}K`;
        }
        return String(count);
    }

    private static generateMultiRowAsciiTable(headers: string[], rows: string[][]): string {
        const colWidths = headers.map((header, colIndex) => {
            const maxRowWidth = Math.max(...rows.map(row => getStringDisplayWidth(row[colIndex] || '')));
            return Math.max(getStringDisplayWidth(header), maxRowWidth) + 2;
        });

        const buildRow = (items: string[]) => {
            return '│' + items.map((item, i) => {
                const itemWidth = getStringDisplayWidth(item);
                const padding = colWidths[i] - itemWidth;

                // For the last column (Details), align left (padding only on right)
                // For other columns, align center
                const isLastColumn = i === items.length - 1;
                const leftPad = isLastColumn ? 1 : Math.floor(padding / 2);
                const rightPad = padding - leftPad;
                return ' '.repeat(leftPad) + item + ' '.repeat(rightPad);
            }).join('│') + '│';
        };

        const buildSeparator = (start: string, mid: string, end: string, line: string) => {
            return start + colWidths.map(w => line.repeat(w)).join(mid) + end;
        };

        const top = buildSeparator('┌', '┬', '┐', '─');
        const headerSep = buildSeparator('├', '┼', '┤', '─');
        const bottom = buildSeparator('└', '┴', '┘', '─');

        const result = [top, buildRow(headers), headerSep];
        rows.forEach(row => {
            result.push(buildRow(row));
        });
        result.push(bottom);

        return result.join('\n');
    }
}






