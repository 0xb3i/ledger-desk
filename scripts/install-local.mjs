import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const label = 'local.qingji.dashboard';
const host = '127.0.0.1';
const port = 43927;
const origin = `http://${host}:${port}`;
const appSupportDir = join(homedir(), 'Library/Application Support/Qingji');
const dataDir = join(appSupportDir, 'data');
const releasesDir = join(appSupportDir, 'releases');
const logsDir = join(appSupportDir, 'logs');
const currentLink = join(appSupportDir, 'current');
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const appPath = join(homedir(), 'Applications/轻记.app');
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;

function xml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function command(file, args, timeout = 30_000) {
  return execute(file, args, { cwd: projectRoot, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
}

async function serviceLoaded(timeout = 30_000) {
  try {
    await command('/bin/launchctl', ['print', service], timeout);
    return true;
  } catch (error) {
    if (error.code === 113 && error.stderr?.includes(`Could not find service "${label}"`)) return false;
    throw error;
  }
}

async function waitForServiceRemoval() {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (!await serviceLoaded(Math.max(1, Math.ceil(deadline - performance.now())))) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
  throw new Error('等待轻记旧服务退出超过 30 秒，未更改启动配置。请稍后重跑安装。');
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`安装目录必须是普通目录：${path}`);
  await chmod(path, 0o700);
}

async function atomicWrite(path, value, mode = 0o600) {
  const previous = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (await exists(path)) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝覆盖非普通文件：${path}`);
  }
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    const latest = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous === null ? latest !== null : latest === null || !previous.equals(latest)) throw new Error(`文件在安装期间已被修改，未覆盖：${path}`);
    await rename(temporary, path);
    await chmod(path, mode);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function payloadFiles(directory, root = directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await payloadFiles(path, root));
    else if (entry.isFile()) result.push({ path, relative: relative(root, path) });
    else throw new Error(`构建产物不允许符号链接或特殊文件：${path}`);
  }
  return result;
}

function supportedNode(version) {
  const major = Number(version.split('.')[0]);
  return major === 24 || major >= 26;
}

async function nodeRuntime() {
  let path = process.execPath;
  if (!supportedNode(process.versions.node)) {
    console.log('正在取得 Node.js 24 运行时，仅安装时需要下载。');
    const result = await command('npm', ['exec', '--yes', '--package=node@24', '--', 'node', '-p', 'process.execPath'], 180_000);
    const candidates = result.stdout.trim().split('\n').filter(isAbsolute);
    if (candidates.length !== 1) throw new Error('无法确认 Node.js 24 运行时的真实路径。');
    path = candidates[0];
  }
  path = await realpath(path);
  const { stdout } = await command(path, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})']);
  const runtime = JSON.parse(stdout);
  if (!supportedNode(runtime.version) || runtime.platform !== 'darwin' || runtime.arch !== process.arch) throw new Error('Node.js 运行时版本或架构与本机不匹配。');
  return { path, ...runtime };
}

function launchAgent(release) {
  const values = {
    Label: label,
    WorkingDirectory: release,
    StandardOutPath: join(logsDir, 'service.log'),
    StandardErrorPath: join(logsDir, 'service-error.log'),
  };
  const environment = {
    NODE_ENV: 'production',
    QINGJI_HOST: host,
    QINGJI_PORT: String(port),
    QINGJI_DATA_DIR: dataDir,
    QINGJI_STATIC_DIR: join(release, 'dist'),
    QINGJI_MIGRATIONS_DIR: join(release, 'migrations'),
    PATH: `${join(release, 'runtime')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const pairs = object => Object.entries(object).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${pairs(values)}
<key>ProgramArguments</key><array><string>${xml(join(release, 'runtime/node'))}</string><string>${xml(join(release, 'dist-local/server.mjs'))}</string></array>
<key>EnvironmentVariables</key><dict>${pairs(environment)}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function launcher(version) {
  return `import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const service = ${JSON.stringify(service)}, domain = ${JSON.stringify(domain)}, plist = ${JSON.stringify(plistPath)};
const origin = ${JSON.stringify(origin)}, version = ${JSON.stringify(version)};
try {
  await execute('/bin/launchctl', ['enable', service]);
  try { await execute('/bin/launchctl', ['print', service]); }
  catch { await execute('/bin/launchctl', ['bootstrap', domain, plist]); }
  await execute('/bin/launchctl', ['kickstart', service]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.data?.status === 'ok' && body.data?.version === version) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('not-ready');
  await execute('/usr/bin/open', [origin + '/local/open']);
} catch {
  await execute('/usr/bin/osascript', ['-e', 'display alert "轻记未能启动" message "请查看 ~/Library/Application Support/Qingji/logs 中的服务日志，修复后重新打开轻记。" as critical']).catch(() => {});
  process.exitCode = 1;
}
`;
}

async function acquireLock() {
  const path = join(appSupportDir, '.install.lock');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('安装锁内容无效，请先确认没有安装进程。');
    try { process.kill(pid, 0); } catch (status) {
      if (status.code === 'ESRCH') { await unlink(path); return acquireLock(); }
      throw status;
    }
    throw new Error('另一个轻记安装进程正在运行。');
  }
  return () => unlink(path);
}

async function waitHealthy(version) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.data?.status === 'ok' && body.data?.version === version) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`轻记已安装但健康检查未通过。数据已保留，请查看 ${logsDir}，修复后重跑安装；不会自动回退数据库迁移。`);
}

async function install() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--open'].includes(arg))) throw new Error('用法：node scripts/install-local.mjs [--dry-run] [--open]');
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('当前安装器适用于 Apple Silicon 或 Intel Mac。');
  if (process.getuid() === 0) throw new Error('请以当前登录用户安装，不要使用 sudo。');
  process.umask(0o077);
  const { version } = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json 版本格式无效。');
  const appIcon = join(projectRoot, 'assets/AppIcon.icns');
  if ((await readFile(appIcon)).subarray(0, 4).toString('ascii') !== 'icns') throw new Error('轻记应用图标格式无效。');
  await readFile(join(projectRoot, 'dist/index.html'));
  await readFile(join(projectRoot, 'dist-local/server.mjs'));
  const payload = [];
  for (const folder of ['dist', 'dist-local', 'migrations']) {
    for (const file of await payloadFiles(join(projectRoot, folder))) payload.push({ ...file, target: join(folder, file.relative) });
  }
  if (!payload.some(file => /^migrations\/\d{4}_.+\.sql$/.test(file.target))) throw new Error('构建产物缺少数据库迁移。');
  const runtime = await nodeRuntime();
  await command(runtime.path, ['--check', join(projectRoot, 'dist-local/server.mjs')]);
  const hash = createHash('sha256').update(version).update(runtime.version).update(runtime.arch);
  for (const file of payload) hash.update(file.target).update(await readFile(file.path));
  hash.update(launcher(version));
  const releaseId = `${version}-${hash.digest('hex').slice(0,16)}`;
  const release = join(releasesDir, releaseId);
  const plan = { application: appPath, dataDirectory: dataDir, release, runtime: `Node.js ${runtime.version}`, address: `${origin}/local/open` };
  if (args.includes('--dry-run')) { console.log('安装预检通过，未更改应用、服务或数据。'); console.log(JSON.stringify(plan, null, 2)); return; }
  await privateDirectory(appSupportDir);
  await privateDirectory(dataDir);
  const unlock = await acquireLock();
  const staging = join(releasesDir, `.install-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await privateDirectory(releasesDir);
    await privateDirectory(logsDir);
    const launchAgentsDir = dirname(plistPath);
    await mkdir(launchAgentsDir, { recursive: true });
    const launchAgentsInfo = await lstat(launchAgentsDir);
    if (!launchAgentsInfo.isDirectory() || launchAgentsInfo.isSymbolicLink()) throw new Error('LaunchAgents 必须是普通目录。');
    await mkdir(dirname(appPath), { recursive: true });
    const appInfo = join(appPath, 'Contents/Info.plist');
    if (await exists(appPath)) {
      const info = await lstat(appPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('已有“轻记.app”不是普通应用目录，未覆盖。');
      const identifier = await command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', appInfo]).catch(() => null);
      if (identifier?.stdout.trim() !== label) throw new Error('已有“轻记.app”不属于此项目，未覆盖。');
    }
    if (await exists(plistPath)) {
      const identifier = await command('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', plistPath]);
      if (identifier.stdout.trim() !== label) throw new Error('已有启动配置不属于此项目，未覆盖。');
    }
    let previousRelease = null;
    if (await exists(currentLink)) {
      if (!(await lstat(currentLink)).isSymbolicLink()) throw new Error('current 必须是安装器管理的符号链接。');
      previousRelease = resolve(appSupportDir, await readlink(currentLink));
      if (dirname(previousRelease) !== releasesDir) throw new Error('已有 current 指向应用目录之外，未修改。');
    }
    if (!await exists(release)) {
      await privateDirectory(staging);
      for (const file of payload) {
        const destination = join(staging, file.target);
        await privateDirectory(dirname(destination));
        await copyFile(file.path, destination);
        await chmod(destination, 0o600);
      }
      await privateDirectory(join(staging, 'runtime'));
      await copyFile(runtime.path, join(staging, 'runtime/node'));
      await chmod(join(staging, 'runtime/node'), 0o700);
      await atomicWrite(join(staging, 'launch.mjs'), launcher(version));
      await atomicWrite(join(staging, 'manifest.json'), JSON.stringify({ application: label, releaseId, version, node: runtime.version, arch: runtime.arch }, null, 2));
      await command(join(staging, 'runtime/node'), ['--check', join(staging, 'dist-local/server.mjs')]);
      await rename(staging, release);
    } else {
      const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
      if (manifest.application !== label || manifest.releaseId !== releaseId) throw new Error('已有发布目录不属于本次构建。');
    }
    for (const filename of ['service.log', 'service-error.log']) {
      const path = join(logsDir, filename);
      if (await exists(path)) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('日志路径必须是普通文件。');
      }
      const file = await open(path, 'a', 0o600);
      await file.close();
      await chmod(path, 0o600);
    }
    const plistTemporary = join(staging + '.plist');
    await atomicWrite(plistTemporary, launchAgent(release));
    try { await command('/usr/bin/plutil', ['-lint', plistTemporary]); }
    finally { await unlink(plistTemporary); }
    await privateDirectory(join(appPath, 'Contents/MacOS'));
    // 应用图标：源文件 assets/app-icon.svg，AppIcon.icns 由它生成
    await privateDirectory(join(appPath, 'Contents/Resources'));
    await copyFile(appIcon, join(appPath, 'Contents/Resources/AppIcon.icns'));
    await atomicWrite(appInfo, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${label}</string><key>CFBundleName</key><string>轻记</string><key>CFBundleDisplayName</key><string>轻记</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleExecutable</key><string>qingji</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${xml(version)}</string><key>CFBundleVersion</key><string>${xml(version)}</string><key>LSUIElement</key><true/></dict></plist>\n`);
    await atomicWrite(join(appPath, 'Contents/MacOS/qingji'), `#!/bin/sh\nexec ${shellQuote(join(currentLink, 'runtime/node'))} ${shellQuote(join(currentLink, 'launch.mjs'))}\n`, 0o700);
    if (await serviceLoaded()) {
      await command('/bin/launchctl', ['bootout', service]);
      // bootout may return while launchd is still removing the old job.
      await waitForServiceRemoval();
    }
    await atomicWrite(plistPath, launchAgent(release));
    const nextLink = join(appSupportDir, `.current-${process.pid}`);
    await symlink(relative(appSupportDir, release), nextLink);
    await rename(nextLink, currentLink);
    await command('/bin/launchctl', ['enable', service]);
    await command('/bin/launchctl', ['bootstrap', domain, plistPath]);
    await waitHealthy(version);
    // Keep the previous build for diagnosis; never touch database or integration files.
    for (const entry of await readdir(releasesDir, { withFileTypes: true })) {
      const path = join(releasesDir, entry.name);
      if (!entry.isDirectory() || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(entry.name) || [release, previousRelease].includes(path)) continue;
      const manifest = await readFile(join(path, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.application === label && manifest.releaseId === entry.name) await rm(path, { recursive: true });
    }
    console.log(`轻记已安装：${appPath}\n本地数据：${dataDir}\n双击“轻记”即可打开看板。`);
    if (args.includes('--open')) await command('/usr/bin/open', [appPath]);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await unlock();
  }
}

install().catch(error => {
  console.error(`安装未完成：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
});
