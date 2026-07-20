const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const MODEL = "gemini-flash-latest";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Fetch with a hard timeout so a stalled request fails loudly instead of
// leaving the UI stuck on a loading screen forever.
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s. Check your API key and network connection.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Non-food items that should never count toward "you've got enough".
const NON_FOOD_ITEMS = ["water", "ice"];

// Step 1: photo(s) -> structured ingredient list with boxes + confidence
export async function detectIngredients(imageFiles) {
  const imageParts = await Promise.all(
    imageFiles.map(async (file) => ({
      inline_data: {
        mime_type: file.type,
        data: await fileToBase64(file),
      },
    }))
  );

  const prompt = `You are looking at ${imageFiles.length} photo(s) of someone's
fridge and/or pantry, indexed 0 to ${imageFiles.length - 1} in the order given.


Identify every distinct food item you can see. For each item give:
- name (simple, e.g. "milk", "capsicum", "eggs")
- quantity (rough estimate, e.g. "1 carton", "3", "half full jar")
- category ("fridge" or "pantry")
- likely_shelf_life_days (a reasonable estimate for this type of item)
- confidence ("high" or "low" — use "low" if you're genuinely unsure what the item is)
- image_index (which photo, 0-based, this item was seen in)
- box_2d: [ymin, xmin, ymax, xmax] normalized 0-1000, tightly bounding just this item

Include non-food items like water bottles too, but they will be filtered out later.
If the photo(s) show little to no food, return an empty or near-empty items array —
do not invent items that aren't there.
If the same type of item appears more than once (e.g. multiple apples, or the
same jar in more than one photo), report it ONCE as a single item with a
combined quantity (e.g. "4" instead of separate "3" and "1" entries). Treat
singular/plural naming as the same item (e.g. "apple" and "apples" are one
item, not two).

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "items": [
    { "name": "milk", "quantity": "1 carton", "category": "fridge", "likely_shelf_life_days": 7, "confidence": "high", "image_index": 0, "box_2d": [120, 300, 400, 520] }
  ]
}`;

  const body = { contents: [{ parts: [{ text: prompt }, ...imageParts] }] };

  const res = await fetchWithTimeout(`${BASE_URL}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini vision call failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  if (!data.candidates || !data.candidates[0]) {
    throw new Error(
      `Gemini returned no candidates (possibly blocked by safety filters): ${JSON.stringify(data)}`
    );
  }
  const text = data.candidates[0].content.parts[0].text;
  const cleaned = text.replace(/```json|```/g, "").trim();
  return mergeDuplicateItems(JSON.parse(cleaned).items);
}

// True if the detected items don't add up to anything actually cookable
// (empty, or only non-food items like water).
export function isEffectivelyEmpty(items) {
  const cookable = items.filter(
    (i) => !NON_FOOD_ITEMS.includes(i.name.toLowerCase())
  );
  return cookable.length === 0;
}

// Crop a region out of a loaded <img> using normalized [ymin, xmin, ymax, xmax] (0-1000)
// and return a data URL for the crop.
export function cropFromBox(img, box2d) {
  const [ymin, xmin, ymax, xmax] = box2d;
  const sx = (xmin / 1000) * img.naturalWidth;
  const sy = (ymin / 1000) * img.naturalHeight;
  const sw = ((xmax - xmin) / 1000) * img.naturalWidth;
  const sh = ((ymax - ymin) / 1000) * img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function normalizeName(name) {
  let n = name.trim().toLowerCase();
  if (n.endsWith("ies")) n = n.slice(0, -3) + "y";
  else if (n.endsWith("s") && !n.endsWith("ss")) n = n.slice(0, -1);
  return n;
}

function combineQuantities(quantities) {
  const nums = quantities.map((q) => parseFloat(q));
  if (nums.every((n) => !isNaN(n))) {
    return `${nums.reduce((a, b) => a + b, 0)}`;
  }
  return quantities.length > 1 ? quantities.join(" + ") : quantities[0];
}

function mergeDuplicateItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = normalizeName(item.name);
    if (!groups.has(key)) {
      groups.set(key, { ...item, quantities: [item.quantity] });
    } else {
      const existing = groups.get(key);
      existing.quantities.push(item.quantity);
      if (item.confidence === "low") existing.confidence = "low";
      existing.likely_shelf_life_days = Math.min(
        existing.likely_shelf_life_days,
        item.likely_shelf_life_days
      );
    }
  }
  return Array.from(groups.values()).map(({ quantities, ...rest }) => ({
    ...rest,
    quantity: combineQuantities(quantities),
  }));
}

// Step 2: ingredient list (+ leftovers habit, allergies) -> recipes
export async function suggestRecipes(items, { eatsLeftovers, allergies, servings } = {}) {
  const itemList = items
    .filter((i) => !NON_FOOD_ITEMS.includes(i.name.toLowerCase()))
    .map((i) => `${i.name} (${i.quantity})`)
    .join(", ");

  const allergyLine = allergies?.trim()
    ? `The person has these allergies or things to avoid: ${allergies}. Never suggest a recipe containing any of these, under any circumstances — this is a hard safety rule, not a preference.`
    : "";

  const leftoverLine = eatsLeftovers
    ? "This person usually cooks once and eats leftovers for a few days, so mention roughly how many days a recipe's portions could stretch."
    : "This person usually cooks fresh each time, so no need to mention leftover stretch.";

const servingsLine = `This recipe should serve about ${servings || 2} people — scale ingredient quantities and portions accordingly.`;

  const prompt = `Here's what's currently in someone's fridge/pantry: ${itemList}.

This person tends to assume they don't have enough at home to cook a real meal,
so they end up buying more than they need. Suggest 3 simple recipes they could
make mostly using what they already have, to show them it was actually enough
all along. For each recipe, list which of their existing ingredients it uses,
and which extra ingredients (if any) they'd need to buy, plus a rough total
cost estimate in dollars for just those missing ingredients (estimated_missing_cost,
a number, omit or use 0 if nothing is missing). Keep missing ingredients minimal
and realistic — don't invent obscure needs.

Also provide clear step-by-step cooking instructions as an array of short steps
(steps), each one a single actionable sentence, in the order they should be
done. Keep it to 4-7 steps, practical and specific (include rough times/temps
where relevant, e.g. "Bake at 400F for 20 minutes").

${leftoverLine}
${allergyLine}
${servingsLine}

Write the blurb in a casual, friendly, reassuring tone, like a mate pointing
out "you've actually already got this" — not a formal recipe card. The steps
themselves should be clear and instructional, not casual.
Do not use em dashes in any text field.

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "recipes": [
    {
      "name": "Veggie Stir Fry",
      "blurb": "You've basically got a stir fry sitting in your fridge already.",
      "uses_existing": ["capsicum", "eggs"],
      "missing": ["soy sauce"],
      "estimated_missing_cost": 3.5,
      "steps": [
        "Heat oil in a large pan over medium-high heat.",
        "Add capsicum and stir fry for 3-4 minutes until slightly softened.",
        "Push veggies aside, crack eggs into the pan and scramble.",
        "Mix everything together, add soy sauce, and stir fry 2 more minutes.",
        "Serve hot."
      ]
    }
  ]
}`;

  const body = { contents: [{ parts: [{ text: prompt }] }] };

  const res = await fetch(`${BASE_URL}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini recipe call failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned).recipes;
}
