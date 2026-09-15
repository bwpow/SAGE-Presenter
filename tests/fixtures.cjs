// Synthetic fixtures only: no private media, logos, servers or network downloads.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body=Buffer.concat([Buffer.from(type),data]); const size=Buffer.alloc(4),crc=Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([size,body,crc]);
}
async function png(filename, width=756, height=189, color=[55,8,71]) {
  const header=Buffer.alloc(13); header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) for(let c=0;c<3;c++) pixels[y*(width*3+1)+1+x*3+c]=color[c];
  await fs.writeFile(filename,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
async function fixtures(directory, videos=true) {
  for(const sub of ['', 'sequence','landscape','gallery','video','auto']) await fs.mkdir(path.join(directory,sub),{recursive:true});
  await png(path.join(directory,'empty.png'));
  for(let i=1;i<=13;i++) await png(path.join(directory,'sequence',`${String(i).padStart(2,'0')}.png`),640,360,[i*15,80,200-i*10]);
  await png(path.join(directory,'landscape','landscape.png'));
  for(let i=1;i<=6;i++) await png(path.join(directory,'gallery',`${i}.png`),640,360,[i*30,50,180]);
  await png(path.join(directory,'auto','after.png'));
  if(videos) {
    const ffmpeg=process.env.FFMPEG_PATH || 'ffmpeg';
    for(const name of ['portrait.mov','sample.mp4','demo.mp4']) {
      execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`testsrc2=size=${name.endsWith('.mov')?'360x640':'640x360'}:rate=24`,'-t','3','-c:v','libx264','-pix_fmt','yuv420p','-an',path.join(directory,name === 'demo.mp4' ? 'auto' : 'video',name)],{windowsHide:true,timeout:30000});
    }
  }
}
module.exports={fixtures,png};
