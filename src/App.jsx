import { useState, useEffect } from "react";
import {
  detectIngredients,
  suggestRecipes,
  estimateItemDetails,
  cropFromBox,
  isEffectivelyEmpty,
} from "./geminiApi";
import "./App.css";

const STAGE = {
  ONBOARDING: "onboarding",
  UPLOAD: "upload",
  DETECTING: "detecting",
  EMPTY: "empty",
  DETECTED: "detected",
  SHORTFALL: "shortfall",
  GENERATING: "generating",
  RESULTS: "results",
  ERROR: "error",
};

const STEPS = ["Preferences", "Photos", "Inventory", "Recipes"];

function getStepIndex(stage) {
  switch (stage) {
    case STAGE.ONBOARDING:
      return 0;
    case STAGE.UPLOAD:
    case STAGE.DETECTING:
    case STAGE.EMPTY:
      return 1;
    case STAGE.DETECTED:
    case STAGE.SHORTFALL:
    case STAGE.GENERATING:
      return 2;
    case STAGE.RESULTS:
      return 3;
    default:
      return 0;
  }
}

// Non-food items that should never count toward "you've got enough".
const NON_FOOD_ITEMS = ["water", "ice"];

// Below this many usable items, don't even bother calling the recipe API —
// there just isn't enough to build a real meal around.
const MIN_ITEMS_FOR_RECIPES = 3;

// Shelf-life tiers for the perishable badge.
const URGENT_THRESHOLD_DAYS = 2;
const SOON_THRESHOLD_DAYS = 7;

const STAPLES = [
  "Rice, pasta, or bread",
  "Cooking oil",
  "Onion & garlic",
  "Eggs",
  "Salt, pepper & a stock cube",
];

const LOADING_EMOJIS = ["🍇", "🥕", "🧀", "🍎", "🍲", "🥘", "🍔", "🍕", "🍤", "🍝", "🥞", "🍞"];

function App() {
  const [stage, setStage] = useState(STAGE.ONBOARDING);
  const [eatsLeftovers, setEatsLeftovers] = useState(null);
  const [allergies, setAllergies] = useState("");
  const [servings, setServings] = useState(2);
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [items, setItems] = useState([]);
  const [crops, setCrops] = useState({});
  const [editingIndex, setEditingIndex] = useState(null);
  const [expandedCrop, setExpandedCrop] = useState(null);
  const [newItemName, setNewItemName] = useState("");
  const [editingQtyIndex, setEditingQtyIndex] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [error, setError] = useState("");
  const [emojiIndex, setEmojiIndex] = useState(0);

  useEffect(() => {
    if (stage !== STAGE.DETECTING) return;
    const interval = setInterval(() => {
      setEmojiIndex((i) => (i + 1) % LOADING_EMOJIS.length);
    }, 500);
    return () => clearInterval(interval);
  }, [stage]);

  function handleOnboardingContinue() {
    if (eatsLeftovers === null) return;
    setStage(STAGE.UPLOAD);
  }

  function handleFileChange(e) {
    const selected = Array.from(e.target.files).slice(0, 3);
    // Release any previews from a prior selection before replacing them.
    previews.forEach((src) => URL.revokeObjectURL(src));
    setFiles(selected);
    setPreviews(selected.map((f) => URL.createObjectURL(f)));
  }

  function removeFile(index) {
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function computeCrops(detectedItems, previewSrcs) {
    const loadedImages = await Promise.all(
      previewSrcs.map(
        (src) =>
          new Promise((resolve) => {
            const img = new Image();
            const timer = setTimeout(() => resolve(null), 5000);
            img.onload = () => {
              clearTimeout(timer);
              resolve(img);
            };
            img.onerror = () => {
              clearTimeout(timer);
              resolve(null);
            };
            img.src = src;
          })
      )
    );

    const newCrops = {};
    detectedItems.forEach((item, i) => {
      if (item.box_2d && loadedImages[item.image_index]) {
        try {
          newCrops[i] = cropFromBox(loadedImages[item.image_index], item.box_2d);
        } catch (err) {
          console.warn("Failed to crop item", item.name, err);
        }
      }
    });
    setCrops(newCrops);
  }

  async function handleDetect() {
    setError("");
    setStage(STAGE.DETECTING);
    try {
      const detected = await detectIngredients(files);
      if (isEffectivelyEmpty(detected)) {
        setItems(detected);
        setStage(STAGE.EMPTY);
        return;
      }
      setItems(detected);
      await computeCrops(detected, previews);
      setStage(STAGE.DETECTED);
    } catch (err) {
      console.error(err);
      setError(err.message);
      setStage(STAGE.ERROR);
    }
  }

  async function handleGetRecipes() {
    if (cookableItemsWithIndex.length < MIN_ITEMS_FOR_RECIPES) {
      setStage(STAGE.SHORTFALL);
      return;
    }
    setError("");
    setStage(STAGE.GENERATING);
    try {
      const suggested = await suggestRecipes(items, { eatsLeftovers, allergies, servings });
      setRecipes(suggested);
      setStage(STAGE.RESULTS);
    } catch (err) {
      console.error(err);
      setError(err.message);
      setStage(STAGE.ERROR);
    }
  }

  function updateItemName(index, newName) {
    setItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, name: newName, edited: true } : item
      )
    );
    setEditingIndex(null);
  }

  function updateItemQuantity(index, newQty) {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, quantity: newQty } : item))
    );
    setEditingQtyIndex(null);
  }

  function addManualItem() {
    const trimmed = newItemName.trim();
    if (!trimmed) return;
    setNewItemName("");

    // Show the item immediately so typing feels responsive, flagged as
    // "estimating" until Gemini tells us how perishable it actually is.
    const tempId = `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setItems((prev) => [
      ...prev,
      {
        name: trimmed,
        quantity: "1",
        likely_shelf_life_days: null,
        confidence: "high",
        edited: true,
        manual: true,
        estimating: true,
        _tempId: tempId,
      },
    ]);

    estimateItemDetails(trimmed)
      .then((details) => {
        setItems((prev) =>
          prev.map((it) =>
            it._tempId === tempId ? { ...it, ...details, estimating: false } : it
          )
        );
      })
      .catch((err) => {
        console.warn("Couldn't estimate shelf life for", trimmed, err);
        // Fall back to a shelf-stable assumption rather than leaving the
        // item stuck in a permanent "estimating" state.
        setItems((prev) =>
          prev.map((it) =>
            it._tempId === tempId
              ? { ...it, likely_shelf_life_days: 14, estimating: false }
              : it
          )
        );
      });
  }

  function reset() {
    setFiles([]);
    setPreviews([]);
    setItems([]);
    setCrops({});
    setRecipes([]);
    setError("");
    setNewItemName("");
    setStage(STAGE.UPLOAD);
  }

  function restartFully() {
    reset();
    setEatsLeftovers(null);
    setAllergies("");
    setStage(STAGE.ONBOARDING);
  }

  // Keep each item's original index alongside it, so thumbnails (keyed on
  // the original detection order) never drift once water/ice are filtered out.
  const cookableItemsWithIndex = items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => !NON_FOOD_ITEMS.includes(item.name?.toLowerCase()));

  const soonToExpire = cookableItemsWithIndex.filter(
    ({ item }) =>
      item.likely_shelf_life_days != null &&
      item.likely_shelf_life_days <= SOON_THRESHOLD_DAYS
  );

  const currentStep = getStepIndex(stage);

  const recipesNeedShopping =
    stage === STAGE.RESULTS &&
    (recipes.length === 0 ||
      recipes.every((r) => (r.missing?.length || 0) > (r.uses_existing?.length || 0)));

  const consolidatedMissing = Array.from(
    new Set(recipes.flatMap((r) => r.missing || []))
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">🥫</span>
          Use What You've Got
        </div>
      </header>

      <div className="stepper">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={
              "step" +
              (i === currentStep ? " step-current" : "") +
              (i < currentStep ? " step-done" : "")
            }
          >
            <span className="step-dot">{i < currentStep ? "✓" : i + 1}</span>
            <span className="step-label">{label}</span>
          </div>
        ))}
      </div>

      {stage === STAGE.ONBOARDING && (
        <section className="card">
          <h1>One quick thing</h1>
          <p className="tagline">
            So we know how far what you've got will actually stretch, and
            what to steer clear of.
          </p>

          <p className="field-label">When you cook, do you usually...</p>
          <div className="choice-group">
            <button
              className={eatsLeftovers === true ? "choice active" : "choice"}
              onClick={() => setEatsLeftovers(true)}
            >
              Cook once, eat leftovers for a few days
            </button>
            <button
              className={eatsLeftovers === false ? "choice active" : "choice"}
              onClick={() => setEatsLeftovers(false)}
            >
              Cook fresh most times
            </button>
          </div>

          <p className="field-label">Any allergies or things to avoid?</p>
          <input
            type="text"
            className="text-input"
            placeholder="e.g. peanuts, shellfish, dairy"
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
          />
          <p className="hint">Leave blank if none.</p>

          <p className="field-label">How many people are you cooking for?</p>
          <input
            type="number"
            min="1"
            className="text-input"
            value={servings}
            onChange={(e) => {
              const val = e.target.value;
              setServings(val === "" ? "" : parseInt(val));
            }}
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              setServings(!val || val < 1 ? 1 : val);
            }}
          />

          <button
            disabled={eatsLeftovers === null}
            onClick={handleOnboardingContinue}
          >
            Continue
          </button>
        </section>
      )}

      {stage === STAGE.UPLOAD && (
        <section className="card landing-card">
          <div className="landing-intro">
            <h1>You've probably got enough</h1>
            <p className="tagline">
              We don't overbuy because we forget what's at home. We overbuy
              because we don't believe it's enough. Snap a photo and find out
              it usually is.
            </p>
          </div>

          <label className="dropzone">
            <i className="ti ti-camera" aria-hidden="true"></i>
            <p className="dropzone-title">
              Drop a photo of your fridge or pantry
            </p>
            <p className="dropzone-sub">or tap to upload, up to 3 photos</p>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
              hidden
            />
          </label>

          {previews.length > 0 && (
            <div className="preview-row">
              {previews.map((src, i) => (
                <div key={src} className="preview-item">
                  <img src={src} alt="preview" className="preview-img" />
                  <button
                    type="button"
                    className="preview-remove"
                    onClick={() => removeFile(i)}
                    aria-label="Remove this photo"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <button disabled={files.length === 0} onClick={handleDetect}>
            Choose photos
          </button>
        </section>
      )}

      {stage === STAGE.DETECTING && (
        <section className="card detecting-card">
          <div className="fridge-loading">
            <span className="cycling-emoji">{LOADING_EMOJIS[emojiIndex]}</span>
          </div>
          <p className="loading-text">Looking through your food...</p>
        </section>
      )}

      {stage === STAGE.EMPTY && (
        <section className="card">
          <h2>Fair enough, this one's actually empty</h2>
          <div className="empty-banner">
            Looks like there's genuinely not much to work with in that photo.
            This is a real shop trip, not a guess.
          </div>
          <div className="button-row">
            <button onClick={() => setStage(STAGE.UPLOAD)}>
              Try another photo
            </button>
          </div>
        </section>
      )}

      {(stage === STAGE.DETECTED ||
        stage === STAGE.SHORTFALL ||
        stage === STAGE.GENERATING) && (
        <section className="card">
          <button className="ghost-btn back-btn" onClick={restartFully}>
            ← Back to home
          </button>

          <h2>Here's what's on hand</h2>

          <ul className="item-list">
            {cookableItemsWithIndex.map(({ item, originalIndex }) => {
              const hasEstimate = item.likely_shelf_life_days != null;
              const isUrgent = hasEstimate && item.likely_shelf_life_days <= URGENT_THRESHOLD_DAYS;
              const isSoon = hasEstimate && item.likely_shelf_life_days <= SOON_THRESHOLD_DAYS;
              return (
                <li key={originalIndex} className={isSoon ? "urgent" : ""}>
                  {crops[originalIndex] ? (
                    <img
                      src={crops[originalIndex]}
                      alt={item.name}
                      className="item-thumb"
                      onClick={() => setExpandedCrop(crops[originalIndex])}
                    />
                  ) : (
                    <span className="item-thumb-placeholder"></span>
                  )}

                  <div className="name-col">
                    {editingIndex === originalIndex ? (
                      <input
                        className="edit-input"
                        defaultValue={item.name}
                        autoFocus
                        onBlur={(e) => updateItemName(originalIndex, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.target.blur();
                        }}
                      />
                    ) : (
                      <span
                        onClick={() => setEditingIndex(originalIndex)}
                        className={
                          item.confidence === "low" && !item.edited
                            ? "unsure"
                            : "editable"
                        }
                      >
                        {item.name}
                        {item.confidence === "low" && !item.edited && " *"}
                      </span>
                    )}
                  </div>

                  {item.estimating ? (
                    <span className="badge badge-checking">checking…</span>
                  ) : isSoon ? (
                    <span className={isUrgent ? "badge badge-urgent" : "badge"}>
                      <i className="ti ti-clock" aria-hidden="true"></i>
                      {isUrgent ? "Use today" : "Use soon"}
                    </span>
                  ) : (
                    <span></span>
                  )}

                  {editingQtyIndex === originalIndex ? (
                    <input
                      className="edit-input qty-input"
                      defaultValue={item.quantity}
                      autoFocus
                      onBlur={(e) => updateItemQuantity(originalIndex, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.target.blur();
                      }}
                    />
                  ) : (
                    <span
                      className="qty editable"
                      onClick={() => setEditingQtyIndex(originalIndex)}
                    >
                      {item.quantity}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {stage === STAGE.DETECTED && (
            <div className="add-item-row">
              <input
                type="text"
                className="text-input"
                placeholder="Add something we missed"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManualItem();
                }}
              />
              <button
                className="ghost-btn"
                onClick={addManualItem}
                disabled={!newItemName.trim()}
              >
                + Add
              </button>
            </div>
          )}

          {items.some((i) => i.confidence === "low" && !i.edited) && (
            <p className="confidence-note">
              * not 100% sure. Click to correct.
            </p>
          )}

          {soonToExpire.length > 0 && (
            <p className="expiry-note">
              {soonToExpire.map(({ item }) => item.name).join(", ")} won't
              keep for long. Worth using in the next few days.
            </p>
          )}

          {stage === STAGE.DETECTED && (
            <button onClick={handleGetRecipes}>Generate recipes</button>
          )}

          {stage === STAGE.SHORTFALL && (
            <>
              <div className="shortfall-banner">
                We found {cookableItemsWithIndex.length} item
                {cookableItemsWithIndex.length === 1 ? "" : "s"} to work
                with — that's usually too little to build a real recipe
                around. A few pantry staples would go a long way.
              </div>
              <p className="field-label">Basics worth having on hand:</p>
              <ul className="staples-list">
                {STAPLES.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <div className="button-row">
                <button
                  className="ghost-btn"
                  onClick={() => setStage(STAGE.DETECTED)}
                >
                  Add more items
                </button>
                <button onClick={reset}>Upload another photo</button>
              </div>
            </>
          )}

          {stage === STAGE.GENERATING && (
            <div className="loading-row">
              <span className="spinner"></span>
              <span>Thinking of recipes...</span>
            </div>
          )}
        </section>
      )}

      {stage === STAGE.RESULTS && (
        <section className="card">
          {recipesNeedShopping ? (
            <>
              <h2>Almost there — a quick shop first</h2>
              <div className="shortfall-banner">
                What's on hand isn't quite enough on its own.
                {consolidatedMissing.length > 0 && (
                  <>
                    {" "}
                    Pick up {consolidatedMissing.slice(0, 6).join(", ")}
                    {consolidatedMissing.length > 6 ? ", and a few more" : ""},
                    and these become real meals.
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <h2>Real meals, right now. No shop needed.</h2>
              <div className="proof-banner">
                {recipes.length} real meal{recipes.length === 1 ? "" : "s"}{" "}
                here.
                {eatsLeftovers &&
                  " Since you eat leftovers, that could stretch across several more days."}
              </div>
            </>
          )}

          <div className="recipe-grid">
            {recipes.map((r, i) => (
              <div key={i} className="recipe-card">
                <h3>{r.name}</h3>
                <p className="uses">
                  Uses {r.uses_existing.join(", ")}.
                  {r.missing.length === 0 && " Nothing else needed."}
                </p>
                {r.missing.length > 0 && (
                  <p className="missing">
                    Only need to buy {r.missing.join(", ")}.
                    {r.estimated_missing_cost != null &&
                      r.estimated_missing_cost > 0 && (
                        <span className="cost-estimate">
                          {" "}
                          (about ${r.estimated_missing_cost.toFixed(2)})
                        </span>
                      )}
                  </p>
                )}

                {r.steps && r.steps.length > 0 && (
                  <ol className="steps-list">
                    {r.steps.map((step, si) => (
                      <li key={si}>{step}</li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
          <button className="ghost-btn" onClick={restartFully}>
            Start over
          </button>
        </section>
      )}

      {stage === STAGE.ERROR && (
        <section className="card error-card">
          <p>Something went wrong: {error}</p>
          <button onClick={reset}>Try again</button>
        </section>
      )}

      {expandedCrop && (
        <div className="modal-overlay" onClick={() => setExpandedCrop(null)}>
          <img src={expandedCrop} alt="zoomed item" className="modal-img" />
        </div>
      )}
    </div>
  );
}

export default App;
