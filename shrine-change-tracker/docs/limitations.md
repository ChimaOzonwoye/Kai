# Limitations

This document records what the Shrine Change Tracker can and cannot do, written from the perspective of the person who built it. This is intended to be honest about the tool's boundaries so researchers can make informed decisions about how to use it and interpret its results.

*Note: This section reflects the builder's technical perspective. The researcher (Chima Ozonwoye) may add additional observations about limitations encountered during use.*

---

## What It Can Do

- **Count devotional items** (plaques, flowers, candles, photographs, and other objects) in Google Street View images of shrine walls
- **Track changes over time** by analyzing every available historical panorama for a location (typically 2007-2025)
- **Show trends** with bar charts and side-by-side image comparisons between consecutive years
- **Run entirely locally** with no cloud dependencies, API keys, or data transmission
- **Process a full location** (13-14 panoramas across ~17 years) in approximately one hour on consumer hardware

---

## What It Cannot Do

### Results Are Not Deterministic

The same image analyzed twice may produce different counts. This is fundamental to how vision language models work — they generate responses by sampling from probability distributions. There is no "locked" answer.

This means:
- Two runs on the same location may show different numbers
- Small items may be counted in one run but missed in another
- The tool is better suited for identifying **trends and patterns** (growth, decline, sudden changes) than for producing exact counts

This is not a bug. It is inherent to the technology. A more powerful model or better prompt engineering can reduce variance but not eliminate it entirely.

### Model-Dependent Accuracy

The current implementation uses **Gemma 3 Vision (4B parameters)**, a relatively small open-source model. This was chosen because it runs on consumer hardware and is freely available.

**The architecture is model-agnostic.** The tool's structure — Chrome extension, Flask server, Ollama integration, prompt-and-parse pipeline — works with any vision model that Ollama supports. If a better model becomes available:
1. Pull it with `ollama pull <model-name>`
2. Change one line in `server.py` (`OLLAMA_MODEL = "new-model-name"`)
3. Results may improve (or degrade) depending on the model's capabilities

The accuracy ceiling is set by the model. The tool's job is to structure the input and parse the output correctly — the model decides what it sees.

### Image Quality Constraints

Google Street View imagery varies significantly in quality:
- **Resolution:** Street View thumbnails are compressed. Fine details (small text on plaques, individual flowers in dense arrangements) may be lost
- **Occlusion:** Trees, cars, pedestrians, and street furniture can block the shrine wall. The model sees what the camera saw — if half the wall was blocked by a parked van, those items are invisible
- **Angle:** The Street View camera position varies between years. Auto-alignment (SSIM-based) compensates for small shifts, but some years may show the shrine from a significantly different angle
- **Lighting and weather:** Shadows, overcast skies, and time-of-day differences affect how clearly items are visible

Some shrine locations will simply produce better results than others based on how well Street View captured them. This is expected. A focused, unobstructed, well-lit image of a shrine wall will always produce more reliable counts than a distant, partially blocked shot.

### Urban Noise

The model sees the entire image, including the surrounding street. In some cases, it may count objects that are not part of the shrine — a flower pot on a nearby balcony, a picture in a shop window, a sign that resembles a plaque.

Potential mitigations (not yet implemented):
- **Image pre-processing:** Cropping the image to the shrine wall region before analysis (using coordinates from the extension)
- **Negative constraints in prompts:** Explicitly telling the model to ignore objects that are not on the wall surface
- **Few-shot examples:** Showing the model example images with correct counts to calibrate its judgment

See [Prompt Book](prompt-book.md) for the current prompt strategy and planned improvements.

### Scale

The tool processes images sequentially. Each image takes 30-60 seconds on CPU. For a single location with 13 panoramas, this means ~10-15 minutes with a GPU or ~1 hour on CPU.

Scaling to hundreds of locations would require either:
- A machine with a GPU (dramatically faster per-image)
- Running multiple analyses in sequence (automated scripting, not yet built)
- Parallel processing across multiple machines

The tool is currently designed for one location at a time, operated manually through the browser extension.

### Not a Replacement for Expert Analysis

This tool counts objects. It does not interpret what those objects mean. A researcher still needs to:
- Understand the cultural and religious significance of shrine changes
- Determine whether a spike in items represents a religious event, a community action, or a data anomaly
- Consider whether a drop to zero means genuine decline or a cleaning/maintenance event
- Cross-reference with other sources (local records, interviews, historical events)

The automated tracker found that the Largo Preneste shrine showed a massive spike to 170 items in August 2017 followed by a drop to 0 in July 2018. A human researcher can hypothesize why — was the wall cleaned? Was there a community event? The tool provides the data; the researcher provides the meaning.

---

## Summary

The Shrine Change Tracker is a research instrument with known limitations. It is most valuable when:
- Used to identify **patterns and trends** rather than exact counts
- Combined with **human interpretation** of what those patterns mean
- Applied to locations with **clear, unobstructed Street View imagery**
- Understood as **model-dependent** — results will change as models improve

It is not meant to replace manual analysis entirely, but to make the initial survey of hundreds of shrine locations feasible within a research timeline.
