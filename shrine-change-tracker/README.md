# Shrine Change Tracker

A tool that tracks visual changes at street-level locations over time using Google Street View historical imagery. Built for academic research on urban shrine devotion in Rome, Italy.

## What This Is

Religious shrines throughout Rome accumulate votive plaques, flowers, candles, and other devotional items over time. Tracking these changes tells researchers how personal religious devotion grows, declines, or shifts at specific locations across years.

Previously, this was done by hand: a researcher would open Google Street View, look at each year's image of a shrine wall, and manually count every plaque — marking which ones were the same, which were new, and which had disappeared. For one site across 14 years of images, this could take days. For all 600+ mapped shrine sites in Rome, it would take months.

This tool automates that process. Give it a GPS coordinate, and it:

- Finds every available Street View image at that location (often going back to 2008)
- Lets you trace the wall surface once so it knows what to analyze
- Compares every consecutive year's image within that wall area
- Reports what percentage of the wall changed and when
- Detects when cars, trees, or signs are blocking the wall and excludes those areas

The output is the same kind of measurement the manual process produced — but in seconds instead of weeks.

## How It Works

The tool has two parts: a **Chrome browser extension** and a **local Python server**.

The Chrome extension detects when you are viewing Google Street View and captures the GPS coordinates and camera angle. It opens an analysis page with a step-by-step wizard.

The Python server runs on your computer. It fetches the actual Street View images, aligns them across years (since the camera position shifts slightly between captures), and runs the pixel-by-pixel comparison within the wall area you marked.

### The Wizard Steps

1. **Location Detected** — Confirms the GPS coordinates and that the server is running.
2. **Timeline** — Shows every available date as a thumbnail. You can click any image to set it as the reference (pick the clearest view of the wall). You can also fine-tune the camera angle for any image that looks slightly misaligned.
3. **Mark the Wall** — Shows the reference image. You click to trace a polygon around the wall surface. This tells the system: "Only analyze pixels inside this outline. Everything outside — sky, ground, sidewalk — ignore it entirely."
4. **Results** — Automatically compares every consecutive date pair. Shows a bar chart of change over time and a plain-language summary like: *"Between 2015-05 and 2016-06, 14% of the marked wall area changed. In the 2016 image, 92% of the wall was visible (8% was obstructed by a parked car)."*

### Two Modes of Use

**Interactive mode (current):** Navigate to a shrine in Google Street View, click the extension, and walk through the wizard. Good for exploring individual sites and validating results.

**Batch mode (planned):** Provide a CSV file with columns for site name, latitude, longitude, heading, and pitch. The system processes all sites automatically. The wall mask and camera angles for each site need to be set once by a researcher, but after that, the batch runs unattended for all 600+ sites.

## Built With

- Development: [Claude Code](https://claude.ai/code) (AI-assisted development)
- Architecture, product direction, and research: **Chima Ozonwoye**
- Academic supervision: **Louis Hamilton, PhD**, New Jersey Institute of Technology

## Setup

These instructions assume you have never used a terminal before. Follow every step in order.

### Install Prerequisites

#### 1. Install Python

Python is the programming language the server is written in.

- Go to https://www.python.org/downloads/
- Download the latest version for your operating system (Windows, Mac, or Linux)
- Run the installer
- **Important (Windows only):** Check the box that says **"Add Python to PATH"** during installation
- To verify, open a terminal and type `python3 --version` (you should see something like `Python 3.12.x`)

#### 2. Install Google Chrome

If you do not already have Chrome, download it from https://www.google.com/chrome/

#### 3. Download This Project

- Click the green **Code** button at the top of this GitHub page
- Click **Download ZIP**
- Unzip the downloaded file somewhere you can find it (like your Desktop)

### Install Dependencies

#### 4. Open a Terminal

- **Windows:** Search for "Command Prompt" or "PowerShell" in the Start menu
- **Mac:** Search for "Terminal" in Spotlight (Cmd + Space)

#### 5. Navigate to the Server Folder

Type this command and press Enter. Adjust the path if you unzipped to a different location:

```
cd Desktop/Kai/shrine-change-tracker/server
```

#### 6. Install Python Packages

```
pip install -r requirements.txt
```

This installs Flask, OpenCV, scikit-image, and the other libraries the server needs. It may take a minute or two.

### Start the Server

You need to do this every time you want to use the tool.

#### 7. Run the Server

Make sure you are in the server folder (step 5), then run:

```
python3 server.py
```

You should see:

```
==================================================
  Shrine Change Tracker Server
  Running on http://localhost:5000
==================================================
```

**Leave this terminal window open.** The server runs as long as this window is open.

### Load the Chrome Extension

You only need to do this once.

#### 8. Open the Extensions Page

Open Google Chrome. Type `chrome://extensions` in the address bar and press Enter.

#### 9. Enable Developer Mode

In the top-right corner of the extensions page, toggle **Developer mode** on.

#### 10. Load the Extension

- Click **Load unpacked**
- Navigate to the `shrine-change-tracker/extension` folder inside your unzipped project
- Click **Select Folder**
- You should see "Shrine Change Tracker" appear in your extensions list

#### 11. Pin the Extension (Optional)

Click the puzzle piece icon in Chrome's toolbar, then click the pin icon next to "Shrine Change Tracker." The icon will now always be visible.

### Use the Tool

#### 12. Go to a Shrine in Google Street View

- Go to https://maps.google.com
- Find a location (try Largo Preneste in Rome: `41.8929, 12.5417`)
- Enter Street View by dragging the yellow person icon onto the street
- Position yourself facing the wall you want to analyze

#### 13. Click the Extension and Analyze

- Click the Shrine Change Tracker icon in Chrome's toolbar
- Confirm it shows "Server connected" with a green dot
- Click **Analyze Location**
- Follow the 4-step wizard in the new tab that opens

## Test Coordinates

**Largo Preneste, Rome** (known to have 13 dated panoramas from 2008-2025):
- Latitude: 41.8929002
- Longitude: 12.5416944
- Heading: 310
- Pitch: -5

## Troubleshooting

**"Server offline" error:** The Python server is not running. Go back to step 7 and make sure the terminal window is still open.

**No panoramas found:** Not every Street View location has historical imagery. Try a different location, or make sure you are actually in Street View mode (not just the regular map).

**Images look misaligned between years:** Hover over any thumbnail in Step 2 and click the gear icon to manually adjust the camera angle for that year.

**Extension not appearing:** Make sure Developer Mode is enabled in `chrome://extensions` and that you selected the `extension` folder (not the parent folder).

## Project Structure

```
shrine-change-tracker/
  server/
    server.py              # Python server (image fetching, comparison, alignment)
    requirements.txt       # Python dependencies
  extension/
    manifest.json          # Chrome extension manifest (V3)
    popup.html/js/css      # Extension popup (detects Street View location)
    analysis.html/js/css   # Analysis wizard (timeline, wall marking, results)
    icon48.png             # Extension icon
    icon128.png            # Extension icon
```
