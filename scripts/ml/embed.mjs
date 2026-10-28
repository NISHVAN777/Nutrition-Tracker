// Turns every training photo into a 512-number CLIP image embedding, using exactly the
// same model and preprocessing as the live app (server/vision.js).
// Output: .cache/emb/<source>.f32 (N x 512 float32) + <source>.json ({ labels, splits, keys }).
// Work is checkpointed per input file (.cache/emb/parts/), so an interrupted run resumes.
// Usage: node scripts/ml/embed.mjs [source...]   sources: food101 indian vietnamese malaysian
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DS = path.join(ROOT, '.cache', 'datasets');
const OUT = path.join(ROOT, '.cache', 'emb');
const PARTS = path.join(OUT, 'parts');
fs.mkdirSync(PARTS, { recursive: true });

env.localModelPath = path.join(ROOT, 'models') + path.sep;
env.allowRemoteModels = false;
const MODEL = 'Xenova/clip-vit-base-patch32';
const processor = await AutoProcessor.from_pretrained(MODEL);
const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' });

const classes = (src) => JSON.parse(fs.readFileSync(path.join(DS, src, 'classes.json'), 'utf8'));
// Deterministic 85/15 train/test split for sets without an official test split.
const splitOf = (key) => (crypto.createHash('md5').update(key).digest()[0] < 38 ? 'test' : 'train');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, what) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err) {
      // Ride out network outages (e.g. the computer sleeping): up to ~2 hours of retries.
      if (attempt >= 30) throw err;
      console.warn(`  retry ${attempt} (${what}): ${err.cause?.code ?? err.message}`);
      await sleep(Math.min(5000 * attempt, 300_000));
    }
  }
}

// A request that hangs (e.g. after a connection reset) is abandoned and retried.
const hardTimeout = (ms, fn) => Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('request timed out')), ms).unref())]);

// Remote parquet file read with HTTP range requests (only the needed bytes), with retries.
async function remoteBuffer(url) {
  const head = await withRetry(() => fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) }), 'HEAD');
  const byteLength = Number(head.headers.get('content-length'));
  if (!byteLength) throw new Error(`No content-length for ${url}`);
  return {
    byteLength,
    slice: (start, end = byteLength) => withRetry(() => hardTimeout(150_000, async () => {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(120_000) });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    }), `range ${start}`),
  };
}

// ---------- Embedding with per-file checkpoints ----------
const BATCH = 16;
async function embedItems(items, partName) {
  const vectors = [];
  const meta = { labels: [], splits: [], keys: [] };
  let batch = [];
  let skipped = 0;
  const flush = async () => {
    if (!batch.length) return;
    const images = [];
    const kept = [];
    for (const item of batch) {
      try { images.push(await item.load()); kept.push(item); } catch { skipped++; }
    }
    batch = [];
    if (!images.length) return;
    const { image_embeds } = await vision(await processor(images));
    const d = image_embeds.dims[1];
    kept.forEach((item, i) => {
      const v = image_embeds.data.slice(i * d, (i + 1) * d);
      const len = Math.hypot(...v);
      vectors.push(v.map((x) => x / len));
      meta.labels.push(item.label); meta.splits.push(item.split); meta.keys.push(item.key);
    });
  };
  for await (const item of items) {
    batch.push(item);
    if (batch.length === BATCH) await flush();
  }
  await flush();
  const buf = Buffer.alloc(vectors.length * 512 * 4);
  vectors.forEach((v, i) => Buffer.from(v.buffer).copy(buf, i * 512 * 4));
  fs.writeFileSync(path.join(PARTS, `${partName}.f32`), buf);
  fs.writeFileSync(path.join(PARTS, `${partName}.json`), JSON.stringify(meta));
  return { n: vectors.length, skipped };
}

const partDone = (name) => fs.existsSync(path.join(PARTS, `${name}.json`));
const partMeta = (name) => JSON.parse(fs.readFileSync(path.join(PARTS, `${name}.json`), 'utf8'));

// One parquet file, read one 100-row group at a time: the small label column first, and the
// image column only for groups that still contain dishes we need (counts carry across files).
async function* parquetFile(src, shard, counts, { capPerClass, splitFor }) {
  const names = classes(src);
  const file = shard.startsWith('http') ? await remoteBuffer(shard) : await asyncBufferFromFile(path.join(DS, src, shard));
  const metadata = await parquetMetadataAsync(file);
  const tag = shard.split('/').pop();
  let rowStart = 0;
  for (const rg of metadata.row_groups) {
    const rowEnd = rowStart + Number(rg.num_rows);
    const labels = await parquetReadObjects({ file, metadata, columns: ['label'], rowStart, rowEnd });
    const wanted = [];
    labels.forEach((r, i) => {
      const label = names[Number(r.label)];
      const key = `${src}/${tag}/${rowStart + i}`;
      const split = splitFor(tag, key);
      const ck = `${label}|${split}`;
      const n = counts.get(ck) ?? 0;
      if (n < capPerClass[split]) { counts.set(ck, n + 1); wanted.push({ i, label, key, split }); }
    });
    if (wanted.length) {
      const rows = await parquetReadObjects({ file, metadata, columns: ['image'], rowStart, rowEnd, utf8: false });
      for (const w of wanted) {
        const bytes = rows[w.i].image.bytes;
        yield { key: w.key, label: w.label, split: w.split, load: () => RawImage.fromBlob(new Blob([bytes])) };
      }
    }
    rowStart = rowEnd;
  }
}

async function parquetSource(src, shards, opts) {
  const counts = new Map();
  for (const shard of shards) {
    const name = `${src}--${shard.split('/').pop().replace(/\.parquet$/, '')}`;
    if (partDone(name)) {
      const m = partMeta(name);
      m.labels.forEach((l, i) => { const ck = `${l}|${m.splits[i]}`; counts.set(ck, (counts.get(ck) ?? 0) + 1); });
      console.log(`  ${name}: already done (${m.labels.length})`);
      continue;
    }
    const t0 = Date.now();
    const { n, skipped } = await embedItems(parquetFile(src, shard, counts, opts), name);
    console.log(`  ${name}: ${n} photos${skipped ? `, ${skipped} unreadable` : ''} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
  return shards.map((s) => `${src}--${s.split('/').pop().replace(/\.parquet$/, '')}`);
}

async function folderSource(src) {
  const dir = path.join(DS, src, 'images');
  const parts = [];
  // One checkpoint per 40 dishes.
  const dishes = fs.readdirSync(dir).sort();
  for (let c = 0; c < dishes.length; c += 40) {
    const name = `${src}--${String(c).padStart(3, '0')}`;
    parts.push(name);
    if (partDone(name)) { console.log(`  ${name}: already done`); continue; }
    const t0 = Date.now();
    async function* items() {
      for (const label of dishes.slice(c, c + 40)) {
        for (const file of fs.readdirSync(path.join(dir, label)).sort()) {
          const key = `${src}/${label}/${file}`;
          const full = path.join(dir, label, file);
          yield { key, label, split: splitOf(key), load: () => RawImage.read(full) };
        }
      }
    }
    const { n, skipped } = await embedItems(items(), name);
    console.log(`  ${name}: ${n} photos${skipped ? `, ${skipped} unreadable` : ''} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
  return parts;
}

const HF = (repo, file) => `https://huggingface.co/datasets/${repo}/resolve/main/${file}`;
const food101 = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i === 0 ? 'train-0.parquet' : i === 4 ? 'train-4.parquet' : HF('ethz/food101', `data/train-0000${i}-of-00008.parquet`))),
  'val-0.parquet', HF('ethz/food101', 'data/validation-00001-of-00003.parquet'), HF('ethz/food101', 'data/validation-00002-of-00003.parquet'),
];
const vietnamese = ['train-0.parquet', ...[1, 2, 3, 4, 5].map((i) => HF('TuyenTrungLe/vietnamese_food_images', `data/train-0000${i}-of-00006.parquet`))];

const SOURCES = {
  food101: () => parquetSource('food101', food101, { capPerClass: { train: 200, test: 50 }, splitFor: (f) => (f.startsWith('val') ? 'test' : 'train') }),
  indian: () => folderSource('indian'),
  vietnamese: () => parquetSource('vietnamese', vietnamese, { capPerClass: { train: 150, test: 30 }, splitFor: (f, k) => splitOf(k) }),
  malaysian: () => parquetSource('malaysian', ['train-0.parquet'], { capPerClass: { train: 150, test: 30 }, splitFor: (f, k) => splitOf(k) }),
};

// Merge a source's checkpoints into .cache/emb/<source>.f32/.json
for (const src of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SOURCES)) {
  console.log(`${src}:`);
  const parts = await SOURCES[src]();
  const meta = { labels: [], splits: [], keys: [] };
  const bufs = [];
  for (const name of parts) {
    const m = partMeta(name);
    meta.labels.push(...m.labels); meta.splits.push(...m.splits); meta.keys.push(...m.keys);
    bufs.push(fs.readFileSync(path.join(PARTS, `${name}.f32`)));
  }
  fs.writeFileSync(path.join(OUT, `${src}.f32`), Buffer.concat(bufs));
  fs.writeFileSync(path.join(OUT, `${src}.json`), JSON.stringify(meta));
  console.log(`${src}: ${meta.labels.length} embeddings, ${new Set(meta.labels).size} classes`);
}
