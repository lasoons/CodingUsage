import * as vscode from 'vscode';
import {
  logWithTime,
  getAppType,
  getDashboardUrl,
  getClientApiKey,
  getTeamServerUrl,
  getConfig,
  isReportingEnabled
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
  logWithTime(`${APP_NAME} Usage Monitor extension is now activated. AppType: ${appType}`);

  const providers: IUsageProvider[] = [];
  if (appType === 'cursor') {
    providers.push(new CursorProvider(context));
  } else if (appType === 'trae') {
    providers.push(new TraeProvider(context));
  } else if (appType === 'antigravity') {
    providers.push(new AntigravityProvider(context));
  } else {
    logWithTime('Unknown App Type, defaulting to Cursor logic');
    providers.push(new CursorProvider(context));
  }

  const clipboardMonitor = new ClipboardMonitor();
  const dbMonitor = new DbMonitor(context, () => providers.forEach(p => p.refresh()));
  const pingManager = new PingManager();

  // 启动数据库监控（每10秒检查变化）
  dbMonitor.start();

  // 服务器发现（API Key 会在首次投递时根据账号自动生成）
  await ServerDiscovery.autoConfigureIfNeeded();
  await TeamServerClient.checkAndUpdateConnectionStatus();
  pingManager.start();
  TeamServerClient.ping(true);

  registerCommands(context, providers);
  registerListeners(context, providers, clipboardMonitor);

  context.subscriptions.push({
    dispose: () => {
      dbMonitor.stop();
      pingManager.stop();
      providers.forEach(p => p.dispose());
    }
  });
}

function registerCommands(context: vscode.ExtensionContext, providers: IUsageProvider[]): void {
  const commands = [
    vscode.commands.registerCommand('cursorUsage.handleStatusBarClick', () => {
      providers.forEach(p => p.handleStatusBarClick());
    }),
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
  const clientApiKey = getClientApiKey();
  const teamServerUrl = getTeamServerUrl();
  const reportingEnabled = isReportingEnabled();

  interface QuickPickItemExtended extends vscode.QuickPickItem {
    action: string;
  }

  // 构建团队上报开关的详情（使用低调的符号）
  const reportingStatus = reportingEnabled ? '● ON' : '○ OFF';
  const serverInfo = teamServerUrl ? teamServerUrl : 'Not configured';
  const apiKeyInfo = clientApiKey ? `${clientApiKey.substring(0, 11)}...` : 'Not generated';
  const reportingDetail = `Status: ${reportingStatus} | Server: ${serverInfo} | Key: ${apiKeyInfo}`;

  const items: QuickPickItemExtended[] = [
    {
      label: reportingEnabled ? '$(check) Team Reporting: ON' : '$(circle-slash) Team Reporting: OFF',
      description: reportingEnabled ? 'Click to disable' : 'Click to enable',
      detail: reportingDetail,
      action: 'toggleReporting'
    },
    {
      label: '$(link-external) Copy API Key & Open Team Server',
      description: 'Copy your API Key and open team server in browser',
      detail: teamServerUrl ? `Server: ${teamServerUrl}` : 'Team server not configured',
      action: 'copyKeyAndOpenServer'
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
      case 'toggleReporting':
        // 切换上报开关
        const newReportingState = !reportingEnabled;
        const configObj = getConfig();
        await configObj.update('enableReporting', newReportingState, vscode.ConfigurationTarget.Global);
        const statusText = newReportingState ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Team reporting ${statusText}!`);
        break;
      case 'copyKeyAndOpenServer':
        // 复制 API Key 并跳转到 team server
        if (!clientApiKey) {
          vscode.window.showWarningMessage('API Key not generated yet. Please wait for primary account to be detected.');
          break;
        }
        await vscode.env.clipboard.writeText(clientApiKey);

        if (teamServerUrl) {
          vscode.env.openExternal(vscode.Uri.parse(teamServerUrl));
          vscode.window.showInformationMessage(`API Key copied! Opening team server...`);
        } else {
          vscode.window.showInformationMessage(`API Key copied! Please configure team server URL in settings.`);
        }
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:whyuds.coding-usage');
        break;
    }
  }
}
