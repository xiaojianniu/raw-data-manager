import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readdir, readFile, writeFile, rename, statfs, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Catalog } from './core';
import type { Asset, ExportResult, PreviewResult } from '../shared/types';

interface ManifestFile { path: string; size: number; sha256: string }
interface BackupManifest { schemaVersion: 1; kind: 'labarchive-backup'; createdAt: string; database: ManifestFile; files: ManifestFile[] }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export function within(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0')) throw new Error('无效的相对路径');
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('路径不能包含跨目录引用');
  const target = path.resolve(root, normalized);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径超出资料库');
  return target;
}
export function isInside(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
export async function checkPlainPath(target: string) {
  let current = path.resolve(target);
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('不支持通过符号链接或目录联接访问归档数据');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function copyVerified(source: string, target: string, expected: string, expectedSize: number) {
  await checkPlainPath(source);
  const before = await stat(source);
  if (!before.isFile() || before.size !== expectedSize) throw new Error('源文件大小发生变化：' + path.basename(source));
  await mkdir(path.dirname(target), { recursive: true });
  await checkPlainPath(path.dirname(target));
  const digest = createHash('sha256');
  const meter = new Transform({transform(chunk, _encoding, done) { digest.update(chunk); done(null, chunk); }});
  await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: 'wx' }));
  const after = await stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || digest.digest('hex') !== expected) throw new Error('源文件已改变或校验不一致：' + path.basename(source));
  const dest = await stat(target);
  if (dest.size !== expectedSize || await hashFile(target) !== expected) throw new Error('副本校验失败：' + path.basename(target));
}
async function requireSpace(directory: string, bytes: number) {
  const info = await statfs(directory);
  if (Number(info.bavail) * Number(info.bsize) < bytes + 32 * 1024 * 1024) throw new Error('目标磁盘剩余空间不足');
}
async function outputFolder(parent: string, prefix: string, sourceRoot: string) {
  if (isInside(sourceRoot, parent)) throw new Error('请选择资料库之外的输出目录');
  await checkPlainPath(parent);
  const id = prefix + '-' + stamp() + '-' + randomUUID().slice(0, 8);
  const staging = path.join(parent, id + '.partial');
  await mkdir(staging, { recursive: false });
  return { staging, final: path.join(parent, id) };
}
function csv(rows: unknown[][]) {
  return '\ufeff' + rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

export class StorageService {
  constructor(private catalog: Catalog, private cacheRoot: string, private workRoot: string) {}
  async preview(id: string, page = 0): Promise<PreviewResult> {
    if (!Number.isInteger(page) || page < 0 || page > 100000) throw new Error('无效页码');
    const asset = this.catalog.asset(id);
    const result: PreviewResult = {supported: false, page, pages: 1, message: ''};
    if (!/\.(jpe?g|png|tiff?)$/i.test(asset.name)) return {...result, message: '此格式已归档。请用原软件打开工作副本，或关联一张导出图片。'};
    try {
      const source = this.catalog.assetPath(id);
      await checkPlainPath(source);
      const metadata = await sharp(source, {limitInputPixels: 100_000_000}).metadata();
      const pages = metadata.pages ?? 1;
      if (page >= pages) throw new Error('页码超出图片范围');
      const directory = path.join(this.cacheRoot, asset.sha256.slice(0, 2));
      await mkdir(directory, {recursive: true});
      const cached = path.join(directory, asset.sha256 + '-p' + page + '.png');
      try { await stat(cached); } catch {
        const bytes = await sharp(source, {page, pages: 1, limitInputPixels: 100_000_000})
          .rotate().resize({width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
        await writeFile(cached, bytes);
      }
      return {supported: true, dataUrl: 'data:image/png;base64,' + (await readFile(cached)).toString('base64'), page, pages,
        width: metadata.width, height: metadata.pageHeight ?? metadata.height,
        message: '显示预览，已缩放；不用于灰度定量。原始文件保持不变。'};
    } catch (error) { return {...result, message: '预览不可用：' + (error as Error).message + '。归档文件仍保留，可用原软件打开工作副本。'}; }
  }
  async workingCopy(id: string): Promise<string> {
    return this.catalog.withExclusive(async () => {
      const selected = this.catalog.asset(id);
      const assets = this.catalog.list({}).flatMap(experiment => this.catalog.detail(experiment.id).assets).filter(asset => asset.importId === selected.importId);
      const libraryKey = createHash('sha256').update(this.catalog.root).digest('hex').slice(0, 12);
      const targetRoot = path.join(this.workRoot, libraryKey, stamp() + '-' + randomUUID().slice(0, 8));
      await mkdir(targetRoot, {recursive: true});
      await requireSpace(targetRoot, assets.reduce((n, asset) => n + asset.size, 0));
      for (const asset of assets) await copyVerified(this.catalog.assetPath(asset.id), within(targetRoot, asset.relativePath), asset.sha256, asset.size);
      await writeFile(path.join(targetRoot, '工作副本说明.txt'), '此目录是独立工作副本。修改不会写回归档库。保存处理结果后，请在实验档案中重新导入并标记为处理结果。\r\n', 'utf8');
      return within(targetRoot, selected.relativePath);
    });
  }
  async exportExperiment(id: string, parent: string): Promise<ExportResult> {
    return this.catalog.withExclusive(async () => {
      const detail = this.catalog.detail(id);
      await requireSpace(parent, detail.experiment.totalSize);
      const output = await outputFolder(parent, '实验导出', this.catalog.root);
      const files: ManifestFile[] = [];
      for (const asset of detail.assets) {
        const rel = ['files', asset.importId, asset.relativePath.replaceAll('\\', '/')].join('/');
        await copyVerified(this.catalog.assetPath(asset.id), within(output.staging, rel), asset.sha256, asset.size);
        files.push({path: rel, size: asset.size, sha256: asset.sha256});
      }
      const animalIds = new Set(detail.experiment.rows.map(row => row.animalId).filter(Boolean));
      const animals = this.catalog.animals().filter(animal => animalIds.has(animal.id));
      await writeFile(path.join(output.staging, 'metadata.json'), JSON.stringify({schemaVersion: 1, ...detail, animals}, null, 2));
      await writeFile(path.join(output.staging, 'files.csv'), csv([['file_id','original_name','export_path','role','size','sha256','source_path'], ...detail.assets.map((asset, i) => [asset.id,asset.name,files[i].path,asset.role,asset.size,asset.sha256,asset.sourcePath])]));
      const columns = [...new Set(detail.experiment.rows.flatMap(row => Object.keys(row.data)))];
      await writeFile(path.join(output.staging, 'records.csv'), csv([['row_id','sample_id','animal_id','animal_label',...columns], ...detail.experiment.rows.map(row => [row.id,row.sampleId,row.animalId ?? '',animals.find(a => a.id === row.animalId)?.label ?? '',...columns.map(c => row.data[c] ?? '')])]));
      await writeFile(path.join(output.staging, 'README.md'), '# ' + detail.experiment.title + '\n\n实验档案导出包。原文件按导入批次保留相对路径。metadata.json 包含完整记录、文件关联、动物标识及修改历史；records.csv 为便于 Excel 查看而导出的记录。\n\n## 实验记录\n\n' + detail.experiment.notes + '\n');
      // Include metadata and human-readable records in the integrity manifest, not just originals.
      for (const name of ['metadata.json','files.csv','records.csv','README.md']) {
        const file = path.join(output.staging, name);
        files.push({path: name, size: (await stat(file)).size, sha256: await hashFile(file)});
      }
      await writeFile(path.join(output.staging, 'SHA256SUMS.csv'), csv([['relative_path','size','sha256'], ...files.map(file => [file.path,file.size,file.sha256])]));
      await writeFile(path.join(output.staging, 'manifest.json'), JSON.stringify({schemaVersion: 1, kind: 'experiment-export', experimentId: id, files}, null, 2));
      await rename(output.staging, output.final);
      return {path: output.final, files: detail.assets.length, message: '实验记录、文件关联和原文件已校验导出'};
    });
  }
  async backup(parent: string): Promise<ExportResult> {
    return this.catalog.withExclusive(async () => {
      const experiments = [...this.catalog.list({archived: false}), ...this.catalog.list({archived: true})];
      const assets = experiments.flatMap(exp => this.catalog.detail(exp.id).assets);
      await requireSpace(parent, assets.reduce((n, a) => n + a.size, 0) + 10 * 1024 * 1024);
      const output = await outputFolder(parent, '实验档案备份', this.catalog.root);
      const dbPath = path.join(output.staging, 'catalog.sqlite');
      await sqliteBackup(this.catalog.db, dbPath);
      const files: ManifestFile[] = [];
      for (const asset of assets) {
        const source = this.catalog.assetPath(asset.id);
        const rel = path.relative(this.catalog.root, source).replaceAll('\\', '/');
        await copyVerified(source, within(output.staging, rel), asset.sha256, asset.size);
        files.push({path: rel, size: asset.size, sha256: asset.sha256});
      }
      const manifest: BackupManifest = {schemaVersion: 1, kind: 'labarchive-backup', createdAt: new Date().toISOString(), database: {path: 'catalog.sqlite', size: (await stat(dbPath)).size, sha256: await hashFile(dbPath)}, files};
      await writeFile(path.join(output.staging, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
      await rename(output.staging, output.final);
      return {path: output.final, files: assets.length, message: '完整备份已完成并校验。工作副本及可重建预览缓存不包含在备份中。'};
    });
  }
}

export async function restoreLibrary(source: string, parent: string): Promise<string> {
  await checkPlainPath(source);
  await checkPlainPath(parent);
  if (isInside(source, parent)) throw new Error('恢复目标必须位于备份目录之外');
  const raw = await readFile(path.join(source, 'backup-manifest.json'), 'utf8');
  if (raw.length > 100_000_000) throw new Error('备份清单过大');
  const manifest = JSON.parse(raw) as BackupManifest;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'labarchive-backup' || !Array.isArray(manifest.files) || manifest.database?.path !== 'catalog.sqlite') throw new Error('不是支持的实验档案备份');
  const all = [manifest.database, ...manifest.files];
  const seen = new Set<string>();
  for (const entry of all) {
    if (typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('备份清单条目无效');
    within(source, entry.path);
    const key = entry.path.replaceAll('\\','/').toLowerCase();
    if (seen.has(key) || (entry !== manifest.database && !key.startsWith('originals/'))) throw new Error('备份路径重复或不合法');
    seen.add(key);
  }
  await requireSpace(parent, all.reduce((n, file) => n + file.size, 0));
  const output = await outputFolder(parent, '恢复资料库', source);
  for (const file of all) await copyVerified(within(source, file.path), within(output.staging, file.path), file.sha256, file.size);
  const check = new DatabaseSync(path.join(output.staging, 'catalog.sqlite'), {readOnly: true});
  try {
    const integrity = check.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('备份数据库完整性检查失败');
    if (check.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据库关联检查失败');
  } finally { check.close(); }
  // Verify database references against the manifest before publishing the restored library.
  const { Catalog: CatalogClass } = await import('./core');
  const restored = new CatalogClass(output.staging);
  try {
    const assets = [...restored.list({archived: false}), ...restored.list({archived: true})].flatMap(exp => restored.detail(exp.id).assets);
    const indexed = new Map(manifest.files.map(file => [file.path.replaceAll('\\', '/').toLowerCase(), file]));
    if (assets.length !== manifest.files.length) throw new Error('数据库与备份文件数量不一致');
    for (const asset of assets) {
      const rel = path.relative(output.staging, restored.assetPath(asset.id)).replaceAll('\\', '/').toLowerCase();
      const file = indexed.get(rel);
      if (!file || file.sha256 !== asset.sha256 || file.size !== asset.size) throw new Error('数据库与文件清单关联不一致');
    }
  } finally { restored.close(); }
  await rename(output.staging, output.final);
  return output.final;
}
