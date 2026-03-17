# Development Journey

This document records the full development process of the Shrine Change Tracker — what was tried, what failed, what worked, and the reasoning behind each decision. This is a research tool, not a product. Every iteration is documented here so the work can be understood, critiqued, and replicated.

Development was done using [Claude Code](https://claude.ai/code) with architectural direction from Chima Ozonwoye and academic supervision from Dr. Louis Hamilton (NJIT).

---

## The Problem

Roman votive shrines accumulate devotional items (plaques, flowers, candles, photographs) over time. Researchers studying these shrines need to track how these items change across years to understand patterns in personal religious devotion.

Google Street View provides historical imagery spanning 2007-2025 for many Roman locations. A researcher can open Street View, navigate to a shrine, and browse through years of images. But counting every item in every year for even a single shrine takes significant time. Rohit's HIRF study demonstrated this — manual analysis of three sites required careful, frame-by-frame counting.

The goal: automate the counting so a researcher can track changes across all available years for a location in a fraction of the time.

---

## Phase 1: Traditional Computer Vision (MSER + Edge Detection)

### Approach
The first version used classical computer vision techniques:
- **MSER (Maximally Stable Extremal Regions)** to detect blob-like regions that might be plaques
- **Canny edge detection** to find rectangular contours
- **Non-Maximum Suppression (NMS)** to merge overlapping detections
- **Bounding box matching** between image pairs to identify added/removed items

The server had adjustable parameters exposed as UI sliders:
- MSER delta, min/max area thresholds
- Edge detection low/high thresholds
- NMS IoU threshold

### What Happened
The detections were unreliable. MSER would trigger on any high-contrast region — windows, signs, shadows, graffiti — not just shrine items. Edge detection found rectangular shapes everywhere in urban scenes. The user had to manually adjust 6+ sliders to try to get reasonable results for each location, and what worked for one image failed on another.

The selection (bounding boxes around detected regions) was visually wrong — boxes around cars, street signs, and building features rather than the shrine wall items.

### Why It Failed
Classical CV has no semantic understanding. MSER finds regions of stable intensity, but it cannot distinguish a votive plaque from a window or a poster. Edge detection finds edges, but a rectangular plaque edge looks identical to a rectangular sign edge. No amount of parameter tuning can solve this — the algorithms lack the concept of "what a plaque is."

### Takeaway
**Object counting at shrines requires semantic understanding of what is being counted.** Pure geometric/intensity-based detection cannot differentiate devotional items from urban clutter.

---

## Phase 2: YOLO-World (Open-Vocabulary Object Detection)

### Approach
To add semantic understanding, we tried YOLO-World — an open-vocabulary object detection model that can find objects by text description without retraining.

The idea: give YOLO-World text prompts like "votive plaque," "flower bouquet," "candle" and let it locate those objects in shrine images.

### Implementation
- Installed `ultralytics` Python package
- Replaced MSER/edge detection with YOLO-World inference
- Set text prompts for shrine-specific object categories
- Applied confidence thresholds to filter weak detections

### What Happened
YOLO-World detected 0 items across all test images. The model had no representation for "votive plaque" in its training data. Even broader prompts like "plaque" or "tablet" returned nothing useful. The shrine context is too domain-specific for a general-purpose detector.

User feedback: *"It does not work, even the selection is bad."*

### Why It Failed
Open-vocabulary detection still relies on the model having seen similar objects during training. YOLO-World was trained on common objects (cars, people, furniture). Votive plaques, devotional candles in wall niches, and small ceramic tiles are not in its vocabulary. The gap between "open vocabulary" and "any vocabulary" proved critical.

### Takeaway
**Domain-specific objects require either fine-tuned models or models with broader visual understanding.** Open-vocabulary detection sounds flexible but still has vocabulary boundaries.

This commit was reverted with `git revert HEAD`.

---

## Phase 3: Vision Language Model (Gemma 3 Vision via Ollama)

### The Pivot
After both CV and detection-model approaches failed, the direction shifted to vision language models (VLMs). The insight: instead of trying to detect objects geometrically, ask a model that can understand images to count what it sees.

The recommendation (sourced via consultation with other LLMs) was to use **Gemma 3 Vision** (4B parameter model) running locally through **Ollama**. This approach:
- Runs entirely locally (no cloud API costs, no data leaving the machine)
- Has genuine visual understanding (can reason about what objects are)
- Can follow structured prompts and return JSON
- Is free and open-source

### First Implementation: Batch Processing
The initial VLM implementation sent all images to the server in a single HTTP request (`/compare-all` endpoint). The server processed them sequentially and returned all results at once.

**Problem:** With 13-14 images and each VLM call taking 30-60 seconds on CPU, the total processing time was 7-14 minutes. The single HTTP request would time out, and the user saw "Analysis failed" with no indication of progress.

### UI Issues (First Round)
The first VLM-based UI had several problems identified by the user:
- Used "AI" jargon throughout (e.g., "Server + AI ready," "Analyzing with AI") — the user said *"It should not be saying AI, it makes it look fake"*
- No cancel button — once analysis started, you had to wait or close the tab
- Still had a "Mark the Wall" step requiring the user to draw a polygon around the shrine region — the user correctly pointed out that with a VLM, this shouldn't be necessary since the model understands the image
- Displayed fake time estimates ("~56 seconds") that were inaccurate — the user said *"it takes longer than 56 seconds, so it would be wise not to approximate a timeline you are uncertain of"*
- Loading overlay with no progress feedback

### The Complete Rebuild
After accumulating this feedback, the user requested a full rebuild: *"Would appreciate building all of this from scratch with all of these lessons."*

The rebuild changed the architecture fundamentally:

**Server changes:**
- Replaced batch `/compare-all` endpoint with per-image `/analyze-image` endpoint
- Each image is a single HTTP request (prevents timeout)
- Removed wall-crop endpoint and all CV detection code
- Added Ollama health check to `/health` endpoint

**Frontend changes:**
- Reduced from 4-step wizard to 3 steps (Location → Timeline → Results)
- Removed wall marking step entirely (VLM understands images without manual region selection)
- Added real progress bar that updates as each image completes
- Added working cancel button using AbortController (cancels between images)
- Chart renders incrementally during analysis
- Frontend computes pair deltas locally (no server-side pair computation)
- Removed all "AI" and "Ollama" references from UI text
- Removed fake time estimates

### Current State
The tool now works end-to-end. For the Largo Preneste test location (13 panoramas, 2008-2025):
- Analysis completes in approximately one hour on CPU (WSL/Linux)
- Results show item counts per year with side-by-side image comparisons
- The bar chart reveals patterns of growth, removal, and replenishment
- Dean Hamilton confirmed this timeframe is acceptable — manual counting for even one year takes longer

### Known Issue: Inconsistent Results
Running the analysis twice on the same location produces different counts. This is inherent to how language models work — they sample from probability distributions, so the same image can yield slightly different interpretations. This is documented further in [Limitations](limitations.md) and addressed in the [Prompt Book](prompt-book.md).

---

## Technical Decisions and Their Reasoning

### Why Ollama instead of a cloud API?
- **Cost:** Cloud vision APIs charge per image. Analyzing 600+ shrines × 13 images each = 7,800+ API calls, which adds up quickly
- **Privacy:** No shrine imagery or research data leaves the researcher's machine
- **Reproducibility:** Anyone can download Ollama and the same model to replicate results
- **Independence:** No dependency on external services that could change pricing, rate-limit, or shut down

### Why Gemma 3 4B?
- Small enough to run on consumer hardware (8 GB RAM minimum, 16 GB recommended)
- Has vision capabilities (can process images, not just text)
- Returns structured JSON when prompted with `format: "json"`
- Available through Ollama with a single `ollama pull` command

### Why per-image processing instead of batch?
- Batch processing caused HTTP timeouts with 13+ images at 30-60 seconds each
- Per-image allows real progress feedback (progress bar)
- Per-image allows cancellation between images
- A single image failure doesn't lose all results

### Why no wall marking?
- The VLM understands what it's looking at — it doesn't need a cropped region
- Wall marking added a manual step that slowed the workflow
- The user correctly identified this: with a vision model, manual region selection is unnecessary
- **Note:** Image pre-processing (cropping to the wall region) may be reintroduced as an optional step if it improves accuracy. See [Prompt Book](prompt-book.md) for discussion.

### Why a Chrome extension instead of a standalone app?
- The workflow starts in Google Street View — the extension reads coordinates directly from the URL
- No need to copy-paste coordinates manually
- The extension only activates when clicked on a Street View page

---

## Timeline of Key Events

| Date | Event |
|------|-------|
| Early development | MSER + edge detection approach built with adjustable sliders |
| — | Sliders were unreliable; detections triggered on non-shrine objects |
| — | YOLO-World attempted as semantic detection alternative |
| — | YOLO-World detected 0 items; reverted immediately |
| — | Pivoted to Gemma 3 Vision via Ollama based on LLM consultation |
| — | First VLM implementation with batch processing |
| — | Ollama install required `zstd` prerequisite on Linux/WSL |
| — | Batch processing caused timeout failures; "Analysis failed" shown |
| — | UI feedback: remove "AI" jargon, add cancel button, remove wall marking |
| — | Complete rebuild: 3-step wizard, per-image processing, real progress |
| — | First successful end-to-end run at Largo Preneste (13 panoramas, 2008-2025) |
| — | Dean Hamilton confirmed ~1 hour analysis time is acceptable for research |
| — | Results compared with Rohit's manual HIRF analysis — significant differences found |

---

## Tools and Consultation

This project used multiple tools and sources during development:

- **Claude Code** — Primary development tool (all code written through Claude Code sessions)
- **ChatGPT** — Consulted for VLM approach recommendation (suggested Gemma 3 via Ollama)
- **Other LLMs** — Consulted for prompt engineering strategies (few-shot anchoring, negative constraints, JSON schema enforcement)
- **Rohit's HIRF study** — Manual analysis baseline for comparison

All consultations and their contributions are documented because this is research. The tool's development process itself is part of the research methodology.
