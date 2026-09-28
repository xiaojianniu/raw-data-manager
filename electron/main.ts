import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { Catalog } from './core';
import { StorageService, restoreLibrary, checkPlainPath, isInside } from './storage-service';
import type { LibraryStatus, ImportJob } from '../shared/types';

const DEFAULT_ROOT = 'C:\\LGR\\实验数据管理库';
if (process.env.LAB_ARCHIVE_USER_DATA) app.setPath('userData', path.resolve(process.env.LAB_ARCHIVE_USER_DATA));
let window: BrowserWindow | null = null;
let catalog: Catalog | null = null;
let service: StorageService | null = null;
let opening = false;
let restoring = false;
let closingMessage = false;
const configPath = () => path.join(app.getPath('userData'), 'settings.json');
const status = (): LibraryStatus => catalog ? {...catalog.status(), defaultRoot: DEFAULT_ROOT} : {root:null, defaultRoot:DEFAULT_ROOT, projects:[], experiments:0, assets:0, totalSize:0, jobs:[]};
function current() { if (!catalog) throw new Error('请先选择或创建资料库'); return catalog; }
function storage() { if (!service) throw new Error('请先选择或创建资料库'); return service; }
function text(value: unknown, label = '参数') { if (typeof value !== 'string' || !value.trim() || value.length > 32768) throw new Error(label + '无效'); return value; }
async function setLibrary(root: string, create: boolean) {
  if (opening || catalog?.busy) throw new Error('当前任务完成后才能切换资料库');
  opening = true;
  try {
    root = path.resolve(root);
    for (const privateRoot of ['preview-cache','working-copies'].map(name => path.join(app.getPath('userData'), name))) {
      if (isInside(root,privateRoot) || isInside(privateRoot,root)) throw new Error('资料库必须与程序缓存和工作副本目录分开');
    }
    if (catalog?.root.toLowerCase() === root.toLowerCase()) return status();
    if (catalog && (isInside(catalog.root, root) || isInside(root, catalog.root))) throw new Error('新资料库不能与当前资料库相互嵌套');
    if (create) await mkdir(root, {recursive:true});
    await checkPlainPath(root);
    const files = await readdir(root);
    if (!files.includes('catalog.sqlite') && files.length) throw new Error('所选目录已有其他文件。请选择空文件夹或已有实验档案资料库。');
    if (!create && !files.includes('catalog.sqlite')) throw new Error('原资料库不可用，请重新选择资料库位置');
    const next = new Catalog(root);
    try {
      await mkdir(app.getPath('userData'), {recursive: true});
      await writeFile(configPath() + '.tmp', JSON.stringify({libraryRoot:root}, null, 2));
      await rename(configPath() + '.tmp', configPath());
    } catch (error) { next.close(); throw error; }
    catalog?.close();
    catalog = next;
    service = new StorageService(next, path.join(app.getPath('userData'), 'preview-cache'), path.join(app.getPath('userData'), 'working-copies'));
    return status();
  } finally { opening = false; }
}
async function chooseDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const answer = await dialog.showOpenDialog(window!, {title, defaultPath, properties:['openDirectory','createDirectory']});
  return answer.canceled ? null : answer.filePaths[0] ?? null;
}
function progress(job: ImportJob) { if (window && !window.isDestroyed()) window.webContents.send('archive:progress', job); }
function registerIpc() {
  const methods: Record<string, (...args: any[]) => unknown> = {
    status,
    chooseLibrary: async () => { const root=await chooseDirectory('选择空文件夹创建资料库，或打开已有资料库', catalog?.root ?? DEFAULT_ROOT); return root ? setLibrary(root,true) : null; },
    chooseImport: async () => { current(); const answer = await dialog.showOpenDialog(window!,{title:'选择实验文件夹（可多选）',properties:['openDirectory','multiSelections']}); return answer.canceled ? null : answer.filePaths; },
    scan: async paths => {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 1000 || paths.some(p => typeof p !== 'string')) throw new Error('请选择实验文件或文件夹');
      return current().scan(paths);
    },
    importFiles: request => current().startImport(request,progress),
    cancelJob: id => current().cancelJob(text(id)), retryJob: id => current().retryJob(text(id),progress),
    list: filter => current().list(filter ?? {}), detail: id => current().detail(text(id)),
    save: (id,draft) => current().save(text(id),draft),
    archive: (id,hidden) => { if(typeof hidden !== 'boolean') throw new Error('归档状态无效'); current().archive(text(id),hidden); },
    lastTemplate: type => current().lastTemplate(type), animals: () => current().animals(),
    createAnimal: (label,notes) => current().createAnimal(text(label,'鼠号'), typeof notes === 'string' ? notes : ''),
    updateAsset: (id,role) => current().updateAsset(text(id),role),
    linkAssets: (source,derived) => current().linkAssets(text(source),text(derived)),
    unlinkAssets: id => current().unlinkAssets(text(id)),
    preview: (id,page) => storage().preview(text(id),page),
    openWorkingCopy: async id => {
      const file = await storage().workingCopy(text(id));
      // Windows shell association must never execute imported executable/script content.
      const ext=path.extname(file).toLowerCase();
      const allowed=new Set(['.scn','.mscn','.czi','.oir','.lif','.tif','.tiff','.png','.jpg','.jpeg','.pdf','.pptx','.xlsx','.xls','.csv','.txt','.md','.zip','.docx','.doc']);
      if (!allowed.has(ext)) { shell.showItemInFolder(file); return '工作副本已生成；此类型请在文件夹中选择合适的软件打开。'; }
      const error = await shell.openPath(file);
      if (error) { shell.showItemInFolder(file); return '工作副本已生成，但系统没有成功打开。请在文件夹中选择原软件。'; }
      return '已在原软件中打开独立工作副本；编辑结果请重新导入。';
    },
    exportExperiment: async id => { text(id); const parent=await chooseDirectory('选择实验导出包的保存位置'); return parent ? storage().exportExperiment(id,parent) : null; },
    backup: async () => { current(); const parent=await chooseDirectory('选择完整备份保存位置（建议另一个磁盘）'); return parent ? storage().backup(parent) : null; },
    restore: async () => {
      if (catalog?.busy) throw new Error('请等待当前任务完成');
      const source=await chooseDirectory('选择包含 backup-manifest.json 的备份目录'); if(!source) return null;
      const parent=await chooseDirectory('选择恢复资料库的上级目录（自动创建新文件夹）'); if(!parent) return null;
      if(catalog && isInside(catalog.root,parent)) throw new Error('恢复目标不能放在当前资料库内部');
      restoring = true;
      let restored: string;
      try { restored = catalog ? await catalog.withExclusive(() => restoreLibrary(source,parent)) : await restoreLibrary(source,parent); }
      finally { restoring = false; }
      return setLibrary(restored,false);
    }
  };
  for (const [method, handler] of Object.entries(methods)) ipcMain.handle('archive:' + method, async (event,...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源');
    if ((opening || restoring) && method !== 'status') throw new Error('正在打开或恢复资料库，请稍候');
    try { return await handler(...args); } catch (error) { throw new Error((error as Error).message || '操作失败'); }
  });
}
async function createWindow() {
  window = new BrowserWindow({width:1536,height:1024,minWidth:960,minHeight:680,show:process.env.LAB_ARCHIVE_TEST_HIDDEN !== '1',backgroundColor:'#ffffff',title:'实验档案',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.webContents.on('will-prevent-unload', async event => {
    const choice = dialog.showMessageBoxSync(window!, {type:'question',title:'记录尚未保存',message:'放弃未保存的修改并关闭？',buttons:['继续编辑','放弃修改'],defaultId:0,cancelId:0});
    if(choice === 1) event.preventDefault();
  });
  window.on('close',event=>{
    if(catalog?.busy) {
      event.preventDefault();
      if(!closingMessage) { closingMessage=true; void dialog.showMessageBox(window!,{type:'info',message:'当前有导入、导出或备份任务。请等待完成，或在任务列表取消导入后再退出。'}).finally(()=>closingMessage=false); }
    }
  });
  const dev=process.env.VITE_DEV_SERVER_URL;
  if(dev) {
    if(dev !== 'http://127.0.0.1:5173') throw new Error('开发服务器必须使用本机固定地址');
    await window.loadURL(dev);
  } else await window.loadFile(path.join(__dirname,'../dist/index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{ if(window){ if(window.isMinimized()) window.restore(); window.show(); window.focus(); }});
  app.whenReady().then(async()=>{
    registerIpc();
    let startupError='';
    try {
      const override=process.env.LAB_ARCHIVE_LIBRARY;
      if(override) await setLibrary(override,true);
      else { try { const settings=JSON.parse(await readFile(configPath(),'utf8')); if(settings.libraryRoot) await setLibrary(settings.libraryRoot,false); } catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') startupError=(error as Error).message; } }
    } catch(error) { startupError=(error as Error).message; }
    await createWindow();
    if(startupError) await dialog.showMessageBox(window!,{type:'warning',message:'无法打开上次资料库，请重新选择位置。',detail:startupError});
  }).catch(error=>{dialog.showErrorBox('实验档案启动失败',String(error));app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('will-quit',()=>{catalog?.close();catalog=null;});
}
