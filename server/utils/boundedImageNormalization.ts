import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Decode untrusted media outside the API process. Pixel, output, thread,
 * heap and wall-clock budgets apply before any scan/provider sees the image. */
export async function normalizeSupportImage(buffer: Buffer): Promise<{
  normalized: Buffer; derivative: Buffer; width: number; height: number;
}> {
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('Image exceeds the 5 MiB limit');
  const code = `
    const sharp=require(process.argv[1]); sharp.cache(false); sharp.concurrency(1);
    const chunks=[]; let size=0;
    process.stdin.on('data',chunk=>{size+=chunk.length;if(size>5242880)process.exit(1);chunks.push(chunk)});
    process.stdin.on('end',async()=>{
      try {
        const image=sharp(Buffer.concat(chunks),{failOn:'warning',limitInputPixels:12000000,animated:false});
        const metadata=await image.metadata();
        if(!metadata.width||!metadata.height||(metadata.pages||1)>1)throw Error('Unsupported image');
        const original=await image.rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true})
          .jpeg({quality:90}).timeout({seconds:5}).toBuffer({resolveWithObject:true});
        const derivative=await sharp(original.data,{limitInputPixels:12000000}).resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
          .jpeg({quality:82}).timeout({seconds:5}).toBuffer({resolveWithObject:true});
        if(original.data.length+derivative.data.length>12582912)throw Error('Output limit');
        const header=Buffer.from(JSON.stringify({size:original.data.length,width:derivative.info.width,height:derivative.info.height})+'\\n');
        process.stdout.write(Buffer.concat([header,original.data,derivative.data]));
      } catch { process.exitCode=1; }
    });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', '--input-type=commonjs', '-e', code, require.resolve('sharp')], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' },
    });
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('Image decoding failed or exceeded its resource limits'));
    };
    const timer = setTimeout(fail, 12_000);
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024 + 1024) { fail(); return; }
      chunks.push(chunk);
    });
    child.once('close', status => {
      if (settled) return;
      if (status !== 0) { fail(); return; }
      try {
        const output = Buffer.concat(chunks);
        const offset = output.indexOf(10);
        if (offset < 1 || offset > 512) { fail(); return; }
        const header = JSON.parse(output.subarray(0, offset).toString('utf8'));
        if (!Number.isSafeInteger(header.size) || header.size <= 0 || header.size >= output.length - offset - 1) { fail(); return; }
        const body = output.subarray(offset + 1);
        settled = true;
        clearTimeout(timer);
        resolve({ normalized: body.subarray(0, header.size), derivative: body.subarray(header.size), width: header.width, height: header.height });
      } catch { fail(); }
    });
    child.stdin.end(buffer);
  });
}
