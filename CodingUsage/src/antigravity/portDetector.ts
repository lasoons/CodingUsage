import { exec } from 'child_process';
import { promisify } from 'util';
import { AntigravityProcessInfo } from './types';

const execAsync = promisify(exec);

export class PortDetector {
    private readonly processName = 'language_server_windows_x64.exe';

    async detectProcessInfo(): Promise<AntigravityProcessInfo | null> {
        try {
            // Use PowerShell to find the process and its command line
            const command = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${this.processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
            const { stdout } = await execAsync(command, { timeout: 10000 });

            if (!stdout.trim()) {
                return null;
            }

            let data = JSON.parse(stdout.trim());
            if (Array.isArray(data)) {
                // Filter for Antigravity-specific processes if multiple exist
                const antigravityProcesses = data.filter((item: any) =>
                    item.CommandLine && this.isAntigravityProcess(item.CommandLine)
                );
                if (antigravityProcesses.length === 0) return null;
                data = antigravityProcesses[0];
            } else if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) {
                return null;
            }

            const commandLine = data.CommandLine || '';
            const pid = data.ProcessId;

            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);

            if (!tokenMatch || !tokenMatch[1]) {
                return null;
            }

            const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
            const csrfToken = tokenMatch[1];

            // For Antigravity, the connectPort is often dynamically discovered but typically we can try standard ones
            // or we use the extension_server_port as fallback. 
            // In the original watcher, it tests listening ports. 
            // For simplicity in this integration, we'll try to find listening ports of the PID.
            const listeningPorts = await this.getProcessListeningPorts(pid);
            if (listeningPorts.length === 0) return null;

            // In the original, it probes. Here we'll just take the first one that is NOT the extension port if possible
            const connectPort = listeningPorts.find(p => p !== extensionPort) || listeningPorts[0];

            return { extensionPort, connectPort, csrfToken };
        } catch (error) {
            console.error('[AntigravityPortDetector] Error:', error);
            return null;
        }
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        return /--app_data_dir\s+antigravity\b/i.test(commandLine) ||
            lowerCmd.includes('\\antigravity\\') ||
            lowerCmd.includes('/antigravity/');
    }

    private async getProcessListeningPorts(pid: number): Promise<number[]> {
        try {
            const { stdout } = await execAsync(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`, { timeout: 3000 });
            const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING/gi;
            const ports: number[] = [];
            let match;

            while ((match = portRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
            return ports.sort((a, b) => a - b);
        } catch (error) {
            return [];
        }
    }
}
