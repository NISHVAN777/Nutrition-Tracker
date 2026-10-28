// Free, self-hosted food recognition.
//   1. CLIP (open-source vision model, runs locally via ONNX) turns the photo into an embedding.
//   2. A classifier trained on free food-photo datasets (Food-101, Indian food, Vietnamese,
//      Malaysian; see scripts/ml/) names the dish among ~395 trained dishes.
//   3. Zero-shot matching against ~6,000 USDA/INDB dish names covers everything else.
//   4. A food / not-food check rejects photos that aren't food.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const MODEL_DIR = path.join(ROOT, 'models');
const ML = path.join(ROOT, 'ml');

export const VISION_AVAILABLE = fs.existsSync(path.join(MODEL_DIR, MODEL_ID, 'onnx', 'vision_model_quantized.onnx'))
  && fs.existsSync(path.join(ML, 'classifier.f32'));

let ready = null;

function readInt8(file) {
  const buf = fs.readFileSync(file);
  const n = buf.length / 516;
  const out = new Float32Array(n * 512);
  for (let i = 0; i < n; i++) {
    const scale = buf.readFloatLE(i * 516);
    for (let j = 0; j < 512; j++) out[i * 512 + j] = buf.readInt8(i * 516 + 4 + j) * scale;
  }
  return { n, data: out };
}

async function load() {
  const { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import('@huggingface/transformers');
  env.localModelPath = MODEL_DIR + path.sep;
  env.allowRemoteModels = false;
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });

  const meta = JSON.parse(fs.readFileSync(path.join(ML, 'classifier.json'), 'utf8'));
  const raw = new Float32Array(fs.readFileSync(path.join(ML, 'classifier.f32')).buffer.slice(0));
  const K = meta.classes.length;
  const W = raw.subarray(0, K * 512);
  const b = raw.subarray(K * 512, K * 512 + K);
  const labels = new Map(JSON.parse(fs.readFileSync(path.join(ML, 'labels.json'), 'utf8')).map((l) => [l.key, l]));
  const vocab = { ...readInt8(path.join(ML, 'vocab.i8')), items: JSON.parse(fs.readFileSync(path.join(ML, 'vocab.json'), 'utf8')) };
  const gate = { ...readInt8(path.join(ML, 'gate.i8')), ...JSON.parse(fs.readFileSync(path.join(ML, 'gate.json'), 'utf8')) };
  return { processor, vision, RawImage, classes: meta.classes, metrics: meta.metrics, W, b, K, labels, vocab, gate };
}

export function warmUp() {
  if (!VISION_AVAILABLE) return Promise.resolve(null);
  ready ??= load();
  return ready;
}

const dot = (data, row, v) => { let s = 0; const o = row * 512; for (let j = 0; j < 512; j++) s += data[o + j] * v[j]; return s; };
function softmax(xs) {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const z = e.reduce((a, c) => a + c, 0);
  return e.map((x) => x / z);
}

/**
 * Recognise the food in a photo.
 * @returns {{ isFood: boolean, foodProbability: number, dishes: Array, foods: Array }}
 *   dishes: trained dishes, most likely first ({ key, name, cuisine, probability, parts })
 *   foods:  zero-shot USDA/INDB matches ({ id, name, dataset, similarity })
 */
export async function recognise(imageBuffer) {
  const m = await warmUp();
  const image = await m.RawImage.fromBlob(new Blob([imageBuffer]));
  const { image_embeds } = await m.vision(await m.processor(image));
  const v = Array.from(image_embeds.data.slice(0, 512));
  const len = Math.hypot(...v);
  for (let j = 0; j < 512; j++) v[j] /= len;

  // Food or not? CLIP's similarity to "a photo of food…" vs "a photo of a person / car / text…".
  const gateLogits = Array.from({ length: m.gate.n }, (_, i) => dot(m.gate.data, i, v) * 100);
  const gp = softmax(gateLogits);
  const foodProbability = gp.slice(0, m.gate.food).reduce((a, c) => a + c, 0);

  // Trained classifier: softmax(W·v + b).
  const logits = Array.from({ length: m.K }, (_, k) => dot(m.W, k, v) + m.b[k]);
  const probs = softmax(logits);
  const dishes = probs.map((p, k) => [k, p]).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([k, p]) => {
    const l = m.labels.get(m.classes[k]);
    return { key: m.classes[k], name: l?.name ?? m.classes[k], cuisine: l?.cuisine ?? '', probability: p, parts: l?.parts ?? [] };
  });

  // Zero-shot over USDA/INDB dish names.
  const sims = new Float32Array(m.vocab.n);
  for (let i = 0; i < m.vocab.n; i++) sims[i] = dot(m.vocab.data, i, v);
  const order = Array.from(sims.keys()).sort((a, c) => sims[c] - sims[a]).slice(0, 8);
  const foods = order.map((i) => ({ ...m.vocab.items[i], similarity: sims[i] }));

  return { isFood: foodProbability >= 0.35, foodProbability, dishes, foods };
}

export async function modelInfo() {
  const m = await warmUp();
  return m ? { model: `${MODEL_ID} + trained classifier`, dishes: m.K, vocabulary: m.vocab.n, metrics: m.metrics } : null;
}
