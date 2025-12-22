import * as vscode from 'vscode';
import { IUsageProvider } from '../common/types';
import { logWithTime, getOutputChannel } from '../common/utils';
import { DOUBLE_CLICK_DELAY, FETCH_TIMEOUT } from '../common/constants';
import { QuotaSnapshot, ModelQuotaInfo } from './types';
import { PortDetector } from './portDetector';
import { getAntigravityApiService } from './antigravityApiService';

export class AntigravityProvider implements IUsageProvider {
    private quotaData: QuotaSnapshot | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private apiService = getAntigravityApiService();
    private portDetector = new PortDetector();

    private clickCount = 0;
    private clickTimer: NodeJS.Timeout | null = null;
    private fetchTimeoutTimer: NodeJS.Timeout | null = null;
    private pollingTimer: NodeJS.Timeout | null = null;
    private rotationTimer: NodeJS.Timeout | null = null;
    private currentDisplayIndex = 0;
    private readonly POLLING_INTERVAL = 100 * 1000; // 100秒
    private readonly ROTATION_INTERVAL = 5 * 1000; // 5秒轮换
    private isRefreshing = false;
    private isManualRefresh = false;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = this.createStatusBarItem();
        this.initialize();
    }

    private createStatusBarItem(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        item.command = 'cursorUsage.handleStatusBarClick';
        item.show();
        return item;
    }

    public initialize(): void {
        this.updateStatusBar();
        this.fetchData();
        this.startPolling();
        this.startRotation();
    }

    private startPolling(): void {
        this.stopPolling();
        this.pollingTimer = setInterval(() => {
            if (!this.isRefreshing) {
                logWithTime('[Antigravity] 自动轮询刷新');
                this.fetchData();
            }
        }, this.POLLING_INTERVAL);
    }

    private stopPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
    }

    private startRotation(): void {
        this.stopRotation();
        this.rotationTimer = setInterval(() => {
            this.currentDisplayIndex++;
            this.updateStatusBar();
        }, this.ROTATION_INTERVAL);
    }

    private stopRotation(): void {
        if (this.rotationTimer) {
            clearInterval(this.rotationTimer);
            this.rotationTimer = null;
        }
    }

    public refresh(): void {
        logWithTime('[Antigravity] 手动刷新开始');
        this.isManualRefresh = true;
        this.isRefreshing = true;
        this.setLoadingState();
        this.fetchData();
    }

    public safeRefresh(): void {
        if (this.isRefreshing) {
            this.resetRefreshState();
        }
        this.fetchData();
    }

    public isInRefreshingState(): boolean {
        return this.isRefreshing;
    }

    public handleStatusBarClick(): void {
        if (this.isRefreshing) return;

        this.clickCount++;
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = null;
            this.clickCount = 0;
            vscode.commands.executeCommand('cursorUsage.updateSession');
        } else {
            this.clickTimer = setTimeout(() => {
                if (this.clickCount === 1) {
                    this.refresh();
                }
                this.clickCount = 0;
                this.clickTimer = null;
            }, DOUBLE_CLICK_DELAY);
        }
    }

    public showOutput(): void {
        getOutputChannel().show();
    }

    public dispose(): void {
        this.stopPolling();
        this.stopRotation();
        this.statusBarItem.dispose();
    }

    private setLoadingState(): void {
        this.statusBarItem.text = '$(loading~spin) Loading...';
    }

    private resetRefreshState(): void {
        this.isManualRefresh = false;
        this.isRefreshing = false;
        if (this.fetchTimeoutTimer) {
            clearTimeout(this.fetchTimeoutTimer);
            this.fetchTimeoutTimer = null;
        }
    }

    private async fetchData(): Promise<void> {
        this.fetchTimeoutTimer = setTimeout(() => {
            logWithTime('[Antigravity] fetchData 超时');
            this.resetRefreshState();
            this.updateStatusBar();
        }, FETCH_TIMEOUT);

        try {
            const info = await this.portDetector.detectProcessInfo();
            if (info) {
                this.apiService.setProcessInfo(info);
                const snapshot = await this.apiService.fetchQuota();
                if (snapshot) {
                    this.quotaData = snapshot;
                }
            } else {
                logWithTime('[Antigravity] 未检测到进程');
            }
        } catch (error) {
            logWithTime(`[Antigravity] fetchData 错误: ${error}`);
        } finally {
            this.resetRefreshState();
            this.updateStatusBar();
        }
    }

    private updateStatusBar(): void {
        if (!this.quotaData) {
            this.statusBarItem.text = '$(warning) Antigravity: Off';
            this.statusBarItem.tooltip = 'Unable to detect Antigravity process\nClick to refresh';
            return;
        }

        // Find relevant models and build display items with full names
        const claude = this.quotaData.models.find(m => m.label.toLowerCase().includes('claude'));
        const gPro = this.quotaData.models.find(m => m.label.toLowerCase().includes('pro'));
        const gFlash = this.quotaData.models.find(m => m.label.toLowerCase().includes('flash'));

        const displayItems: { name: string; model: ModelQuotaInfo }[] = [];
        if (claude) displayItems.push({ name: 'Claude 4.5', model: claude });
        if (gPro) displayItems.push({ name: 'Gemini Pro', model: gPro });
        if (gFlash) displayItems.push({ name: 'Gemini Flash', model: gFlash });

        // Filter out models at 100% - they don't need to be in rotation
        const rotationItems = displayItems.filter(item =>
            item.model.remainingPercentage === undefined || item.model.remainingPercentage < 100
        );

        if (rotationItems.length === 0) {
            this.statusBarItem.text = 'Antigravity: OK';
        } else {
            // Rotate through models under 100%
            const index = this.currentDisplayIndex % rotationItems.length;
            const current = rotationItems[index];
            this.statusBarItem.text = `${current.name}: ${this.formatRemaining(current.model)} (${current.model.timeUntilResetFormatted})`;
        }
        this.statusBarItem.tooltip = this.buildTooltip();
    }

    private formatRemaining(model: ModelQuotaInfo): string {
        return model.remainingPercentage !== undefined ? `${model.remainingPercentage.toFixed(0)}%` : '??%';
    }

    private buildTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        if (!this.quotaData) {
            md.appendMarkdown('Antigravity process not detected.\n\n[Refresh](command:cursorUsage.refresh)');
            return md;
        }

        md.appendMarkdown(`**Antigravity Usage** \u00A0\u00A0 🕐${this.formatTime(this.quotaData.timestamp)}\n\n`);

        this.quotaData.models.forEach(model => {
            const progress = this.buildProgressBar(model.remainingPercentage || 0);
            const shortLabel = this.shortenModelLabel(model.label);
            md.appendMarkdown(`${shortLabel} [${progress.bar}] ${progress.percentage}% \u00A0 Reset: ${model.timeUntilResetFormatted}\n\n`);
        });

        md.appendMarkdown('---\n\n[Refresh](command:cursorUsage.refresh) \u00A0\u00A0 [Settings](command:cursorUsage.updateSession)');
        return md;
    }

    private shortenModelLabel(label: string): string {
        // 缩短模型名称以节省空间
        const mappings: Record<string, string> = {
            'Claude Sonnet 4.5': 'Sonnet 4.5',
            'Claude Sonnet 4.5 (Thinking)': 'Sonnet 4.5T',
            'Claude Opus 4.5 (Thinking)': 'Opus 4.5T',
            'Gemini 3 Flash': 'G3 Flash',
            'Gemini 3 Pro (High)': 'G3 Pro-H',
            'Gemini 3 Pro (Low)': 'G3 Pro-L',
            'GPT-OSS 120B (Medium)': 'GPT-OSS',
        };
        return mappings[label] || label;
    }

    private buildProgressBar(percentage: number): { bar: string; percentage: number } {
        const length = 20;
        const filled = Math.round((percentage / 100) * length);
        const bar = '█'.repeat(filled) + '░'.repeat(length - filled);
        return { bar, percentage: Math.round(percentage) };
    }

    private formatTime(date: Date): string {
        const mm = (date.getMonth() + 1).toString().padStart(2, '0');
        const dd = date.getDate().toString().padStart(2, '0');
        const hh = date.getHours().toString().padStart(2, '0');
        const min = date.getMinutes().toString().padStart(2, '0');
        return `${mm}/${dd} ${hh}:${min}`;
    }
}
