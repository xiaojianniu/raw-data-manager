import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Catalog } from '../electron/core';
import { StorageService, hashFile, restoreLibrary, within } from '../electron/storage-service';
import type { ExperimentDraft } from '../shared/types';

const draft: ExperimentDraft = {title:'完整性验收',type:'WB',date:'',project:'测试课题',tags:['验收'],status:'待补信息',notes:'尚未判读',fields:{target:'测试蛋白'},rows:[]};
async function fixture() {
  const base=await mkdtemp(path.join(os.tmpdir(),'labarchive-storage-'));
  const source=path.join(base,'原始测试文件'); await mkdir(source);
  await sharp({create:{width:16,height:16,channels:3,background:'#668899'}}).png().toFile(path.join(source,'显示测试.png'));
  await writeFile(path.join(source,'容器.czi'),'opaque scientific container test');
  const library=path.join(base,'资料库');
  const catalog=new Catalog(library);
  const scan=await catalog.scan([source]);
  const job=catalog.startImport({scanId:scan.id,draft,assignments:scan.files.map(file=>({fileId:file.id,role:'待确认'}))});
  const end=await catalog.waitForJob(job.id); assert.equal(end.status,'complete',end.error || '');
  const service=new StorageService(catalog,path.join(base,'缓存'),path.join(base,'工作副本'));
  return {base,source,library,catalog,service,id:end.experimentIds[0]};
}
test('image preview is separate and opaque/corrupt files remain archived',async()=>{
  const f=await fixture();
  try {
    const assets=f.catalog.detail(f.id).assets;
    const png=assets.find(a=>a.name.endsWith('.png'))!;
    const before=await hashFile(f.catalog.assetPath(png.id));
    const p=await f.service.preview(png.id,0);
    assert.equal(p.supported,true); assert.equal(p.width,16); assert.match(p.dataUrl!,/^data:image\/png;base64,/);
    assert.equal(await hashFile(f.catalog.assetPath(png.id)),before);
    assert.equal((await f.service.preview(assets.find(a=>a.name.endsWith('.czi'))!.id,0)).supported,false);
    await assert.rejects(()=>f.service.preview(png.id,-1),/页码/);
    assert.equal((await f.service.preview(png.id,1)).supported,false);
    const invalid=path.join(f.source,'损坏.tif');await writeFile(invalid,'bad tiff');
    const scan=await f.catalog.scan([invalid]);
    const job=f.catalog.startImport({scanId:scan.id,draft,assignments:scan.files.map(a=>({fileId:a.id,role:'待确认',targetExperimentId:f.id}))});
    await f.catalog.waitForJob(job.id);
    const broken=f.catalog.detail(f.id).assets.find(a=>a.name==='损坏.tif')!;
    assert.equal((await f.service.preview(broken.id)).supported,false);
    assert.equal(f.catalog.detail(f.id).assets.length,3);
  } finally {f.catalog.close();}
});
test('working copies retain companions and editing never changes archive',async()=>{
  const f=await fixture();
  try {
    const asset=f.catalog.detail(f.id).assets[0];
    const opened=await f.service.workingCopy(asset.id);
    assert.notEqual(opened,f.catalog.assetPath(asset.id));
    assert.equal(await hashFile(opened),asset.sha256);
    await writeFile(opened,'edited working copy');
    assert.equal(await hashFile(f.catalog.assetPath(asset.id)),asset.sha256);
    assert.equal((await readdir(path.dirname(opened))).length,2);
  } finally {f.catalog.close();}
});
test('export retains metadata, animals, links, history and verifies all payload files',async()=>{
  const f=await fixture();
  try {
    const detail=f.catalog.detail(f.id); const animal=f.catalog.createAnimal('同名鼠号','来源 A');
    f.catalog.save(f.id,{...detail.experiment,rows:[{id:crypto.randomUUID(),sampleId:'S01',animalId:animal.id,data:{manualResult:'待判定',reviewState:'待复核',note:'=1+1'}}]});
    f.catalog.linkAssets(detail.assets[0].id,detail.assets[1].id);
    const exported=await f.service.exportExperiment(f.id,f.base);
    const metadata=JSON.parse(await readFile(path.join(exported.path,'metadata.json'),'utf8'));
    assert.equal(metadata.animals[0].id,animal.id); assert.equal(metadata.links.length,1); assert.ok(metadata.history.length>=3);
    assert.match(await readFile(path.join(exported.path,'records.csv'),'utf8'),/'=1\+1/);
    const manifest=JSON.parse(await readFile(path.join(exported.path,'manifest.json'),'utf8'));
    for(const file of manifest.files) assert.equal(await hashFile(within(exported.path,file.path)),file.sha256);
    await assert.rejects(()=>f.service.exportExperiment(f.id,f.library),/之外/);
  } finally {f.catalog.close();}
});
test('complete backup restores archived data, byte hashes, metadata and search',async()=>{
  const f=await fixture();
  try {
    f.catalog.archive(f.id,true);
    const backup=await f.service.backup(f.base);
    const restoredRoot=await restoreLibrary(backup.path,f.base);
    const restored=new Catalog(restoredRoot);
    try {
      assert.equal(restored.list({archived:false}).length,0);
      assert.equal(restored.list({archived:true,query:'测试蛋白'}).length,1);
      assert.equal(restored.detail(f.id).experiment.archived,true);
      for(const a of restored.detail(f.id).assets) assert.equal(await hashFile(restored.assetPath(a.id)),a.sha256);
      assert.equal(restored.detail(f.id).history.length,f.catalog.detail(f.id).history.length);
    } finally {restored.close();}
  } finally {f.catalog.close();}
});
test('backup/restore rejects corruption and traversal without publishing success',async()=>{
  const f=await fixture();
  try {
    const backup=await f.service.backup(f.base);
    const manifestPath=path.join(backup.path,'backup-manifest.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    const original=manifest.files[0].path;
    manifest.files[0].path='../escape.bin'; await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(()=>restoreLibrary(backup.path,f.base),/跨目录/);
    manifest.files[0].path=original; await writeFile(manifestPath,JSON.stringify(manifest));
    await writeFile(within(backup.path,original),'tampered');
    await assert.rejects(()=>restoreLibrary(backup.path,f.base),/大小|校验/);
    const before=f.catalog.detail(f.id).assets[0];
    await writeFile(f.catalog.assetPath(before.id),'corrupted test archive');
    await assert.rejects(()=>f.service.backup(f.base),/大小|校验/);
    const finished=(await readdir(f.base)).filter(name=>name.startsWith('实验档案备份')&&!name.endsWith('.partial'));
    assert.equal(finished.length,1);
    assert.equal(f.catalog.detail(f.id).assets.length,2);
  } finally {f.catalog.close();}
});

// Two 2x2 16-bit grayscale pages, built expressly as a synthetic decoder fixture.
function tiff16TwoPages() {
  const tags=10, ifdSize=2+tags*12+4, first=8, second=first+ifdSize, pixels=second+ifdSize;
  const buf=Buffer.alloc(pixels+16);buf.write('II');buf.writeUInt16LE(42,2);buf.writeUInt32LE(first,4);
  function page(offset:number,dataOffset:number,next:number) {
    buf.writeUInt16LE(tags,offset);
    const entries=[[256,4,1,2],[257,4,1,2],[258,3,1,16],[259,3,1,1],[262,3,1,1],[273,4,1,dataOffset],[277,3,1,1],[278,4,1,2],[279,4,1,8],[339,3,1,1]];
    entries.forEach(([tag,type,count,value],i)=>{const p=offset+2+i*12;buf.writeUInt16LE(tag,p);buf.writeUInt16LE(type,p+2);buf.writeUInt32LE(count,p+4);buf.writeUInt32LE(value,p+8);});
    buf.writeUInt32LE(next,offset+2+tags*12);
  }
  page(first,pixels,second);page(second,pixels+8,0);
  [0,16384,32768,65535,65535,32768,16384,0].forEach((v,i)=>buf.writeUInt16LE(v,pixels+i*2));return buf;
}
test('16-bit multipage TIFF selects individual pages without modifying source',async()=>{
  const f=await fixture();
  try {
    const file=path.join(f.source,'16位多页.tif');await writeFile(file,tiff16TwoPages());
    const scan=await f.catalog.scan([file]);const job=f.catalog.startImport({scanId:scan.id,draft,assignments:scan.files.map(a=>({fileId:a.id,role:'导出图',targetExperimentId:f.id}))});
    await f.catalog.waitForJob(job.id);
    const asset=f.catalog.detail(f.id).assets.find(a=>a.name==='16位多页.tif')!;
    const p0=await f.service.preview(asset.id,0),p1=await f.service.preview(asset.id,1);
    assert.equal(p0.supported,true,p0.message);assert.equal(p1.supported,true,p1.message);assert.equal(p0.pages,2);assert.notEqual(p0.dataUrl,p1.dataUrl);
    assert.equal(await hashFile(file),asset.sha256);
  } finally {f.catalog.close();}
});
