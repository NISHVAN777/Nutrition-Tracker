// Free, explainable nutrition rules that turn numbers into the report's words.
// Health score: Nutri-Score (2017 algorithm, per 100 g of the whole meal) mapped to 1-10.
// Everything else (verdict, reasons, tips, allergens, diet tags) is derived from the
// nutrients and the food names, so the same meal always gets the same, checkable answer.

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (v, ref) => (ref ? Math.round((v / ref) * 100) : 0);
const steps = (v, limits) => limits.filter((l) => v > l).length;

// ---------- Nutri-Score ----------
export function nutriScore(per100, { fruitVegShare = 0 } = {}) {
  const kj = (per100.calories ?? 0) * 4.184;
  const n = {
    energy: steps(kj, [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350]),
    sugar: steps(per100.sugar_g ?? 0, [4.5, 9, 13.5, 18, 22.5, 27, 31, 36, 40, 45]),
    satFat: steps(per100.saturated_fat_g ?? 0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    sodium: steps(per100.sodium_mg ?? 0, [90, 180, 270, 360, 450, 540, 630, 720, 810, 900]),
  };
  const p = {
    fruitVeg: fruitVegShare > 80 ? 5 : fruitVegShare > 60 ? 2 : fruitVegShare > 40 ? 1 : 0,
    fiber: steps(per100.fiber_g ?? 0, [0.9, 1.9, 2.8, 3.7, 4.7]),
    protein: steps(per100.protein_g ?? 0, [1.6, 3.2, 4.8, 6.4, 8.0]),
  };
  const negative = n.energy + n.sugar + n.satFat + n.sodium;
  const positive = p.fruitVeg + p.fiber + (negative < 11 || p.fruitVeg === 5 ? p.protein : 0);
  const points = negative - positive;
  const grade = points <= -1 ? 'A' : points <= 2 ? 'B' : points <= 10 ? 'C' : points <= 18 ? 'D' : 'E';
  // Map to the app's 1-10 scale (A ≈ 9-10, B ≈ 7-8, C ≈ 5-6, D ≈ 3-4, E ≈ 1-2).
  const score = points <= -6 ? 10 : points <= -1 ? 9 : points <= 1 ? 8 : points <= 2 ? 7 : points <= 6 ? 6
    : points <= 10 ? 5 : points <= 14 ? 4 : points <= 18 ? 3 : points <= 24 ? 2 : 1;
  return { score, grade, points, negative: n, positive: p };
}

// ---------- Keyword knowledge (from food names) ----------
const has = (text, words) => words.some((w) => new RegExp(`\\b${w}`, 'i').test(text));
const MEAT = ['chicken', 'mutton', 'lamb', 'beef', 'pork', 'bacon', 'ham\\b', 'sausage', 'pepperoni', 'salami', 'keema', 'meat', 'turkey', 'duck', 'steak', 'rib', 'wing', 'kebab', 'kabab', 'tikka', 'biryani with meat', 'hot dog', 'burger', 'hamburger', 'cheeseburger', 'nugget', 'gyro', 'shawarma', 'carpaccio', 'tartare', 'foie gras', 'pho', 'bun bo', 'satay', 'goat', 'prawn', 'shrimp', 'fish', 'crab', 'lobster', 'tuna', 'salmon', 'sardine', 'mussel', 'oyster', 'scallop', 'squid', 'calamari', 'clam', 'eel', 'anchov', 'sashimi', 'sushi', 'ceviche'];
const EGG = ['egg', 'omelet', 'omelette', 'frittata', 'quiche', 'eggs benedict', 'carbonara'];
const DAIRY = ['milk', 'cheese', 'paneer', 'butter', 'cream', 'ghee', 'yogurt', 'yoghurt', 'curd', 'dahi', 'kheer', 'ice cream', 'lassi', 'raita', 'malai', 'khoa', 'khoya', 'rabri', 'rasgulla', 'rasmalai', 'gulab jamun', 'kulfi', 'custard', 'cheesecake', 'tiramisu', 'panna cotta', 'latte', 'cappuccino', 'pizza', 'lasagna', 'mac', 'alfredo', 'makhani', 'makhni', 'shrikhand', 'chaas', 'payasam', 'barfi', 'burfi', 'pedha', 'peda', 'sandesh', 'cham cham'];
const GLUTEN = ['wheat', 'bread', 'naan', 'roti', 'chapati', 'paratha', 'puri', 'poori', 'bhatura', 'bhature', 'kulcha', 'pasta', 'spaghetti', 'macaroni', 'noodle', 'ramen', 'udon', 'chow mein', 'cake', 'biscuit', 'cookie', 'pizza', 'burger', 'sandwich', 'samosa', 'maida', 'pie', 'croissant', 'donut', 'doughnut', 'waffle', 'pancake', 'toast', 'dumpling', 'gyoza', 'momo', 'baklava', 'churro', 'lasagna', 'ravioli', 'gnocchi', 'bruschetta', 'garlic bread', 'french toast', 'beignet', 'cannoli', 'eclair', 'cupcake', 'brownie', 'muffin', 'bagel', 'pretzel', 'semolina', 'suji', 'sooji', 'rava', 'upma', 'halwa', 'dalia', 'daliya', 'seviyan', 'vermicelli', 'kachori', 'mathri', 'banh mi', 'spring roll', 'bun', 'pav', 'kathi', 'roll', 'falafel'];
const NUTS = ['almond', 'cashew', 'pistachio', 'walnut', 'hazelnut', 'kaju', 'badam', 'pista', 'nut\\b', 'nuts', 'praline', 'baklava'];
const PEANUT = ['peanut', 'groundnut', 'satay', 'chikki', 'pad thai'];
const FISH = ['fish', 'tuna', 'salmon', 'sardine', 'anchov', 'sashimi', 'sushi', 'ceviche', 'fish sauce'];
const SHELLFISH = ['prawn', 'shrimp', 'crab', 'lobster', 'mussel', 'oyster', 'scallop', 'clam', 'squid', 'calamari'];
const SOY = ['soy', 'soya', 'tofu', 'edamame', 'miso', 'tempeh'];
const SESAME = ['sesame', 'til\\b', 'tahini', 'hummus'];
const FRIED = ['fried', 'fry', 'pakora', 'pakoda', 'bhaji', 'samosa', 'kachori', 'puri', 'poori', 'bhatura', 'bhature', 'vada', 'wada', 'jalebi', 'french fries', 'chips', 'nugget', 'tempura', 'churro', 'donut', 'doughnut', 'onion rings', 'fritter', 'spring roll', 'chakli', 'mathri', 'bonda', 'cutlet', 'tikki'];
const SWEET = ['cake', 'ice cream', 'kheer', 'halwa', 'ladoo', 'laddu', 'jalebi', 'gulab jamun', 'rasgulla', 'barfi', 'burfi', 'pedha', 'peda', 'payasam', 'sweet', 'dessert', 'pudding', 'pie\\b', 'tiramisu', 'cheesecake', 'brownie', 'cookie', 'chocolate', 'donut', 'doughnut', 'macaron', 'baklava', 'churro', 'waffle', 'pancake', 'custard', 'mousse', 'panna cotta', 'sorbet', 'cupcake', 'cannoli', 'creme brulee', 'beignet', 'kulfi', 'rasmalai', 'shrikhand', 'sandesh', 'mithai', 'chikki', 'modak', 'malpua', 'rabri'];
const VEG_HEAVY = ['salad', 'vegetable', 'veggie', 'sabzi', 'sabji', 'bhindi', 'okra', 'palak', 'spinach', 'saag', 'gobi', 'cabbage', 'beans', 'carrot', 'cucumber', 'tomato', 'broccoli', 'mushroom', 'capsicum', 'baingan', 'brinjal', 'eggplant', 'lauki', 'tinda', 'karela', 'methi', 'aloo gobi', 'mixed veg', 'fruit', 'apple', 'banana', 'mango', 'orange', 'papaya', 'watermelon', 'grape', 'berries', 'dal', 'daal', 'dhal', 'lentil', 'chana', 'chole', 'rajma', 'sambar', 'sprout', 'kosambari', 'poriyal', 'thoran', 'avial', 'kootu'];
const BREAKFAST = ['idli', 'dosa', 'upma', 'poha', 'paratha', 'uttapam', 'pongal', 'omelette', 'omelet', 'egg', 'toast', 'pancake', 'waffle', 'oatmeal', 'porridge', 'cereal', 'muesli', 'granola', 'dalia', 'daliya', 'appam', 'puttu', 'thepla', 'aloo puri', 'chai', 'coffee', 'croissant', 'bagel', 'eggs benedict', 'french toast', 'breakfast'];
const RICH = ['(?<!peanut )butter', 'cream', 'makhani', 'makhni', 'malai', 'korma', 'cheese', 'alfredo', 'carbonara', 'ghee'];
const DRINK = ['tea', 'chai', 'coffee', 'juice', 'lassi', 'chaas', 'milkshake', 'shake', 'smoothie', 'soda', 'cola', 'lemonade', 'nimbu', 'sharbat', 'coconut water', 'buttermilk'];

export function foodFacts(names) {
  const text = names.join(' | ');
  const nonVeg = has(text, MEAT);
  const egg = has(text, EGG);
  const dairy = has(text, DAIRY);
  const allergens = [
    has(text, GLUTEN) && 'Gluten (wheat)',
    dairy && 'Milk / dairy',
    egg && 'Eggs',
    has(text, PEANUT) && 'Peanuts',
    has(text, NUTS) && 'Tree nuts',
    has(text, FISH) && 'Fish',
    has(text, SHELLFISH) && 'Shellfish',
    has(text, SOY) && 'Soy',
    has(text, SESAME) && 'Sesame',
  ].filter(Boolean);
  return {
    nonVeg, egg, dairy, allergens,
    vegetarian: !nonVeg,
    vegan: !nonVeg && !egg && !dairy,
    fried: has(text, FRIED),
    sweet: has(text, SWEET),
    rich: has(text, RICH),
    seafood: has(text, FISH) || has(text, SHELLFISH),
    vegHeavy: has(text, VEG_HEAVY),
    breakfast: has(text, BREAKFAST),
    drink: has(text, DRINK),
  };
}

// ---------- The report's words ----------
const BAND = (s) => (s <= 3 ? 'Less healthy' : s <= 5 ? 'Okay sometimes' : s <= 7 ? 'Good choice' : 'Excellent');
const FREQ = (s) => (s >= 8 ? 'everyday' : s >= 6 ? 'few_times_week' : s >= 4 ? 'occasionally' : 'rarely');

/**
 * @param {object} p
 * @param {string} p.mealName
 * @param {Array} p.items       items with nutrient totals for their grams
 * @param {object} p.totals     summed nutrients
 * @param {object} p.goals      the user's daily goals
 */
export function describeMeal({ mealName, items, totals: t, goals }) {
  const grams = items.reduce((n, it) => n + (it.estimated_grams || 0), 0) || 1;
  const per100 = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (v / grams) * 100]));
  const facts = foodFacts(items.map((it) => `${it.name} ${it.source?.description ?? ''}`));
  const vegGrams = items.filter((it) => foodFacts([it.name]).vegHeavy).reduce((n, it) => n + it.estimated_grams, 0);
  const ns = nutriScore(per100, { fruitVegShare: (vegGrams / grams) * 100 });

  const refs = { ...goals, saturated_fat_g: 20, cholesterol_mg: 300 };
  const P = (k) => pct(t[k], refs[k]);
  const kcalPct = P('calories');

  // Nutri-Score judges 100 g of a food; a whole meal also needs the portion and cooking method.
  let score = ns.score;
  if (facts.fried) score -= 2;
  score -= P('saturated_fat_g') >= 60 ? 2 : P('saturated_fat_g') >= 35 ? 1 : 0;
  score -= P('sodium_mg') >= 60 ? 2 : P('sodium_mg') >= 35 ? 1 : 0;
  score -= P('sugar_g') >= 70 ? 2 : P('sugar_g') >= 40 ? 1 : 0;
  if (kcalPct >= 45) score -= 1;
  if (facts.rich) score -= 1;
  if (facts.seafood && !facts.fried) score += 1;
  score = Math.min(Math.max(score, 1), 10);

  // Reasons, strongest first. Each: [strength, short phrase for the headline, sentence].
  const pros = [];
  const cons = [];
  if (P('protein_g') >= 25) pros.push([P('protein_g'), 'protein-rich', `Good protein: ${r1(t.protein_g)} g, which keeps you full`]);
  else if (P('protein_g') >= 15) pros.push([P('protein_g') - 5, 'some protein', `Some protein: ${r1(t.protein_g)} g`]);
  if (P('fiber_g') >= 20) pros.push([P('fiber_g'), 'fiber-rich', `High in fiber: ${r1(t.fiber_g)} g, good for digestion`]);
  if (facts.vegHeavy) pros.push([30, 'with veggies or lentils', 'Has vegetables, fruit or lentils']);
  if (P('sugar_g') <= 10 && !facts.sweet) pros.push([20, 'low in sugar', `Low in sugar: ${r1(t.sugar_g)} g`]);
  if (P('saturated_fat_g') <= 10 && t.calories > 50) pros.push([18, 'low in saturated fat', 'Low in saturated (unhealthy) fat']);
  if (t.calories <= 250 && t.calories >= 60 && !facts.sweet && !facts.fried) pros.push([15, 'light', `Light: ${Math.round(t.calories)} kcal`]);
  if (facts.seafood && !facts.fried) pros.push([24, 'with fish or seafood', 'Fish or seafood: good protein and healthy fats']);

  if (P('saturated_fat_g') >= 30) cons.push([P('saturated_fat_g'), 'high in saturated fat', `High in saturated fat: ${r1(t.saturated_fat_g)} g (${P('saturated_fat_g')}% of a day)`]);
  if (P('sodium_mg') >= 30) cons.push([P('sodium_mg'), 'salty', `Salty: ${Math.round(t.sodium_mg)} mg sodium (${P('sodium_mg')}% of a day)`]);
  if (P('sugar_g') >= 30 || (facts.sweet && P('sugar_g') >= 15)) cons.push([P('sugar_g') + 5, 'sugary', `Sugary: ${r1(t.sugar_g)} g sugar (${P('sugar_g')}% of a day)`]);
  if (kcalPct >= 40) cons.push([kcalPct, 'very filling', `Very filling: ${Math.round(t.calories)} kcal, about ${kcalPct}% of your day`]);
  if (facts.fried) cons.push([28, 'fried', 'Fried or oily, so it adds extra fat']);
  if (facts.rich) cons.push([26, 'rich and creamy', 'Rich: made with butter, cream, cheese or ghee']);
  if (t.fiber_g < 2 && t.carbs_g > 30) cons.push([22, 'low in fiber', 'Low in fiber for the amount of carbs']);
  if (P('protein_g') < 10 && t.calories > 250 && !facts.sweet && !facts.drink) cons.push([18, 'low in protein', `Low in protein: ${r1(t.protein_g)} g`]);
  pros.sort((a, b) => b[0] - a[0]);
  cons.sort((a, b) => b[0] - a[0]);

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const headline = pros[0] && cons[0] ? `${cap(pros[0][1])}, but ${cons[0][1]}`
    : pros[0] ? `${cap(pros[0][1])}${pros[1] ? ` and ${pros[1][1]}` : ''}`
      : cons[0] ? `${cap(cons[0][1])}${cons[1] ? ` and ${cons[1][1]}` : ''}`
        : `A ${BAND(score).toLowerCase()} option`;

  const bandPhrase = { 'Less healthy': 'best kept as an occasional treat', 'Okay sometimes': 'fine now and then', 'Good choice': 'a fairly balanced choice', Excellent: 'a very nutritious choice' }[BAND(score)];
  const simple = `${mealName} is ${bandPhrase}. It gives you ${Math.round(t.calories)} kcal (${kcalPct}% of your daily ${goals.calories} kcal) and ${r1(t.protein_g)} g of protein.${cons[0] ? ` Watch out: ${cons[0][2].split(':')[0].toLowerCase()}.` : ''}`;

  const tips = [];
  const consText = cons.map((c) => c[1]).join(' ');
  if (/salty/.test(consText)) tips.push('Skip extra salt, pickles or papad, and pair it with fresh salad or curd.');
  if (/saturated|fried/.test(consText)) tips.push('Ask for less butter, ghee, cream or oil, or share the portion.');
  if (/sugary/.test(consText)) tips.push('Have a smaller portion, or pair it with something high in protein.');
  if (/fiber/.test(consText)) tips.push('Add vegetables, salad or a whole-grain side for more fiber.');
  if (/protein/.test(consText)) tips.push('Add dal, eggs, paneer, curd, chicken or fish for more protein.');
  if (/filling/.test(consText)) tips.push('Try a smaller portion: use the − button to see the difference.');
  if (!tips.length) tips.push('Nice choice. Drink water with it and keep portions steady.');
  if (tips.length < 2 && !facts.vegHeavy) tips.push('Add a side of vegetables or fruit to round it out.');

  const bestFor = facts.drink ? 'A drink between meals'
    : facts.sweet ? 'An occasional treat'
      : facts.breakfast ? 'Breakfast'
        : t.calories < 250 ? 'A light snack'
          : t.protein_g >= 30 ? 'A post-workout meal'
            : t.calories > 900 ? 'Sharing, or one big meal of the day'
              : 'Lunch or dinner';

  const overall = [
    `${mealName} scores ${score}/10 for nutrition (Nutri-Score ${ns.grade}, adjusted for the portion and cooking).`,
    pros[0] ? `On the plus side: ${pros.slice(0, 2).map((p) => p[2].split(':')[0].toLowerCase()).join(' and ')}.` : '',
    cons[0] ? `Keep an eye on: ${cons.slice(0, 2).map((c) => c[2].split(':')[0].toLowerCase()).join(' and ')}.` : 'Nothing stands out as a concern.',
    `Best for: ${bestFor.toLowerCase()}.`,
  ].filter(Boolean).join(' ');

  const tags = [
    facts.vegan ? 'vegan' : facts.vegetarian ? 'vegetarian' : 'non-vegetarian',
    (t.protein_g * 4) / Math.max(t.calories, 1) >= 0.25 || t.protein_g >= 25 ? 'high-protein' : null,
    t.fiber_g >= 6 ? 'high-fiber' : null,
    t.calories < 300 ? 'low-calorie' : null,
    facts.fried ? 'fried' : null,
  ].filter(Boolean);

  return {
    health_score: score,
    nutri_score: { grade: ns.grade, points: ns.points },
    score_good_points: pros.slice(0, 3).map((p) => p[2]),
    score_watch_outs: cons.slice(0, 3).map((c) => c[2]),
    headline,
    simple_summary: simple,
    health_summary: simple,
    overall_review: overall,
    eat_frequency: FREQ(score),
    best_for: bestFor,
    tips: tips.slice(0, 3),
    allergens: facts.allergens,
    diet_tags: tags,
  };
}

// ---------- AI Coach replacement: a rule-based daily summary ----------
export function dailyAdvice({ goals, totals: t, meals }) {
  const hour = new Date().getHours();
  const left = goals.calories - t.calories;
  const lines = [];
  const P = (k) => pct(t[k], goals[k]);
  lines.push(left >= 0
    ? `- So far: ${Math.round(t.calories)} kcal from ${meals.length} meal${meals.length === 1 ? '' : 's'}, with ${Math.round(left)} kcal left for today.`
    : `- You're ${Math.round(-left)} kcal over today's goal of ${goals.calories} kcal.`);
  const gaps = [];
  if (P('protein_g') < (hour < 14 ? 30 : hour < 19 ? 55 : 80)) gaps.push(`protein (${Math.round(t.protein_g)} of ${goals.protein_g} g)`);
  if (P('fiber_g') < (hour < 14 ? 25 : hour < 19 ? 50 : 75)) gaps.push(`fiber (${Math.round(t.fiber_g)} of ${goals.fiber_g} g)`);
  const over = [];
  if (P('sodium_mg') > 100) over.push(`salt (${Math.round(t.sodium_mg)} mg, limit ${goals.sodium_mg})`);
  if (P('sugar_g') > 100) over.push(`sugar (${Math.round(t.sugar_g)} g, limit ${goals.sugar_g})`);
  if (gaps.length) lines.push(`- Running low on ${gaps.join(' and ')}.`);
  if (over.length) lines.push(`- Over the limit for ${over.join(' and ')}.`);
  if (!gaps.length && !over.length) lines.push('- Your protein, fiber, salt and sugar are on track. Nice work.');
  const next = over.some((o) => o.startsWith('salt')) ? 'keep the next meal low in salt: plain dal, curd, fruit or a fresh salad'
    : gaps.some((g) => g.startsWith('protein')) ? 'add protein: dal, eggs, paneer, curd, chicken or fish'
      : gaps.some((g) => g.startsWith('fiber')) ? 'add fiber: vegetables, fruit, sprouts or whole grains'
        : left < 300 ? 'keep the next meal light, like soup, salad or fruit'
          : 'a balanced plate: half vegetables, a quarter protein, a quarter grains';
  lines.push(`- Next meal: ${next}.`);
  return lines.join('\n');
}
