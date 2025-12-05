import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';
import axios from 'axios';
import { networkInterfaces } from 'os';
import { 
  logWithTime, 
  getAppDisplayName, 
  getAppType,
  getConfig, 
  getTeamServerUrl, 
  getClientApiKey, 
  setClientApiKey, 
  setTeamServerUrl 
} from './utils';
import { UsageSummaryResponse, BillingCycleResponse, getApiService } from './apiService';
import serverListConfig from './serverList.json';

const API_TIMEOUT = 5000;

// ==================== ApiKey 生成器 ====================
export class ApiKeyGenerator {
  // 获取 MAC 地址
  static getMacAddress(): string {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;
      for (const info of iface) {
        if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
          return info.mac;
        }
      }
    }
    return `fallback-${os.userInfo().username}-${os.platform()}`;
  }

  // 生成 apikey（基于 hostname + MAC 地址 + appName），带 ck_ 前缀
  static generateApiKey(salt?: string): string {
    const hostname = os.hostname();
    const mac = this.getMacAddress();
    const appName = vscode.env.appName || 'Unknown';
    const baseString = `${hostname}-${mac}-${appName}${salt ? `-${salt}` : ''}`;
    const hash = crypto.createHash('md5').update(baseString).digest('hex');
    return `ck_${hash}`;
  }

  // 生成带时间戳盐的新 apikey（用于重新生成）
  static regenerateApiKey(): string {
    const salt = Date.now().toString();
    return this.generateApiKey(salt);
  }

  // 获取或创建 apikey
  static async getOrCreateApiKey(): Promise<string> {
    const existingKey = getClientApiKey();
    
    if (existingKey) {
      logWithTime(`已存在 Client API Key: ${existingKey.substring(0, 11)}...`);
      return existingKey;
    }

    const newKey = this.generateApiKey();
    await setClientApiKey(newKey);
    logWithTime(`生成新的 Client API Key: ${newKey.substring(0, 11)}...`);
    return newKey;
  }

  // 重新生成 apikey
  static async regenerate(): Promise<string> {
    const newKey = this.regenerateApiKey();
    await setClientApiKey(newKey);
    logWithTime(`重新生成 Client API Key: ${newKey.substring(0, 11)}...`);
    return newKey;
  }
}

// ==================== 服务发现 ====================
export class ServerDiscovery {
  // 检查 URL 是否是 coding-usage 服务
  static async checkHealth(url: string): Promise<boolean> {
    try {
      const response = await axios.get(`${url}/api/health`, { timeout: 3000 });
      return response.data && response.data.service === 'coding-usage' && response.data.status === 'ok';
    } catch {
      return false;
    }
  }

  // 从列表中找到第一个可用的 coding-usage 服务
  static async discoverServer(): Promise<string | null> {
    const servers = serverListConfig.servers || [];
    for (const url of servers) {
      logWithTime(`检查服务器: ${url}`);
      const isValid = await this.checkHealth(url);
      if (isValid) {
        logWithTime(`发现可用的 coding-usage 服务: ${url}`);
        return url;
      }
    }
    logWithTime('未发现可用的 coding-usage 服务');
    return null;
  }

  // 自动配置 Team Server URL
  static async autoConfigureIfNeeded(): Promise<void> {
    const currentUrl = getTeamServerUrl();
    
    if (currentUrl) {
      logWithTime(`Team Server URL 已配置: ${currentUrl}`);
      return;
    }

    logWithTime('Team Server URL 未配置，开始自动发现...');
    const discoveredUrl = await this.discoverServer();
    
    if (discoveredUrl) {
      const appName = getAppDisplayName();
      await setTeamServerUrl(discoveredUrl);
      logWithTime(`已自动配置 Team Server URL: ${discoveredUrl}`);
      vscode.window.showInformationMessage(`${appName} Usage: Auto-configured server ${discoveredUrl}`);
    }
  }
}

// ==================== 团队服务器客户端 ====================
export class TeamServerClient {
  static getConfig() {
    return {
      url: getTeamServerUrl(),
      apiKey: getClientApiKey()
    };
  }

  // 提交 Cursor 使用数据到团队服务器
  static async submitCursorUsage(sessionToken: string, summary: UsageSummaryResponse, billing: BillingCycleResponse): Promise<void> {
    const { url, apiKey } = this.getConfig();
    if (!url || !apiKey) return;
    
    try {
      const apiService = getApiService();
      const me = await apiService.fetchCursorUserInfo(sessionToken);
      const plan = summary.individualUsage.plan;
      // 使用breakdown.total如果存在，否则使用used
      const totalUsed = plan.breakdown?.total ?? plan.used;
      const bonus = plan.breakdown?.bonus ?? 0;
      const body = {
        client_token: apiKey,
        email: me.email,
        expire_time: Number(billing.endDateEpochMillis),
        total_usage: plan.limit,
        used_usage: totalUsed,
        bonus_usage: bonus,
        remaining_usage: plan.remaining,
        membership_type: summary.membershipType,
        host: os.hostname(),
        platform: os.platform(),
        app_name: vscode.env.appName
      };
      logWithTime(`提交使用数据: ${JSON.stringify(body)}`);
      await axios.post(`${url}/api/usage`, body, { headers: { 'X-Api-Key': apiKey }, timeout: API_TIMEOUT });
      logWithTime('提交使用数据成功');
    } catch (e) {
      logWithTime(`提交使用数据失败: ${e}`);
    }
  }

  // 提交 Trae 使用数据到团队服务器
  static async submitTraeUsage(email: string, usageData: {
    expire_time: number;
    total_usage: number;
    used_usage: number;
    bonus_usage: number;
    remaining_usage: number;
    membership_type: string;
  }): Promise<void> {
    const { url, apiKey } = this.getConfig();
    if (!url || !apiKey) return;
    
    try {
      const body = {
        client_token: apiKey,
        email: email,
        expire_time: usageData.expire_time,
        total_usage: usageData.total_usage,
        used_usage: usageData.used_usage,
        bonus_usage: usageData.bonus_usage,
        remaining_usage: usageData.remaining_usage,
        membership_type: usageData.membership_type,
        host: os.hostname(),
        platform: os.platform(),
        app_name: vscode.env.appName
      };
      logWithTime(`提交使用数据: ${JSON.stringify(body)}`);
      await axios.post(`${url}/api/usage`, body, { headers: { 'X-Api-Key': apiKey }, timeout: API_TIMEOUT });
      logWithTime('提交使用数据成功');
    } catch (e) {
      logWithTime(`提交使用数据失败: ${e}`);
    }
  }

  private static teamHint = false;
  static isTeamHintActive() { return this.teamHint; }

  // 检查并更新连接状态
  static async checkAndUpdateConnectionStatus(): Promise<boolean> {
    const { url, apiKey } = this.getConfig();
    if (!url || !apiKey) {
      this.teamHint = false;
      return false;
    }

    try {
      logWithTime('检查团队服务器连接状态...');
      await axios.post(`${url}/api/ping`, { active: true, client_token: apiKey }, { headers: { 'X-Api-Key': apiKey }, timeout: API_TIMEOUT });
      this.teamHint = true;
      logWithTime('团队服务器连接成功');
      return true;
    } catch (error) {
      this.teamHint = false;
      logWithTime(`团队服务器连接失败: ${error}`);
      return false;
    }
  }

  static async ping(active?: boolean): Promise<boolean> {
    const { url, apiKey } = this.getConfig();
    if (!url || !apiKey) return false;
    try {
      logWithTime(`Ping platform: active=${typeof active === 'undefined' ? 'true' : String(active)}`);
      await axios.post(`${url}/api/ping`, { active, client_token: apiKey }, { headers: { 'X-Api-Key': apiKey }, timeout: API_TIMEOUT });
      if (!this.teamHint && active !== false) this.teamHint = true;
      return true;
    } catch {
      return false;
    }
  }
}

// ==================== Ping 管理器 ====================
export class PingManager {
  private interval: NodeJS.Timeout | null = null;
  
  start() {
    this.stop();
    this.interval = setInterval(() => TeamServerClient.ping(), 60000);
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
