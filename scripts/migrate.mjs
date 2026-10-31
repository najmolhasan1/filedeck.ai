#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readEnv } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = { ...await readEnv(join(root, '.env')), ...process.env };
const role = environment.POSTGRES_APP_USER || 'cloudnest_app';
const password = environment.POSTGRES_APP_PASSWORD;
const bootstrapRole = !process.argv.includes('--no-role-bootstrap');
if (!environment.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required for migrations; never supply it to the HTTP API.');
if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw new Error('POSTGRES_APP_USER must be a simple lowercase role name.');
if (bootstrapRole && (!password || password.length < 32 || /replace|placeholder/iu.test(password))) throw new Error('POSTGRES_APP_PASSWORD needs a unique secret of at least 32 characters.');

const client = new pg.Client({ connectionString: environment.DATABASE_ADMIN_URL, application_name: 'cloudnest-migrations', connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  const owner = await client.query('SELECT rolsuper OR rolbypassrls AS can_migrate FROM pg_roles WHERE rolname=current_user');
  if (!owner.rows[0]?.can_migrate) throw new Error('Migration owner must bypass forced RLS; the application role must not.');
  await client.query("SELECT pg_advisory_lock(hashtextextended('cloudnest-schema-migrations',0))");
  await client.query('CREATE TABLE IF NOT EXISTS cloudnest_schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = join(root, 'infra', 'migrations');
  for (const name of (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/u.test(name)).sort()) {
    const source = await readFile(join(directory, name), 'utf8');
    const digest = createHash('sha256').update(source).digest('hex');
    const previous = await client.query('SELECT sha256 FROM cloudnest_schema_migrations WHERE name=$1', [name]);
    if (previous.rows[0]) {
      if (previous.rows[0].sha256 !== digest) throw new Error(`Applied migration ${name} changed; restore it and add a new migration.`);
      console.log(`Already applied ${name}`);
      continue;
    }
    // These trusted schema files have standalone BEGIN;/COMMIT; wrappers. The
    // runner makes schema changes + history atomic under one transaction.
    const body = source.replace(/^\s*(?:BEGIN|COMMIT)\s*;\s*$/gmi, '');
    await client.query('BEGIN');
    try {
      await client.query(body);
      await client.query('INSERT INTO cloudnest_schema_migrations(name,sha256) VALUES($1,$2)', [name, digest]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  if (bootstrapRole) {
    const identifier = pg.escapeIdentifier(role);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (exists.rowCount) {
      const unsafe = await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname=$1 UNION ALL SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=$1 LIMIT 1', [role]);
      if (unsafe.rowCount) throw new Error('Runtime role has existing memberships or table ownership; use a dedicated unprivileged role.');
    }
    if (!exists.rowCount) await client.query(`CREATE ROLE ${identifier}`);
    await client.query(`ALTER ROLE ${identifier} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
    const database = await client.query('SELECT current_database() AS name');
    await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database.rows[0].name)} TO ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${identifier}`);
    const tables = [
      'users','devices','product_sessions','telegram_sessions','storage_chats','folders','files','tags','file_tags',
      'transfers','uploads','upload_chunks','backup_sources','backup_items','sync_checkpoints','catalog_tombstones',
      'idempotency_keys','outbox_events','audit_events','session_refresh_history','login_transactions','sync_jobs','pending_revocations'
    ];
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.map(name => `public.${pg.escapeIdentifier(name)}`).join(',')} TO ${identifier}`);
    for (const signature of ['cloudnest_upsert_verified_user(bigint,text)','cloudnest_connected_accounts()','cloudnest_check_rate_limit(text,integer,integer)','cloudnest_runnable_sync_jobs(integer)','cloudnest_pending_revocations(integer)']) {
      await client.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${identifier}`);
    }
    console.log('Runtime role prepared: scoped CRUD, bounded auth functions, no superuser/ownership/BYPASSRLS.');
  }
} catch (error) {
  // Database connection errors may contain connection metadata. Never print
  // server detail, statement text, URL, password, or a complete error object.
  const code = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/u.test(error.code) ? ` (${error.code})` : '';
  const safe = error instanceof Error && /^(Migration owner|Applied migration|Runtime role)/u.test(error.message) ? ` ${error.message}` : '';
  console.error(`Database migration/bootstrap failed${code}.${safe}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
