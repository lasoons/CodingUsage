import * as vscode from 'vscode';
import {
  logWithTime,
  getAppType,
  getDashboardUrl,
  getClientApiKey,
  getTeamServerUrl,
  getConfig,
  isShowAllProvidersEnabled,
  exportSessionLogs
} from './common/utils';
import { APP_NAME } from './common/constants';
import { IUsageProvider } from './common/types';
import { CursorProvider } from './cursor/cursorProvider';
import { TraeProvider } from './trae/traeProvider';
import { AntigravityProvider } from './antigravity/antigravityProvider';
import { DbMonitor, ClipboardMonitor } from './common/monitors';
import { ServerDiscovery, TeamServerClient, PingManager } from './teamServerClient';

export async function activate(context: vscode.ExtensionContext) {
  const appType = getAppType();
  
  // 打印环境详情
  const extensionId = 'whyuds.coding-usage';
  const extension = vscode.extensions.getExtension(extensionId);
  const extensionVersion = extension?.packageJSON?.version || 'unknown';
  
  logWithTime(`========== ${APP_NAME} Extension Activated ==========`);
  logWithTime(`Extension Version: ${extensionVersion}`);
  logWithTime(`IDE: ${vscode.env.appName} (${vscode.env.appHost})`);
  logWithTime(`IDE Version: ${vscode.version}`);
  logWithTime(`App Type: ${appType}`);
  logWithTime(`Platform: ${process.platform} ${process.arch}`);
  logWithTime(`Node Version: ${process.version}`);
  logWithTime(`Language: ${vscode.env.language}`);
  logWithTime(`=====================================================`);

  const providers: IUsageProvider[] = [];
  const showAll = isShowAllProvidersEnabled();

  // 创建各个 Provider 实例（用于独立命令注册）
  let cursorProvider: CursorProvider | null = null;
  let traeProvider: TraeProvider | null = null;
  let antigravityProvider: AntigravityProvider | null = null;

  if (showAll) {
    cursorProvider = new CursorProvider(context);
    traeProvider = new TraeProvider(context);
    antigravityProvider = new AntigravityProvider(context);
    providers.push(cursorProvider, traeProvider, antigravityProvider);
  } else {
    if (appType === 'cursor') {
      cursorProvider = new CursorProvider(context);
      providers.push(cursorProvider);
    } else if (appType === 'trae') {
      traeProvider = new TraeProvider(context);
      providers.push(traeProvider);
    } else if (appType === 'antigravity') {
      antigravityProvider = new AntigravityProvider(context);
      providers.push(antigravityProvider);
    } else {
      logWithTime('Unknown App Type, defaulting to Cursor logic');
      cursorProvider = new CursorProvider(context);
      providers.push(cursorProvider);
    }
  }

  const clipboardMonitor = new ClipboardMonitor();
  const dbMonitor = new DbMonitor(context, () => providers.forEach(p => p.safeRefresh()));
  const pingManager = new PingManager();

  // 启动数据库监控（每10秒检查变化）
  dbMonitor.start();

  // 服务器发现（API Key 会在首次投递时根据账号自动生成）
  await ServerDiscovery.autoConfigureIfNeeded();
  await TeamServerClient.checkAndUpdateConnectionStatus();
  pingManager.start();
  TeamServerClient.ping(true);

  registerCommands(context, providers, cursorProvider, traeProvider, antigravityProvider);
  registerListeners(context, providers, clipboardMonitor);

  context.subscriptions.push({
    dispose: () => {
      dbMonitor.stop();
      pingManager.stop();
      providers.forEach(p => p.dispose());
    }
  });
}

function registerCommands(
  context: vscode.ExtensionContext,
  providers: IUsageProvider[],
  cursorProvider: CursorProvider | null,
  traeProvider: TraeProvider | null,
  antigravityProvider: AntigravityProvider | null
): void {
  const commands = [
    // 为每个 Provider 注册独立的点击命令
    vscode.commands.registerCommand('cursorUsage.handleCursorClick', () => {
      cursorProvider?.handleStatusBarClick();
    }),
    vscode.commands.registerCommand('cursorUsage.handleTraeClick', () => {
      traeProvider?.handleStatusBarClick();
    }),
    vscode.commands.registerCommand('cursorUsage.handleAntigravityClick', () => {
      antigravityProvider?.handleStatusBarClick();
    }),
    // 保留通用的刷新命令（用于刷新全部）
    vscode.commands.registerCommand('cursorUsage.refresh', () => {
      providers.forEach(p => p.refresh());
    }),
    vscode.commands.registerCommand('cursorUsage.updateSession', async () => {
      await showUpdateSessionDialog(context);
    }),
    vscode.commands.registerCommand('cursorUsage.showOutput', () => {
      providers.forEach(p => p.showOutput());
    }),
    vscode.commands.registerCommand('cursorUsage.copyApiKey', async () => {
      const apiKey = getClientApiKey();
      const teamServerUrl = getTeamServerUrl();
      if (apiKey) {
        await vscode.env.clipboard.writeText(apiKey);
        if (teamServerUrl) {
          vscode.window.showInformationMessage('API Key copied! Opening platform...');
          vscode.commands.executeCommand('simpleBrowser.show', vscode.Uri.parse(teamServerUrl));
        } else {
          vscode.window.showInformationMessage('API Key copied to clipboard!');
        }
      } else {
        vscode.window.showErrorMessage('No API Key found. Please wait for it to be generated.');
      }
    }),
    vscode.commands.registerCommand('cursorUsage.exportLogs', async () => {
      await exportSessionLogs();
    })
  ];

  context.subscriptions.push(...commands);
}

function registerListeners(context: vscode.ExtensionContext, providers: IUsageProvider[], clipboardMonitor: ClipboardMonitor): void {
  const windowStateListener = vscode.window.onDidChangeWindowState(async (e) => {
    if (e.focused) {
      setTimeout(async () => {
        clipboardMonitor.checkForToken();
        if (providers.some(p => p.isInRefreshingState())) {
          logWithTime('检测到之前可能卡住的刷新状态，尝试恢复...');
          providers.forEach(p => p.safeRefresh());
        }
      }, 500);
    }
  });

  context.subscriptions.push(windowStateListener);
}

async function showUpdateSessionDialog(context: vscode.ExtensionContext): Promise<void> {
  const dashboardUrl = getDashboardUrl();
  const showAllProviders = isShowAllProvidersEnabled();

  interface QuickPickItemExtended extends vscode.QuickPickItem {
    action: string;
  }

  const items: QuickPickItemExtended[] = [
    {
      label: showAllProviders ? '$(check) Show All Providers: ON' : '$(circle-slash) Show All Providers: OFF',
      description: showAllProviders ? 'Click to show only current IDE' : 'Click to show usage for all IDEs',
      detail: 'View usage for Cursor, Trae, and Antigravity regardless of context',
      action: 'toggleShowAll'
    },
    {
      label: '$(gear) Open Extension Settings',
      description: 'Open settings for this extension',
      detail: 'Configure additional accounts, team server URL, and reporting options',
      action: 'openSettings'
    },
    {
      label: `$(globe) Visit ${APP_NAME} Dashboard`,
      description: `Open ${APP_NAME} dashboard in browser`,
      detail: dashboardUrl,
      action: 'visitDashboard'
    }
  ];

  const selectedItem = await vscode.window.showQuickPick(items, {
    title: `${APP_NAME} Usage Configuration`,
    placeHolder: 'Select an action',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selectedItem) {
    switch (selectedItem.action) {
      case 'visitDashboard':
        vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
        break;

      case 'toggleShowAll':
        // 切换显示所有提供者
        const newShowAllState = !showAllProviders;
        const config = getConfig();
        await config.update('showAllProviders', newShowAllState, vscode.ConfigurationTarget.Global);
        const action = newShowAllState ? 'enabled' : 'disabled';
        const msg = await vscode.window.showInformationMessage(`Show All Providers ${action}! Please reload to apply changes.`, 'Reload');
        if (msg === 'Reload') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:whyuds.coding-usage');
        break;
    }
  }
}
