import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config';

/**
 * Integration credentials are encrypted at rest with AES-256-GCM. The key comes from PULSE_SECRET,
 * or is generated once into data/secret.key (chmod 600) next to the database.
 */
function key(): Buffer {
  const env = process.env.PULSE_SECRET?.trim();
  if (env) return createHash('sha256').update(env).digest();
  const file = join(dirname(config.dbPath), 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
}
let cached: Buffer | null = null;
const k = () => (cached ??= key());

export function encrypt(obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    const [, iv, tag, data] = s.split(':');
    const d = createDecipheriv('aes-256-gcm', k(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}
