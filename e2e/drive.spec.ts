import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('originals survive reload, organization, trash, and restore with byte equality',async({page})=>{
  const original=Buffer.from('An original file. বাংলা লেখা.\nDo not alter these bytes.\n');
  await page.goto('/');
  await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.getByRole('button',{name:'New folder',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Name',{exact:true}).fill('A place to remember');
  await page.getByRole('button',{name:'Create folder',exact:true}).click();
  await page.locator('.folder-open').filter({hasText:'A place to remember'}).click();
  await page.locator('input[type=file]').setInputFiles({name:'original-notes.txt',mimeType:'text/plain',buffer:original});
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.reload();
  await page.locator('.folder-open').filter({hasText:'A place to remember'}).click();
  await expect(page.locator('.file-name strong')).toHaveText('original-notes.txt');
  await page.getByRole('button',{name:'Actions for original-notes.txt',exact:true}).click();
  await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Name',{exact:true}).fill('Keep this original.txt');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.locator('.file-name').click();
  await expect(page.getByRole('dialog')).toContainText('original-notes.txt');
  await page.getByLabel('Tags',{exact:true}).fill('important');
  await page.getByLabel('Tags',{exact:true}).press('Enter');
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download original',exact:true}).click();
  const downloaded=await downloadPromise;
  expect(await readFile((await downloaded.path())!)).toEqual(original);
  expect(downloaded.suggestedFilename()).toBe('Keep this original.txt');
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('button',{name:'Actions for Keep this original.txt',exact:true}).click();
  await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
  await expect(page.locator('.file-card')).toHaveCount(0);
  await page.locator('nav').getByRole('button',{name:/^Trash/}).click();
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Actions for Keep this original.txt',exact:true}).click();
  await page.getByRole('menuitem',{name:'Restore to drive',exact:true}).click();
  await expect(page.locator('.file-card')).toHaveCount(0);
  await page.locator('nav').getByRole('button',{name:/^My drive/}).click();
  await page.getByRole('textbox',{name:'Search files and tags'}).fill('important');
  await expect(page.locator('.file-name strong')).toHaveText('Keep this original.txt');
});

test('bulk operations in list view and metadata export remain usable',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.getByRole('button',{name:'List view',exact:true}).click();
  await page.getByRole('checkbox',{name:'Select A quiet afternoon.jpg',exact:true}).check();
  await page.getByRole('checkbox',{name:'Select Project brief.pdf',exact:true}).check();
  await page.locator('.selection-bar').getByRole('button',{name:'Move',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Destination folder').selectOption('documents');
  await page.getByRole('button',{name:'Move files',exact:true}).click();
  await page.locator('.folder-open').filter({hasText:'Documents'}).click();
  await expect(page.locator('.file-card')).toHaveCount(3);
  await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
  const promise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export catalog',exact:true}).click();
  const downloaded=await promise;
  const catalog=JSON.parse(await readFile((await downloaded.path())!,'utf8'));
  expect(catalog.storage).toBe('browser-demo');
  expect(catalog.files.filter((file:{folderId:string})=>file.folderId==='documents')).toHaveLength(3);
});

test('mobile navigation, Bangla, and unsafe content fallback work without overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.locator('.sidebar-upload')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'Open navigation'}).click();
  await page.locator('nav').getByRole('button',{name:'Photos',exact:true}).click();
  await expect(page.locator('.file-card')).toHaveCount(4);
  await page.locator('.locale-button').click();
  await expect(page.locator('h1')).toContainText('ছবি');
  await page.reload();
  await expect(page.locator('.locale-button')).toContainText('English');
  await page.locator('.locale-button').click();
  await page.locator('input[type=file]').setInputFiles({name:'untrusted.html',mimeType:'text/html',buffer:Buffer.from('<script>window.__executed=true</script>')});
  await expect(page.locator('.file-name').filter({hasText:'untrusted.html'})).toBeVisible();
  await page.locator('.file-name').filter({hasText:'untrusted.html'}).click();
  await expect(page.locator('.preview-fallback')).toBeVisible();
  expect(await page.evaluate(()=>Object.prototype.hasOwnProperty.call(window,'__executed'))).toBe(false);
  expect(await page.getByRole('dialog').locator('iframe').count()).toBe(0);
});

test('an interrupted original write never becomes a saved file',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.evaluate(()=>{
    const originalPut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args: Parameters<IDBObjectStore['put']>) {
      if(this.name==='originals') {
        IDBObjectStore.prototype.put=originalPut;
        this.transaction.abort();
        throw new DOMException('Simulated storage failure','QuotaExceededError');
      }
      return originalPut.apply(this,args);
    };
  });
  await page.locator('input[type=file]').setInputFiles({name:'must-not-appear.txt',mimeType:'text/plain',buffer:Buffer.from('An interrupted original')});
  await expect(page.locator('.toast')).toContainText('could not be saved');
  await expect(page.locator('.file-card')).toHaveCount(8);
  await page.locator('nav').getByRole('button',{name:'Transfers',exact:true}).click();
  await expect(page.locator('.transfer-status.failed')).toContainText('Needs attention');
  await page.reload();
  await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await expect(page.locator('.file-card')).toHaveCount(8);
  await expect(page.locator('.file-name').filter({hasText:'must-not-appear.txt'})).toHaveCount(0);
});

test('reusing a duplicate keeps its original after the first catalog copy is removed',async({page})=>{
  const bytes=Buffer.from('One verified original, organized twice.\n');
  await page.goto('/');await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.locator('input[type=file][multiple]').setInputFiles({name:'first-copy.txt',mimeType:'text/plain',buffer:bytes});
  await expect(page.locator('.file-name').filter({hasText:'first-copy.txt'})).toBeVisible();
  await page.locator('input[type=file][multiple]').setInputFiles({name:'second-copy.txt',mimeType:'text/plain',buffer:bytes});
  await expect(page.getByRole('dialog',{name:'You already have this original',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Reuse existing original',exact:true}).click();
  await expect(page.locator('.file-name').filter({hasText:'second-copy.txt'})).toBeVisible();
  await page.getByRole('button',{name:'Actions for first-copy.txt',exact:true}).click();
  await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
  await page.locator('nav').getByRole('button',{name:/^Trash/}).click();
  await page.getByRole('button',{name:'Actions for first-copy.txt',exact:true}).click();
  await page.getByRole('menuitem',{name:'Remove from app',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove from app',exact:true}).click();
  await expect(page.locator('.file-card')).toHaveCount(0);
  await page.reload();await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.getByRole('button',{name:'Actions for second-copy.txt',exact:true}).click();
  const promised=page.waitForEvent('download');
  await page.getByRole('menuitem',{name:'Download original',exact:true}).click();
  const downloaded=await promised;expect(await readFile((await downloaded.path())!)).toEqual(bytes);
});

test('catalog metadata restore preserves originals already held in the browser',async({page})=>{
  await page.goto('/');await expect(page.locator('.sidebar-upload')).toBeEnabled();
  await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
  const promised=page.waitForEvent('download');await page.getByRole('button',{name:'Export catalog',exact:true}).click();
  const exported=await promised;const catalog=JSON.parse(await readFile((await exported.path())!,'utf8'));
  catalog.files[0].name='Restored organization.jpg';
  await page.getByLabel('Import catalog JSON',{exact:true}).setInputFiles({name:'catalog.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(catalog))});
  await page.getByRole('dialog',{name:'Restore your organization?',exact:true}).getByRole('button',{name:'Import metadata',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Restore your organization?',exact:true})).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('textbox',{name:'Search files and tags'}).fill('Restored organization');
  await expect(page.locator('.file-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Actions for Restored organization.jpg',exact:true}).click();
  const originalPromise=page.waitForEvent('download');await page.getByRole('menuitem',{name:'Download original',exact:true}).click();
  const original=await originalPromise;expect(await readFile((await original.path())!)).toEqual(await readFile('apps/web/public/images/coast.jpg'));
});
