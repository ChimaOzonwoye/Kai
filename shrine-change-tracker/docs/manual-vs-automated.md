# Manual vs Automated Analysis

This document compares findings from manual human counting (Rohit's HIRF study) with results from the Shrine Change Tracker's automated analysis at the same locations.

---

## Background

### Manual Analysis (Rohit's HIRF Study)
Rohit conducted a manual analysis of votive plaque placement at three Roman shrine sites, counting items by hand across available Google Street View years. The study found:
- An overall **negative trend** in votive plaque placement at two of three sites
- A "slow loss" in overall votive plaques, correlated with declining national church attendance
- Plaque placement was described as **"linear"** — suggesting predictable, gradual change over time

### Automated Analysis (Shrine Change Tracker)
The Shrine Change Tracker analyzed the Largo Preneste shrine location across 14 time periods (2008-05 to 2025-05) using Gemma 3 Vision (4B). One run reported:
- **+353 items added** and **-325 items removed** over the full period
- Net positive growth: from 26 items in 2008 to 54 items in 2025
- A massive spike of **170 items in August 2017**, followed by a drop to **0 items by July 2018**

---

## Key Differences

### 1. Growth vs Decline

| | Manual (Rohit) | Automated |
|---|---|---|
| **Overall trend** | Negative (decline) | Net positive (growth) |
| **Interpretation** | Slow loss of devotion | Active, volatile site |
| **Pattern** | Linear decline | Cyclical — spikes and drops |

The manual study concludes devotion is waning. The automated data suggests the site is actively maintained — items are placed, removed (possibly by cleaning or maintenance), and replaced.

### 2. Volatility vs Linearity

The most striking difference is in the **shape** of the data:

- **Manual:** Describes change as "linear" — a gradual, predictable decline
- **Automated:** Captures extreme fluctuations between years. The 170→0 spike-and-drop pattern suggests that what looks like "decline" in a linear model may actually be **periodic maintenance** (removal of all items) followed by **replenishment**

This matters for interpretation: if items are periodically cleared and replaced, the site isn't declining — it's being actively managed. The "decay" may be institutional (church or city maintenance) rather than spiritual (loss of devotion).

### 3. Granularity

- **Manual:** Counts votive plaques specifically
- **Automated:** Counts five categories — plaques, flowers, candles, pictures, and other items

The automated tracker captures a broader picture of shrine activity. Flowers and candles are inherently temporary (they wilt and burn out), so their presence or absence tells a different story than permanent plaques. A shrine with many flowers but few plaques may indicate active informal devotion even if formal plaque placement has stopped.

---

## Important Caveats

### The automated counts are not ground truth
As documented in [Limitations](limitations.md), the vision model produces different counts on different runs. The specific numbers (170 items in 2017, 0 in 2018) should be treated as **approximate** rather than exact. The pattern — large spike followed by complete removal — is more significant than the specific number.

### The comparison is not one-to-one
Rohit's manual analysis focused specifically on votive plaques and may have used different criteria for what constitutes a "plaque." The automated tracker counts all visible items using the model's interpretation of the category definitions. These are different measurement methods, and some divergence is expected.

### Image quality affects both methods
Both the manual and automated analyses are limited by what Google Street View shows. If a year's panorama has poor resolution, an obstructed view, or a different camera angle, both human and model counters will miss items. The automated tracker applies SSIM-based auto-alignment to reduce angle variation, but this is not perfect.

---

## What This Comparison Suggests

The disagreement between manual and automated results is itself a finding. It suggests:

1. **Sampling frequency matters.** Manual analysis may sample a few key years and interpolate. The automated tracker examines every available year, capturing events (like mass removal and replacement) that sparse sampling would miss.

2. **The "slow decline" narrative may be incomplete.** If shrines undergo periodic cleaning followed by rapid replenishment, a snapshot at the wrong time would show zero items and suggest decline. The full timeline reveals this as a cycle, not a trend.

3. **Different counting methods produce different conclusions.** This is expected and valuable — it shows where human assumptions (what counts as a plaque, whether to count flowers) shape the conclusions drawn from the same visual evidence.

4. **Both methods have value.** The automated tracker provides breadth (every year, all categories, multiple locations quickly). Manual analysis provides depth (expert judgment, cultural context, nuanced categorization). The most complete picture comes from using both.

---

## Next Steps

- Run the automated tracker on Rohit's other two study sites for direct comparison
- Have a human manually count the Largo Preneste images to create a ground-truth baseline
- Investigate the 2017 spike and 2018 drop — is there a known cleaning event or community activity?
- Test with a more capable model to see if the automated counts converge with manual counts
- Document inter-run variance by running the same location multiple times

---

*This comparison is preliminary. The automated tracker is a new tool and its results have not been independently verified. This document is intended to record observations, not to assert that either method is definitively correct.*
