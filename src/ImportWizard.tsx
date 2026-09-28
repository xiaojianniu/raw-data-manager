import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Search, Check } from 'lucide-react';
import type { Animal, ArchiveApi, AssetRole, Experiment, ExperimentDraft, ImportAssignment, ImportJob, ImportScan } from '../shared/types';
import { blankDraft, errorText, ROLES, sizeText } from './model';
import { Busy, ErrorBanner, JobCard, Modal } from './components';
import { DraftEditor } from './DraftEditor';

export function ImportWizard({ api, scan, experiments, animals, refreshAnimals, close, jobUpdate, complete, confirm }: { api: ArchiveApi; scan: ImportScan; experiments: Experiment[]; animals: Animal[]; refreshAnimals: () => Promise<void>; close: () => void; jobUpdate: (job: ImportJob) => void; complete: () => Promise<void>; confirm: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<ExperimentDraft>({ ...blankDraft(), title: scan.suggestedTitle });
  const [assignments, setAssignments] = useState<Record<string, ImportAssignment>>(() => Object.fromEntries(scan.files.map(file => [file.id, { fileId: file.id, role: '待确认' }])));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(scan.files.map(file => file.id)));
  const [query, setQuery] = useState('');
  const [bulkTarget, setBulkTarget] = useState('');
  const [bulkRole, setBulkRole] = useState<AssetRole>('待确认');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (!job || ['queued', 'copying', 'verifying'].includes(job.status)) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [job?.status]);
  const visible = useMemo(() => scan.files.filter(file => file.relativePath.toLowerCase().includes(query.toLowerCase())), [query, scan.files]);
  const usesDraft = [...selected].some(id => !assignments[id]?.targetExperimentId);
  const bytes = scan.files.reduce((sum, file) => sum + (selected.has(file.id) ? file.size : 0), 0);
  const patch = (id: string, value: Partial<ImportAssignment>) => setAssignments(prev => ({ ...prev, [id]: { ...prev[id], ...value } }));
  const updateJob = (value: ImportJob) => { setJob(value); jobUpdate(value); };
  const start = async () => { setBusy(true); setError(''); try { const result = await api.importFiles({ scanId: scan.id, draft, assignments: [...selected].map(id => assignments[id]) }); updateJob(result); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const quit = async () => { if (busy) return; if (!job && !await confirm('关闭导入向导会丢弃本次文件分类与实验信息，是否继续？')) return; close(); };
  const cancel = async (id: string) => { try { await api.cancelJob(id); } catch (e) { setError(errorText(e)); } };
  const retry = async (id: string) => { try { const result = await api.retryJob(id); updateJob(result); } catch (e) { setError(errorText(e)); } };
  return <Modal title={job ? '导入任务' : '确认文件与实验归属'} wide close={() => void quit()} footer={job ? <><span className="hint">关闭窗口后，任务仍可在资料库中查看。</span><button onClick={() => { void complete(); close(); }}>返回实验列表</button></> : <><span className="hint">已选 {selected.size} 个文件 · {sizeText(bytes)} · 确认后复制并校验</span><button disabled={busy} onClick={() => void quit()}>取消</button><button className="primary" disabled={busy || !selected.size || (usesDraft && !draft.title.trim())} onClick={() => void start()}>{busy ? <Busy>开始导入…</Busy> : <><Check size={16} />确认导入</>}</button></>}>
    {error && <ErrorBanner message={error} dismiss={() => setError('')} />}{job ? <ImportJobView api={api} job={job} update={updateJob} complete={complete} cancel={cancel} retry={retry} /> : <><div className="import-summary"><strong>{scan.files.length} 个文件 · {sizeText(scan.totalSize)}</strong><small>{scan.roots.join('；')}</small></div>{scan.warnings.length > 0 && <div className="warning"><AlertTriangle size={18} /><div>{scan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}<p className="hint">分类建议来自文件格式，实际角色默认“待确认”。相同哈希仅提示内容重复，不自动合并或跳过。</p><div className="import-toolbar"><div className="search-input"><Search size={16} /><input aria-label="搜索待导入文件" placeholder="筛选文件名或路径" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="批量实验归属" value={bulkTarget} onChange={e => setBulkTarget(e.target.value)}><option value="">本次新建实验</option>{experiments.filter(experiment => !experiment.archived).map(experiment => <option key={experiment.id} value={experiment.id}>{experiment.title} · {experiment.id.slice(-6)}</option>)}</select><select aria-label="批量文件角色" value={bulkRole} onChange={e => setBulkRole(e.target.value as AssetRole)}>{ROLES.map(role => <option key={role}>{role}</option>)}</select><button disabled={!selected.size} onClick={() => setAssignments(prev => { const next = { ...prev }; selected.forEach(id => { next[id] = { ...next[id], role: bulkRole, targetExperimentId: bulkTarget || undefined }; }); return next; })}>应用到已选</button></div><div className="table-scroll import-table"><table><thead><tr><th><input aria-label="选择当前筛选的全部文件" type="checkbox" checked={visible.length > 0 && visible.every(file => selected.has(file.id))} onChange={e => { const next = new Set(selected); visible.forEach(file => e.target.checked ? next.add(file.id) : next.delete(file.id)); setSelected(next); }} /></th><th>文件 / 相对路径</th><th>大小</th><th>重复提示</th><th>建议</th><th>实际角色</th><th>实验归属</th></tr></thead><tbody>{visible.map(file => <tr key={file.id}><td><input aria-label={`导入 ${file.relativePath}`} type="checkbox" checked={selected.has(file.id)} onChange={e => { const next = new Set(selected); e.target.checked ? next.add(file.id) : next.delete(file.id); setSelected(next); }} /></td><td className="path-cell" title={file.sourcePath}>{file.relativePath}</td><td>{sizeText(file.size)}</td><td>{file.duplicateCount ? <span className="duplicate">已有 {file.duplicateCount} 份相同内容</span> : '—'}</td><td>{file.suggestedRole}</td><td><select aria-label={`${file.relativePath} 实际角色`} value={assignments[file.id].role} onChange={e => patch(file.id, { role: e.target.value as AssetRole })}>{ROLES.map(role => <option key={role}>{role}</option>)}</select></td><td><select aria-label={`${file.relativePath} 实验归属`} value={assignments[file.id].targetExperimentId || ''} onChange={e => patch(file.id, { targetExperimentId: e.target.value || undefined })}><option value="">本次新建实验</option>{experiments.filter(experiment => !experiment.archived).map(experiment => <option key={experiment.id} value={experiment.id}>{experiment.title} · {experiment.id.slice(-6)}</option>)}</select></td></tr>)}</tbody></table>{!visible.length && <div className="table-empty">没有匹配的文件。</div>}</div>{usesDraft ? <section className="import-metadata"><h3>本次新建实验</h3><DraftEditor api={api} draft={draft} change={setDraft} animals={animals} refreshAnimals={refreshAnimals} compact confirm={confirm} /></section> : <p className="hint">所有已选文件均分配到已有实验，本次不会新建实验。</p>}</>}
  </Modal>;
}

function ImportJobView({ api, job, update, complete, cancel, retry }: { api: ArchiveApi; job: ImportJob; update: (job: ImportJob) => void; complete: () => Promise<void>; cancel: (id: string) => Promise<void>; retry: (id: string) => Promise<void> }) {
  const [error, setError] = useState('');
  const callbacks = useRef({ update, complete }); callbacks.current = { update, complete };
  const completionReported = useRef(false);
  const live = ['queued', 'copying', 'verifying'].includes(job.status);
  useEffect(() => {
    let active = true;
    let pending = false;
    let version = 0;
    let terminal = !live;
    if (live) completionReported.current = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const apply = (next: ImportJob) => {
      if (!active || next.id !== job.id || (terminal && ['queued', 'copying', 'verifying'].includes(next.status))) return;
      version += 1;
      callbacks.current.update(next);
      terminal = !['queued', 'copying', 'verifying'].includes(next.status);
      if (terminal && timer) clearInterval(timer);
      if (next.status === 'complete' && !completionReported.current) { completionReported.current = true; void callbacks.current.complete().catch(e => { if (active) setError(errorText(e)); }); }
    };
    const lookup = async () => {
      if (!active || pending) return;
      pending = true;
      const requestedVersion = version;
      try { const status = await api.status(); if (!active || requestedVersion !== version) return; const next = status.jobs.find(item => item.id === job.id); if (next) apply(next); setError(''); }
      catch (e) { if (active) setError(`无法刷新任务状态：${errorText(e)}`); }
      finally { pending = false; }
    };
    const unsubscribe = api.onProgress(apply);
    if (live) timer = setInterval(() => { if (!terminal) void lookup(); }, 1000);
    void lookup();
    return () => { active = false; unsubscribe(); if (timer) clearInterval(timer); };
  }, [api, job.id, live]);
  return <>{error && <ErrorBanner message={error} dismiss={() => setError('')} />}<JobCard job={job} cancel={cancel} retry={retry} /></>;
}
