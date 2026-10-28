"""Trains the NutriLens food classifier on CLIP image embeddings.

Reads .cache/emb/<source>.f32/.json (from scripts/ml/embed.mjs), merges dishes that
appear in several datasets, trains a multinomial logistic regression on the training
split, reports accuracy on held-out test photos, and writes:
  ml/classifier.json  class names, metrics
  ml/classifier.f32   weights (K x 512) then biases (K), float32
Usage: python scripts/ml/train.py
"""
import json
import os
import re
import sys
import time

import numpy as np
from sklearn.linear_model import LogisticRegression

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EMB = os.path.join(ROOT, ".cache", "emb")
OUT = os.path.join(ROOT, "ml")
SOURCES = ["food101", "indian", "vietnamese", "malaysian"]

# Same dish under different names in different datasets.
ALIASES = {
    "hamburger": "burger",
    "samosas": "samosa",
    "omelet": "omelette",
}


def canonical(name):
    n = re.sub(r"[_\s]+", " ", name.strip().lower())
    return ALIASES.get(n, n)


X_parts, y_parts, split_parts, src_parts = [], [], [], []
for src in SOURCES:
    f32 = os.path.join(EMB, f"{src}.f32")
    if not os.path.exists(f32):
        print(f"! skipping {src}: no embeddings")
        continue
    meta = json.load(open(os.path.join(EMB, f"{src}.json"), encoding="utf-8"))
    X = np.fromfile(f32, dtype=np.float32).reshape(-1, 512)
    X_parts.append(X)
    y_parts += [canonical(l) for l in meta["labels"]]
    split_parts += meta["splits"]
    src_parts += [src] * len(X)
    print(f"{src:11s} {len(X):6d} photos")

X = np.vstack(X_parts)
y = np.array(y_parts)
split = np.array(split_parts)
src = np.array(src_parts)
classes = sorted(set(y))
index = {c: i for i, c in enumerate(classes)}
yi = np.array([index[c] for c in y])
train, test = split == "train", split == "test"
print(f"total      {len(X):6d} photos, {len(classes)} dishes, {train.sum()} train / {test.sum()} test")


def evaluate(model, mask):
    # Columns of predict_proba follow model.classes_ (only dishes seen in training), so map back.
    mask = mask & np.isin(yi, model.classes_)
    if not mask.any():
        return 0.0, 0.0
    p = model.predict_proba(X[mask])
    top = model.classes_[np.argsort(-p, axis=1)]
    t = yi[mask]
    return float((top[:, 0] == t).mean()), float((top[:, :5] == t[:, None]).any(axis=1).mean())


best = None
for C in [3.0, 10.0, 30.0]:
    t0 = time.time()
    model = LogisticRegression(C=C, max_iter=3000, n_jobs=-1)
    model.fit(X[train], yi[train])
    top1, top5 = evaluate(model, test)
    print(f"C={C:<5} top-1 {top1:.3f}  top-5 {top5:.3f}  ({time.time() - t0:.0f} s)")
    if best is None or top1 > best[1]:
        best = (model, top1, top5, C)

model, top1, top5, C = best
per_source = {s: dict(zip(["top1", "top5"], evaluate(model, test & (src == s)))) for s in SOURCES if (test & (src == s)).any()}
print(f"chosen C={C}: top-1 {top1:.3f}, top-5 {top5:.3f}")
for s, m in per_source.items():
    print(f"   {s:11s} top-1 {m['top1']:.3f}  top-5 {m['top5']:.3f}")

os.makedirs(OUT, exist_ok=True)
unseen = sorted(set(classes) - {classes[i] for i in model.classes_})
if unseen:
    print(f"! {len(unseen)} dishes had no training photos and are left out: {', '.join(unseen[:10])}")
classes = [classes[i] for i in model.classes_]  # row order of coef_
weights = np.concatenate([model.coef_.astype(np.float32).ravel(), model.intercept_.astype(np.float32)])
weights.tofile(os.path.join(OUT, "classifier.f32"))
counts = {c: int((yi[train] == index[c]).sum()) for c in classes}
json.dump({
    "model": "Xenova/clip-vit-base-patch32 (q8 vision encoder) + multinomial logistic regression",
    "dim": 512,
    "classes": classes,
    "train_photos_per_class": counts,
    "metrics": {"test_photos": int(test.sum()), "top1": round(top1, 4), "top5": round(top5, 4), "C": C,
                "per_source": {k: {m: round(v, 4) for m, v in d.items()} for k, d in per_source.items()}},
}, open(os.path.join(OUT, "classifier.json"), "w", encoding="utf-8"), indent=1)
print(f"wrote ml/classifier.json and ml/classifier.f32 ({os.path.getsize(os.path.join(OUT, 'classifier.f32')) // 1024} KB)")
