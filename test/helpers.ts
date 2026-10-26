import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

export function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'psk-test-'));
  dirs.push(d);
  return d;
}

export const ROOT = path.resolve(import.meta.dirname, '..');
