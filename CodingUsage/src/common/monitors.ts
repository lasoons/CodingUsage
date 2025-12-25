import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import initSqlJs from 'sql.js';
import {
    logWithTime,
    getAppType,
    getDbMonitorKey,
    getClipboardTokenPattern,
    getAdditionalSessionTokens,
    getConfig
} from './utils';
import { APP_NAME } from './constants';

// ==================== 数据库监控 ====================
export class DbMonitor {
    private interval: NodeJS.Timeout | null = null;
    private lastContentHash: string | null = null;
    private wasmPath: string;
    private appType = getAppType();

    constructor(private context: vscode.ExtensionContext, private triggerRefresh: () => void) {
        this.wasmPath = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'sql-wasm.wasm').fsPath;
    }

    private async getStateDbPathForCurrentWorkspace(): Promise<string | null> {
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
            const normalizedPath = os.platform() === 'win32' ? workspaceDir.replace(/^([A-Z]):/, (_match, letter) => (letter as string).toLowerCase() + ':') : workspaceDir;
            const hashInput = normalizedPath + Math.floor(ctime).toString();
            const workspaceId = crypto.createHash('md5').update(hashInput, 'utf8').digest('hex');
            let baseStoragePath: string;
            const platform = os.platform();
            const homeDir = os.homedir();

            // 根据应用类型确定存储路径
            const appFolderName = this.appType === 'trae' ? 'Trae' : (vscode.env.appName || 'Cursor');

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

    private async queryMonitoredContent(stateDbPath: string): Promise<string | null> {
        try {
            const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
            const fileBuffer = await fs.readFile(stateDbPath);
            const db = new SQL.Database(fileBuffer);
            const key = getDbMonitorKey();
            const res = db.exec(`SELECT value FROM ItemTable WHERE key = '${key}';`);
            db.close();
            if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
                const val = res[0].values[0][0];
                return typeof val === 'string' ? val : JSON.stringify(val);
            }
        } catch (e: any) {
            logWithTime(`[DbMonitor] Query failed: ${e?.message}`);
        }
        return null;
    }

    private async tick(): Promise<void> {
        try {
            const dbPath = await this.getStateDbPathForCurrentWorkspace();
            if (!dbPath) {
                return;
            }
            const content = await this.queryMonitoredContent(dbPath);
            if (!content) {
                return;
            }
            const contentHash = crypto.createHash('md5').update(content, 'utf8').digest('hex');
            if (this.lastContentHash !== contentHash) {
                logWithTime(`[DbMonitor] 内容变化: ${this.lastContentHash?.slice(0, 8) ?? 'null'} -> ${contentHash.slice(0, 8)}, DB: ${dbPath}`);
                this.lastContentHash = contentHash;
                this.triggerRefresh();
            }
        } catch (e: any) {
            logWithTime(`[DbMonitor] FAILED: ${e?.message ?? e}`);
        }
    }

    public async refresh(): Promise<void> {
        await this.tick();
    }

    public async start(): Promise<void> {
        const dbPath = await this.getStateDbPathForCurrentWorkspace();
        if (dbPath) await this.tick();
        this.interval = setInterval(() => this.tick(), 10000);
    }

    public stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

// ==================== 剪贴板监控 ====================
export class ClipboardMonitor {
    private lastNotifiedToken: string | null = null;
    private appType = getAppType();

    async checkForToken(): Promise<void> {
        try {
            const tokenPattern = getClipboardTokenPattern();
            // 如果当前IDE不需要检测剪贴板token，直接返回
            if (!tokenPattern) {
                return;
            }
            const clipboardText = await vscode.env.clipboard.readText();
            const tokenMatch = clipboardText.match(tokenPattern);
            if (tokenMatch?.[1]) {
                await this.handleTokenDetected(tokenMatch[1]);
            }
        } catch (error) {
            //   logWithTime(`Clipboard check failed: ${error}`);
        }
    }

    private async handleTokenDetected(token: string): Promise<void> {
        const existingTokens = getAdditionalSessionTokens();
        if (existingTokens.includes(token)) {
            if (this.lastNotifiedToken !== token) {
                vscode.window.showInformationMessage(`Session token already in additional accounts.`);
                this.lastNotifiedToken = token;
            }
            return;
        }

        if (this.lastNotifiedToken !== token) {
            await this.promptAddToken(token);
        }
    }

    private async promptAddToken(token: string): Promise<void> {
        const message = this.appType === 'cursor'
            ? 'Found session token in clipboard. Add as additional account?'
            : 'Found session token in clipboard. Update Trae configuration?';

        const choice = await vscode.window.showInformationMessage(
            message,
            'Add',
            'Cancel'
        );

        if (choice === 'Add') {
            const existingTokens = getAdditionalSessionTokens();
            if (existingTokens.length >= 3) {
                vscode.window.showWarningMessage('Maximum 3 additional accounts allowed. Please remove one first.');
                return;
            }

            const newTokens = [...existingTokens, token];
            await getConfig().update('additionalSessionTokens', newTokens, vscode.ConfigurationTarget.Global);

            this.lastNotifiedToken = token;
            vscode.window.showInformationMessage('Session token added to additional accounts.');
            vscode.commands.executeCommand('cursorUsage.refresh');
        }
    }
}

















