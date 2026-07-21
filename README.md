# Use What You've Got 🥫

Snap a photo of your fridge/pantry — instantly see what you already have,
get recipes you can make with it, and only buy what's actually missing.

## The problem

We keep overbuying groceries even though we already have things at home —
not because we forget what's in the fridge, but because we don't quite
believe it's enough for a real meal. So we buy more anyway, "just in case."
Most of the time, it already was enough. That means duplicate purchases,
food that expires and gets thrown out unused, and wasted time browsing a
grocery cart for things we don't actually need. As international students
on a budget (~$70/week grocery spend), this adds up fast — in both money
and time.

## How it works

1. **Quick setup** — tell it whether you eat leftovers or cook fresh each
   time, and list any allergies to avoid
2. **Upload a photo** of your fridge and/or pantry
3. **Gemini (vision)** detects items, quantities, estimated shelf life,
   a confidence flag, and a bounding box per item (shown as a small crop
   thumbnail next to each item, click to zoom)
4. If an item's name looks wrong, click it to correct it inline
5. If the photo shows nothing edible (or just things like water), the app
   says so honestly instead of forcing a false "you've got enough"
6. **Gemini (text)** suggests recipes using what you already have, respecting
   your stated allergies, and lists only the ingredients you're actually
   missing with a rough cost estimate.

## Tech stack

- React + Vite
- Google Gemini API (`gemini-2.0-flash`) — vision for ingredient detection
  and bounding boxes, text generation for recipe suggestions
- Canvas API for cropping item thumbnails from the uploaded photo
- Plain CSS, no UI framework

## Setup

1. Clone the repo and install dependencies:
   ```
   npm install
   ```

2. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

3. Copy the env template and add your key:
   ```
   cp .env.example .env
   ```
   Then edit `.env` and paste your key:
   ```
   VITE_GEMINI_API_KEY=your_actual_key_here
   ```

4. Run the dev server:
   ```
   npm run dev
   ```

5. Open the local URL shown in the terminal (usually `http://localhost:5173`)

## Notes

- The API key is used directly from the frontend for simplicity — fine for
  a hackathon demo, not intended for a public production deployment.
- Works best with clear, well-lit photos of an open fridge/pantry.

## Future improvements

- Persistent inventory across multiple visits (track what's been used)
- Barcode scanning for faster input
- Real-time supermarket price comparison for missing items
- Expiry-based push reminders
- Learn from usage over time — after enough visits, analyze which
  ingredients someone actually uses most and how much they typically
  consume, then adjust shelf-life estimates and recipe recommendations
  to match their real habits instead of generic averages
