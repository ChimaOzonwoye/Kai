"""
Shrine Change Tracker - Local Python Server
Flask server that handles panorama searching and image fetching
for the Shrine Change Tracker Chrome extension.
"""

import hashlib
import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
import requests
import streetview
from flask import Flask, jsonify, request, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Cache directory for downloaded thumbnails
CACHE_DIR = Path(tempfile.gettempdir()) / "shrine_tracker_cache"
CACHE_DIR.mkdir(exist_ok=True)

# In-memory store for last comparison overlay images
_overlay_store = {}

THUMBNAIL_BASE = (
    "https://streetviewpixels-pa.googleapis.com/v1/thumbnail"
    "?cb_client=maps_sv.tactile"
)

# Demo data: known panoramas at Largo Preneste, Rome (for fallback/testing)
DEMO_PANORAMAS = {
    "41.893_12.542": [
        {"pano_id": "47x1tHcNc-nd5wD3i-aQEw", "date": "2008-05", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "iHr4lWIMtsGyFGPlEPP5-w", "date": "2011-11", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "o2vh0o5LqUgWk3l2fQr7tg", "date": "2014-08", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "ruNEQgRqbSQO_SaLeXfTVw", "date": "2015-05", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "aLkG_CyUpT8O46okPPaJHA", "date": "2016-06", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "jVczeIKJAfc-edVQsi3wUg", "date": "2017-08", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "Vu28QR3hMQ9SwtKh4XKS7A", "date": "2018-07", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "xAF1Dn82YhrzVPUVhiwTcQ", "date": "2019-07", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "Dmk6SS6M-_MxMFDj55mT6w", "date": "2020-10", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "DI6oVbZYLDXTaLSqKMWzRw", "date": "2021-03", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "ji1gBRZGsOZclIkoI0-k2Q", "date": "2022-05", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "2V3A-wbLdAWF6b0Y5dhNxA", "date": "2023-10", "lat": 41.8929002, "lon": 12.5416944},
        {"pano_id": "Dpgy8eH_lXO4vkldh5-wvw", "date": "2025-05", "lat": 41.8929002, "lon": 12.5416944},
    ]
}


def _cache_key(pano_id, heading, pitch, w, h):
    # Normalize all values to consistent types for cache key stability
    raw = f"{pano_id}_{float(heading)}_{float(pitch)}_{int(w)}_{int(h)}"
    return hashlib.md5(raw.encode()).hexdigest()


def _fetch_thumbnail_bytes(pano_id, heading, pitch, w=800, h=400):
    """Fetch a Street View thumbnail image. Returns raw JPEG bytes."""
    heading = float(heading)
    pitch = float(pitch)
    w = int(w)
    h = int(h)
    key = _cache_key(pano_id, heading, pitch, w, h)
    cache_path = CACHE_DIR / f"{key}.jpg"

    if cache_path.exists():
        return cache_path.read_bytes()

    url = f"{THUMBNAIL_BASE}&w={w}&h={h}&pitch={pitch}&panoid={pano_id}&yaw={heading}"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()

    cache_path.write_bytes(resp.content)
    return resp.content


def _bytes_to_cv(img_bytes):
    """Convert raw image bytes to an OpenCV BGR numpy array."""
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _cv_to_png_bytes(img):
    """Encode an OpenCV image to PNG bytes."""
    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _compute_grid(img_a, img_b, cell_size, threshold):
    """
    Compare two images using a grid approach.
    Returns (cells_list, grid_rows, grid_cols).
    """
    h, w = img_a.shape[:2]
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY).astype(np.float64)

    grid_cols = w // cell_size
    grid_rows = h // cell_size
    cells = []

    for r in range(grid_rows):
        for c in range(grid_cols):
            x = c * cell_size
            y = r * cell_size
            patch_a = gray_a[y : y + cell_size, x : x + cell_size]
            patch_b = gray_b[y : y + cell_size, x : x + cell_size]
            diff = float(np.mean(np.abs(patch_a - patch_b)))
            cells.append(
                {
                    "label": f"R{r:03d}-C{c:03d}",
                    "row": r,
                    "col": c,
                    "x": x,
                    "y": y,
                    "w": cell_size,
                    "h": cell_size,
                    "diff": round(diff, 2),
                    "changed": diff >= threshold,
                }
            )

    return cells, grid_rows, grid_cols


def _draw_overlay(img, cells, cell_size):
    """Draw grid overlay on an image, highlighting changed cells."""
    overlay = img.copy()
    for cell in cells:
        x, y = cell["x"], cell["y"]
        cv2.rectangle(overlay, (x, y), (x + cell_size, y + cell_size), (180, 180, 180), 1)
        if cell["changed"]:
            alpha = min(cell["diff"] / 50.0, 1.0)
            color = (0, int(255 * (1 - alpha)), 255)  # BGR: yellow->red
            sub = overlay[y : y + cell_size, x : x + cell_size]
            rect = np.full_like(sub, color, dtype=np.uint8)
            cv2.addWeighted(rect, 0.4, sub, 0.6, 0, sub)
    return overlay


def _draw_heatmap(shape, cells, cell_size):
    """Generate a change heatmap image."""
    h, w = shape[:2]
    heatmap = np.zeros((h, w), dtype=np.float64)

    for cell in cells:
        x, y = cell["x"], cell["y"]
        heatmap[y : y + cell_size, x : x + cell_size] = cell["diff"]

    max_val = heatmap.max() if heatmap.max() > 0 else 1.0
    heatmap_norm = (heatmap / max_val * 255).astype(np.uint8)
    colored = cv2.applyColorMap(heatmap_norm, cv2.COLORMAP_JET)

    for cell in cells:
        x, y = cell["x"], cell["y"]
        cv2.rectangle(colored, (x, y), (x + cell_size, y + cell_size), (100, 100, 100), 1)

    return colored


def _demo_key(lat, lon):
    """Round coordinates to find a demo match."""
    return f"{lat:.3f}_{lon:.3f}"


# ───────── API Endpoints ─────────


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/search", methods=["POST"])
def search_panoramas_endpoint():
    data = request.get_json(force=True)
    lat = float(data["lat"])
    lon = float(data["lon"])

    # Try the streetview package first
    try:
        panos = streetview.search_panoramas(lat, lon)
        dated = [p for p in panos if p.date is not None]
        dated.sort(key=lambda p: p.date)

        results = [
            {
                "pano_id": p.pano_id,
                "date": p.date,
                "lat": p.lat,
                "lon": p.lon,
            }
            for p in dated
        ]
        return jsonify({"panoramas": results})

    except Exception as e:
        # If the streetview package fails (e.g., network issues, API changes),
        # fall back to demo data if coordinates match a known location.
        key = _demo_key(lat, lon)
        if key in DEMO_PANORAMAS:
            return jsonify({
                "panoramas": DEMO_PANORAMAS[key],
                "source": "demo_fallback",
                "note": f"Live search failed ({e}). Using cached demo data for this known location.",
            })

        return jsonify({
            "error": f"Panorama search failed: {e}",
            "hint": "Make sure you are running this server on your local machine (not in a cloud environment). "
                    "Google may block requests from datacenter IPs.",
        }), 500


@app.route("/thumbnail", methods=["GET"])
def thumbnail():
    pano_id = request.args.get("pano_id")
    heading = request.args.get("heading", "0")
    pitch = request.args.get("pitch", "0")
    w = request.args.get("w", "800")
    h = request.args.get("h", "400")

    if not pano_id:
        return jsonify({"error": "pano_id is required"}), 400

    try:
        img_bytes = _fetch_thumbnail_bytes(pano_id, heading, pitch, int(w), int(h))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return Response(img_bytes, mimetype="image/jpeg")


@app.route("/compare", methods=["POST"])
def compare():
    data = request.get_json(force=True)
    pano_a = data["pano_id_a"]
    pano_b = data["pano_id_b"]
    heading = float(data.get("heading", 0))
    pitch = float(data.get("pitch", 0))
    cell_size = int(data.get("cell_size", 15))
    threshold = float(data.get("threshold", 12))
    w = int(data.get("width", 800))
    h = int(data.get("height", 400))

    # Fetch both images
    try:
        bytes_a = _fetch_thumbnail_bytes(pano_a, heading, pitch, w, h)
        bytes_b = _fetch_thumbnail_bytes(pano_b, heading, pitch, w, h)
    except Exception as e:
        return jsonify({"error": f"Failed to fetch images: {e}"}), 500

    img_a = _bytes_to_cv(bytes_a)
    img_b = _bytes_to_cv(bytes_b)

    if img_a is None or img_b is None:
        return jsonify({"error": "Failed to decode one or both images"}), 500

    # Resize to exact requested dimensions
    img_a = cv2.resize(img_a, (w, h))
    img_b = cv2.resize(img_b, (w, h))

    # Compute grid comparison
    cells, grid_rows, grid_cols = _compute_grid(img_a, img_b, cell_size, threshold)

    changed_count = sum(1 for c in cells if c["changed"])
    total = len(cells)
    change_pct = round(changed_count / total * 100, 1) if total > 0 else 0.0

    # Generate overlay images
    overlay_a = _draw_overlay(img_a, cells, cell_size)
    overlay_b = _draw_overlay(img_b, cells, cell_size)
    diff_map = _draw_heatmap(img_a.shape, cells, cell_size)

    # Store overlays for serving
    _overlay_store["a"] = _cv_to_png_bytes(overlay_a)
    _overlay_store["b"] = _cv_to_png_bytes(overlay_b)
    _overlay_store["diff"] = _cv_to_png_bytes(diff_map)

    qs_a = f"pano_id={pano_a}&heading={heading}&pitch={pitch}&w={w}&h={h}"
    qs_b = f"pano_id={pano_b}&heading={heading}&pitch={pitch}&w={w}&h={h}"

    return jsonify(
        {
            "total_cells": total,
            "changed_cells": changed_count,
            "change_pct": change_pct,
            "grid_cols": grid_cols,
            "grid_rows": grid_rows,
            "cells": cells,
            "image_a_url": f"/thumbnail?{qs_a}",
            "image_b_url": f"/thumbnail?{qs_b}",
            "overlay_a_url": "/overlay/a",
            "overlay_b_url": "/overlay/b",
            "diff_map_url": "/overlay/diff",
        }
    )


@app.route("/overlay/<name>", methods=["GET"])
def overlay(name):
    if name not in _overlay_store:
        return jsonify({"error": "No overlay available. Run /compare first."}), 404
    return Response(_overlay_store[name], mimetype="image/png")


if __name__ == "__main__":
    print("=" * 50)
    print("  Shrine Change Tracker Server")
    print("  Running on http://localhost:5000")
    print("=" * 50)
    app.run(host="127.0.0.1", port=5000, debug=True)
