#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readEnv } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'up';
const withWeb = process.argv.includes('--web');
if (!['up', 'setup', 'down', 'status', 'logs'].includes(command)) {
  console.error('Usage: node scripts/dev-stack.mjs [up|setup|down|status|logs] [--web]');
  process.exit(2);
}
if (['up', 'setup'].includes(command) && process.getuid?.() === 0) {
  console.error('Run stack setup as a non-root user with Docker access so mounted account data and services retain that user’s ownership.');
  process.exit(2);
}

function run(args, environment) {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, { cwd: root, env: environment, stdio: 'inherit' });
    child.on('error', () => reject(new Error('Docker could not start. Install Docker with Compose and start its daemon.')));
    child.on('exit', code => code === 0 ? accept() : reject(new Error('Docker Compose failed. Inspect service status/logs; this script does not print secrets.')));
  });
}

try {
  const envPath = join(root, '.env');
  let local = await readEnv(envPath);
  if (Object.keys(local).length === 0) {
    let template = await readFile(join(root, '.env.example'), 'utf8');
    const replacements = {
      POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
      POSTGRES_APP_PASSWORD: randomBytes(32).toString('hex'),
      CLOUDNEST_WORKER_TOKEN: randomBytes(32).toString('hex'),
      CLOUDNEST_COOKIE_SECRET: randomBytes(32).toString('hex'),
      CLOUDNEST_UID: String(process.getuid?.() ?? 1000),
      CLOUDNEST_GID: String(process.getgid?.() ?? 1000),
      CLOUDNEST_STAGING_HOST_DIR: join(root, '.data', 'staging'),
      CLOUDNEST_SESSION_HOST_DIR: join(root, '.data', 'tdlib')
    };
    replacements.DATABASE_ADMIN_URL = `postgresql://cloudnest:${replacements.POSTGRES_PASSWORD}@127.0.0.1:${process.env.POSTGRES_PORT || 5432}/cloudnest`;
    replacements.DATABASE_URL = `postgresql://cloudnest_app:${replacements.POSTGRES_APP_PASSWORD}@127.0.0.1:${process.env.POSTGRES_PORT || 5432}/cloudnest`;
    replacements.AUTH_DATABASE_URL = replacements.DATABASE_URL;
    replacements.STAGING_ROOT = replacements.CLOUDNEST_STAGING_HOST_DIR;
    replacements.TDLIB_STATE_DIR = replacements.CLOUDNEST_SESSION_HOST_DIR;
    for (const [name, value] of Object.entries(replacements)) {
      const pattern = new RegExp(`^${name}=.*$`, 'mu');
      template = pattern.test(template) ? template.replace(pattern, `${name}=${value}`) : `${template}\n${name}=${value}\n`;
    }
    await writeFile(envPath, template, { flag: 'wx', mode: 0o600 });
    local = await readEnv(envPath);
    console.log('Created private .env with random local DB/RPC/cookie secrets. Telegram remains disabled.');
  }
  await chmod(envPath, 0o600);
  const environment = { ...local, ...process.env };
  if (environment.CLOUDNEST_UID && (!/^\d+$/u.test(environment.CLOUDNEST_UID) || Number(environment.CLOUDNEST_UID) === 0)) {
    throw new Error('CLOUDNEST_UID must identify a non-root service user.');
  }
  for (const name of ['POSTGRES_PASSWORD', 'POSTGRES_APP_PASSWORD', 'CLOUDNEST_WORKER_TOKEN', 'CLOUDNEST_COOKIE_SECRET']) {
    const value = environment[name];
    if (!value || !/^[A-Za-z0-9_-]{32,}$/u.test(value) || /replace|placeholder|change-me/iu.test(value)) {
      throw new Error(`${name} needs a unique value of at least 32 letters, digits, _ or - in .env. Existing configuration was preserved.`);
    }
  }
  for (const name of ['CLOUDNEST_STAGING_HOST_DIR', 'CLOUDNEST_SESSION_HOST_DIR']) {
    const target = environment[name] || join(root, '.data', name.includes('STAGING') ? 'staging' : 'tdlib');
    environment[name] = isAbsolute(target) ? target : resolve(root, target);
    await mkdir(environment[name], { recursive: true, mode: 0o700 });
  }
  if (!environment.CLOUDNEST_BUILD_CA_FILE) {
    const candidates = [environment.CODEX_PROXY_CERT, '/etc/ssl/certs/ca-certificates.crt'].filter(Boolean);
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) { environment.CLOUDNEST_BUILD_CA_FILE = candidate; break; } } catch {}
    }
    if (!environment.CLOUDNEST_BUILD_CA_FILE) {
      const emptyCA = join(root, '.data', 'optional-build-ca.pem');
      await mkdir(dirname(emptyCA), { recursive: true, mode: 0o700 });
      await writeFile(emptyCA, '', { mode: 0o600 });
      environment.CLOUDNEST_BUILD_CA_FILE = emptyCA;
    }
  }
  if (command === 'setup') { console.log('Environment/data directories prepared. No service was started.'); process.exit(0); }
  const base = ['compose', '--env-file', envPath, '-f', join(root, 'infra', 'compose.yaml')];
  if (withWeb) base.push('--profile', 'web');
  if (command === 'up') {
    await run([...base, 'up', '--build', '--wait', '--wait-timeout', '120', ...(withWeb ? [] : ['postgres', 'redis', 'migrate', 'worker', 'api'])], environment);
    await run([...base, 'ps'], environment);
    console.log(`API health: http://localhost:${environment.API_PORT || 4000}/v1/health`);
    if (withWeb) console.log(`Drive: http://localhost:${environment.WEB_PORT || 3000}`);
    console.log('Telegram requires credentials and operator-approved encrypted session storage before RPC can connect.');
  } else if (command === 'down') {
    await run([...base, '--profile', 'web', 'down'], environment);
    console.log('Services stopped. Database volumes and originals retained.');
  } else if (command === 'status') await run([...base, 'ps', '--all'], environment);
  else await run([...base, 'logs', '--tail', '100'], environment);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The development stack could not be prepared.');
  process.exitCode = 1;
}
