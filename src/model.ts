import type { ExperimentDraft, ExperimentType, AssetRole, RecordStatus } from '../shared/types';

export const TYPES: ExperimentType[] = ['WB', '共聚焦', '鼠尾鉴定', '其他实验'];
export const ROLES: AssetRole[] = ['待确认', '仪器原文件', '导出图', '处理结果', '实验记录', '汇总材料'];
export const STATUSES: RecordStatus[] = ['待补信息', '待复核', '已整理'];
export const FIELD_SETS: Record<ExperimentType, [string, string][]> = {
  WB: [['target', '靶蛋白'], ['loadingControl', '内参'], ['antibodies', '抗体与稀释比例'], ['membrane', '膜信息'], ['instrument', '成像仪器'], ['conditions', '实验条件']],
  '共聚焦': [['channels', '通道与染料'], ['microscope', '显微镜'], ['objective', '物镜'], ['acquisition', '采集参数'], ['conditions', '处理条件']],
  '鼠尾鉴定': [['gene', '基因'], ['primerName', '引物名称'], ['primerForward', '正向引物序列'], ['primerReverse', '反向引物序列'], ['expectedBands', '预期条带大小（bp）'], ['conditions', 'PCR 条件']],
  '其他实验': [['method', '实验方法'], ['instrument', '仪器'], ['conditions', '实验条件']],
};
export const ROW_SETS: Record<ExperimentType, [string, string][]> = {
  WB: [['sampleId', '样本 ID'], ['group', '组别'], ['lane', '泳道'], ['membrane', '膜编号'], ['marker', '标志物'], ['antibody', '抗体'], ['exposureFile', '曝光文件'], ['notes', '备注']],
  '共聚焦': [['sampleId', '样本 ID'], ['group', '组别'], ['replicate', '重复'], ['field', '视野'], ['channels', '通道'], ['file', '文件'], ['notes', '备注']],
  '鼠尾鉴定': [['sampleId', '样本 ID'], ['animalId', '实验动物'], ['sampledDate', '取样日期'], ['gene', '基因'], ['primer', '引物'], ['expectedBand', '预期条带（bp）'], ['lane', '泳道'], ['control', '对照'], ['manualResult', '人工判读'], ['reviewState', '复核状态'], ['notes', '备注']],
  '其他实验': [['sampleId', '样本 ID'], ['group', '组别'], ['file', '文件'], ['result', '人工记录'], ['notes', '备注']],
};
export function blankDraft(type: ExperimentType = 'WB'): ExperimentDraft { return { title: '', type, date: '', project: '', tags: [], status: '待补信息', notes: '', fields: {}, rows: [] }; }
export function cloneDraft(draft: ExperimentDraft): ExperimentDraft { return { title: draft.title, type: draft.type, date: draft.date, project: draft.project, tags: [...draft.tags], status: draft.status, notes: draft.notes, fields: { ...draft.fields }, rows: draft.rows.map(row => ({ ...row, data: { ...row.data } })) }; }
export function sizeText(value: number) { if (!value) return '0 B'; const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3); return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][unit]}`; }
export function timeText(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
