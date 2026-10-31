import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CatalogState, emptyCatalog } from '@cloudnest/domain';

export interface CatalogRepository {
  read<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T>;
  transaction<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T>;
}

/** Local feasibility repository only. Production must bind a PostgreSQL repository. */
export class DemoCatalogRepository implements CatalogRepository {
  private state = emptyCatalog();
  private serial: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8')) as CatalogState;
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.folders) || !Array.isArray(parsed.transfers)) throw new Error('Unsupported local catalog schema.');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async read<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T> {
    await this.serial;
    return callback(structuredClone(this.state));
  }

  async transaction<T>(callback: (state: CatalogState) => T | Promise<T>): Promise<T> {
    const result = this.serial.then(async () => {
      const copy = structuredClone(this.state);
      const value = await callback(copy);
      const temporary = join(this.directory, 'catalog.next.json');
      await writeFile(temporary, JSON.stringify(copy), { mode: 0o600 });
      await rename(temporary, join(this.directory, 'catalog.json'));
      this.state = copy;
      return value;
    });
    this.serial = result.then(() => {}, () => {});
    return result;
  }
}
