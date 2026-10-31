/** Provider simulation stays in tests; the browser and API use the real PostgreSQL transport. */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../../apps/api/src/app.js';
import { startProviderFixture, workerToken } from '../fixtures/provider.js';

test.describe('connected drive with a test-only provider and actual database',()=>{
  test.skip(!process.env.TEST_DATABASE_URL,'Set TEST_DATABASE_URL after applying the PostgreSQL migrations.');
  let application:Awaited<ReturnType<typeof createApi>>;
  let worker:Awaited<ReturnType<typeof startProviderFixture>>;
  let directory:string;
  const previous={...process.env};
  test.beforeAll(async()=>{
    worker=await startProviderFixture();directory=await mkdtemp(join(tmpdir(),'cloudnest-ui-'));
    Object.assign(process.env,{CLOUDNEST_API_ENABLE:'true',CLOUDNEST_DEMO:'0',DATABASE_URL:process.env.TEST_DATABASE_URL,AUTH_DATABASE_URL:process.env.TEST_DATABASE_URL,
      TELEGRAM_WORKER_URL:worker.url,CLOUDNEST_WORKER_TOKEN:workerToken,CLOUDNEST_COOKIE_SECRET:randomUUID()+randomUUID(),APP_ORIGIN:'http://localhost:3003',STAGING_ROOT:directory,CLOUDNEST_DISPATCH_AUTO:'false'});
    application=await createApi({logger:false});await application.app.listen(4100,'127.0.0.1');
  });
  test.afterAll(async()=>{
    if(application){application.app.getHttpServer().closeAllConnections();await application.app.close();}
    if(worker){worker.server.closeAllConnections();await new Promise<void>(resolve=>worker.server.close(()=>resolve()));}
    if(directory)await rm(directory,{recursive:true,force:true});
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
  });
  test('phone, code, 2FA, explicit storage, confirmed upload, organization and sign-out',async({page})=>{
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    const bytes=Buffer.from('Server-side original bytes. বাংলা লেখা.\n');
    await page.goto('/');
    await page.getByRole('button',{name:'Connect your account',exact:true}).click();
    await page.getByLabel('Phone number with country code').fill(`+880${Date.now().toString().slice(-8)}01`);
    await page.getByRole('checkbox',{name:'I understand the session access described above.'}).check();
    await page.getByRole('button',{name:'Continue with Telegram',exact:true}).click();
    await page.getByLabel('Verification code',{exact:true}).fill('12345');
    await page.getByRole('button',{name:'Verify and continue',exact:true}).click();
    await page.getByLabel('Two-step verification password',{exact:true}).fill('fixture-password');
    await page.getByRole('button',{name:'Verify and continue',exact:true}).click();
    await page.getByRole('button',{name:'Use Saved Messages',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.sidebar-upload')).toBeEnabled();
    await expect(page.locator('.demo-badge').first()).toContainText('Telegram connected');
    await page.getByRole('button',{name:'New folder',exact:true}).click();
    await page.getByRole('dialog').getByLabel('Name',{exact:true}).fill('Server workspace');
    await page.getByRole('button',{name:'Create folder',exact:true}).click();
    await page.locator('.folder-open').filter({hasText:'Server workspace'}).click();
    await page.locator('input[type=file][multiple]').setInputFiles({name:'server-original.txt',mimeType:'text/plain',buffer:bytes});
    const me=await page.evaluate(()=>fetch('/v1/me').then(response=>response.json()));
    await expect.poll(async()=>application.production!.repositoryFor(me.id).read(state=>state.transfers[0]?.state)).toBe('QUEUED');
    await expect(page.locator('.file-card')).toHaveCount(0);
    await application.production!.dispatcher.tick();
    expect(worker.sendCount).toBe(1);
    await expect(page.locator('.file-card')).toHaveCount(0);
    for(const operation of worker.operations.values())operation.confirmed=true;
    await application.production!.dispatcher.tick();
    await expect(page.locator('.file-name strong')).toHaveText('server-original.txt',{timeout:10000});
    await page.getByRole('button',{name:'Actions for server-original.txt',exact:true}).click();
    await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
    await page.getByRole('dialog').getByLabel('Name',{exact:true}).fill('Verified original.txt');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.locator('.file-name strong')).toHaveText('Verified original.txt');
    await page.getByRole('button',{name:'Actions for Verified original.txt',exact:true}).click();
    const promised=page.waitForEvent('download');
    await page.getByRole('menuitem',{name:'Download original',exact:true}).click();
    const downloaded=await promised;
    expect(await readFile((await downloaded.path())!)).toEqual(bytes);
    await page.reload();
    await expect(page.locator('.sidebar-upload')).toBeEnabled();
    await expect(page.locator('.file-name strong')).toHaveText('Verified original.txt');
    await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
    await page.getByRole('button',{name:'Sign out this device',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.file-card')).toHaveCount(0);
    await expect(page.locator('.sidebar-upload')).toBeDisabled();
    expect(errors).toEqual([]);
  });
});
