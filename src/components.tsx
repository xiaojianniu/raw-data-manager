import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, X, LoaderCircle, FolderOpen, CheckCircle2, RotateCcw } from 'lucide-react';
import type { ImportJob, RecordStatus } from '../shared/types';
import { sizeText } from './model';

export function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}</label>; }
export function Badge({ status }: { status: RecordStatus }) { return <span className={`badge ${status === '已整理' ? 'done' : status === '待复核' ? 'review' : ''}`}>{status}</span>; }
export function Busy({ children }: { children?: ReactNode }) { return <span className="busy"><LoaderCircle size={16} className="spin" />{children}</span>; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><FolderOpen size={36} strokeWidth={1.4} /><h3>{title}</h3><p>{children}</p></div>; }
export function ErrorBanner({ message, dismiss }: { message: string; dismiss?: () => void }) { return <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{message}</span>{dismiss && <button aria-label="关闭错误提示" className="icon-button" onClick={dismiss}><X size={16} /></button>}</div>; }
export function Modal({ title, children, close, wide = false, footer }: { title: string; children: ReactNode; close: () => void; wide?: boolean; footer?: ReactNode }) {
  const container = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const element = container.current; element?.focus(); const key = (event: KeyboardEvent) => { const overlays = document.querySelectorAll('.overlay'); if (element?.parentElement !== overlays[overlays.length - 1]) return; if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); } if (event.key === 'Tab') { const items = element?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'); const visible = Array.from(items || []).filter(item => item.offsetParent !== null); if (!visible.length) { event.preventDefault(); return; } const first = visible[0], last = visible[visible.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); } } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); }; }, []);
  return <div className="overlay"><section ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={22} /></button></header><div className="modal-body">{children}</div>{footer && <footer>{footer}</footer>}</section></div>;
}
export function useConfirm() {
  const [pending, setPending] = useState<{ text: string; resolve: (value: boolean) => void } | null>(null);
  const confirm = (text: string) => new Promise<boolean>(resolve => setPending({ text, resolve }));
  const finish = (value: boolean) => { pending?.resolve(value); setPending(null); };
  const dialog = pending && <Modal title="确认操作" close={() => finish(false)} footer={<><button onClick={() => finish(false)}>取消</button><button className="primary" onClick={() => finish(true)}>继续</button></>}><p>{pending.text}</p></Modal>;
  return { confirm, dialog };
}
const JOB_LABEL: Record<ImportJob['status'], string> = { queued: '等待开始', copying: '正在复制', verifying: '正在校验', complete: '导入完成', failed: '导入失败', cancelled: '已取消', interrupted: '导入中断' };
export function JobCard({ job, cancel, retry }: { job: ImportJob; cancel: (id: string) => Promise<void>; retry: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const live = ['queued', 'copying', 'verifying'].includes(job.status);
  const action = async (fn: (id: string) => Promise<void>) => { setBusy(true); try { await fn(job.id); } finally { setBusy(false); } };
  const percent = job.totalBytes ? Math.min(100, Math.round(job.copiedBytes / job.totalBytes * 100)) : job.status === 'complete' ? 100 : 0;
  return <div className="job"><div className="job-title"><strong>{job.status === 'complete' && <CheckCircle2 size={16} />}{live && <LoaderCircle size={16} className="spin" />}{JOB_LABEL[job.status]}</strong><small>{job.id.slice(-8)}</small></div><progress value={percent} max={100} aria-label="导入进度" /><p>{job.completedFiles} / {job.totalFiles} 个文件 · {sizeText(job.copiedBytes)} / {sizeText(job.totalBytes)}</p><p>{job.message}</p>{job.error && <p className="error-text">{job.error}</p>}<div className="job-actions">{live && <button disabled={busy} onClick={() => void action(cancel)}>取消导入</button>}{['failed', 'interrupted', 'cancelled'].includes(job.status) && <button disabled={busy} onClick={() => void action(retry)}><RotateCcw size={14} />{busy ? '正在重试…' : '重试'}</button>}</div></div>;
}
