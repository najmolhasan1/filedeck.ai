import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolder } from '@cloudnest/domain';
import { DemoCatalogRepository } from '../src/repository.js';

test('demo catalog persists across restart and rolls back failed transactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudnest-repository-'));
  try {
    const repository = new DemoCatalogRepository(directory); await repository.initialize();
    await repository.transaction(state => createFolder(state, 'user-a', { name: 'Persisted' }));
    await assert.rejects(repository.transaction(state => { createFolder(state, 'user-a', { name: 'Rolled back' }); throw new Error('intentional failure'); }));
    const restarted = new DemoCatalogRepository(directory); await restarted.initialize();
    assert.equal(await restarted.read(state => state.folders.length), 1);
    assert.equal(await restarted.read(state => state.folders[0].name), 'Persisted');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('demo transaction serialization prevents duplicate names under concurrent creates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudnest-concurrent-'));
  try {
    const repository = new DemoCatalogRepository(directory); await repository.initialize();
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => repository.transaction(state => createFolder(state, 'user-a', { name: 'Same name' }))));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(await repository.read(state => state.folders.length), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
