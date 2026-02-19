# Shrine Change Tracker - Product Requirements Document

## Purpose

Build a Chrome extension that detects visual changes at street-level locations over time using Google Street View historical imagery. The primary use case is tracking devotional activity at urban shrines in Rome, Italy (plaques, flowers, candles added/removed from walls), but the tool must work at any location with Street View coverage.

This is an academic research project supervised by Dean Louis Hamilton, PhD at NJIT (New Jersey Institute of Technology). The student (Chima) needs a working prototype to demonstrate feasibility.

---

## What This Tool Does (Plain English)

1. User opens Google Maps Street View and navigates to a location
2. User clicks the extension button
3. The extension reads the current coordinates and viewing angle from the URL
4. It finds all historical panoramas available at that location (dates ranging from 2008 to 2025)
5. It fetches a targeted image at each date, all at the same angle
6. It displays a timeline of all available dates with thumbnail previews
7. User selects two dates to compare (or it auto-selects earliest vs latest)
8. It divides both images into a grid of small cells, every cell labeled (e.g., R003-C012)
9. It compares each cell and highlights which cells changed
10. It shows results: original images with grid overlay, a change heatmap, summary statistics, and a list of changed cells

All of this happens on the same page within the extension. No separate apps, no new tabs, no external servers that require terminal commands.

---

## Architecture

The extension has two components:

### Component 1: Chrome Extension (Frontend)
- Popup UI that reads Street View URL parameters
- Analysis panel (displayed inline, not in a new tab) that shows timeline, comparison, and grid results
- Handles all image rendering, grid overlay drawing, and comparison visualization

### Component 2: Local Python Server (Backend)
- A single Python script (`server.py`) that runs locally
- Handles panorama searching (using the `streetview` Python package, which reliably returns historical panoramas)
- Handles thumbnail image fetching (using Google's free thumbnail endpoint)
- The extension communicates with this server via HTTP requests to localhost

**Why a Python backend is needed:** The `streetview` Python package reliably finds all historical panoramas at a given coordinate. Every attempt to replicate this in JavaScript using Google's undocumented APIs has failed because the response format is complex and undocumented. The Python package has already solved this. Do not attempt to rewrite panorama search in JavaScript. Use the Python package.

---

## Technical Specifications

### Panorama Search (Python, PROVEN WORKING)

The `streetview` Python package searches panoramas at a coordinate and returns all available ones, including historical.

```python
import streetview

panos = streetview.search_panoramas(lat, lon)
dated = [p for p in panos if p.date is not None]
dated.sort(key=lambda p: p.date)

# Each panorama has:
# p.pano_id  - unique identifier string
# p.date     - string like "2008-05", "2023-10"
# p.lat      - float latitude
# p.lon      - float longitude
```

**Tested result at Largo Preneste (41.8929002, 12.5416944):**
Returns 13 dated panoramas from 2008-05 to 2025-05. Pano IDs confirmed working:
- `47x1tHcNc-nd5wD3i-aQEw` (2008-05)
- `iHr4lWIMtsGyFGPlEPP5-w` (2011-11)
- `o2vh0o5LqUgWk3l2fQr7tg` (2014-08)
- `ruNEQgRqbSQO_SaLeXfTVw` (2015-05)
- `aLkG_CyUpT8O46okPPaJHA` (2016-06)
- `jVczeIKJAfc-edVQsi3wUg` (2017-08)
- `Vu28QR3hMQ9SwtKh4XKS7A` (2018-07)
- `xAF1Dn82YhrzVPUVhiwTcQ` (2019-07)
- `Dmk6SS6M-_MxMFDj55mT6w` (2020-10)
- `DI6oVbZYLDXTaLSqKMWzRw` (2021-03)
- `ji1gBRZGsOZclIkoI0-k2Q` (2022-05)
- `2V3A-wbLdAWF6b0Y5dhNxA` (2023-10)
- `Dpgy8eH_lXO4vkldh5-wvw` (2025-05)

### Thumbnail Image Fetching (PROVEN WORKING, FREE, NO API KEY)

Google has a free, undocumented thumbnail endpoint that returns a Street View image at a specific panorama ID, heading, pitch, and resolution. No API key needed. No billing. No rate limit issues encountered.

```
https://streetviewpixels-pa.googleapis.com/v1/thumbnail?cb_client=maps_sv.tactile&w={width}&h={height}&pitch={pitch}&panoid={pano_id}&yaw={heading}
```

Parameters:
- `w`: image width in pixels (tested up to 1600)
- `h`: image height in pixels (tested up to 800)
- `pitch`: camera tilt in degrees (negative = look down, tested -5 for this shrine)
- `panoid`: the panorama ID from the search step
- `yaw`: heading/direction in degrees (0-360, tested 310 for this shrine)
- `cb_client`: must be `maps_sv.tactile`

**Tested and confirmed working.** Returns JPEG image data. Response time is fast (under 2 seconds typically).

Recommended dimensions for the prototype: w=800, h=400. This balances quality and speed.

### Image Comparison (Grid Method)

The comparison works by dividing both images into a grid of small cells and comparing each cell independently.

For each cell:
1. Extract the pixel data from both images at that cell's position
2. Convert to grayscale
3. Calculate the mean absolute difference between the two patches
4. If the difference exceeds a threshold, mark the cell as "changed"

Each cell gets a label in the format `R{row:03d}-C{col:03d}` (e.g., R000-C000, R001-C015, R047-C089). Every cell is labeled. Nothing is left unlabeled.

**Cell size** controls how fine the grid is. Default 15px. Smaller = more detail, more cells. At 15px on an 800x400 image, you get approximately 54 columns x 27 rows = 1,458 cells.

**Sensitivity/threshold** controls what counts as a change. Default 12. Lower = more sensitive (catches minor lighting changes). Higher = only flags significant structural changes.

### URL Parsing (How to extract location from Google Maps)

When a user is in Street View on Google Maps, the URL contains all the information needed:

Example URL:
```
https://www.google.com/maps/place/Largo+Preneste.../@41.8929002,12.5416944,3a,75y,310.12h,84.07t/data=...
```

Extract:
- Latitude: `41.8929002` (from `@{lat},{lng}` pattern)
- Longitude: `12.5416944`
- Heading: `310.12` (from `{value}h` pattern)
- Pitch: calculated as `90 - tilt` where tilt is from `{value}t` pattern. In this example, tilt=84.07, so pitch=5.93. Note: for the thumbnail endpoint, pitch is inverted (negative = look down).
- Street View mode detection: URL contains `,3a,` which indicates Street View

Regex patterns:
- Coordinates: `/@(-?\d+\.\d+),(-?\d+\.\d+)`
- Heading: `([\d.]+)h`
- Tilt: `([\d.]+)t`

---

## User Interface Design

### Extension Popup (when user clicks the extension icon)

Small popup (300px wide) that shows:
1. Connection status (is the Python server running?)
2. Detected location info (lat, lng, heading, pitch extracted from current tab URL)
3. A single button: "Analyze" or "Scan All Dates"

If the user is not on Google Maps Street View, show a message telling them to navigate there first.
If the server is not running, show instructions: "Start the server: python3 server.py"

### Analysis Panel

When the user clicks Analyze, the results should appear. This can be a new tab or an injected panel, but it should NOT require the user to interact with a terminal or any other app.

The analysis panel contains:

**1. Info Bar**
Shows the current coordinates, heading, pitch.

**2. Timeline**
A horizontal scrollable row of thumbnail images, one for each available date. Each thumbnail shows the date below it. The earliest date is on the left, latest on the right. Thumbnails are fetched from the Python server using the same heading and pitch.

**3. Date Selection**
User clicks one thumbnail to select it as Image A (highlighted with red border). Clicks another for Image B (green border). Or it auto-selects the oldest and newest.

**4. Summary Stats**
After comparison runs:
- Total cells
- Changed cells
- Change percentage
- Grid dimensions (cols x rows)

**5. Image Comparison (3 columns)**
- Left: Image A with grid overlay (changed cells highlighted in semi-transparent red/yellow)
- Center: Image B with grid overlay
- Right: Change heatmap (green = no change, yellow = minor change, red = significant change)

All three images have the grid drawn on them. When hovering over any cell on any image, show the cell label and diff value.

**6. Cell Detail**
A bar that updates on hover showing: cell label, position, difference score, changed/unchanged status.

**7. Change Grid Table**
A visual table/matrix where each cell is colored by its change status. Green = no change, yellow = minor, red = significant. Hovering shows cell details. This is a bird's-eye view of the entire grid.

**8. Changed Cells List**
A list of all changed cells sorted by difference score (highest first). Each entry shows the cell label, diff value, and severity.

### Controls
- Cell size slider (5-50px, default 15)
- Sensitivity slider (1-50, default 12)
- Rerun button (re-runs comparison with new settings without re-fetching images)

---

## Python Server API Endpoints

The server runs on `http://localhost:5000` using Flask.

### GET /health
Returns `{"status": "ok"}`. Used by extension to check if server is running.

### POST /search
Request body: `{"lat": float, "lon": float}`
Response: `{"panoramas": [{"pano_id": string, "date": string, "lat": float, "lon": float}, ...]}`

Uses the `streetview` Python package to search for panoramas.

### GET /thumbnail?pano_id={id}&heading={h}&pitch={p}&w={width}&h={height}
Fetches a thumbnail from Google's free endpoint and returns the image.
This acts as a proxy so the extension doesn't have CORS issues.
Cache images locally so repeated requests are instant.

### POST /compare
Request body:
```json
{
  "pano_id_a": "string",
  "pano_id_b": "string",
  "heading": 310.0,
  "pitch": -5.0,
  "cell_size": 15,
  "threshold": 12,
  "width": 800,
  "height": 400
}
```

Response:
```json
{
  "total_cells": 1458,
  "changed_cells": 127,
  "change_pct": 8.7,
  "grid_cols": 54,
  "grid_rows": 27,
  "cells": [
    {
      "label": "R003-C012",
      "row": 3,
      "col": 12,
      "x": 180,
      "y": 45,
      "w": 15,
      "h": 15,
      "diff": 23.45,
      "changed": true
    }
  ],
  "image_a_url": "/thumbnail?pano_id=...&...",
  "image_b_url": "/thumbnail?pano_id=...&...",
  "overlay_a_url": "/overlay/a",
  "overlay_b_url": "/overlay/b",
  "diff_map_url": "/overlay/diff"
}
```

The server should also generate and serve the overlay images (images with grid drawn on them, change heatmap) so the extension just displays them.

---

## Python Dependencies

All of these are pip-installable. The user already has a virtual environment at `~/shrine-project/`.

```
flask
flask-cors
streetview
opencv-python
scikit-image
requests
numpy
Pillow
```

Install command:
```bash
source ~/shrine-project/bin/activate
pip install flask flask-cors streetview opencv-python scikit-image requests numpy Pillow
```

---

## Chrome Extension Structure

```
shrine-tracker/
  manifest.json
  popup.html
  popup.js
  popup.css
  analysis.html
  analysis.js
  analysis.css
  icon.png (48x48 and 128x128)
```

manifest.json needs:
- manifest_version: 3
- permissions: ["activeTab", "tabs", "storage"]
- host_permissions: ["http://localhost:5000/*"] (to talk to the Python server)
- action: default_popup pointing to popup.html

---

## File Organization for the GitHub Repo

```
shrine-change-tracker/
  README.md                  # Setup instructions, screenshots, usage guide
  server/
    server.py                # Flask server (single file)
    requirements.txt         # Python dependencies
  extension/
    manifest.json
    popup.html
    popup.js
    popup.css
    analysis.html
    analysis.js
    analysis.css
    icon.png
  docs/
    ARCHITECTURE.md          # How the system works
```

---

## Setup Instructions (for README.md)

### Prerequisites
- Python 3.10+
- Google Chrome
- pip

### Server Setup
```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 server.py
```
Server starts on http://localhost:5000

### Extension Setup
1. Open Chrome, go to chrome://extensions/
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `extension/` folder
5. Pin the extension in the toolbar

### Usage
1. Make sure server.py is running
2. Open Google Maps (google.com/maps)
3. Enter Street View at any location
4. Position the view to face what you want to track
5. Click the extension icon
6. Click "Analyze"
7. View results, adjust cell size and sensitivity as needed

---

## Important Context and Decisions

### Why Not a Full Chrome Extension Without Backend?
The `streetview` Python package reliably returns all historical panorama IDs at a location. Multiple attempts to replicate this in JavaScript by calling Google's internal APIs failed because the response format is undocumented and changes. The Python package is the only reliable method found. Do not attempt to rewrite this in JavaScript.

### Why Not the Official Google Street View API?
It requires a Google Cloud account with a credit card on file. The student does not want to risk charges. The free thumbnail endpoint (`streetviewpixels-pa.googleapis.com/v1/thumbnail`) provides the same images without any API key or billing.

### Why Not Full Panorama Downloads?
Full 360-degree panoramas are large (several MB each), slow to download (4+ minutes), and contain mostly irrelevant content (sky, road, buildings behind the camera). The thumbnail endpoint lets us request only the specific view we need at a reasonable resolution.

### Grid Labeling Philosophy
The user's core idea is that every unit of space in the image should be accounted for and labeled. Nothing should be unlabeled. This is analogous to how latitude/longitude labels every point on Earth. The grid system assigns a unique label to every cell. The user wants this to eventually extend to labeling every inch of physical distance along a wall, but for the prototype, pixel-level grid cells on the image are sufficient.

### Image Quality
The thumbnail endpoint produces images that are lower resolution than what Google renders in its own Street View viewer. This is acceptable for the prototype because the comparison doesn't need to read individual plaque text. It needs to detect whether objects were added or removed. The 800x400 resolution is sufficient for detecting structural changes (new plaques, removed flowers, etc.).

### What This Replaces
Previously, a student manually circled changes on printed photos with a green marker, year by year. This tool automates that process. Instead of a human examining the whole wall, the system flags the specific cells where changes occurred, and a human can verify just those spots.

### Academic Reference
The Stanford project (Gebru et al., 2017) "Using Deep Learning and Google Street View to Estimate the Demographic Makeup of the US" is the methodological inspiration. They scanned 50 million Street View images to identify cars and predict demographics. This project applies the same principle (mine Street View imagery programmatically) to a narrower domain (shrine devotion tracking). The Axios article describing this project was shared by Dean Hamilton: https://www.axios.com/2018/01/05/using-ai-to-mine-google-street-view-1515110942

### Future Enhancements (Not for Prototype)
- Automatic scanning of all 616 shrines in the database (batch processing)
- Object classification using a Hugging Face model (classify what changed: new plaque, new flower, removed item)
- Physical distance grid: dividing the wall's GPS span into inch-level units, each with its own coordinate
- Integration with the dean's shrine database
- Cloud hosting so the server doesn't need to run locally

---

## Test Coordinates

Use these to verify the system works:

**Largo Preneste, Rome**
- Latitude: 41.8929002
- Longitude: 12.5416944
- Heading: 310
- Pitch: -5
- Expected panoramas: 13 dated (2008-2025)
- This is a large shrine wall with plaques, flowers, candles, and religious imagery

---

## What Success Looks Like

The prototype is successful if:

1. User opens Google Maps Street View at Largo Preneste
2. Clicks the extension, clicks one button
3. Sees all 13 available dates with thumbnail previews
4. Can select any two dates and get a grid comparison
5. Can see exactly which cells changed between those dates
6. Can adjust sensitivity to filter out lighting changes vs actual structural changes
7. The whole process takes under 30 seconds after the initial panorama search
8. A non-technical person (Dean Hamilton) can understand the output

This is the deliverable for the meeting with Dean Hamilton.
