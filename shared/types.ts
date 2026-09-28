export type ExperimentType = 'WB' | '共聚焦' | '鼠尾鉴定' | '其他实验';
export type RecordStatus = '待补信息' | '待复核' | '已整理';
export type AssetRole = '待确认' | '仪器原文件' | '导出图' | '处理结果' | '实验记录' | '汇总材料';
export interface RecordRow { id: string; sampleId: string; animalId?: string; data: Record<string, string> }
export interface Animal { id: string; label: string; notes: string }
export interface ExperimentDraft {
  title: string; type: ExperimentType; date: string; project: string; tags: string[];
  status: RecordStatus; notes: string; fields: Record<string, string>; rows: RecordRow[];
}
export interface Experiment extends ExperimentDraft { id: string; archived: boolean; createdAt: string; updatedAt: string; fileCount: number; totalSize: number }
export interface Asset {
  id: string; experimentId: string; importId: string; name: string; relativePath: string;
  sourcePath: string; sha256: string; size: number; role: AssetRole; createdAt: string;
}
export interface AssetLink { id: string; sourceId: string; derivedId: string }
export interface HistoryEntry { id: string; experimentId: string; at: string; action: string; detail: string }
export interface ExperimentDetail { experiment: Experiment; assets: Asset[]; links: AssetLink[]; history: HistoryEntry[] }
export interface ListFilter { query?: string; type?: string; project?: string; dateFrom?: string; dateTo?: string; archived?: boolean }
export interface ScanFile { id: string; sourcePath: string; relativePath: string; size: number; mtimeMs: number; sha256: string; duplicateCount: number; suggestedRole: AssetRole }
export interface ImportScan { id: string; roots: string[]; files: ScanFile[]; totalSize: number; warnings: string[]; suggestedTitle: string }
export interface ImportAssignment { fileId: string; role: AssetRole; targetExperimentId?: string }
export interface ImportRequest { scanId: string; draft: ExperimentDraft; assignments: ImportAssignment[] }
export type JobStatus = 'queued' | 'copying' | 'verifying' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
export interface ImportJob { id: string; status: JobStatus; totalFiles: number; completedFiles: number; totalBytes: number; copiedBytes: number; message: string; error?: string; createdAt: string; experimentIds: string[] }
export interface LibraryStatus { root: string | null; defaultRoot: string; projects: string[]; experiments: number; assets: number; totalSize: number; jobs: ImportJob[] }
export interface PreviewResult { supported: boolean; dataUrl?: string; page: number; pages: number; width?: number; height?: number; message: string }
export interface ExportResult { path: string; files: number; message: string }
export interface ArchiveApi {
  status(): Promise<LibraryStatus>;
  chooseLibrary(): Promise<LibraryStatus | null>;
  chooseImport(): Promise<string[] | null>;
  pathsForFiles(files: File[]): string[];
  scan(paths: string[]): Promise<ImportScan>;
  importFiles(request: ImportRequest): Promise<ImportJob>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<ImportJob>;
  list(filter: ListFilter): Promise<Experiment[]>;
  detail(id: string): Promise<ExperimentDetail>;
  save(id: string, draft: ExperimentDraft): Promise<ExperimentDetail>;
  archive(id: string, archived: boolean): Promise<void>;
  lastTemplate(type: ExperimentType): Promise<ExperimentDraft | null>;
  animals(): Promise<Animal[]>;
  createAnimal(label: string, notes: string): Promise<Animal>;
  updateAsset(id: string, role: AssetRole): Promise<void>;
  linkAssets(sourceId: string, derivedId: string): Promise<void>;
  unlinkAssets(id: string): Promise<void>;
  preview(id: string, page: number): Promise<PreviewResult>;
  openWorkingCopy(id: string): Promise<string>;
  exportExperiment(id: string): Promise<ExportResult | null>;
  backup(): Promise<ExportResult | null>;
  restore(): Promise<LibraryStatus | null>;
  onProgress(callback: (job: ImportJob) => void): () => void;
}
declare global { interface Window { archive: ArchiveApi } }
