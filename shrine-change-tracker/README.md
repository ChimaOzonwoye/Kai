# Shrine Change Tracker

A Chrome extension that tracks changes to Roman votive shrines over time using Google Street View historical imagery and a local AI vision model.

**What it does:** You navigate to a shrine in Google Street View, click the extension, and it pulls every historical image of that location (sometimes spanning 15+ years). A local AI model (Gemma 3 Vision) then analyzes each image — counting plaques, flowers, candles, and other devotional items — and shows you how the shrine has changed over time with a chart and side-by-side comparisons.

**How it works:** The AI runs entirely on your computer via Ollama. No data is sent to the cloud. No API keys needed.

## Is This Safe?

**Yes.** Here's exactly what each component does and doesn't do:

- **Ollama** is an open-source tool that runs AI models locally on your computer. It does NOT access the internet, does NOT send your data anywhere, does NOT read or modify your files, and does NOT run unless you start it. It can only answer questions when your server explicitly asks it one. Think of it like a calculator — it sits there doing nothing until you give it a problem.
- **The Python server** only talks to two things: Google Street View (to download public street images) and Ollama (to analyze those images). It cannot access your documents, photos, email, or anything else on your computer.
- **The Chrome extension** only activates when you click it on a Google Street View page. It reads the URL to get GPS coordinates. It cannot access your browsing history, passwords, or other tabs.

None of these components run in the background, start automatically, or do anything you didn't explicitly ask them to do.

## What This Is

Religious shrines throughout Rome accumulate votive plaques, flowers, candles, and other devotional items over time. Tracking these changes tells researchers how personal religious devotion grows, declines, or shifts at specific locations across years.

Previously, this was done by hand: a researcher would open Google Street View, look at each year's image of a shrine wall, and manually count every plaque. For one site across 14 years of images, this could take days. For all 600+ mapped shrine sites in Rome, it would take months.

This tool automates that process using AI vision.

## Built With

- Development: [Claude Code](https://claude.ai/code) (AI-assisted development)
- Architecture, product direction, and research: **Chima Ozonwoye**
- Academic supervision: **Louis Hamilton, PhD**, New Jersey Institute of Technology

---

## Setup

Follow every step in order. You will copy and paste commands into a terminal.

### What You Need

- **Google Chrome** browser
- **Python 3.9 or newer** (check with `python3 --version` or `python --version`)
- **~4 GB free disk space** (for the AI model)
- **8 GB+ RAM** (16 GB or more recommended)

If you don't have Python, download it from https://www.python.org/downloads/
**Windows users:** Check "Add Python to PATH" during installation.

---

### Step 1: Install Ollama

Ollama is a free tool that runs AI models locally on your computer.

#### Windows

1. Go to https://ollama.com/download/windows
2. Download and run the installer
3. Follow the prompts — it installs like any normal program
4. Ollama starts automatically and shows an icon in your system tray (bottom-right of taskbar)

#### macOS

1. Go to https://ollama.com/download/mac
2. Download and open the `.dmg` file
3. Drag Ollama to your Applications folder
4. Open Ollama from Applications — it shows in your menu bar

#### Linux / WSL

Open a terminal and run:

```bash
sudo apt-get install zstd
curl -fsSL https://ollama.ai/install.sh | sh
```

Then start it:

```bash
ollama serve
```

Keep this terminal open (or run it in the background).

---

### Step 2: Download the AI Model

Open a **new terminal** (Command Prompt on Windows, Terminal on Mac/Linux) and run:

```bash
ollama pull gemma3:4b
```

This downloads the Gemma 3 Vision model (~3 GB). It only downloads once.

To verify it worked:

```bash
ollama list
```

You should see `gemma3:4b` in the list.

---

### Step 3: Download This Project

- Click the green **Code** button at the top of this GitHub page
- Click **Download ZIP**
- Unzip the file somewhere easy to find (like your Desktop or Documents folder)

Or if you have Git:

```bash
git clone https://github.com/ChimaOzonwoye/Kai.git
```

---

### Step 4: Set Up the Python Server

Open a terminal and navigate to the server folder, then create a virtual environment and install dependencies.

#### Windows (Command Prompt)

```cmd
cd Desktop\Kai\shrine-change-tracker\server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

#### Windows (PowerShell)

```powershell
cd Desktop\Kai\shrine-change-tracker\server
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

#### macOS / Linux

```bash
cd ~/Desktop/Kai/shrine-change-tracker/server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

> **Note:** Adjust the `cd` path if you unzipped the project to a different location.

---

### Step 5: Load the Chrome Extension

You only need to do this once.

1. Open Google Chrome
2. Type `chrome://extensions/` in the address bar and press Enter
3. Turn on **Developer mode** (toggle switch in the top-right corner)
4. Click **Load unpacked**
5. Navigate to the `shrine-change-tracker/extension` folder and select it
6. You should see "Shrine Change Tracker" appear in your extensions list
7. **Pin it:** Click the puzzle piece icon in Chrome's toolbar, then click the pin icon next to "Shrine Change Tracker"

---

## How to Use

### Every time you want to use it:

#### 1. Make sure Ollama is running

- **Windows:** It starts automatically. Look for the Ollama icon in your system tray.
- **macOS:** Look for the Ollama icon in your menu bar. If not there, open it from Applications.
- **Linux:** Run `ollama serve` in a terminal and keep it open.

#### 2. Start the server

Open a terminal:

**Windows (Command Prompt):**
```cmd
cd Desktop\Kai\shrine-change-tracker\server
venv\Scripts\activate
python server.py
```

**Windows (PowerShell):**
```powershell
cd Desktop\Kai\shrine-change-tracker\server
.\venv\Scripts\Activate.ps1
python server.py
```

**macOS / Linux:**
```bash
cd ~/Desktop/Kai/shrine-change-tracker/server
source venv/bin/activate
python server.py
```

You should see:
```
==================================================
  Shrine Change Tracker Server
  Running on http://localhost:5000
==================================================
```

**Keep this terminal open** while using the extension.

#### 3. Open Google Street View

1. Go to https://maps.google.com in Chrome
2. Navigate to a shrine location (try Rome, Italy)
3. Drop into Street View (drag the yellow person icon onto the street)
4. Point your view at the shrine wall

#### 4. Click the extension and analyze

1. Click the **Shrine Change Tracker** icon in your Chrome toolbar
2. It should show "Server + AI ready" with a green dot
3. Click **"Analyze Location"**
4. A new tab opens with the analysis wizard

#### 5. Follow the wizard

- **Step 1 — Location:** Confirms your coordinates. Click "Continue to Timeline."
- **Step 2 — Timeline:** Shows every historical image as a thumbnail. Click one to set it as the reference (pick the clearest view). Click "Mark the Wall."
- **Step 3 — Mark the Wall (Optional):** Draw a polygon around the wall for focused analysis, or click "Analyze Changes" to let the AI scan the full image.
- **Step 4 — Results:** The AI analyzes each image (~4 seconds per image). You'll see:
  - A **bar chart** showing total items detected over time
  - **Side-by-side comparisons** between consecutive years with categorized counts (plaques, flowers, candles, pictures)
  - **Change summaries** showing what was added or removed

---

## Demo Location

If you don't have a specific shrine in mind, try this:

**Largo Preneste, Rome** — has 13 panoramas spanning 2008-2025:
- Latitude: `41.8929`
- Longitude: `12.5417`

The extension includes built-in demo data for this location.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Server offline"** | Make sure `python server.py` is running in your terminal. Make sure you activated the virtual environment first. |
| **"Ollama not running"** | Start Ollama. Windows/Mac: it should auto-start. Linux: run `ollama serve` in a terminal. |
| **"AI model not found"** | Run `ollama pull gemma3:4b` to download the model. |
| **Analysis is slow** | Each image takes ~3-5 seconds on CPU. 13 images = ~1 minute. If you have a GPU, Ollama uses it automatically. |
| **pip install fails** | Make sure you're using Python 3.9+. Try `python3` instead of `python`. Make sure the virtual environment is activated. |
| **Extension doesn't detect location** | Make sure you're on a Google Street View page (URL contains `@` coordinates). Refresh and try again. |
| **Images look misaligned** | In Step 2, hover over any thumbnail and click the gear icon to adjust the camera angle. |
| **Extension not showing** | In `chrome://extensions/`, make sure Developer Mode is on and you loaded the `extension` folder. |

---

## Project Structure

```
shrine-change-tracker/
├── extension/              # Chrome extension
│   ├── manifest.json       # Extension configuration
│   ├── popup.html/js/css   # Popup (detects Street View location)
│   ├── analysis.html       # Analysis wizard page
│   ├── analysis.js         # Wizard logic and visualization
│   ├── analysis.css        # Styling
│   └── icon*.png           # Extension icons
└── server/
    ├── server.py           # Flask backend + Ollama integration
    └── requirements.txt    # Python dependencies
```
