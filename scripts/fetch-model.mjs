// Downloads the open-source CLIP model (Xenova/clip-vit-base-patch32, ONNX) used for food
// recognition, pinned to an exact revision and verified by SHA-256.
// Usage: node scripts/fetch-model.mjs            (runtime files: vision encoder only)
//        node scripts/fetch-model.mjs --training (also the text encoder + tokenizer, for scripts/ml/)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Xenova/clip-vit-base-patch32';
const REVISION = 'd15189d7028b43f1d3e65039190477f6af591c2a';
const RUNTIME = {
  'config.json': '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495',
  'preprocessor_config.json': '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f',
  'onnx/vision_model_quantized.onnx': '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
};
const TRAINING = {
  'onnx/text_model_quantized.onnx': '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a',
  'tokenizer.json': 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd',
  'tokenizer_config.json': '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967',
  'special_tokens_map.json': 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac',
};
const files = { ...RUNTIME, ...(process.argv.includes('--training') ? TRAINING : {}) };
const dir = path.join(ROOT, 'models', REPO);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

for (const [file, expected] of Object.entries(files)) {
  const out = path.join(dir, file);
  if (fs.existsSync(out) && sha256(fs.readFileSync(out)) === expected) { console.log(`ok       ${file}`); continue; }
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`);
  if (!res.ok) throw new Error(`Download failed for ${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== expected) throw new Error(`Checksum mismatch for ${file}: refusing to use it`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`fetched  ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
fs.writeFileSync(path.join(dir, 'REVISION'), REVISION);
