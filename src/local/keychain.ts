import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SERVICE_NAME = 'local.qingji.dashboard.qqmail';
const SECURITY_BIN = '/usr/bin/security';

export interface MailSecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

function assertSafeAccount(account: string): string {
  const clean = account.trim().toLowerCase();
  if (!clean || /[\r\n\0"\\]/.test(clean) || clean.length > 200) {
    throw new Error('邮箱地址格式无效。');
  }
  return clean;
}

function assertSafeSecret(secret: string): string {
  const clean = secret.trim();
  if (!clean || /[\r\n\0]/.test(clean) || clean.length > 256) {
    throw new Error('授权码格式无效。');
  }
  return clean;
}

function quoteSecurityArg(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * macOS Keychain secret store backed by `/usr/bin/security`.
 * Writes via `security -i` stdin so the auth code never appears in process argv.
 */
export function createMacOsKeychainStore(service = SERVICE_NAME): MailSecretStore {
  return {
    async get(account: string): Promise<string | null> {
      const cleanAccount = assertSafeAccount(account);
      try {
        const { stdout } = await execute(SECURITY_BIN, [
          'find-generic-password', '-s', service, '-a', cleanAccount, '-w',
        ], { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
        const value = stdout.replace(/\r?\n$/, '');
        return value || null;
      } catch (error) {
        const err = error as { code?: number | string; stderr?: string };
        if (err.code === 44 || err.stderr?.includes('could not be found')) return null;
        throw new Error('无法从系统钥匙串读取邮箱授权码，请检查钥匙串访问权限。');
      }
    },

    async set(account: string, secret: string): Promise<void> {
      const cleanAccount = assertSafeAccount(account);
      const cleanSecret = assertSafeSecret(secret);
      const hexSecret = Buffer.from(cleanSecret, 'utf8').toString('hex');
      const command = `add-generic-password -U -s ${quoteSecurityArg(service)} -a ${quoteSecurityArg(cleanAccount)} -X ${hexSecret} -T ${quoteSecurityArg(SECURITY_BIN)}\n`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(SECURITY_BIN, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('写入系统钥匙串超时，请重试。'));
        }, 10_000);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('无法调用 macOS 系统钥匙串工具。'));
        });
        child.on('close', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(stderr.includes('denied') ? '系统钥匙串拒绝写入，请在弹窗中允许访问。' : '无法将邮箱授权码保存到系统钥匙串。'));
        });
        child.stdin.end(command, 'utf8');
      });
    },

    async delete(account: string): Promise<void> {
      const cleanAccount = assertSafeAccount(account);
      try {
        await execute(SECURITY_BIN, [
          'delete-generic-password', '-s', service, '-a', cleanAccount,
        ], { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      } catch (error) {
        const err = error as { code?: number | string; stderr?: string };
        if (err.code === 44 || err.stderr?.includes('could not be found')) return;
        throw new Error('无法从系统钥匙串移除旧的邮箱授权码。');
      }
    },
  };
}
