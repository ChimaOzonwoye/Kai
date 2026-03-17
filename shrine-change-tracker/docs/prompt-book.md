# Prompt Book

This document records the prompt engineering behind the Shrine Change Tracker's vision model analysis. The prompts are designed to be **model-agnostic** — they should work with any vision language model that can accept images and return structured JSON, not just Gemma 3.

---

## Current Production Prompt

This is the prompt currently used in `server.py`:

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

### Why This Structure

1. **Context setting** ("image of a wall from a Roman votive shrine in Italy") — tells the model what it's looking at so it can apply domain-relevant reasoning
2. **Specific task** ("Count every distinct object") — clear, measurable instruction
3. **Category definitions with examples** — reduces ambiguity about what belongs in each category
4. **Output format enforcement** — specifying JSON structure with example output, combined with Ollama's `format: "json"` parameter

---

## Known Weaknesses of the Current Prompt

### 1. No Negative Constraints
The prompt tells the model what to count but not what to ignore. In urban Street View images, the model may count:
- Shop signs that resemble plaques
- Flower pots on nearby balconies
- Street lights mistaken for candles
- Advertising posters mistaken for pictures

### 2. No Spatial Anchoring
The prompt says "mounted on or placed against the wall" but does not define which wall. If the image shows multiple buildings, the model may count items on adjacent structures.

### 3. No Few-Shot Examples
The model has no calibration for what "correct" looks like. Without examples of images paired with their correct counts, the model relies entirely on its pre-training to interpret the scene.

### 4. No Handling of Ambiguity
When items are partially occluded, clustered together, or deteriorated, the prompt gives no guidance on how to count them. Should a crumbled plaque still count? Should a cluster of 5 overlapping plaques count as 1 or 5?

---

## Improvement Strategies

The following strategies were identified through consultation with other LLMs and prompt engineering research. They are documented here for future implementation.

### Strategy 1: Negative Constraints

Add explicit instructions about what to ignore:

```
IGNORE the following — do NOT count these:
- Objects not physically on the shrine wall surface (cars, pedestrians, street signs, shop fronts)
- Background buildings and their features
- Street furniture (traffic lights, lamp posts, railings)
- Text or graffiti painted directly on the wall (only count mounted/attached objects)
```

**Rationale:** Defining boundaries reduces false positives from urban clutter. The model is more accurate when it knows what to exclude.

### Strategy 2: Few-Shot Pattern Anchoring

Provide 2-3 examples of images with their correct JSON analyses before the actual query. This forces the model to calibrate its counting logic against known-correct examples.

```
Here are examples of correct analyses:

[Example image 1]
{"plaques": 12, "flowers": 3, "candles": 0, "pictures": 2, "other": 1, "total": 18}

[Example image 2]
{"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}

Now analyze this image:
[Target image]
```

**Rationale:** Few-shot examples are the most effective way to calibrate model behavior without fine-tuning. The model learns from the pattern of input→output rather than from verbal instructions alone.

**Implementation note:** This requires storing reference images and their verified counts. The first few-shot examples should come from manually verified analyses of the Largo Preneste shrine.

### Strategy 3: Image Pre-Processing (Wall Cropping)

Crop the image to the shrine wall region before sending it to the model. This removes urban noise entirely by ensuring the model only sees the wall and its items.

The extension already captures the viewing angle coordinates. A future improvement could:
1. Allow the user to draw a region around the wall once (on the reference image)
2. Apply that crop region to all historical images (adjusted for alignment)
3. Send only the cropped region to the vision model

**Rationale:** This was the original purpose of the "Mark the Wall" step that was removed. It was removed because it added friction and the VLM works without it. However, as an optional pre-processing step (not a required manual action), it could significantly improve accuracy by eliminating the urban noise problem entirely.

### Strategy 4: JSON Schema Enforcement

The current prompt uses Ollama's `format: "json"` parameter, which forces JSON output. This can be strengthened by providing a stricter schema:

```json
{
  "plaques": {
    "count": 0,
    "confidence": "high|medium|low",
    "notes": "description of what was counted"
  },
  ...
}
```

**Rationale:** Forcing the model to explain what it counted and rate its confidence provides an audit trail. However, this adds complexity and processing time. For the current use case, simple integer counts are sufficient.

### Strategy 5: Temperature and Sampling Control

Most vision models accept a `temperature` parameter:
- **Lower temperature (0.1-0.3):** More deterministic, less creative → more consistent counts between runs
- **Higher temperature (0.7-1.0):** More variable, explores alternatives → less consistent

The current implementation uses the model's default temperature. Setting a low temperature through Ollama's API could reduce run-to-run variance:

```json
{
  "model": "gemma3:4b",
  "options": {
    "temperature": 0.1
  }
}
```

**Rationale:** For a counting task, we want deterministic behavior, not creativity. Lower temperature should produce more consistent results.

---

## Prompt Design Principles (Model-Agnostic)

These principles should apply regardless of which model is used:

1. **Be specific about the domain.** Tell the model it's looking at a Roman votive shrine, not a generic wall. Domain context activates relevant learned patterns.

2. **Define categories with physical descriptions.** "Marble or stone tablets, ceramic tiles" is better than just "plaques." The model needs to know what the physical object looks like.

3. **Constrain the output format.** Always enforce JSON. Always specify the exact keys expected. Parse and validate server-side.

4. **Tell the model what to ignore.** Negative constraints are as important as positive instructions, especially in noisy environments.

5. **Calibrate with examples when possible.** Few-shot examples beat verbose instructions for teaching a model what "correct" looks like.

6. **Keep the prompt focused.** Don't ask the model to be an expert, describe its role, or explain its reasoning. Just ask it to count and return JSON.

7. **Structure should do the heavy lifting.** The extension controls the camera angle, alignment, and image quality. The server controls image resolution and encoding. The prompt should focus only on the counting task — let the surrounding infrastructure handle everything else.

---

## Future Work

- [ ] Implement temperature control (low temperature for consistency)
- [ ] Add negative constraints to the production prompt
- [ ] Create few-shot examples from manually verified Largo Preneste counts
- [ ] Test image cropping as optional pre-processing step
- [ ] Benchmark consistency: run same location 5 times, measure count variance
- [ ] Test with larger models (gemma3:12b, llava, etc.) and compare accuracy
- [ ] Document which model versions produce which results for reproducibility
