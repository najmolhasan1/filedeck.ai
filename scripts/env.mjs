import { readFile } from 'node:fs/promises';

/** Configuration only: shell substitutions and commands are never evaluated. */
export function parseEnv(source) {
  const result = {};
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error('The environment file contains an invalid assignment.');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

export async function readEnv(path) {
  try { return parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
