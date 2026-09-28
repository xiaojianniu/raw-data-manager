import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../electron/core';
import type { ExperimentDraft, ImportRequest, ImportScan } from '../shared/types';

const draft = (patch: Partial<ExperimentDraft> = {}): ExperimentDraft => ({ title: 'WB 原始实验', type: 'WB', date: '2026-09-26', project: '独立测试课题', tags: ['审计'], status: '待补信息', notes: '人工录入', fields: { instrument: 'ChemiDoc', target: 'MFN2' }, rows: [], ...patch });
async function fixture(t: TestContext) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lab-archive-test-'));
  const root = path.join(temp, '资料库');
  let catalog = new Catalog(root);
  t.after(async () => {
    for (const job of catalog.status().jobs) if (!['complete', 'failed', 'cancelled', 'interrupted'].includes(job.status)) { catalog.cancelJob(job.id); await catalog.waitForJob(job.id); }
    if (!catalog.busy) catalog.close();
    // Only remove this freshly allocated fixture, after verifying its final absolute path.
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('lab-archive-test-'));
    await fsp.rm(temp, { recursive: true, force: true });
  });
  return { temp, root, get catalog() { return catalog; }, restart() { catalog.close(); catalog = new Catalog(root); return catalog; }, async file(relative: string, bytes: string | Buffer = 'original bytes') { const file = path.join(temp, relative); await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, bytes); return file; } };
}
function request(scan: ImportScan, record = draft(), targetExperimentId?: string): ImportRequest {
  return { scanId: scan.id, draft: record, assignments: scan.files.map(file => ({ fileId: file.id, role: '待确认', ...(targetExperimentId ? { targetExperimentId } : {}) })) };
}
async function importFiles(catalog: Catalog, files: string[], record = draft()) {
  const scan = await catalog.scan(files);
  const job = catalog.startImport(request(scan, record));
  const result = await catalog.waitForJob(job.id);
  assert.equal(result.status, 'complete', result.error || '');
  return { scan, result, detail: catalog.detail(result.experimentIds[0]) };
}

test('preserves source bytes, original names, nested Chinese paths and same-named roots', async t => {
  const f = await fixture(t);
  const a = await f.file('源甲/同名实验/目录/曝光.tif', Buffer.from([1, 2, 0, 255]));
  const b = await f.file('源乙/同名实验/目录/曝光.tif', 'different original');
  const beforeA = await fsp.readFile(a), beforeB = await fsp.readFile(b);
  const scan = await f.catalog.scan([path.dirname(path.dirname(a)), path.dirname(path.dirname(b))]);
  assert.equal(scan.files.length, 2);
  assert.notEqual(scan.files[0].relativePath.toLowerCase(), scan.files[1].relativePath.toLowerCase());
  assert.ok(scan.files.every(file => file.suggestedRole === '导出图'));
  const job = f.catalog.startImport(request(scan));
  assert.equal(job.status, 'queued');
  assert.equal(f.catalog.status().assets, 0);
  assert.equal((await f.catalog.waitForJob(job.id)).status, 'complete');
  const detail = f.catalog.detail(f.catalog.status().jobs[0].experimentIds[0]);
  assert.equal(detail.assets.length, 2);
  for (const asset of detail.assets) {
    assert.equal(asset.name, '曝光.tif');
    assert.equal(asset.role, '待确认');
    const bytes = await fsp.readFile(f.catalog.assetPath(asset.id));
    assert.deepEqual(bytes, await fsp.readFile(asset.sourcePath));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  assert.deepEqual(await fsp.readFile(a), beforeA);
  assert.deepEqual(await fsp.readFile(b), beforeB);
  f.restart();
  assert.equal(f.catalog.detail(detail.experiment.id).assets.length, 2);
  assert.equal(f.catalog.status().jobs[0].status, 'complete');
});

test('duplicate contents are flagged and imported as separate provenance-preserving assets', async t => {
  const f = await fixture(t);
  const a = await f.file('来源/a.bin', 'identical'), b = await f.file('来源/b.bin', 'identical');
  const first = await importFiles(f.catalog, [a, b]);
  assert.deepEqual(first.scan.files.map(file => file.duplicateCount), [1, 1]);
  const scan = await f.catalog.scan([a]);
  assert.equal(scan.files[0].duplicateCount, 2);
  const job = f.catalog.startImport(request(scan, draft(), first.detail.experiment.id));
  assert.equal((await f.catalog.waitForJob(job.id)).status, 'complete');
  assert.equal(f.catalog.list({}).length, 1);
  assert.equal(f.catalog.detail(first.detail.experiment.id).assets.length, 3);
});

test('file assignments split one atomic import across existing and new experiments', async t => {
  const f = await fixture(t);
  const old = await importFiles(f.catalog, [await f.file('prior/a.bin')]);
  const scan = await f.catalog.scan([await f.file('batch/a.bin'), await f.file('batch/b.bin')]);
  const req = request(scan, draft({ title: '新共聚焦记录', type: '共聚焦' }));
  req.assignments[0] = { fileId: scan.files[0].id, role: '仪器原文件', targetExperimentId: old.detail.experiment.id };
  req.assignments[1].role = '导出图';
  const job = await f.catalog.waitForJob(f.catalog.startImport(req).id);
  assert.equal(job.status, 'complete');
  assert.equal(job.experimentIds.length, 2);
  assert.equal(f.catalog.detail(old.detail.experiment.id).assets.length, 2);
  const newId = job.experimentIds.find(id => id !== old.detail.experiment.id)!;
  assert.equal(f.catalog.detail(newId).assets[0].role, '导出图');
  assert.equal(f.catalog.detail(newId).experiment.type, '共聚焦');
});

test('changed and missing sources fail the whole import without phantom assets; retry persists across restart', async t => {
  const f = await fixture(t);
  const a = await f.file('source/a.bin', 'fixed original'), b = await f.file('sourceB/b.bin', 'second');
  const scan = await f.catalog.scan([a, b]);
  const hidden = `${path.dirname(b)}.hidden`;
  await fsp.rename(path.dirname(b), hidden);
  const job = f.catalog.startImport(request(scan));
  assert.equal((await f.catalog.waitForJob(job.id)).status, 'failed');
  assert.equal(f.catalog.status().assets, 0);
  assert.equal(f.catalog.status().experiments, 0);
  assert.ok((JSON.parse((f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id) as any).payload)).pendingDirectories.length > 0);
  f.restart();
  await fsp.rename(hidden, path.dirname(b));
  const retried = f.catalog.retryJob(job.id);
  assert.equal(retried.status, 'queued');
  const done = await f.catalog.waitForJob(job.id);
  assert.equal(done.status, 'complete', done.error || '');
  assert.equal(f.catalog.status().assets, 2);
  const scan2 = await f.catalog.scan([a]);
  await fsp.writeFile(a, 'mutated after scan');
  const changed = await f.catalog.waitForJob(f.catalog.startImport(request(scan2)).id);
  assert.equal(changed.status, 'failed');
  assert.match(changed.error!, /改变/);
  assert.equal(f.catalog.status().assets, 2);
});

test('post-copy corruption is detected before publication', async t => {
  const f = await fixture(t);
  const file = await f.file('source/data.bin');
  const scan = await f.catalog.scan([file]);
  const job = f.catalog.startImport(request(scan), progress => {
    if (progress.status === 'verifying') {
      const row = f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(progress.id) as any;
      const stored = JSON.parse(row.payload);
      const stage = stored.pendingDirectories.find((p: string) => p.startsWith('.staging/'));
      fs.writeFileSync(path.join(f.root, stage, scan.files[0].relativePath), 'corrupt copy');
    }
  });
  const done = await f.catalog.waitForJob(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error!, /副本校验失败/);
  assert.equal(f.catalog.status().assets, 0);
  assert.equal((await fsp.readdir(path.join(f.root, 'originals'))).length, 0);
});

test('cancel queued and active imports, prohibit writes and close while imports are busy', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin', Buffer.alloc(256 * 1024, 3))]);
  const queued = f.catalog.startImport(request(scan));
  assert.equal(f.catalog.busy, true);
  assert.throws(() => f.catalog.createAnimal('M1', ''), /等待完成/);
  assert.throws(() => f.catalog.close(), /等待完成/);
  f.catalog.cancelJob(queued.id);
  assert.equal((await f.catalog.waitForJob(queued.id)).status, 'cancelled');
  assert.equal(f.catalog.busy, false);
  const active = f.catalog.startImport(request(scan), job => { if (job.status === 'copying') f.catalog.cancelJob(job.id); });
  assert.equal((await f.catalog.waitForJob(active.id)).status, 'cancelled');
  assert.equal(f.catalog.status().assets, 0);
  assert.equal(f.catalog.busy, false);
  assert.equal((await f.catalog.waitForJob(f.catalog.retryJob(active.id).id)).status, 'complete');
});

test('restart marks persisted in-flight jobs interrupted, keeps pending directories and supports retry', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const cancelled = f.catalog.startImport(request(scan));
  f.catalog.cancelJob(cancelled.id);
  await f.catalog.waitForJob(cancelled.id);
  await new Promise(resolve => setImmediate(resolve));
  const row = f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(cancelled.id) as any;
  const stored = JSON.parse(row.payload);
  stored.job.status = 'copying';
  const pending = `originals/${randomUUID()}`;
  await fsp.mkdir(path.join(f.root, pending));
  await fsp.writeFile(path.join(f.root, pending, 'retained.bin'), 'uncommitted original');
  stored.pendingDirectories.push(pending);
  f.catalog.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(stored), cancelled.id);
  f.restart();
  assert.equal(f.catalog.status().jobs[0].status, 'interrupted');
  assert.equal(f.catalog.status().assets, 0);
  assert.equal((await f.catalog.waitForJob(f.catalog.retryJob(cancelled.id).id)).status, 'complete');
  assert.equal(await fsp.readFile(path.join(f.root, pending, 'retained.bin'), 'utf8'), 'uncommitted original');
});

test('metadata history, explicit animal identity, search and conservative templates survive restart', async t => {
  const f = await fixture(t);
  const a1 = f.catalog.createAnimal('鼠17', '甲批'), a2 = f.catalog.createAnimal('鼠17', '乙批');
  assert.notEqual(a1.id, a2.id);
  const record = draft({ fields: { target: 'FSP1', antibodies: 'A 1:1000', result: '不能复用', antibodyIntensity: '不能复用' }, rows: [{ id: randomUUID(), sampleId: '样本中文', animalId: a2.id, data: { manualResult: 'Het', uniqueSearch: '泳道独有字段' } }] });
  const imported = await importFiles(f.catalog, [await f.file('source/中文原始.bin')], record);
  const id = imported.detail.experiment.id;
  for (const query of ['鼠17', '乙批', '泳道独有字段', '中文原始.bin', 'FSP1']) assert.equal(f.catalog.list({ query }).length, 1, query);
  assert.equal(f.catalog.list({ project: '' }).length, 1, 'empty project is the All Projects UI selection');
  assert.equal(f.catalog.list({ dateFrom: '2026-09-27' }).length, 0);
  assert.equal(f.catalog.list({ type: '共聚焦' }).length, 0);
  const saved = f.catalog.save(id, { ...record, notes: 'edited notes' });
  const history = JSON.parse(saved.history[0].detail);
  assert.equal(history.before.notes, record.notes);
  assert.equal(history.after.notes, 'edited notes');
  const template = f.catalog.lastTemplate('WB')!;
  assert.equal(template.date, ''); assert.equal(template.notes, ''); assert.deepEqual(template.rows, []);
  assert.deepEqual(template.fields, { target: 'FSP1', antibodies: 'A 1:1000' });
  f.catalog.archive(id, true);
  assert.equal(f.catalog.list({ archived: false }).length, 0);
  assert.equal(f.catalog.list({ archived: true }).length, 1);
  f.restart();
  assert.equal(f.catalog.detail(id).experiment.rows[0].animalId, a2.id);
  assert.equal(f.catalog.animals().length, 2);
});

test('links are explicit, same-experiment only, acyclic and auditable', async t => {
  const f = await fixture(t);
  const first = await importFiles(f.catalog, [await f.file('a/one.bin'), await f.file('a/two.bin'), await f.file('a/three.bin')]);
  const [a, b, c] = first.detail.assets;
  f.catalog.linkAssets(a.id, b.id); f.catalog.linkAssets(b.id, c.id);
  assert.throws(() => f.catalog.linkAssets(c.id, a.id), /循环/);
  assert.throws(() => f.catalog.linkAssets(a.id, a.id), /自身/);
  const second = await importFiles(f.catalog, [await f.file('b/four.bin')]);
  assert.throws(() => f.catalog.linkAssets(a.id, second.detail.assets[0].id), /同一实验/);
  const linked = f.catalog.detail(first.detail.experiment.id);
  assert.equal(linked.links.length, 2);
  f.catalog.unlinkAssets(linked.links[0].id);
  assert.equal(f.catalog.detail(first.detail.experiment.id).links.length, 1);
  f.catalog.updateAsset(a.id, '仪器原文件');
  assert.equal(f.catalog.asset(a.id).role, '仪器原文件');
});

test('IPC validation, path confinement, symlink exclusion and exclusive maintenance lock', async t => {
  const f = await fixture(t);
  assert.throws(() => f.catalog.asset('../outside'), /ID/);
  await assert.rejects(f.catalog.scan(['relative']), /绝对路径/);
  const imported = await importFiles(f.catalog, [await f.file('source/file.bin')]);
  const asset = imported.detail.assets[0];
  const dbRow = f.catalog.db.prepare('SELECT storage_path FROM assets WHERE id=?').get(asset.id) as any;
  f.catalog.db.prepare('UPDATE assets SET storage_path=? WHERE id=?').run('../outside.bin', asset.id);
  assert.throws(() => f.catalog.assetPath(asset.id), /路径/);
  f.catalog.db.prepare('UPDATE assets SET storage_path=? WHERE id=?').run(dbRow.storage_path, asset.id);
  assert.throws(() => f.catalog.updateAsset(asset.id, '猜测原始' as any), /角色/);
  assert.throws(() => f.catalog.save(imported.detail.experiment.id, { ...draft(), type: 'invalid' as any }), /类型/);
  assert.throws(() => f.catalog.save(imported.detail.experiment.id, { ...draft(), date: '2026-02-30' }), /日期/);
  assert.throws(() => f.catalog.save(imported.detail.experiment.id, { ...draft(), rows: [{ id: randomUUID(), sampleId: '', animalId: randomUUID(), data: {} }] }), /动物 ID/);
  const libraryScan = await f.catalog.scan([f.root, imported.scan.roots[0], imported.scan.roots[0]]);
  assert.equal(libraryScan.files.length, 1);
  assert.ok(libraryScan.warnings.some(w => w.includes('资料库')));
  assert.ok(libraryScan.warnings.some(w => w.includes('重复来源')));
  const junction = path.join(f.temp, '重解析目录');
  try { await fsp.symlink(path.join(f.temp, 'source'), junction, 'junction'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  if (fs.existsSync(junction)) {
    const scanned = await f.catalog.scan([junction]);
    assert.equal(scanned.files.length, 0); assert.ok(scanned.warnings.some(w => w.includes('重解析点')));
    assert.throws(() => new Catalog(path.join(junction, 'new-library')), /重解析点/);
    await fsp.unlink(junction);
  }
  let release!: () => void;
  const maintenance = f.catalog.withExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  assert.equal(f.catalog.busy, true);
  assert.throws(() => f.catalog.startImport(request(imported.scan)), /维护/);
  assert.throws(() => f.catalog.createAnimal('鼠1', ''), /等待完成/);
  await assert.rejects(f.catalog.withExclusive(async () => {}), /等待完成/);
  release(); await maintenance;
  assert.equal(f.catalog.busy, false);
});

test('disk-space failure is deterministic and cannot publish assets or originals', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const actualStatfs = fsp.statfs;
  fsp.statfs = (async () => ({ bavail: 0n, bsize: 4096n })) as unknown as typeof fsp.statfs;
  try {
    const failed = await f.catalog.waitForJob(f.catalog.startImport(request(scan)).id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /空间不足/);
    assert.equal(f.catalog.status().assets, 0); assert.equal(f.catalog.status().experiments, 0);
    assert.deepEqual(await fsp.readdir(path.join(f.root, 'originals')), []);
    assert.equal(f.catalog.busy, false);
  } finally { fsp.statfs = actualStatfs; }
});

test('failure after directory rename rolls back all catalog changes and tracks retained originals through retry', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  f.catalog.db.exec("CREATE TRIGGER force_commit_failure BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END");
  const job = f.catalog.startImport(request(scan));
  const failed = await f.catalog.waitForJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /injected catalog failure/);
  assert.equal(f.catalog.status().assets, 0); assert.equal(f.catalog.status().experiments, 0);
  assert.equal(f.catalog.status().projects.length, 0);
  const stored = JSON.parse((f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id) as any).payload);
  const retained = stored.pendingDirectories.find((p: string) => p.startsWith('originals/'));
  assert.ok(retained);
  assert.equal(await fsp.readFile(path.join(f.root, retained, scan.files[0].relativePath), 'utf8'), 'original bytes');
  assert.equal(f.catalog.busy, false);
  f.restart();
  f.catalog.db.exec('DROP TRIGGER force_commit_failure');
  const retry = await f.catalog.waitForJob(f.catalog.retryJob(job.id).id);
  assert.equal(retry.status, 'complete', retry.error || '');
  assert.equal(f.catalog.status().assets, 1);
  assert.equal(f.catalog.status().experiments, 1);
  assert.equal((await fsp.readdir(path.join(f.root, 'originals'))).length, 2);
  const after = JSON.parse((f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id) as any).payload);
  assert.ok(after.pendingDirectories.includes(retained));
});

test('in-flight scan blocks close, writes, imports and exclusive maintenance; failures release the lock', async t => {
  const f = await fixture(t);
  const file = await f.file('source/data.bin');
  const priorScan = await f.catalog.scan([file]);
  const scanning = f.catalog.scan([file]);
  assert.equal(f.catalog.busy, true);
  assert.throws(() => f.catalog.close(), /扫描/);
  assert.throws(() => f.catalog.createAnimal('鼠1', ''), /扫描/);
  assert.throws(() => f.catalog.startImport(request(priorScan)), /扫描/);
  await assert.rejects(f.catalog.withExclusive(async () => {}), /扫描/);
  await scanning;
  assert.equal(f.catalog.busy, false);
  await assert.rejects(f.catalog.scan(['relative']), /绝对路径/);
  assert.equal(f.catalog.busy, false);
});

test('future-version catalogs are rejected without schema or file modifications', async t => {
  const f = await fixture(t);
  const root = path.join(f.temp, 'future-library');
  await fsp.mkdir(root);
  const filename = path.join(root, 'catalog.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('schema_version','999'); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve');");
  db.close();
  const before = await fsp.readFile(filename);
  assert.throws(() => new Catalog(root), /版本不兼容/);
  assert.deepEqual(await fsp.readFile(filename), before);
  assert.deepEqual(await fsp.readdir(root), ['catalog.sqlite']);
});

test('queued imports run serially and waitForJob observes an idle catalog after the last commit', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  let secondId = '';
  const observedSecondStatuses: string[] = [];
  const first = f.catalog.startImport(request(scan, draft({ title: '第一批' })), job => {
    if (job.status === 'copying') observedSecondStatuses.push(f.catalog.status().jobs.find(item => item.id === secondId)?.status || 'missing');
  });
  const second = f.catalog.startImport(request(scan, draft({ title: '第二批' })));
  secondId = second.id;
  const [one, two] = await Promise.all([f.catalog.waitForJob(first.id), f.catalog.waitForJob(second.id)]);
  assert.equal(one.status, 'complete'); assert.equal(two.status, 'complete');
  assert.ok(observedSecondStatuses.length > 0);
  assert.ok(observedSecondStatuses.every(status => status === 'queued'));
  assert.equal(f.catalog.busy, false);
  assert.equal(f.catalog.status().assets, 2); assert.equal(f.catalog.status().experiments, 2);
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`publication retries one transient ${code} then commits verified originals`, async t => {
    const f = await fixture(t);
    const scan = await f.catalog.scan([await f.file('source/data.bin')]);
    const actualRename = fsp.rename;
    let attempts = 0;
    fsp.rename = async (source, destination) => {
      if (String(source).startsWith(path.join(f.root, '.staging') + path.sep) && ++attempts === 1) throw Object.assign(new Error('transient publication lock'), { code });
      return actualRename(source, destination);
    };
    try {
      const done = await f.catalog.waitForJob(f.catalog.startImport(request(scan)).id);
      assert.equal(done.status, 'complete', done.error || '');
      assert.equal(attempts, 2);
      assert.equal(f.catalog.status().assets, 1);
      const asset = f.catalog.detail(done.experimentIds[0]).assets[0];
      assert.deepEqual(await fsp.readFile(f.catalog.assetPath(asset.id)), await fsp.readFile(scan.files[0].sourcePath));
    } finally { fsp.rename = actualRename; }
  });
}

test('persistent publication lock stops after five attempts and retains verified staging without phantom assets', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const actualRename = fsp.rename;
  let attempts = 0;
  fsp.rename = async () => { attempts++; throw Object.assign(new Error('persistent publication lock'), { code: 'EPERM' }); };
  try {
    const job = f.catalog.startImport(request(scan));
    const done = await f.catalog.waitForJob(job.id);
    assert.equal(done.status, 'failed'); assert.equal(attempts, 5);
    assert.equal(f.catalog.status().assets, 0); assert.equal(f.catalog.status().experiments, 0);
    assert.deepEqual(await fsp.readdir(path.join(f.root, 'originals')), []);
    const stored = JSON.parse((f.catalog.db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id) as any).payload);
    const stage = stored.pendingDirectories.find((p: string) => p.startsWith('.staging/'));
    assert.equal(await fsp.readFile(path.join(f.root, stage, scan.files[0].relativePath), 'utf8'), 'original bytes');
    assert.equal(f.catalog.busy, false);
  } finally { fsp.rename = actualRename; }
});

test('publication backoff is cancellable and does not attempt another rename after cancellation', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const actualRename = fsp.rename;
  let attempts = 0, jobId = '';
  let cancelTimer: NodeJS.Timeout | undefined;
  fsp.rename = async () => {
    attempts++;
    cancelTimer = setTimeout(() => f.catalog.cancelJob(jobId), 20);
    throw Object.assign(new Error('transient publication lock'), { code: 'EBUSY' });
  };
  try {
    jobId = f.catalog.startImport(request(scan)).id;
    const done = await f.catalog.waitForJob(jobId);
    assert.equal(done.status, 'cancelled'); assert.equal(attempts, 1);
    assert.equal(f.catalog.status().assets, 0); assert.equal(f.catalog.status().experiments, 0);
    assert.deepEqual(await fsp.readdir(path.join(f.root, 'originals')), []);
    assert.equal(f.catalog.busy, false);
  } finally { fsp.rename = actualRename; if (cancelTimer) clearTimeout(cancelTimer); }
});

test('publication retries rehash staged bytes and never overwrite a destination created during backoff', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const actualRename = fsp.rename;
  let attempts = 0;
  fsp.rename = async (source) => {
    attempts++;
    await fsp.writeFile(path.join(String(source), scan.files[0].relativePath), 'modified during publication');
    throw Object.assign(new Error('transient publication lock'), { code: 'EACCES' });
  };
  try {
    const failed = await f.catalog.waitForJob(f.catalog.startImport(request(scan)).id);
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /最终副本校验失败/); assert.equal(attempts, 1);
    assert.equal(f.catalog.status().assets, 0);
    let reservedDestination = '';
    attempts = 0;
    fsp.rename = async (_source, destination) => {
      attempts++; reservedDestination = String(destination);
      await fsp.mkdir(reservedDestination);
      await fsp.writeFile(path.join(reservedDestination, '保留.txt'), 'must not replace');
      throw Object.assign(new Error('transient publication lock'), { code: 'EBUSY' });
    };
    const collision = await f.catalog.waitForJob(f.catalog.startImport(request(scan)).id);
    assert.equal(collision.status, 'failed'); assert.match(collision.error!, /目标目录已存在/); assert.equal(attempts, 1);
    assert.equal(await fsp.readFile(path.join(reservedDestination, '保留.txt'), 'utf8'), 'must not replace');
    assert.equal(f.catalog.status().assets, 0);
  } finally { fsp.rename = actualRename; }
});

test('publication does not retry non-transient rename failures', async t => {
  const f = await fixture(t);
  const scan = await f.catalog.scan([await f.file('source/data.bin')]);
  const actualRename = fsp.rename;
  let attempts = 0;
  fsp.rename = async () => { attempts++; throw Object.assign(new Error('non-transient missing directory'), { code: 'ENOENT' }); };
  try {
    const done = await f.catalog.waitForJob(f.catalog.startImport(request(scan)).id);
    assert.equal(done.status, 'failed'); assert.equal(attempts, 1);
    assert.equal(f.catalog.status().assets, 0);
  } finally { fsp.rename = actualRename; }
});

test('simulated repeated tail genotyping preserves animal identity and independent decisions through edits and restart', async t => {
  const f = await fixture(t);
  const label = '模拟动物 SIM-MOUSE-017（非真实实验）';
  const sharedAnimal = f.catalog.createAnimal(label, '模拟验收数据：用于两次独立鉴定，不代表真实动物');
  const sameLabelAnimal = f.catalog.createAnimal(label, '模拟验收数据：同名但内部 ID 不同的对照动物');
  assert.notEqual(sharedAnimal.id, sameLabelAnimal.id);
  const record = (title: string, animalId: string, sampleId: string, manualResult: string, reviewState: string): ExperimentDraft => draft({
    title, type: '鼠尾鉴定', date: '', project: '模拟验收（非真实实验数据）', tags: ['模拟数据'],
    notes: '仅用于软件验收；人工判定字符串为模拟值，不代表实际基因型或实验结论。',
    fields: { gene: '模拟基因 GENE-X', primerName: '模拟引物 SIM-PRIMER', expectedBands: '模拟预期条带' },
    rows: [{ id: randomUUID(), sampleId, animalId, data: { manualResult, reviewState, lane: '模拟泳道 1' } }],
  });
  const first = await importFiles(f.catalog, [await f.file('模拟鉴定首次/模拟记录.txt', 'SIMULATED TEST DATA ONLY: first tail genotyping')], record('模拟鼠尾鉴定：首次', sharedAnimal.id, 'SIM-TAIL-001', '模拟判定：WT', '未复核'));
  const second = await importFiles(f.catalog, [await f.file('模拟鉴定复检/模拟记录.txt', 'SIMULATED TEST DATA ONLY: repeat tail genotyping')], record('模拟鼠尾鉴定：独立复检', sharedAnimal.id, 'SIM-TAIL-002', '模拟判定：Het', '待复核'));
  const control = await importFiles(f.catalog, [await f.file('模拟同名动物对照/模拟记录.txt', 'SIMULATED TEST DATA ONLY: different animal with same label')], record('模拟鼠尾鉴定：同名不同 ID 对照', sameLabelAnimal.id, 'SIM-TAIL-CONTROL', '模拟判定：KO', '未复核'));
  const firstId = first.detail.experiment.id, secondId = second.detail.experiment.id, controlId = control.detail.experiment.id;
  const assertIdentitySearch = () => {
    assert.deepEqual(f.catalog.list({ type: '鼠尾鉴定', query: sharedAnimal.id }).map(e => e.id).sort(), [firstId, secondId].sort());
    assert.deepEqual(f.catalog.list({ type: '鼠尾鉴定', query: sameLabelAnimal.id }).map(e => e.id), [controlId]);
    assert.equal(f.catalog.list({ query: label }).length, 3, 'same labels must not collapse distinct internal animal IDs');
  };
  assertIdentitySearch();
  const firstOriginal = Buffer.from(await fsp.readFile(f.catalog.assetPath(first.detail.assets[0].id)));
  const changedDecision = f.catalog.save(secondId, { ...second.detail.experiment, rows: second.detail.experiment.rows.map(row => ({ ...row, data: { ...row.data, manualResult: '模拟编辑判定：KO' } })) });
  assert.equal(changedDecision.experiment.rows[0].data.reviewState, '待复核', 'editing a decision must not automatically mark it reviewed');
  const changedReview = f.catalog.save(secondId, { ...changedDecision.experiment, rows: changedDecision.experiment.rows.map(row => ({ ...row, data: { ...row.data, reviewState: '已复核' } })) });
  assert.equal(changedReview.experiment.rows[0].data.manualResult, '模拟编辑判定：KO', 'changing review state must not rewrite a decision');
  const assertIndependentResults = () => {
    const one = f.catalog.detail(firstId), two = f.catalog.detail(secondId);
    assert.equal(one.experiment.rows[0].animalId, sharedAnimal.id);
    assert.equal(two.experiment.rows[0].animalId, sharedAnimal.id);
    assert.equal(one.experiment.rows[0].data.manualResult, '模拟判定：WT');
    assert.equal(one.experiment.rows[0].data.reviewState, '未复核');
    assert.equal(two.experiment.rows[0].data.manualResult, '模拟编辑判定：KO');
    assert.equal(two.experiment.rows[0].data.reviewState, '已复核');
    const initialRecord = JSON.parse(one.history.find(entry => entry.action === '导入原始资料')!.detail).initialRecord;
    assert.equal(initialRecord.rows[0].data.manualResult, '模拟判定：WT', 'later edits must preserve the first imported result and its audit history');
  };
  assertIndependentResults();
  f.restart();
  assertIdentitySearch();
  assertIndependentResults();
  assert.equal(f.catalog.animals().length, 2);
  assert.deepEqual(await fsp.readFile(f.catalog.assetPath(first.detail.assets[0].id)), firstOriginal);
});

test('simulated confocal sample and field-of-view records remain searchable and persist across restart', async t => {
  const f = await fixture(t);
  const rowId = randomUUID();
  const confocal = draft({
    title: '模拟共聚焦验收（非真实实验）', type: '共聚焦', date: '', project: '模拟验收（非真实实验数据）', tags: ['模拟数据'],
    notes: '仅用于软件验收，不包含真实显微图像、细胞观察或实验结论。',
    fields: { microscope: '模拟显微镜', objective: '模拟物镜参数', channels: '模拟通道参数' },
    rows: [{ id: rowId, sampleId: 'SIM-CONFOCAL-SAMPLE-008', data: { group: '模拟处理组', replicate: 'SIM-REP-02', field: 'SIM-FOV-独立视野-007', channels: '模拟视野通道', file: '模拟占位记录.txt', notes: '模拟样本与视野记录' } }],
  });
  const imported = await importFiles(f.catalog, [await f.file('模拟共聚焦/模拟占位记录.txt', 'SIMULATED TEST DATA ONLY: confocal placeholder, not a microscopy image')], confocal);
  const experimentId = imported.detail.experiment.id;
  const assertSampleSearch = () => {
    for (const query of ['SIM-CONFOCAL-SAMPLE-008', 'SIM-FOV-独立视野-007', 'SIM-REP-02', '模拟视野通道']) {
      assert.deepEqual(f.catalog.list({ type: '共聚焦', query }).map(experiment => experiment.id), [experimentId], query);
    }
    const stored = f.catalog.detail(experimentId).experiment;
    assert.deepEqual(stored.rows, confocal.rows);
    assert.deepEqual(stored.fields, confocal.fields);
  };
  assertSampleSearch();
  f.restart();
  assertSampleSearch();
});
