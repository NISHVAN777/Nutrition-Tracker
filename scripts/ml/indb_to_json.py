"""Converts the Indian Nutrient Databank (INDB.xlsx) to JSON for scripts/build-foods-db.mjs.

INDB: Indian recipes with nutrient values per 100 g (Vijayakumar et al., Lindsay Jaacks lab,
https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-).
Usage: python scripts/ml/indb_to_json.py <INDB.xlsx> <out.json>
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from xlsx import read_sheet  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
rows = read_sheet(src)
header = rows[0]


def num(v):
    return float(v) if isinstance(v, (int, float)) else None


foods = []
for r in rows[1:]:
    d = dict(zip(header, r))
    kcal = num(d.get("energy_kcal"))
    if not d.get("food_code") or not d.get("food_name") or not kcal:
        continue
    serving_kcal = num(d.get("unit_serving_energy_kcal"))
    serving_g = round(serving_kcal / kcal * 100) if serving_kcal and kcal > 0 else None
    sfa = num(d.get("sfa_mg"))
    vitd = (num(d.get("vitd2_ug")) or 0) + (num(d.get("vitd3_ug")) or 0)
    foods.append({
        "code": d["food_code"],
        "name": d["food_name"].strip(),
        "kcal": kcal,
        "protein_g": num(d.get("protein_g")),
        "fat_g": num(d.get("fat_g")),
        "carbs_g": num(d.get("carb_g")),
        "fiber_g": num(d.get("fibre_g")),
        "sugar_g": num(d.get("freesugar_g")),
        "sodium_mg": num(d.get("sodium_mg")),
        "cholesterol_mg": num(d.get("cholesterol_mg")),
        "saturated_fat_g": sfa / 1000 if sfa is not None else None,
        "calcium_mg": num(d.get("calcium_mg")),
        "iron_mg": num(d.get("iron_mg")),
        "magnesium_mg": num(d.get("magnesium_mg")),
        "potassium_mg": num(d.get("potassium_mg")),
        "vitamin_c_mg": num(d.get("vitc_mg")),
        "vitamin_a_ug": num(d.get("vita_ug")),
        "vitamin_b12_ug": None,  # not reported in INDB
        "vitamin_d_ug": vitd,
        "serving_g": serving_g if serving_g and 5 <= serving_g <= 1500 else None,
        "serving_desc": f"1 {d['servings_unit']}" if d.get("servings_unit") else None,
    })

json.dump(foods, open(out, "w", encoding="utf-8"))
print(f"INDB: {len(foods)} recipes -> {out}")
