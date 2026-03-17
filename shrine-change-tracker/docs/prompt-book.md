# Prompt Book

This document records the prompt engineering behind the Shrine Change Tracker's vision model analysis. The prompts are designed to be **model-agnostic** — they should work with any vision language model that can accept images and return structured JSON, not just Gemma 3.

---

## Current Production Prompt

This is the prompt currently used in `server.py`:

```
This is a Google Street View image of a Roman madonnella — a devotional
shrine mounted on a building wall in Italy. The shrine area is typically a
section of wall with a central religious image (often the Virgin Mary)
surrounded by votive offerings left by worshippers.

COUNT only objects that are physically attached to, mounted on, or placed
directly against the shrine wall surface. Look for:

Categories:
- plaques: marble tablets, stone slabs, ceramic tiles, engraved memorial
  inscriptions, ex-voto tablets, any flat rectangular items mounted flush
  against the wall. These are often white or light-colored and arranged in
  rows or clusters around the central shrine image.
- flowers: flower bouquets, floral arrangements, potted plants, wreaths
  placed at the base of or attached to the shrine.
- candles: candles, votive lights, oil lamps, electric candle substitutes
  placed as offerings at or near the shrine.
- pictures: framed photographs, printed religious images, painted icons,
  holy cards, laminated images attached to the wall.
- other: rosaries, ribbons, letters, stuffed animals, or any other
  devotional object on the shrine wall that does not fit the above.

DO NOT COUNT any of the following:
- Cars, motorcycles, bicycles, or any vehicles
- Pedestrians or people
- Street signs, traffic lights, or road markings
- Shop signs, advertisements, or business signage
- Windows, doors, or architectural features of surrounding buildings
- Graffiti or paint on the wall (only count mounted/attached objects)
- Objects on the ground, sidewalk, or street that are not part of the shrine
- Trees, utility poles, wires, or street furniture

If the shrine wall is not clearly visible or the image is too unclear to
count reliably, return all zeros.

Return ONLY a JSON object with integer counts:
{"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}
```

### Technical Parameters

- **Temperature:** `0.1` (low, for deterministic/consistent counting)
- **Format:** `json` (Ollama enforces structured JSON output)
- **Image encoding:** JPEG at 85% quality, base64-encoded
- **Image resolution:** 1600x800 pixels (or cropped sub-region if focus area is set)

### Why This Prompt Works

1. **Domain-specific context** — Uses the term "madonnella" and describes what a Roman votive shrine looks like. This activates the model's knowledge about Italian religious culture rather than treating it as a generic object counting task.

2. **Physical descriptions for each category** — Instead of just "plaques," the prompt describes "marble tablets, stone slabs, ceramic tiles, engraved memorial inscriptions, ex-voto tablets, any flat rectangular items mounted flush against the wall." This gives the model concrete visual features to look for.

3. **Explicit negative constraints** — A full list of what NOT to count (vehicles, people, signs, street furniture, etc.) prevents the most common false positives from urban Street View imagery.

4. **Graceful fallback** — "If the shrine wall is not clearly visible or the image is too unclear to count reliably, return all zeros." This prevents the model from hallucinating counts for images where the shrine is obscured.

5. **Low temperature** — Setting temperature to 0.1 reduces sampling randomness, making results more consistent across multiple runs of the same image.

6. **JSON schema enforcement** — Ollama's `format: "json"` parameter combined with the explicit example output forces structured, parseable responses.

---

## Prompt Evolution

### Version 1 (Original)
```
Look at this image of a wall from a Roman votive shrine in Italy.
Count every distinct object you can see mounted on or placed against the wall.

Categories:
- plaques: marble or stone tablets, ceramic tiles, memorial inscriptions, any flat mounted items
- flowers: flower bouquets, arrangements, potted plants
- candles: candles, lamps, any light sources placed as offerings
- pictures: framed photographs, religious images, paintings, icons, prints
- other: any other distinct devotional objects on the wall

Return ONLY a JSON object with integer counts:
{"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}
```

**Problems:**
- No negative constraints → counted cars, signs, and street objects
- No domain-specific language → model treated it as generic object detection
- Default temperature → inconsistent results between runs
- No fallback for unclear images → hallucinated counts for obstructed views

### Version 2 (Current)
Added negative constraints, madonnella terminology, physical descriptions, temperature control, and unclear-image fallback. See "Current Production Prompt" above.

---

## Image Pre-Processing: Focus Region

The tool now supports an optional **focus region** — a rectangle the user can draw around the shrine wall area in Step 2 (Timeline). When set:

1. The full Street View image is fetched at 1600x800
2. The image is cropped to the selected rectangle
3. Only the cropped region is sent to the vision model
4. The full image is still stored for display in results

**When to use it:** When the shrine is a small part of the overall Street View image, or when there's significant urban clutter (parked cars, large trees, shop fronts) that might confuse the model.

**When to skip it:** When the shrine wall fills most of the image and there's minimal surrounding noise.

This is the implementation of Strategy 3 from the original improvement list (see below), designed as an optional user action rather than a required step.

---

## Strategies Implemented

### Strategy 1: Negative Constraints — IMPLEMENTED

The prompt now includes an explicit "DO NOT COUNT" section listing vehicles, pedestrians, street signs, shop signage, architectural features, graffiti, ground-level objects, and street furniture.

### Strategy 2: Few-Shot Pattern Anchoring — NOT YET IMPLEMENTED

Providing 2-3 example images with correct counts would be the most impactful improvement. This requires:
1. Manually counting items in several Largo Preneste images to establish ground truth
2. Storing those images and counts as reference data
3. Sending them as part of the prompt (multi-image context)

**Implementation note:** Ollama's chat API supports multiple images per message. Few-shot examples would be sent as prior messages in the conversation:

```json
{
  "messages": [
    {"role": "user", "content": "Analyze this shrine image:", "images": ["<reference_img_1>"]},
    {"role": "assistant", "content": "{\"plaques\": 12, \"flowers\": 3, ...}"},
    {"role": "user", "content": "Now analyze this image:", "images": ["<target_img>"]}
  ]
}
```

### Strategy 3: Image Pre-Processing (Wall Cropping) — IMPLEMENTED

Users can optionally draw a focus rectangle in Step 2. The server crops the image before sending to the model. See "Image Pre-Processing: Focus Region" above.

### Strategy 4: JSON Schema Enforcement — PARTIALLY IMPLEMENTED

Ollama's `format: "json"` is used. A richer schema (with confidence scores and notes) is deferred — simple integer counts are sufficient for the current research phase.

### Strategy 5: Temperature Control — IMPLEMENTED

Temperature is set to `0.1` via Ollama's `options.temperature` parameter. This should reduce but not eliminate run-to-run variance.

---

## Prompt Design Principles (Model-Agnostic)

These principles apply regardless of which model is used:

1. **Be specific about the domain.** "Roman madonnella" activates more relevant knowledge than "wall with objects." Use the actual terminology of the field.

2. **Define categories with physical descriptions.** The model needs to know what the objects look like, not just their names. "Marble tablets, stone slabs, ceramic tiles" is better than just "plaques."

3. **Constrain the output format.** Always enforce JSON. Always specify the exact keys expected. Parse and validate server-side.

4. **Tell the model what NOT to count.** Negative constraints are as important as positive instructions, especially in noisy Street View imagery.

5. **Provide a fallback for ambiguity.** "If unclear, return zeros" is better than forcing the model to guess, which leads to hallucinated counts.

6. **Keep temperature low for counting tasks.** Creative sampling is the enemy of consistent measurement.

7. **Let structure do the heavy lifting.** The extension controls camera angle and alignment. The server controls image resolution. The optional crop region removes noise. The prompt should focus only on the counting task — everything else is handled by the surrounding infrastructure.

8. **The prompt should not depend on the model.** Write prompts that describe what you want, not how a specific model should process it. If you switch from Gemma 3 to LLaVA to a future model, the prompt should still work.

---

## Switching Models

To use a different vision model:

1. Pull it: `ollama pull <model-name>` (e.g., `gemma3:12b`, `llava:13b`)
2. Edit `server.py` line: `OLLAMA_MODEL = "<model-name>"`
3. Restart the server

The prompt, temperature, JSON enforcement, and crop region all work the same way regardless of model. Results will vary based on the model's capabilities — a larger model may be more accurate but slower.

---

## Future Work

- [x] ~~Implement temperature control (low temperature for consistency)~~
- [x] ~~Add negative constraints to the production prompt~~
- [x] ~~Implement image cropping as optional pre-processing step~~
- [ ] Create few-shot examples from manually verified Largo Preneste counts
- [ ] Benchmark consistency: run same location 5 times, measure count variance
- [ ] Test with larger models (gemma3:12b, llava, etc.) and compare accuracy
- [ ] Document which model versions produce which results for reproducibility
- [ ] Test whether few-shot examples improve consistency more than temperature alone
