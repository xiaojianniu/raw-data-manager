import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ArchiveApi, ImportJob } from '../shared/types';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('archive:' + method, ...args);
const api: ArchiveApi = {
  status: () => invoke('status'), chooseLibrary: () => invoke('chooseLibrary'),
  chooseImport: () => invoke('chooseImport'), pathsForFiles: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
  scan: paths => invoke('scan', paths), importFiles: request => invoke('importFiles', request),
  cancelJob: id => invoke('cancelJob', id), retryJob: id => invoke('retryJob', id),
  list: filter => invoke('list', filter), detail: id => invoke('detail', id),
  save: (id, draft) => invoke('save', id, draft), archive: (id, hidden) => invoke('archive', id, hidden),
  lastTemplate: type => invoke('lastTemplate', type), animals: () => invoke('animals'),
  createAnimal: (label, notes) => invoke('createAnimal', label, notes),
  updateAsset: (id, role) => invoke('updateAsset', id, role),
  linkAssets: (source, derived) => invoke('linkAssets', source, derived), unlinkAssets: id => invoke('unlinkAssets', id),
  preview: (id, page) => invoke('preview', id, page), openWorkingCopy: id => invoke('openWorkingCopy', id),
  exportExperiment: id => invoke('exportExperiment', id), backup: () => invoke('backup'), restore: () => invoke('restore'),
  onProgress: callback => {
    const listener = (_event: unknown, job: ImportJob) => callback(job);
    ipcRenderer.on('archive:progress', listener);
    return () => ipcRenderer.removeListener('archive:progress', listener);
  }
};
contextBridge.exposeInMainWorld('archive', api);
