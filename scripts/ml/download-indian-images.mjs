// Downloads up to N photos per dish from the snow3751/Indian_food_images dataset
// (268 Indian dishes, image files stored individually on Hugging Face).
// Usage: node scripts/ml/download-indian-images.mjs [perClass=50]
import fs from 'node:fs';
import path from 'node:path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';

const PER_CLASS = Number(process.argv[2] ?? 50);
const DIR = '.cache/datasets/indian';
const index = path.join(DIR, 'train-conv.parquet');
if (!fs.existsSync(index)) {
  const res = await fetch('https://huggingface.co/datasets/snow3751/Indian_food_images/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(index, Buffer.from(await res.arrayBuffer()));
}
const rows = await parquetReadObjects({ file: await asyncBufferFromFile(index) });

// hf://datasets/snow3751/Indian_food_images@<rev>/<class>/<file>
const jobs = [];
const perClass = new Map();
for (const r of rows) {
  const m = /^hf:\/\/datasets\/snow3751\/Indian_food_images@([0-9a-f]+)\/(.+)\/([^/]+)$/.exec(r.image.path);
  if (!m) continue;
  const [, rev, cls, file] = m;
  const n = perClass.get(cls) ?? 0;
  if (n >= PER_CLASS) continue;
  perClass.set(cls, n + 1);
  const out = path.join(DIR, 'images', cls, file);
  if (!fs.existsSync(out)) jobs.push({ url: `https://huggingface.co/datasets/snow3751/Indian_food_images/resolve/${rev}/${encodeURIComponent(cls).replace(/%2F/g, '/')}/${file}`, out });
}
console.log(`${perClass.size} dishes, ${jobs.length} photos to download`);

let done = 0, failed = 0;
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(job.url);
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.mkdirSync(path.dirname(job.out), { recursive: true });
        fs.writeFileSync(job.out, Buffer.from(await res.arrayBuffer()));
        break;
      } catch (err) {
        if (attempt === 4) { failed++; console.warn('failed', job.url, err.message); }
      }
    }
    if (++done % 1000 === 0) console.log(`  ${done} downloaded`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`finished: ${done - failed} ok, ${failed} failed`);
