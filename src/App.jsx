import { useState, useEffect } from "react";
import {
  detectIngredients,
  suggestRecipes,
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
  GENERATING: "generating",
  RESULTS: "results",
  ERROR: "error",
};

const SOON_THRESHOLD_DAYS = 5;

const LOADING_EMOJIS = ["🍇", "🥕", "🧀", "🍎", "🍲","🥘","🍔","🍕","🍤","🍝","🥞", "🍞"];

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
    setFiles(selected);
    setPreviews(selected.map((f) => URL.createObjectURL(f)));
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
      console.log("Detected items:", detected);
      await computeCrops(detected, previews);
      setStage(STAGE.DETECTED);
    } catch (err) {
      console.error(err);
      setError(err.message);
      setStage(STAGE.ERROR);
    }
  }

  async function handleGetRecipes() {
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
    setItems((prev) => [
      ...prev,
      {
        name: trimmed,
        quantity: "1",
        likely_shelf_life_days: 7,
        confidence: "high",
        edited: true,
        manual: true,
      },
    ]);
    setNewItemName("");
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

  const cookableItems = items.filter(
    (i) => !["water", "ice"].includes(i.name?.toLowerCase())
  );
  const soonToExpire = cookableItems.filter(
    (i) => i.likely_shelf_life_days <= SOON_THRESHOLD_DAYS
  );

  return (
    <div className="app">
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
                <img key={i} src={src} alt="preview" className="preview-img" />
              ))}
            </div>
          )}

          <button disabled={files.length === 0} onClick={handleDetect}>
            Choose photos
          </button>
        </section>
      )}

      {stage === STAGE.DETECTING && (
        
        <section className="card DETECTING-CARD">
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
        stage === STAGE.GENERATING ||
        stage === STAGE.RESULTS) && (
        <section className="card">
          <button className="ghost-btn back-btn" onClick={restartFully}>
            ← Back to home
          </button>

          <h2>Here's what's on hand</h2>

          <ul className="item-list">
            {cookableItems.map((item, i) => {
              const isSoon = item.likely_shelf_life_days <= SOON_THRESHOLD_DAYS;
              return (
                <li key={i} className={isSoon ? "urgent" : ""}>
                  {crops[i] ? (
                    <img src={crops[i]} alt={item.name} className="item-thumb" onClick={() => setExpandedCrop(crops[i])} />
                  ) : (
                    <span className="item-thumb-placeholder"></span>
                  )}

                  <div className="name-col">
                    {editingIndex === i ? (
                      <input className="edit-input" defaultValue={item.name} autoFocus
                        onBlur={(e) => updateItemName(i, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
                    ) : (
                      <span onClick={() => setEditingIndex(i)}
                        className={item.confidence === "low" && !item.edited ? "unsure" : "editable"}>
                        {item.name}{item.confidence === "low" && !item.edited && " *"}
                      </span>
                    )}
                  </div>

                  {isSoon ? (
                    <span className="badge"><i className="ti ti-clock" aria-hidden="true"></i> use soon</span>
                  ) : (
                    <span></span>
                  )}

                  {editingQtyIndex === i ? (
                    <input
                      className="edit-input qty-input"
                      defaultValue={item.quantity}
                      autoFocus
                      onBlur={(e) => updateItemQuantity(i, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                    />
                  ) : (
                    <span className="qty editable" onClick={() => setEditingQtyIndex(i)}>
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
              {soonToExpire.map((i) => i.name).join(", ")} won't keep for
              long. Worth using in the next few days.
            </p>
          )}

          {stage === STAGE.DETECTED && (
            <button onClick={handleGetRecipes}>Prove I've got enough</button>
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
          <h2>Real meals, right now. No shop needed.</h2>

          <div className="proof-banner">
            {recipes.length} real meal{recipes.length === 1 ? "" : "s"} here.
            {eatsLeftovers &&
              " Since you eat leftovers, that could stretch across several more days."}
          </div>

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
