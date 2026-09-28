import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Link2, Unlink, Image as ImageIcon, FileText } from 'lucide-react';
import type { ArchiveApi, Asset, AssetRole, ExperimentDetail, PreviewResult } from '../shared/types';
import { ROLES, errorText, sizeText, timeText } from './model';
import { Busy, Empty, ErrorBanner, Field } from './components';

export function AssetPreview({ api, asset }: { api: ArchiveApi; asset: Asset | null }) {
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPage(0); setPreview(null); setError(''); }, [asset?.id]);
  useEffect(() => { if (!asset) return; let active = true; setBusy(true); setPreview(null); setError(''); api.preview(asset.id, page).then(result => { if (active) setPreview(result); }).catch(e => { if (active) setError(errorText(e)); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [api, asset?.id, page]);
  return <div className="preview-area">{busy ? <Busy>生成预览…</Busy> : !asset ? <div className="preview-placeholder"><ImageIcon size={44} strokeWidth={1.2} /><p>选择文件查看预览</p><small>支持 JPEG、PNG、TIFF</small></div> : preview?.supported && preview.dataUrl ? <><img src={preview.dataUrl} alt={`${asset.name} 第 ${page + 1} 页预览`} /><div className="preview-caption">{preview.width} × {preview.height} 像素{preview.pages > 1 && <span className="pager"><button disabled={page === 0} aria-label="上一页" onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button>第 {page + 1} / {preview.pages} 页<button disabled={page + 1 >= preview.pages} aria-label="下一页" onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button></span>}</div></> : <div className="preview-placeholder"><FileText size={36} /><p>{error || preview?.message || '暂无预览'}</p><small>可打开工作副本查看原格式文件。</small></div>}</div>;
}

export function AssetsPanel({ api, detail, refresh, setError: parentError }: { api: ArchiveApi; detail: ExperimentDetail; refresh: () => Promise<void>; setError: (message: string) => void }) {
  const [selected, setSelected] = useState<string>(detail.assets[0]?.id || '');
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState('');
  const [derived, setDerived] = useState('');
  const [error, setError] = useState('');
  const asset = detail.assets.find(file => file.id === selected) || null;
  const action = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setError(''); try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } };
  const open = async () => { if (!asset) return; setBusy('open'); try { await api.openWorkingCopy(asset.id); } catch (e) { parentError(errorText(e)); } finally { setBusy(''); } };
  const name = (id: string) => detail.assets.find(file => file.id === id)?.name || id;
  return <div>{error && <ErrorBanner message={error} dismiss={() => setError('')} />}<p className="hint">文件保存在资料库中；“打开工作副本”使用独立副本，保留已导入的档案。</p><div className="asset-layout"><div className="table-scroll"><table><thead><tr><th>文件</th><th>角色</th><th>大小</th></tr></thead><tbody>{detail.assets.map(file => <tr key={file.id} className={file.id === selected ? 'selected' : ''}><td><button className="text-button file-name" onClick={() => setSelected(file.id)} title={file.relativePath}>{file.name}</button><small>{file.relativePath}</small></td><td><select aria-label={`${file.name} 文件角色`} disabled={!!busy} value={file.role} onChange={e => void action(file.id, () => api.updateAsset(file.id, e.target.value as AssetRole))}>{ROLES.map(role => <option key={role}>{role}</option>)}</select></td><td>{sizeText(file.size)}</td></tr>)}</tbody></table>{!detail.assets.length && <Empty title="尚未导入文件">从主界面导入文件夹并分配到该实验。</Empty>}</div><div><AssetPreview api={api} asset={asset} />{asset && <><button className="full-width" disabled={!!busy} onClick={() => void open()}><ExternalLink size={15} />{busy === 'open' ? '正在打开…' : '打开工作副本'}</button><dl className="file-details"><dt>来源路径</dt><dd>{asset.sourcePath}</dd><dt>SHA-256</dt><dd className="mono">{asset.sha256}</dd><dt>导入时间</dt><dd>{timeText(asset.createdAt)}</dd><dt>档案相对路径</dt><dd>{asset.relativePath}</dd><dt>大小</dt><dd>{sizeText(asset.size)}</dd></dl></>}</div></div><div className="section-heading"><h3>原始文件与派生文件关联</h3></div><p className="hint">关联仅用于记录来源关系，不代表处理过程或结果已验证。</p><div className="link-builder"><Field label="来源文件"><select value={source} onChange={e => setSource(e.target.value)}><option value="">选择来源</option>{detail.assets.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></Field><Field label="派生文件"><select value={derived} onChange={e => setDerived(e.target.value)}><option value="">选择派生文件</option>{detail.assets.filter(file => file.id !== source).map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></Field><button disabled={!!busy || !source || !derived || source === derived} onClick={() => void action('link', async () => { await api.linkAssets(source, derived); setSource(''); setDerived(''); })}><Link2 size={15} />建立关联</button></div><div className="links-list">{detail.links.map(link => <div key={link.id}><span>{name(link.sourceId)} <span className="muted">→</span> {name(link.derivedId)}</span><button disabled={!!busy} onClick={() => void action(link.id, () => api.unlinkAssets(link.id))}><Unlink size={14} />解除</button></div>)}{!detail.links.length && <p className="muted">暂无关联。</p>}</div></div>;
}

export function HistoryPanel({ detail }: { detail: ExperimentDetail }) { return <div className="history-list">{!detail.history.length && <Empty title="暂无历史记录" />}{detail.history.map(entry => <article key={entry.id}><div><strong>{entry.action}</strong><time>{timeText(entry.at)}</time></div><HistoryDetail value={entry.detail} /></article>)}</div>; }
function HistoryDetail({ value }: { value: string }) { let parsed: unknown; try { parsed = JSON.parse(value); } catch { return <pre>{value}</pre>; } return <pre>{JSON.stringify(parsed, null, 2)}</pre>; }
