"""
Shrine Change Tracker - Local Python Server
Flask server that handles panorama searching, image fetching,
auto-alignment, and polygon-mask-based comparison for the
Shrine Change Tracker Chrome extension.
"""

import hashlib
import json
import tempfile
from pathlib import Path

import cv2
import numpy as np
import requests
import streetview
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from skimage.metrics import structural_similarity as ssim

app = Flask(__name__)
CORS(app)

# Cache directory for downloaded thumbnails
CACHE_DIR = Path(tempfile.gettempdir()) / "shrine_tracker_cache"
CACHE_DIR.mkdir(exist_ok=True)

# Cache for best-aligned heading/pitch per panorama
ALIGN_CACHE_PATH = CACHE_DIR / "align_cache.json"

# In-memory store for last comparison overlay images
_overlay_store = {}

THUMBNAIL_BASE = (
    "https://streetviewpixels-pa.googleapis.com/v1/thumbnail"
    "?cb_client=maps_sv.tactile"
)

# High-res size for comparisons
COMPARE_W = 1600
COMPARE_H = 800

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


# ───────── Helpers ─────────


def _load_align_cache():
    if ALIGN_CACHE_PATH.exists():
        try:
            return json.loads(ALIGN_CACHE_PATH.read_text())
        except Exception:
            return {}
    return {}


def _save_align_cache(cache):
    ALIGN_CACHE_PATH.write_text(json.dumps(cache))


def _cache_key(pano_id, heading, pitch, w, h):
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


def _polygon_pct_to_mask(polygon_pct, w, h):
    """
    Convert a polygon defined as percentage coordinates [{x, y}, ...]
    into a binary mask of shape (h, w). Pixels inside the polygon are 255.
    """
    pts = np.array(
        [[int(p["x"] * w), int(p["y"] * h)] for p in polygon_pct],
        dtype=np.int32,
    )
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def _compute_ssim(img_a, img_b):
    """Compute SSIM between two images (grayscale). Returns float 0-1."""
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)
    if gray_a.shape != gray_b.shape:
        gray_b = cv2.resize(gray_b, (gray_a.shape[1], gray_a.shape[0]))
    score, _ = ssim(gray_a, gray_b, full=True)
    return float(score)


def _compute_reference_texture(ref_img, mask):
    """
    Compute a texture descriptor for the wall in the reference image.
    Returns the mean color and std dev of masked pixels in LAB color space,
    which is perceptually uniform and better for color comparison.
    """
    lab = cv2.cvtColor(ref_img, cv2.COLOR_BGR2LAB)
    masked_pixels = lab[mask == 255]
    if len(masked_pixels) == 0:
        return None
    return {
        "mean": masked_pixels.mean(axis=0).tolist(),
        "std": masked_pixels.std(axis=0).tolist(),
    }


def _detect_obstruction(img, mask, ref_texture, cell_size):
    """
    For each cell inside the mask, check if it looks like wall texture
    (similar to the reference) or is obstructed (drastically different).

    Returns:
      - mask_cells: list of cell dicts with obstruction info
      - visible_count: cells that look like wall
      - obstructed_count: cells that look obstructed
      - total_mask_cells: total cells inside the mask
    """
    if ref_texture is None:
        return [], 0, 0, 0

    h, w = img.shape[:2]
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float64)

    ref_mean = np.array(ref_texture["mean"])
    ref_std = np.array(ref_texture["std"])

    grid_cols = w // cell_size
    grid_rows = h // cell_size

    mask_cells = []
    visible_count = 0
    obstructed_count = 0

    for r in range(grid_rows):
        for c in range(grid_cols):
            x = c * cell_size
            y = r * cell_size

            # Check if this cell is inside the mask (center point)
            cx = x + cell_size // 2
            cy = y + cell_size // 2
            if cy >= h or cx >= w or mask[cy, cx] == 0:
                continue

            # Also check what fraction of this cell is inside the mask
            cell_mask = mask[y:y + cell_size, x:x + cell_size]
            mask_ratio = np.count_nonzero(cell_mask) / (cell_size * cell_size)
            if mask_ratio < 0.5:
                continue

            # Get this cell's LAB values
            cell_lab = lab[y:y + cell_size, x:x + cell_size]
            cell_mean = cell_lab.mean(axis=(0, 1))

            # Compute color distance from reference wall texture
            # Use Mahalanobis-like distance with reference std
            safe_std = np.maximum(ref_std, 5.0)  # prevent division by tiny values
            color_dist = np.sqrt(np.sum(((cell_mean - ref_mean) / safe_std) ** 2))

            # A cell is "obstructed" if its color is very different from wall texture
            # Threshold of 4.0 std deviations catches cars, trees, signs etc.
            is_obstructed = color_dist > 4.0

            if is_obstructed:
                obstructed_count += 1
            else:
                visible_count += 1

            mask_cells.append({
                "row": r,
                "col": c,
                "x": x,
                "y": y,
                "w": cell_size,
                "h": cell_size,
                "obstructed": is_obstructed,
                "color_dist": round(float(color_dist), 2),
            })

    total = visible_count + obstructed_count
    return mask_cells, visible_count, obstructed_count, total


def _compute_masked_comparison(img_a, img_b, mask, cell_size, threshold):
    """
    Compare two images only within the polygon mask.
    Skips cells outside the mask entirely.

    Returns (cells_list, grid_rows, grid_cols, total_mask_cells).
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

            # Check if this cell's center is inside the mask
            cx = x + cell_size // 2
            cy = y + cell_size // 2
            if cy >= h or cx >= w or mask[cy, cx] == 0:
                continue

            # Check mask coverage of this cell
            cell_mask = mask[y:y + cell_size, x:x + cell_size]
            mask_ratio = np.count_nonzero(cell_mask) / (cell_size * cell_size)
            if mask_ratio < 0.5:
                continue

            patch_a = gray_a[y:y + cell_size, x:x + cell_size]
            patch_b = gray_b[y:y + cell_size, x:x + cell_size]
            diff = float(np.mean(np.abs(patch_a - patch_b)))

            cells.append({
                "label": f"R{r:03d}-C{c:03d}",
                "row": r,
                "col": c,
                "x": x,
                "y": y,
                "w": cell_size,
                "h": cell_size,
                "diff": round(diff, 2),
                "changed": diff >= threshold,
            })

    return cells, grid_rows, grid_cols


def _draw_overlay(img, cells, cell_size):
    """Draw grid overlay on an image, highlighting changed cells."""
    overlay = img.copy()
    for cell in cells:
        x, y = cell["x"], cell["y"]
        cv2.rectangle(overlay, (x, y), (x + cell_size, y + cell_size), (180, 180, 180), 1)
        if cell["changed"]:
            alpha = min(cell["diff"] / 50.0, 1.0)
            color = (0, int(255 * (1 - alpha)), 255)
            sub = overlay[y:y + cell_size, x:x + cell_size]
            rect = np.full_like(sub, color, dtype=np.uint8)
            cv2.addWeighted(rect, 0.4, sub, 0.6, 0, sub)
    return overlay


def _draw_heatmap(shape, cells, cell_size):
    """Generate a change heatmap image."""
    h, w = shape[:2]
    heatmap = np.zeros((h, w), dtype=np.float64)
    for cell in cells:
        x, y = cell["x"], cell["y"]
        heatmap[y:y + cell_size, x:x + cell_size] = cell["diff"]
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
        key = _demo_key(lat, lon)
        if key in DEMO_PANORAMAS:
            return jsonify({
                "panoramas": DEMO_PANORAMAS[key],
                "source": "demo_fallback",
                "note": f"Live search failed ({e}). Using cached demo data.",
            })

        return jsonify({
            "error": f"Panorama search failed: {e}",
            "hint": "Make sure you are running this server on your local machine. "
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


@app.route("/auto-align", methods=["POST"])
def auto_align():
    """
    Given a reference panorama and a target, try a 3x3 grid of heading/pitch
    offsets and return the best match using SSIM. Optionally uses a polygon
    mask to focus the comparison on the wall area only.
    """
    data = request.get_json(force=True)
    ref_pano_id = data["ref_pano_id"]
    target_pano_id = data["target_pano_id"]
    base_heading = float(data["heading"])
    base_pitch = float(data["pitch"])
    mask_polygon = data.get("mask_polygon")  # [{x, y}, ...] as 0-1 fractions

    # Check cache
    align_cache = _load_align_cache()
    cache_key = f"{ref_pano_id}_{target_pano_id}_{base_heading}_{base_pitch}"
    if mask_polygon:
        poly_hash = hashlib.md5(json.dumps(mask_polygon).encode()).hexdigest()[:8]
        cache_key += f"_mask_{poly_hash}"

    if cache_key in align_cache:
        return jsonify(align_cache[cache_key])

    # Fetch reference image
    try:
        ref_bytes = _fetch_thumbnail_bytes(ref_pano_id, base_heading, base_pitch, COMPARE_W, COMPARE_H)
        ref_img = _bytes_to_cv(ref_bytes)
        if ref_img is None:
            return jsonify({"error": "Failed to decode reference image"}), 500
        ref_img = cv2.resize(ref_img, (COMPARE_W, COMPARE_H))
    except Exception as e:
        return jsonify({"error": f"Failed to fetch reference image: {e}"}), 500

    # If mask provided, create it and apply to reference
    ref_compare = ref_img
    mask = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, COMPARE_W, COMPARE_H)
        # Zero out pixels outside mask for SSIM comparison
        ref_compare = cv2.bitwise_and(ref_img, ref_img, mask=mask)

    # Try 3x3 grid: heading +/-5, pitch +/-3
    heading_offsets = [-5, 0, 5]
    pitch_offsets = [-3, 0, 3]

    best_score = -1
    best_heading = base_heading
    best_pitch = base_pitch

    for dh in heading_offsets:
        for dp in pitch_offsets:
            h_try = base_heading + dh
            p_try = base_pitch + dp
            try:
                t_bytes = _fetch_thumbnail_bytes(target_pano_id, h_try, p_try, COMPARE_W, COMPARE_H)
                t_img = _bytes_to_cv(t_bytes)
                if t_img is None:
                    continue
                t_img = cv2.resize(t_img, (COMPARE_W, COMPARE_H))

                if mask is not None:
                    t_compare = cv2.bitwise_and(t_img, t_img, mask=mask)
                else:
                    t_compare = t_img

                score = _compute_ssim(ref_compare, t_compare)
                if score > best_score:
                    best_score = score
                    best_heading = h_try
                    best_pitch = p_try
            except Exception:
                continue

    result = {
        "heading": best_heading,
        "pitch": best_pitch,
        "ssim_score": round(best_score, 4),
        "offset_heading": best_heading - base_heading,
        "offset_pitch": best_pitch - base_pitch,
    }

    align_cache[cache_key] = result
    _save_align_cache(align_cache)

    return jsonify(result)


@app.route("/compare", methods=["POST"])
def compare():
    """
    Compare two panoramas using a polygon mask.
    Only pixels inside the mask are compared. Includes obstruction detection.
    """
    data = request.get_json(force=True)
    pano_a = data["pano_id_a"]
    pano_b = data["pano_id_b"]
    heading_a = float(data.get("heading_a", data.get("heading", 0)))
    pitch_a = float(data.get("pitch_a", data.get("pitch", 0)))
    heading_b = float(data.get("heading_b", heading_a))
    pitch_b = float(data.get("pitch_b", pitch_a))
    cell_size = int(data.get("cell_size", 15))
    threshold = float(data.get("threshold", 12))
    w = int(data.get("width", COMPARE_W))
    h = int(data.get("height", COMPARE_H))
    mask_polygon = data.get("mask_polygon")  # [{x, y}, ...] as 0-1 fractions
    ref_pano_id = data.get("ref_pano_id")  # pano used as reference for texture

    # Fetch both images
    try:
        bytes_a = _fetch_thumbnail_bytes(pano_a, heading_a, pitch_a, w, h)
        bytes_b = _fetch_thumbnail_bytes(pano_b, heading_b, pitch_b, w, h)
    except Exception as e:
        return jsonify({"error": f"Failed to fetch images: {e}"}), 500

    img_a = _bytes_to_cv(bytes_a)
    img_b = _bytes_to_cv(bytes_b)

    if img_a is None or img_b is None:
        return jsonify({"error": "Failed to decode one or both images"}), 500

    img_a = cv2.resize(img_a, (w, h))
    img_b = cv2.resize(img_b, (w, h))

    # Create mask from polygon
    mask = None
    ref_texture = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, w, h)

        # Compute reference wall texture from the reference image
        # Use Image A by default, or a specific ref if provided
        ref_img = img_a
        if ref_pano_id and ref_pano_id != pano_a:
            try:
                ref_bytes = _fetch_thumbnail_bytes(ref_pano_id, heading_a, pitch_a, w, h)
                ref_loaded = _bytes_to_cv(ref_bytes)
                if ref_loaded is not None:
                    ref_img = cv2.resize(ref_loaded, (w, h))
            except Exception:
                pass
        ref_texture = _compute_reference_texture(ref_img, mask)

    # Perform comparison
    if mask is not None:
        cells, grid_rows, grid_cols = _compute_masked_comparison(
            img_a, img_b, mask, cell_size, threshold
        )
    else:
        # Fallback: full image comparison
        cells, grid_rows, grid_cols = _compute_masked_comparison(
            img_a, img_b,
            np.ones((h, w), dtype=np.uint8) * 255,
            cell_size, threshold
        )

    # Obstruction detection for Image B
    obstruction_a = {"visible_pct": 100.0, "obstructed_pct": 0.0}
    obstruction_b = {"visible_pct": 100.0, "obstructed_pct": 0.0}

    if mask is not None and ref_texture is not None:
        _, vis_a, obs_a, total_a = _detect_obstruction(img_a, mask, ref_texture, cell_size)
        _, vis_b, obs_b, total_b = _detect_obstruction(img_b, mask, ref_texture, cell_size)

        if total_a > 0:
            obstruction_a = {
                "visible_pct": round(vis_a / total_a * 100, 1),
                "obstructed_pct": round(obs_a / total_a * 100, 1),
                "visible_cells": vis_a,
                "obstructed_cells": obs_a,
                "total_cells": total_a,
            }
        if total_b > 0:
            obstruction_b = {
                "visible_pct": round(vis_b / total_b * 100, 1),
                "obstructed_pct": round(obs_b / total_b * 100, 1),
                "visible_cells": vis_b,
                "obstructed_cells": obs_b,
                "total_cells": total_b,
            }

    changed_count = sum(1 for c in cells if c["changed"])
    total = len(cells)
    change_pct = round(changed_count / total * 100, 1) if total > 0 else 0.0

    # Generate overlay images
    overlay_a = _draw_overlay(img_a, cells, cell_size)
    overlay_b = _draw_overlay(img_b, cells, cell_size)
    diff_map = _draw_heatmap(img_a.shape, cells, cell_size)

    # Dim areas outside mask in overlays
    if mask is not None:
        inv_mask = cv2.bitwise_not(mask)
        for ov in [overlay_a, overlay_b, diff_map]:
            ov[inv_mask == 255] = (ov[inv_mask == 255] * 0.2).astype(np.uint8)

    _overlay_store["a"] = _cv_to_png_bytes(overlay_a)
    _overlay_store["b"] = _cv_to_png_bytes(overlay_b)
    _overlay_store["diff"] = _cv_to_png_bytes(diff_map)

    qs_a = f"pano_id={pano_a}&heading={heading_a}&pitch={pitch_a}&w={w}&h={h}"
    qs_b = f"pano_id={pano_b}&heading={heading_b}&pitch={pitch_b}&w={w}&h={h}"

    return jsonify({
        "total_cells": total,
        "changed_cells": changed_count,
        "change_pct": change_pct,
        "grid_cols": grid_cols,
        "grid_rows": grid_rows,
        "cells": cells,
        "obstruction_a": obstruction_a,
        "obstruction_b": obstruction_b,
        "image_a_url": f"/thumbnail?{qs_a}",
        "image_b_url": f"/thumbnail?{qs_b}",
        "overlay_a_url": "/overlay/a",
        "overlay_b_url": "/overlay/b",
        "diff_map_url": "/overlay/diff",
    })


@app.route("/compare-consecutive", methods=["POST"])
def compare_consecutive():
    """
    Compare all consecutive date pairs within a polygon mask.
    Returns change percentages and obstruction info for each pair.

    Expects:
      panoramas: [{pano_id, date, heading, pitch}, ...]  (sorted by date)
      mask_polygon: [{x, y}, ...] as 0-1 fractions
      ref_pano_id: pano_id of the reference image for wall texture
      ref_heading: heading used for reference
      ref_pitch: pitch used for reference
      cell_size: int (optional, default 15)
      threshold: float (optional, default 12)
    """
    data = request.get_json(force=True)
    panos = data["panoramas"]
    mask_polygon = data.get("mask_polygon")
    ref_pano_id = data.get("ref_pano_id")
    ref_heading = float(data.get("ref_heading", 0))
    ref_pitch = float(data.get("ref_pitch", 0))
    cell_size = int(data.get("cell_size", 15))
    threshold = float(data.get("threshold", 12))
    w = COMPARE_W
    h = COMPARE_H

    # Create mask
    mask = None
    ref_texture = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, w, h)

        # Compute reference wall texture
        if ref_pano_id:
            try:
                ref_bytes = _fetch_thumbnail_bytes(ref_pano_id, ref_heading, ref_pitch, w, h)
                ref_img = _bytes_to_cv(ref_bytes)
                if ref_img is not None:
                    ref_img = cv2.resize(ref_img, (w, h))
                    ref_texture = _compute_reference_texture(ref_img, mask)
            except Exception:
                pass

    if mask is None:
        mask = np.ones((h, w), dtype=np.uint8) * 255

    results = []

    for i in range(len(panos) - 1):
        pa = panos[i]
        pb = panos[i + 1]

        try:
            bytes_a = _fetch_thumbnail_bytes(pa["pano_id"], pa["heading"], pa["pitch"], w, h)
            bytes_b = _fetch_thumbnail_bytes(pb["pano_id"], pb["heading"], pb["pitch"], w, h)

            img_a = _bytes_to_cv(bytes_a)
            img_b = _bytes_to_cv(bytes_b)

            if img_a is None or img_b is None:
                results.append({
                    "date_a": pa["date"], "date_b": pb["date"],
                    "change_pct": None, "error": "Failed to decode image",
                })
                continue

            img_a = cv2.resize(img_a, (w, h))
            img_b = cv2.resize(img_b, (w, h))

            cells, _, _ = _compute_masked_comparison(img_a, img_b, mask, cell_size, threshold)
            changed_count = sum(1 for c in cells if c["changed"])
            total = len(cells)
            change_pct = round(changed_count / total * 100, 1) if total > 0 else 0.0

            # Obstruction detection
            obs_a_info = {"visible_pct": 100.0, "obstructed_pct": 0.0}
            obs_b_info = {"visible_pct": 100.0, "obstructed_pct": 0.0}

            if ref_texture is not None:
                _, vis_a, obs_a, tot_a = _detect_obstruction(img_a, mask, ref_texture, cell_size)
                _, vis_b, obs_b, tot_b = _detect_obstruction(img_b, mask, ref_texture, cell_size)

                if tot_a > 0:
                    obs_a_info = {
                        "visible_pct": round(vis_a / tot_a * 100, 1),
                        "obstructed_pct": round(obs_a / tot_a * 100, 1),
                    }
                if tot_b > 0:
                    obs_b_info = {
                        "visible_pct": round(vis_b / tot_b * 100, 1),
                        "obstructed_pct": round(obs_b / tot_b * 100, 1),
                    }

            results.append({
                "date_a": pa["date"],
                "date_b": pb["date"],
                "pano_id_a": pa["pano_id"],
                "pano_id_b": pb["pano_id"],
                "change_pct": change_pct,
                "changed_cells": changed_count,
                "total_cells": total,
                "obstruction_a": obs_a_info,
                "obstruction_b": obs_b_info,
            })

        except Exception as e:
            results.append({
                "date_a": pa["date"], "date_b": pb["date"],
                "change_pct": None, "error": str(e),
            })

    return jsonify({"pairs": results})


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
