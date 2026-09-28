import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { contains } from './core-validation';

export interface Fingerprint { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
export function fingerprint(stat: fs.Stats): Fingerprint { return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev }; }
export function matches(a: Fingerprint, b: Fingerprint): boolean { return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev; }
export function noLinksSync(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接或重解析点：${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function noLinks(target: string): Promise<void> {
  let current = path.resolve(target);
  for (;;) {
    try { if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error(`拒绝符号链接或重解析点：${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function hashFile(file: string, expected?: Fingerprint, signal?: AbortSignal): Promise<{ sha256: string; stat: Fingerprint }> {
  await noLinks(file);
  const before = await fsp.lstat(file);
  if (!before.isFile()) throw new Error(`不是普通文件：${file}`);
  const stat = fingerprint(before);
  if (expected && !matches(expected, stat)) throw new Error(`源文件在扫描后改变：${file}`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  const after = fingerprint(await fsp.lstat(file));
  if (!matches(stat, after)) throw new Error(`读取期间源文件改变：${file}`);
  return { sha256: hash.digest('hex'), stat };
}
export async function copyVerified(source: string, destination: string, expected: Fingerprint, sha256: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  await noLinks(source);
  if (!matches(expected, fingerprint(await fsp.lstat(source)))) throw new Error(`源文件在扫描后改变：${source}`);
  await noLinks(path.dirname(destination));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); progress(chunk.length); callback(null, chunk); } });
  await pipeline(fs.createReadStream(source), meter, fs.createWriteStream(destination, { flags: 'wx', flush: true }), { signal });
  if (!matches(expected, fingerprint(await fsp.lstat(source))) || hash.digest('hex') !== sha256) throw new Error(`复制时源文件改变或校验失败：${source}`);
  const copied = await hashFile(destination, undefined, signal);
  if (copied.sha256 !== sha256 || copied.stat.size !== expected.size) throw new Error(`目标副本校验失败：${destination}`);
}
/** Windows scanners/watchers can briefly hold directory handles after streams have closed. */
export async function publishDirectory(source: string, destination: string, signal: AbortSignal, verify: () => Promise<void>): Promise<void> {
  const backoff = [100, 200, 400, 800];
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    await noLinks(source);
    await noLinks(destination);
    try {
      await fsp.lstat(destination);
      throw new Error('导入目标目录已存在');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // The backoff can outlast a third-party write; never publish on an outdated verification.
    await verify();
    signal.throwIfAborted();
    try { await fsp.rename(source, destination); return; }
    catch (error) {
      if (!transient.has((error as NodeJS.ErrnoException).code || '') || attempt >= backoff.length) throw error;
      await delay(backoff[attempt], undefined, { signal });
    }
  }
}
export function verifyLibraryFileSync(root: string, target: string): void {
  if (!contains(root, target)) throw new Error('文件超出资料库');
  noLinksSync(target);
  const resolved = fs.realpathSync(target);
  if (!contains(fs.realpathSync(root), resolved) || !fs.statSync(target).isFile()) throw new Error('库内文件无效');
}
