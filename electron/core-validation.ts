import path from 'node:path';
import type { AssetRole, ExperimentDraft, ExperimentType, ListFilter, RecordStatus } from '../shared/types';

export const TYPES: ExperimentType[] = ['WB', '共聚焦', '鼠尾鉴定', '其他实验'];
export const ROLES: AssetRole[] = ['待确认', '仪器原文件', '导出图', '处理结果', '实验记录', '汇总材料'];
const STATUSES: RecordStatus[] = ['待补信息', '待复核', '已整理'];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象');
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}无效`);
  return value;
}
export function id(value: unknown): string {
  const v = string(value, 'ID', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('ID 无效');
  return v;
}
export function role(value: unknown): AssetRole {
  if (!ROLES.includes(value as AssetRole)) throw new Error('文件角色无效');
  return value as AssetRole;
}
export function type(value: unknown): ExperimentType {
  if (!TYPES.includes(value as ExperimentType)) throw new Error('实验类型无效');
  return value as ExperimentType;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('布尔参数无效');
  return value;
}
export function date(value: unknown): string {
  const v = string(value, '日期', 10);
  if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)) throw new Error('日期应为有效 YYYY-MM-DD');
  return v;
}
function fields(value: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const entries = Object.entries(record(value));
  if (entries.length > 200) throw new Error('字段太多');
  for (const [key, item] of entries) {
    string(key, '字段名', 200);
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('字段名无效');
    result[key] = string(item, '字段内容', 50000);
  }
  return result;
}
export function draft(value: unknown): ExperimentDraft {
  const v = record(value);
  const title = string(v.title, '标题', 500).trim();
  if (!title) throw new Error('请填写实验标题');
  if (!STATUSES.includes(v.status as RecordStatus)) throw new Error('整理状态无效');
  if (!Array.isArray(v.tags) || v.tags.length > 100) throw new Error('标签无效');
  if (!Array.isArray(v.rows) || v.rows.length > 10000) throw new Error('样本行无效');
  const rowIds = new Set<string>();
  const rows = v.rows.map(item => {
    const r = record(item);
    const rowId = id(r.id);
    if (rowIds.has(rowId)) throw new Error('样本行 ID 重复');
    rowIds.add(rowId);
    return { id: rowId, sampleId: string(r.sampleId, '样本编号', 500), ...(r.animalId !== undefined ? { animalId: id(r.animalId) } : {}), data: fields(r.data) };
  });
  return { title, type: type(v.type), date: date(v.date), project: string(v.project, '课题', 500).trim(), tags: [...new Set(v.tags.map(t => string(t, '标签', 200).trim()).filter(Boolean))], status: v.status as RecordStatus, notes: string(v.notes, '备注', 100000), fields: fields(v.fields), rows };
}
export function filter(value: unknown): ListFilter {
  const v = record(value);
  const project = v.project !== undefined ? string(v.project, '课题', 500) : undefined;
  return { ...(v.query !== undefined ? { query: string(v.query, '搜索词', 2000) } : {}), ...(v.type !== undefined && v.type !== '' ? { type: type(v.type) } : {}), ...(project ? { project } : {}), ...(v.dateFrom !== undefined ? { dateFrom: date(v.dateFrom) } : {}), ...(v.dateTo !== undefined ? { dateTo: date(v.dateTo) } : {}), ...(v.archived !== undefined ? { archived: boolean(v.archived) } : {}) };
}
export function absolute(value: unknown): string {
  const p = string(value, '路径', 32760);
  if (!path.isAbsolute(p)) throw new Error('路径必须是绝对路径');
  return path.resolve(p);
}
export function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function confined(root: string, relative: string): string {
  string(relative, '库内路径', 32760);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.' || !p) || relative.includes(':')) throw new Error('库内路径无效');
  const result = path.resolve(root, relative);
  if (!contains(root, result) || result.toLowerCase() === root.toLowerCase()) throw new Error('路径越界');
  return result;
}
