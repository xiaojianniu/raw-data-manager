import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Animal, Asset, AssetRole, Experiment, ExperimentDetail, ExperimentDraft, ExperimentType, ImportJob, ImportRequest, ImportScan, LibraryStatus, ListFilter, ScanFile } from '../shared/types';
import * as validate from './core-validation';
import { copyVerified, fingerprint, hashFile, noLinks, noLinksSync, publishDirectory, verifyLibraryFileSync, type Fingerprint } from './core-files';

interface SnapshotFile extends ScanFile { snapshot: Fingerprint }
interface SnapshotScan extends ImportScan { files: SnapshotFile[] }
interface StoredJob { job: ImportJob; request: ImportRequest; scan: SnapshotScan; pendingDirectories: string[] }
type Row = Record<string, any>;
type Progress = (job: ImportJob) => void;
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'interrupted']);
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function suggestedRole(filename: string): AssetRole {
  if (/(?:_cropped|_crop|裁剪|处理结果)/i.test(path.basename(filename))) return '处理结果';
  const extension = path.extname(filename).toLowerCase();
  if (['.scn','.mscn','.czi','.oir','.lif'].includes(extension)) return '仪器原文件';
  if (['.jpg','.jpeg','.png','.tif','.tiff'].includes(extension)) return '导出图';
  if (['.pptx','.ppt'].includes(extension)) return '汇总材料';
  if (['.docx','.doc','.xlsx','.xls','.csv','.txt','.md'].includes(extension)) return '实验记录';
  return '待确认';
}

/** Owns one local archive. Original files are append-only; all observations require explicit user input. */
export class Catalog {
  readonly root: string;
  readonly db: DatabaseSync;
  private scans = new Map<string, SnapshotScan>();
  private queue: { id: string; progress?: Progress }[] = [];
  private active?: { id: string; controller: AbortController };
  private exclusive = false;
  private scansInFlight = 0;
  private closed = false;
  private pumping = false;
  private scheduled = false;
  private waiters = new Map<string, ((job: ImportJob) => void)[]>();

  constructor(root: string) {
    this.root = validate.absolute(root);
    noLinksSync(this.root);
    fs.mkdirSync(this.root, { recursive: true });
    for (const folder of ['originals', '.staging']) noLinksSync(path.join(this.root, folder));
    for (const suffix of ['', '-wal', '-shm']) noLinksSync(path.join(this.root, `catalog.sqlite${suffix}`));
    this.db = new DatabaseSync(path.join(this.root, 'catalog.sqlite'));
    // Check compatibility before PRAGMAs, migrations or managed-directory creation.
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Row[];
      if (tables.length) {
        if (!tables.some(table => table.name === 'settings')) throw new Error('资料库缺少版本信息');
        const version = (this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as Row | undefined)?.value;
        if (version !== '1') throw new Error('资料库版本不兼容');
      }
    } catch (error) { this.db.close(); throw error; }
    try {
    for (const folder of ['originals', '.staging']) fs.mkdirSync(path.join(this.root, folder), { recursive: true });
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('schema_version','1');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS experiments(
        id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,date TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id),tags TEXT NOT NULL,status TEXT NOT NULL,notes TEXT NOT NULL,
        fields TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS animals(id TEXT PRIMARY KEY,label TEXT NOT NULL,notes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(
        id TEXT NOT NULL,experiment_id TEXT NOT NULL REFERENCES experiments(id),sample_id TEXT NOT NULL,
        animal_id TEXT REFERENCES animals(id),data TEXT NOT NULL,position INTEGER NOT NULL,
        PRIMARY KEY(experiment_id,id));
      CREATE TABLE IF NOT EXISTS assets(
        id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES experiments(id),import_id TEXT NOT NULL,
        name TEXT NOT NULL,relative_path TEXT NOT NULL,storage_path TEXT NOT NULL UNIQUE,source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,size INTEGER NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assets_experiment ON assets(experiment_id);
      CREATE INDEX IF NOT EXISTS assets_hash ON assets(sha256);
      CREATE TABLE IF NOT EXISTS asset_links(
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES assets(id),derived_id TEXT NOT NULL REFERENCES assets(id),
        UNIQUE(source_id,derived_id));
      CREATE TABLE IF NOT EXISTS history(
        id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES experiments(id),at TEXT NOT NULL,
        action TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    `);
    for (const stored of this.storedJobs()) {
      if (!TERMINAL.has(stored.job.status)) {
        stored.job.status = 'interrupted';
        stored.job.message = '上次程序退出中断了导入；未提交的副本已保留，可重试';
        stored.job.error = '导入中断';
        this.persistJob(stored);
      }
    }
    } catch (error) { this.db.close(); throw error; }
  }

  get busy(): boolean { return this.exclusive || this.scansInFlight > 0 || !!this.active || this.queue.length > 0 || this.pumping; }
  private open(): void { if (this.closed) throw new Error('资料库已关闭'); }
  private writable(): void { this.open(); if (this.busy) throw new Error('资料库正在扫描、导入或维护，请等待完成'); }
  close(): void { this.writable(); this.db.close(); this.closed = true; }
  async withExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.writable();
    this.exclusive = true;
    try { return await task(); } finally { this.exclusive = false; }
  }
  private transaction<T>(task: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = task(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private storedJobs(): StoredJob[] {
    return (this.db.prepare('SELECT payload FROM jobs ORDER BY rowid DESC').all() as Row[]).map(r => JSON.parse(r.payload));
  }
  private storedJob(jobId: string): StoredJob {
    this.open();
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(validate.id(jobId)) as Row | undefined;
    if (!row) throw new Error('找不到导入任务');
    return JSON.parse(row.payload);
  }
  private persistJob(stored: StoredJob): void {
    this.db.prepare('INSERT INTO jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(stored.job.id, JSON.stringify(stored));
  }
  status(): LibraryStatus {
    this.open();
    const counts = this.db.prepare('SELECT COUNT(*) AS assets,COALESCE(SUM(size),0) AS totalSize FROM assets').get() as Row;
    return { root: this.root, defaultRoot: this.root, projects: (this.db.prepare('SELECT name FROM projects ORDER BY name').all() as Row[]).map(r => r.name), experiments: (this.db.prepare('SELECT COUNT(*) AS count FROM experiments').get() as Row).count, assets: counts.assets, totalSize: counts.totalSize, jobs: this.storedJobs().map(s => s.job) };
  }
  private experiment(row: Row): Experiment {
    const rows = (this.db.prepare('SELECT * FROM samples WHERE experiment_id=? ORDER BY position').all(row.id) as Row[]).map(r => ({ id: r.id, sampleId: r.sample_id, ...(r.animal_id ? { animalId: r.animal_id } : {}), data: JSON.parse(r.data) }));
    const counts = this.db.prepare('SELECT COUNT(*) AS files,COALESCE(SUM(size),0) AS bytes FROM assets WHERE experiment_id=?').get(row.id) as Row;
    return { id: row.id, title: row.title, type: row.type, date: row.date, project: row.project || '', tags: JSON.parse(row.tags), status: row.status, notes: row.notes, fields: JSON.parse(row.fields), rows, archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at, fileCount: counts.files, totalSize: counts.bytes };
  }
  private experimentRow(experimentId: string): Row {
    this.open();
    const row = this.db.prepare('SELECT e.*,p.name AS project FROM experiments e LEFT JOIN projects p ON e.project_id=p.id WHERE e.id=?').get(validate.id(experimentId)) as Row | undefined;
    if (!row) throw new Error('找不到实验');
    return row;
  }
  private mapAsset(row: Row): Asset {
    return { id: row.id, experimentId: row.experiment_id, importId: row.import_id, name: row.name, relativePath: row.relative_path, sourcePath: row.source_path, sha256: row.sha256, size: row.size, role: row.role, createdAt: row.created_at };
  }
  asset(assetId: string): Asset {
    this.open();
    const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(validate.id(assetId)) as Row | undefined;
    if (!row) throw new Error('找不到文件');
    return this.mapAsset(row);
  }
  assetPath(assetId: string): string {
    this.open();
    const row = this.db.prepare('SELECT storage_path FROM assets WHERE id=?').get(validate.id(assetId)) as Row | undefined;
    if (!row) throw new Error('找不到文件');
    const file = validate.confined(this.root, row.storage_path);
    if (!validate.contains(path.join(this.root, 'originals'), file)) throw new Error('文件不在原始资料区');
    verifyLibraryFileSync(this.root, file);
    return file;
  }
  list(input: ListFilter = {}): Experiment[] {
    this.open();
    const filter = validate.filter(input);
    const all = (this.db.prepare('SELECT e.*,p.name AS project FROM experiments e LEFT JOIN projects p ON e.project_id=p.id ORDER BY e.updated_at DESC,e.rowid DESC').all() as Row[]).map(r => this.experiment(r));
    const query = (filter.query || '').toLocaleLowerCase();
    return all.filter(e => {
      if (filter.type && e.type !== filter.type || filter.project !== undefined && e.project !== filter.project || filter.archived !== undefined && e.archived !== filter.archived || filter.dateFrom && (!e.date || e.date < filter.dateFrom) || filter.dateTo && (!e.date || e.date > filter.dateTo)) return false;
      if (!query) return true;
      const assets = (this.db.prepare('SELECT name,relative_path,source_path,sha256,role FROM assets WHERE experiment_id=?').all(e.id) as Row[]);
      const animalRows = this.db.prepare('SELECT a.label,a.notes FROM animals a JOIN samples s ON s.animal_id=a.id WHERE s.experiment_id=?').all(e.id);
      return JSON.stringify([e.title, e.type, e.project, e.tags, e.notes, e.fields, e.rows, assets, animalRows]).toLocaleLowerCase().includes(query);
    });
  }
  detail(experimentId: string): ExperimentDetail {
    const experiment = this.experiment(this.experimentRow(experimentId));
    return { experiment, assets: (this.db.prepare('SELECT * FROM assets WHERE experiment_id=? ORDER BY created_at,rowid').all(experiment.id) as Row[]).map(r => this.mapAsset(r)), links: (this.db.prepare('SELECT l.id,l.source_id AS sourceId,l.derived_id AS derivedId FROM asset_links l JOIN assets a ON a.id=l.source_id WHERE a.experiment_id=? ORDER BY l.rowid').all(experiment.id) as any[]), history: (this.db.prepare('SELECT id,experiment_id AS experimentId,at,action,detail FROM history WHERE experiment_id=? ORDER BY rowid DESC').all(experiment.id) as any[]) };
  }
  private checkAnimals(draft: ExperimentDraft): void {
    for (const row of draft.rows) if (row.animalId && !this.db.prepare('SELECT 1 FROM animals WHERE id=?').get(row.animalId)) throw new Error(`动物 ID 不存在：${row.animalId}`);
  }
  private projectId(name: string): string | null {
    if (!name) return null;
    const existing = this.db.prepare('SELECT id FROM projects WHERE name=?').get(name) as Row | undefined;
    if (existing) return existing.id;
    const projectId = randomUUID();
    this.db.prepare('INSERT INTO projects(id,name) VALUES(?,?)').run(projectId, name);
    return projectId;
  }
  private putDraft(experimentId: string, draft: ExperimentDraft, createdAt?: string): void {
    const timestamp = now();
    const projectId = this.projectId(draft.project);
    if (createdAt) this.db.prepare('INSERT INTO experiments(id,title,type,date,project_id,tags,status,notes,fields,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(experimentId, draft.title, draft.type, draft.date, projectId, JSON.stringify(draft.tags), draft.status, draft.notes, JSON.stringify(draft.fields), createdAt, timestamp);
    else this.db.prepare('UPDATE experiments SET title=?,type=?,date=?,project_id=?,tags=?,status=?,notes=?,fields=?,updated_at=? WHERE id=?').run(draft.title, draft.type, draft.date, projectId, JSON.stringify(draft.tags), draft.status, draft.notes, JSON.stringify(draft.fields), timestamp, experimentId);
    this.db.prepare('DELETE FROM samples WHERE experiment_id=?').run(experimentId);
    draft.rows.forEach((row, index) => this.db.prepare('INSERT INTO samples(id,experiment_id,sample_id,animal_id,data,position) VALUES(?,?,?,?,?,?)').run(row.id, experimentId, row.sampleId, row.animalId || null, JSON.stringify(row.data), index));
  }
  private history(experimentId: string, action: string, detail: unknown): void {
    this.db.prepare('INSERT INTO history(id,experiment_id,at,action,detail) VALUES(?,?,?,?,?)').run(randomUUID(), experimentId, now(), action, JSON.stringify(detail));
  }
  save(experimentId: string, input: ExperimentDraft): ExperimentDetail {
    this.writable();
    const before = this.detail(experimentId).experiment;
    const draft = validate.draft(input);
    this.checkAnimals(draft);
    this.transaction(() => { this.putDraft(experimentId, draft); this.history(experimentId, '修改记录', { before, after: draft }); });
    return this.detail(experimentId);
  }
  archive(experimentId: string, archived: boolean): void {
    this.writable();
    const before = this.experiment(this.experimentRow(experimentId)).archived;
    const after = validate.boolean(archived);
    this.transaction(() => { this.db.prepare('UPDATE experiments SET archived=?,updated_at=? WHERE id=?').run(after ? 1 : 0, now(), experimentId); this.history(experimentId, after ? '归档' : '恢复归档', { before, after }); });
  }
  lastTemplate(type: ExperimentType): ExperimentDraft | null {
    validate.type(type);
    const previous = this.list({ type, archived: false })[0];
    if (!previous) return null;
    // Only reusable setup fields are copied. Unrecognized fields and all observation rows are excluded.
    const safe: Record<ExperimentType, string[]> = {
      WB: ['target', 'loadingControl', 'antibodies', 'membrane', 'instrument', 'conditions'],
      '共聚焦': ['channels', 'microscope', 'objective', 'acquisition', 'conditions'],
      '鼠尾鉴定': ['gene', 'primerName', 'primerForward', 'primerReverse', 'expectedBands', 'conditions'],
      '其他实验': ['method', 'instrument', 'conditions'],
    };
    return { title: `${previous.type} 实验`, type: previous.type, date: '', project: previous.project, tags: [...previous.tags], status: '待补信息', notes: '', fields: Object.fromEntries(Object.entries(previous.fields).filter(([key]) => safe[type].includes(key))), rows: [] };
  }
  animals(): Animal[] { this.open(); return this.db.prepare('SELECT id,label,notes FROM animals ORDER BY label,rowid').all() as unknown as Animal[]; }
  createAnimal(label: string, notes: string): Animal {
    this.writable();
    const animal = { id: randomUUID(), label: validate.string(label, '动物编号', 500).trim(), notes: validate.string(notes, '动物备注', 100000) };
    if (!animal.label) throw new Error('请填写动物编号');
    this.db.prepare('INSERT INTO animals(id,label,notes) VALUES(?,?,?)').run(animal.id, animal.label, animal.notes);
    return animal;
  }
  updateAsset(assetId: string, role: AssetRole): void {
    this.writable();
    const before = this.asset(assetId);
    validate.role(role);
    this.transaction(() => { this.db.prepare('UPDATE assets SET role=? WHERE id=?').run(role, assetId); this.history(before.experimentId, '确认文件角色', { assetId, before: before.role, after: role }); });
  }
  linkAssets(sourceId: string, derivedId: string): void {
    this.writable();
    const source = this.asset(sourceId), derived = this.asset(derivedId);
    if (source.id === derived.id || source.experimentId !== derived.experimentId) throw new Error('文件关联必须属于同一实验，且不能关联自身');
    const cycle = this.db.prepare('WITH RECURSIVE reachable(id) AS (SELECT derived_id FROM asset_links WHERE source_id=? UNION SELECT l.derived_id FROM asset_links l JOIN reachable r ON l.source_id=r.id) SELECT 1 FROM reachable WHERE id=?').get(derivedId, sourceId);
    if (cycle) throw new Error('文件关联不能构成循环');
    this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO asset_links(id,source_id,derived_id) VALUES(?,?,?)').run(randomUUID(), sourceId, derivedId); this.history(source.experimentId, '关联原文件与派生文件', { sourceId, derivedId }); });
  }
  unlinkAssets(linkId: string): void {
    this.writable();
    validate.id(linkId);
    const link = this.db.prepare('SELECT l.*,a.experiment_id FROM asset_links l JOIN assets a ON a.id=l.source_id WHERE l.id=?').get(linkId) as Row | undefined;
    if (!link) throw new Error('找不到文件关联');
    this.transaction(() => { this.db.prepare('DELETE FROM asset_links WHERE id=?').run(linkId); this.history(link.experiment_id, '移除文件关联', { sourceId: link.source_id, derivedId: link.derived_id }); });
  }

  async scan(input: string[]): Promise<ImportScan> {
    this.open();
    if (!Array.isArray(input) || !input.length || input.length > 1000) throw new Error('请选择有效文件或目录');
    if (this.exclusive) throw new Error('资料库正在维护');
    this.scansInFlight++;
    try {
    const warnings: string[] = [], files: SnapshotFile[] = [], roots: string[] = [];
    const aliases = new Set<string>(), seenFiles = new Set<string>(), seenRoots = new Set<string>();
    const libraryReal = await fsp.realpath(this.root);
    for (const item of input) {
      const source = validate.absolute(item);
      try {
        await noLinks(source);
        const real = await fsp.realpath(source);
        if (validate.contains(libraryReal, real)) { warnings.push(`跳过资料库内路径：${source}`); continue; }
        const key = real.toLowerCase();
        if (seenRoots.has(key)) { warnings.push(`跳过重复来源：${source}`); continue; }
        seenRoots.add(key);
        const rootStat = await fsp.lstat(source);
        if (!rootStat.isDirectory() && !rootStat.isFile()) { warnings.push(`跳过非普通文件：${source}`); continue; }
        roots.push(source);
        const baseAlias = (path.basename(source) || '来源').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '来源';
        let alias = baseAlias, suffix = 2;
        while (aliases.has(alias.toLowerCase())) alias = `${baseAlias} (${suffix++})`;
        aliases.add(alias.toLowerCase());
        const walk = async (entry: string, relative: string): Promise<void> => {
          if (validate.contains(this.root, entry)) { warnings.push(`跳过资料库目录：${entry}`); return; }
          try {
            const stat = await fsp.lstat(entry);
            if (stat.isSymbolicLink()) { warnings.push(`跳过符号链接或重解析点：${entry}`); return; }
            if (stat.isDirectory()) {
              const children = (await fsp.readdir(entry)).sort((a, b) => a.localeCompare(b));
              for (const child of children) await walk(path.join(entry, child), relative ? `${relative}/${child}` : child);
            } else if (stat.isFile()) {
              const realFile = await fsp.realpath(entry);
              if (validate.contains(libraryReal, realFile)) { warnings.push(`跳过资料库文件：${entry}`); return; }
              if (seenFiles.has(realFile.toLowerCase())) { warnings.push(`跳过重叠来源文件：${entry}`); return; }
              const result = await hashFile(entry, fingerprint(stat));
              seenFiles.add(realFile.toLowerCase());
              files.push({ id: randomUUID(), sourcePath: entry, relativePath: rootStat.isDirectory() ? `${alias}/${relative}` : `${alias}/${path.basename(entry)}`, size: result.stat.size, mtimeMs: result.stat.mtimeMs, sha256: result.sha256, duplicateCount: 0, suggestedRole: suggestedRole(entry), snapshot: result.stat });
            } else warnings.push(`跳过非普通文件：${entry}`);
          } catch (error) { warnings.push(`未纳入扫描：${entry}；${(error as Error).message}`); }
        };
        await walk(source, '');
      } catch (error) { warnings.push(`未纳入来源：${source}；${(error as Error).message}`); }
    }
    if (this.closed) throw new Error('扫描期间资料库已关闭');
    const hashes = new Map<string, number>();
    for (const file of files) hashes.set(file.sha256, (hashes.get(file.sha256) || 0) + 1);
    for (const file of files) {
      const existing = this.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE sha256=?').get(file.sha256) as Row;
      file.duplicateCount = existing.count + (hashes.get(file.sha256) || 1) - 1;
    }
    const scan: SnapshotScan = { id: randomUUID(), roots, files, totalSize: files.reduce((sum, file) => sum + file.size, 0), warnings, suggestedTitle: roots.length === 1 ? path.basename(roots[0], path.extname(roots[0])) : '新实验' };
    // Bound retained scan snapshots; requests already queued contain their own immutable snapshot.
    if (this.scans.size >= 20) this.scans.delete(this.scans.keys().next().value!);
    this.scans.set(scan.id, scan);
    return clone(scan);
    } finally { this.scansInFlight--; }
  }
  private validateRequest(input: ImportRequest): { request: ImportRequest; scan: SnapshotScan } {
    const value = validate.record(input);
    const scan = this.scans.get(validate.id(value.scanId));
    if (!scan || !scan.files.length) throw new Error('扫描已过期或没有可导入文件，请重新扫描');
    const draft = validate.draft(value.draft);
    this.checkAnimals(draft);
    if (!Array.isArray(value.assignments) || value.assignments.length !== scan.files.length) throw new Error('每个文件都需要确认分配');
    const files = new Set(scan.files.map(file => file.id)), assigned = new Set<string>();
    const assignments = value.assignments.map(item => {
      const a = validate.record(item), fileId = validate.id(a.fileId);
      if (!files.has(fileId) || assigned.has(fileId)) throw new Error('文件分配无效或重复');
      assigned.add(fileId);
      const targetExperimentId = a.targetExperimentId !== undefined ? validate.id(a.targetExperimentId) : undefined;
      if (targetExperimentId) this.experimentRow(targetExperimentId);
      return { fileId, role: validate.role(a.role), ...(targetExperimentId ? { targetExperimentId } : {}) };
    });
    return { request: { scanId: scan.id, draft, assignments }, scan: clone(scan) };
  }
  startImport(input: ImportRequest, onProgress?: Progress): ImportJob {
    this.open();
    if (this.exclusive) throw new Error('资料库正在维护');
    if (this.scansInFlight) throw new Error('资料库正在扫描，请等待完成');
    const { request, scan } = this.validateRequest(input);
    const job: ImportJob = { id: randomUUID(), status: 'queued', totalFiles: scan.files.length, completedFiles: 0, totalBytes: scan.totalSize, copiedBytes: 0, message: '已加入导入队列', createdAt: now(), experimentIds: [] };
    this.persistJob({ job, request, scan, pendingDirectories: [] });
    this.queue.push({ id: job.id, progress: onProgress });
    this.schedule();
    return clone(job);
  }
  retryJob(jobId: string, onProgress?: Progress): ImportJob {
    this.open();
    if (this.exclusive) throw new Error('资料库正在维护');
    if (this.scansInFlight) throw new Error('资料库正在扫描，请等待完成');
    const stored = this.storedJob(jobId);
    if (!['failed', 'cancelled', 'interrupted'].includes(stored.job.status)) throw new Error('此任务不能重试');
    validate.draft(stored.request.draft);
    this.checkAnimals(stored.request.draft);
    for (const a of stored.request.assignments) { validate.role(a.role); if (a.targetExperimentId) this.experimentRow(a.targetExperimentId); }
    stored.job = { ...stored.job, status: 'queued', completedFiles: 0, copiedBytes: 0, message: '已加入重试队列；沿用原扫描快照校验', error: undefined, experimentIds: [] };
    this.persistJob(stored);
    this.queue.push({ id: jobId, progress: onProgress });
    this.schedule();
    return clone(stored.job);
  }
  cancelJob(jobId: string): void {
    const stored = this.storedJob(jobId);
    if (TERMINAL.has(stored.job.status)) return;
    if (this.active?.id === jobId) { this.active.controller.abort(); return; }
    const pending = this.queue.find(item => item.id === jobId);
    this.queue = this.queue.filter(item => item.id !== jobId);
    stored.job.status = 'cancelled'; stored.job.message = '已取消，未提交资料';
    this.persistJob(stored);
    this.emit(pending?.progress, stored.job);
    this.finish(stored.job);
  }
  waitForJob(jobId: string): Promise<ImportJob> {
    const stored = this.storedJob(jobId);
    if (TERMINAL.has(stored.job.status)) return Promise.resolve(clone(stored.job));
    return new Promise(resolve => this.waiters.set(jobId, [...(this.waiters.get(jobId) || []), resolve]));
  }
  private schedule(): void {
    if (!this.pumping && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => { this.scheduled = false; if (this.queue.length && !this.pumping) { this.pumping = true; void this.pump(); } });
    }
  }
  private finish(job: ImportJob): void { for (const resolve of this.waiters.get(job.id) || []) resolve(clone(job)); this.waiters.delete(job.id); }
  private emit(progress: Progress | undefined, job: ImportJob): void { try { progress?.(clone(job)); } catch { /* UI listeners cannot change a committed job. */ } }
  private async pump(): Promise<void> {
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const stored = this.storedJob(next.id);
        if (stored.job.status !== 'queued') continue;
        const controller = new AbortController();
        this.active = { id: next.id, controller };
        try { await this.runImport(stored, controller.signal, next.progress); }
        catch (error) {
          stored.job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          stored.job.error = (error as Error).message;
          stored.job.message = controller.signal.aborted ? '已取消，未提交资料；暂存副本保留以供检查' : '导入失败，未提交资料；暂存副本保留以供检查';
          this.persistJob(stored);
        }
        finally { this.active = undefined; this.emit(next.progress, stored.job); this.finish(stored.job); }
      }
    } finally { this.pumping = false; }
  }
  private async runImport(stored: StoredJob, signal: AbortSignal, progress?: Progress): Promise<void> {
    const { job, request, scan } = stored;
    const checkCancel = () => { if (signal.aborted) throw new Error('导入已取消'); };
    checkCancel();
    // statfs values are bigint to avoid overflow on large volumes.
    const space = await fsp.statfs(this.root, { bigint: true });
    if (space.bavail * space.bsize < BigInt(scan.totalSize) + 32n * 1024n * 1024n) throw new Error('资料库可用空间不足（需要副本大小加 32 MiB 余量）');
    const importId = randomUUID();
    const stagedRelative = `.staging/${job.id}/${importId}`;
    const finalRelative = `originals/${importId}`;
    const stage = validate.confined(this.root, stagedRelative), final = validate.confined(this.root, finalRelative);
    noLinksSync(path.join(this.root, 'originals'));
    noLinksSync(path.join(this.root, '.staging'));
    await fsp.mkdir(stage, { recursive: true });
    stored.pendingDirectories.push(stagedRelative);
    job.status = 'copying'; job.message = '正在复制并验证原始文件';
    this.persistJob(stored); this.emit(progress, job);
    let lastUpdate = 0;
    for (const file of scan.files) {
      checkCancel();
      const destination = validate.confined(stage, file.relativePath);
      await copyVerified(file.sourcePath, destination, file.snapshot, file.sha256, signal, bytes => {
        job.copiedBytes += bytes;
        if (Date.now() - lastUpdate > 150) { this.persistJob(stored); this.emit(progress, job); lastUpdate = Date.now(); }
      });
      job.completedFiles++;
      this.persistJob(stored); this.emit(progress, job);
    }
    checkCancel();
    job.status = 'verifying'; job.message = '正在进行最终副本校验';
    this.persistJob(stored); this.emit(progress, job);
    stored.pendingDirectories.push(finalRelative);
    this.persistJob(stored); // Record destination before rename; a crash cannot create an untracked publication.
    await publishDirectory(stage, final, signal, async () => {
      // Re-read every destination immediately before each atomic publication attempt.
      for (const file of scan.files) {
        const verified = await hashFile(validate.confined(stage, file.relativePath), undefined, signal);
        if (verified.sha256 !== file.sha256 || verified.stat.size !== file.size) throw new Error(`最终副本校验失败：${file.relativePath}`);
      }
    });
    checkCancel();
    const assignmentMap = new Map(request.assignments.map(a => [a.fileId, a]));
    const newExperimentId = request.assignments.some(a => !a.targetExperimentId) ? randomUUID() : undefined;
    const success = clone(stored);
    this.transaction(() => {
      if (newExperimentId) { this.checkAnimals(request.draft); this.putDraft(newExperimentId, request.draft, now()); }
      const experimentIds = new Set<string>();
      for (const file of scan.files) {
        const assignment = assignmentMap.get(file.id)!;
        const experimentId = assignment.targetExperimentId || newExperimentId!;
        this.experimentRow(experimentId);
        const storagePath = `${finalRelative}/${file.relativePath}`;
        this.db.prepare('INSERT INTO assets(id,experiment_id,import_id,name,relative_path,storage_path,source_path,sha256,size,role,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), experimentId, importId, path.basename(file.sourcePath), file.relativePath, storagePath, file.sourcePath, file.sha256, file.size, assignment.role, now());
        experimentIds.add(experimentId);
      }
      for (const experimentId of experimentIds) {
        this.db.prepare('UPDATE experiments SET updated_at=? WHERE id=?').run(now(), experimentId);
        this.history(experimentId, '导入原始资料', { jobId: job.id, importId, files: scan.files.filter(file => (assignmentMap.get(file.id)!.targetExperimentId || newExperimentId) === experimentId).map(file => ({ sourcePath: file.sourcePath, relativePath: file.relativePath, sha256: file.sha256, size: file.size })), initialRecord: experimentId === newExperimentId ? request.draft : undefined });
      }
      success.job.status = 'complete'; success.job.message = '导入完成，全部副本通过 SHA-256 校验'; success.job.experimentIds = [...experimentIds]; success.job.copiedBytes = job.totalBytes;
      success.pendingDirectories = success.pendingDirectories.filter(p => p !== stagedRelative && p !== finalRelative);
      this.persistJob(success);
    });
    Object.assign(stored, success);
  }
}
