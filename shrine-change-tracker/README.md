# Shrine Change Tracker

A Chrome extension that detects visual changes at street-level locations over time using Google Street View historical imagery. Built for tracking devotional activity at urban shrines in Rome, Italy (plaques, flowers, candles added/removed from walls), but works at any location with Street View coverage.

Academic research project supervised by Dean Louis Hamilton, PhD at NJIT.

## How It Works

1. Open Google Maps Street View and navigate to a location
2. Click the extension icon
3. The extension reads coordinates and viewing angle from the URL
4. It finds all historical panoramas available at that location (dates from 2008-2025)
5. It fetches a targeted image at each date, all at the same angle
6. Select two dates to compare
7. The system divides both images into a labeled grid and highlights which cells changed
8. View results: overlay images, change heatmap, summary statistics, and a list of changed cells

## Architecture

- **Chrome Extension (Frontend)**: Popup UI + analysis page that handles visualization
- **Python Server (Backend)**: Flask server that searches panoramas and fetches images

The Python backend is required because the `streetview` Python package reliably finds all historical panoramas at a given coordinate. This cannot be replicated in JavaScript.

## Prerequisites

- Python 3.10+
- Google Chrome
- pip

## Server Setup

```bash
cd shrine-change-tracker/server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 server.py
```

Server starts on http://localhost:5000

## Extension Setup

1. Open Chrome, go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `shrine-change-tracker/extension/` folder
5. Pin the extension in the toolbar

## Usage

1. Make sure `server.py` is running
2. Open [Google Maps](https://www.google.com/maps)
3. Enter Street View at any location
4. Position the view to face what you want to track
5. Click the extension icon
6. Click **Analyze**
7. View the timeline, select two dates, and click **Compare Selected Dates**
8. Adjust cell size and sensitivity as needed

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/search` | POST | Search panoramas at coordinates |
| `/thumbnail` | GET | Fetch Street View thumbnail image |
| `/compare` | POST | Compare two panoramas with grid analysis |
| `/overlay/<name>` | GET | Serve generated overlay images |

## Test Coordinates

**Largo Preneste, Rome**
- Latitude: 41.8929002
- Longitude: 12.5416944
- Heading: 310
- Pitch: -5
- Expected: 13 dated panoramas (2008-2025)

## Project Structure

```
shrine-change-tracker/
  README.md
  server/
    server.py              # Flask server
    requirements.txt       # Python dependencies
  extension/
    manifest.json          # Chrome extension manifest (V3)
    popup.html/js/css      # Extension popup
    analysis.html/js/css   # Analysis page
    icon48.png             # Extension icon (48x48)
    icon128.png            # Extension icon (128x128)
```
