import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('build',{recursive:true});
const png=await sharp('assets/app-icon.svg').resize(256,256).png().toBuffer();
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
await writeFile('build/app-icon.ico',Buffer.concat([header,png]));
