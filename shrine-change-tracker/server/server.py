"""
Shrine Change Tracker - Local Python Server
Flask server that handles panorama searching, image fetching,
auto-alignment, polygon-mask-based comparison, and color-coded
annotated output for the Shrine Change Tracker Chrome extension.
"""

import hashlib
import json
import tempfile
import uuid
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

CACHE_DIR = Path(tempfile.gettempdir()) / "shrine_tracker_cache"
CACHE_DIR.mkdir(exist_ok=True)

ALIGN_CACHE_PATH = CACHE_DIR / "align_cache.json"

# Store generated annotated images keyed by unique ID
_image_store = {}

THUMBNAIL_BASE = (
    "https://streetviewpixels-pa.googleapis.com/v1/thumbnail"
    "?cb_client=maps_sv.tactile"
)

COMPARE_W = 1600
COMPARE_H = 800

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
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _cv_to_png_bytes(img):
    _, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def _polygon_pct_to_mask(polygon_pct, w, h):
    pts = np.array(
        [[int(p["x"] * w), int(p["y"] * h)] for p in polygon_pct],
        dtype=np.int32,
    )
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def _polygon_bbox(polygon_pct, w, h):
    """Get bounding box of polygon in pixel coords. Returns (x, y, bw, bh)."""
    xs = [int(p["x"] * w) for p in polygon_pct]
    ys = [int(p["y"] * h) for p in polygon_pct]
    x1 = max(0, min(xs))
    y1 = max(0, min(ys))
    x2 = min(w, max(xs))
    y2 = min(h, max(ys))
    return x1, y1, x2 - x1, y2 - y1


def _compute_ssim(img_a, img_b):
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)
    if gray_a.shape != gray_b.shape:
        gray_b = cv2.resize(gray_b, (gray_a.shape[1], gray_a.shape[0]))
    score, _ = ssim(gray_a, gray_b, full=True)
    return float(score)


def _compute_reference_texture(ref_img, mask):
    lab = cv2.cvtColor(ref_img, cv2.COLOR_BGR2LAB)
    masked_pixels = lab[mask == 255]
    if len(masked_pixels) == 0:
        return None
    return {
        "mean": masked_pixels.mean(axis=0).tolist(),
        "std": masked_pixels.std(axis=0).tolist(),
    }


def _detect_obstruction_pct(img, mask, ref_texture, cell_size):
    """Return (visible_pct, obstructed_pct)."""
    if ref_texture is None:
        return 100.0, 0.0

    h, w = img.shape[:2]
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float64)
    ref_mean = np.array(ref_texture["mean"])
    ref_std = np.array(ref_texture["std"])
    safe_std = np.maximum(ref_std, 5.0)

    grid_cols = w // cell_size
    grid_rows = h // cell_size
    visible = 0
    obstructed = 0

    for r in range(grid_rows):
        for c in range(grid_cols):
            x, y = c * cell_size, r * cell_size
            cx, cy = x + cell_size // 2, y + cell_size // 2
            if cy >= h or cx >= w or mask[cy, cx] == 0:
                continue
            cell_mask = mask[y:y + cell_size, x:x + cell_size]
            if np.count_nonzero(cell_mask) / (cell_size * cell_size) < 0.5:
                continue
            cell_mean = lab[y:y + cell_size, x:x + cell_size].mean(axis=(0, 1))
            dist = np.sqrt(np.sum(((cell_mean - ref_mean) / safe_std) ** 2))
            if dist > 4.0:
                obstructed += 1
            else:
                visible += 1

    total = visible + obstructed
    if total == 0:
        return 100.0, 0.0
    return round(visible / total * 100, 1), round(obstructed / total * 100, 1)


def _compute_masked_comparison(img_a, img_b, mask, cell_size, threshold):
    """Compare two images within the mask. Returns (cells, grid_rows, grid_cols)."""
    h, w = img_a.shape[:2]
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    grid_cols = w // cell_size
    grid_rows = h // cell_size
    cells = []
    for r in range(grid_rows):
        for c in range(grid_cols):
            x, y = c * cell_size, r * cell_size
            cx, cy = x + cell_size // 2, y + cell_size // 2
            if cy >= h or cx >= w or mask[cy, cx] == 0:
                continue
            cell_mask = mask[y:y + cell_size, x:x + cell_size]
            if np.count_nonzero(cell_mask) / (cell_size * cell_size) < 0.5:
                continue
            pa = gray_a[y:y + cell_size, x:x + cell_size]
            pb = gray_b[y:y + cell_size, x:x + cell_size]
            diff = float(np.mean(np.abs(pa - pb)))
            cells.append({
                "row": r, "col": c, "x": x, "y": y,
                "w": cell_size, "h": cell_size,
                "diff": round(diff, 2), "changed": diff >= threshold,
            })
    return cells, grid_rows, grid_cols


def _annotate_image(img, cells, cell_size, mask, is_b=False, cells_a_changed=None, cells_b_changed=None):
    """
    Draw color-coded annotations on the image, cropped to mask bounding box.

    Color legend (matching the previous student's manual approach):
    - Red outline:    Same item present in both images (unchanged cell)
    - Yellow outline: New item appeared in this image (cell changed, present in B but not highlighted in A)
    - Green outline:  Item gone from this image (cell changed, was in A but not in B)

    For image A: red = unchanged, green = gone (will disappear by B)
    For image B: red = unchanged, yellow = new (appeared since A)
    """
    annotated = img.copy()

    for cell in cells:
        x, y, cw, ch = cell["x"], cell["y"], cell["w"], cell["h"]
        if cell["changed"]:
            if is_b:
                # Yellow: new in B
                color = (0, 255, 255)  # BGR yellow
            else:
                # Green: gone from A (will disappear by B)
                color = (0, 200, 0)  # BGR green
            cv2.rectangle(annotated, (x + 1, y + 1), (x + cw - 1, y + ch - 1), color, 2)
        else:
            # Red: same in both
            color = (0, 0, 220)  # BGR red
            cv2.rectangle(annotated, (x + 1, y + 1), (x + cw - 1, y + ch - 1), color, 1)

    return annotated


def _crop_to_mask_bbox(img, polygon_pct, w, h, pad=20):
    """Crop image to the bounding box of the polygon mask with padding."""
    bx, by, bw, bh = _polygon_bbox(polygon_pct, w, h)
    x1 = max(0, bx - pad)
    y1 = max(0, by - pad)
    x2 = min(w, bx + bw + pad)
    y2 = min(h, by + bh + pad)
    return img[y1:y2, x1:x2]


def _store_image(img_bytes):
    """Store an image and return its ID."""
    img_id = str(uuid.uuid4())[:12]
    _image_store[img_id] = img_bytes
    return img_id


def _demo_key(lat, lon):
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
        results = [{"pano_id": p.pano_id, "date": p.date, "lat": p.lat, "lon": p.lon} for p in dated]
        return jsonify({"panoramas": results})
    except Exception as e:
        key = _demo_key(lat, lon)
        if key in DEMO_PANORAMAS:
            return jsonify({"panoramas": DEMO_PANORAMAS[key], "source": "demo_fallback"})
        return jsonify({"error": f"Panorama search failed: {e}"}), 500


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


@app.route("/image/<image_id>", methods=["GET"])
def serve_image(image_id):
    """Serve a stored annotated image by ID."""
    if image_id not in _image_store:
        return jsonify({"error": "Image not found"}), 404
    return Response(_image_store[image_id], mimetype="image/png")


@app.route("/auto-align", methods=["POST"])
def auto_align():
    data = request.get_json(force=True)
    ref_pano_id = data["ref_pano_id"]
    target_pano_id = data["target_pano_id"]
    base_heading = float(data["heading"])
    base_pitch = float(data["pitch"])
    mask_polygon = data.get("mask_polygon")

    align_cache = _load_align_cache()
    cache_key = f"{ref_pano_id}_{target_pano_id}_{base_heading}_{base_pitch}"
    if mask_polygon:
        poly_hash = hashlib.md5(json.dumps(mask_polygon).encode()).hexdigest()[:8]
        cache_key += f"_mask_{poly_hash}"
    if cache_key in align_cache:
        return jsonify(align_cache[cache_key])

    try:
        ref_bytes = _fetch_thumbnail_bytes(ref_pano_id, base_heading, base_pitch, COMPARE_W, COMPARE_H)
        ref_img = _bytes_to_cv(ref_bytes)
        if ref_img is None:
            return jsonify({"error": "Failed to decode reference image"}), 500
        ref_img = cv2.resize(ref_img, (COMPARE_W, COMPARE_H))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    ref_compare = ref_img
    mask = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, COMPARE_W, COMPARE_H)
        ref_compare = cv2.bitwise_and(ref_img, ref_img, mask=mask)

    best_score, best_heading, best_pitch = -1, base_heading, base_pitch
    for dh in [-5, 0, 5]:
        for dp in [-3, 0, 3]:
            try:
                t_bytes = _fetch_thumbnail_bytes(target_pano_id, base_heading + dh, base_pitch + dp, COMPARE_W, COMPARE_H)
                t_img = _bytes_to_cv(t_bytes)
                if t_img is None:
                    continue
                t_img = cv2.resize(t_img, (COMPARE_W, COMPARE_H))
                t_compare = cv2.bitwise_and(t_img, t_img, mask=mask) if mask is not None else t_img
                score = _compute_ssim(ref_compare, t_compare)
                if score > best_score:
                    best_score, best_heading, best_pitch = score, base_heading + dh, base_pitch + dp
            except Exception:
                continue

    result = {"heading": best_heading, "pitch": best_pitch, "ssim_score": round(best_score, 4)}
    align_cache[cache_key] = result
    _save_align_cache(align_cache)
    return jsonify(result)


@app.route("/compare-all", methods=["POST"])
def compare_all():
    """
    Compare all consecutive date pairs. For each pair, generate color-coded
    annotated images (cropped to wall area) and return URLs + stats.

    Color code:
      Red   = same (unchanged between the two images)
      Yellow = new (appeared in the later image)
      Green  = gone (disappeared from the earlier image)

    Returns a list of pair results, each with image URLs for annotated A and B,
    change percentage, obstruction info, and a plain-language summary.
    """
    data = request.get_json(force=True)
    panos = data["panoramas"]  # [{pano_id, date, heading, pitch}, ...]
    mask_polygon = data.get("mask_polygon")
    ref_pano_id = data.get("ref_pano_id")
    ref_heading = float(data.get("ref_heading", 0))
    ref_pitch = float(data.get("ref_pitch", 0))
    cell_size = int(data.get("cell_size", 15))
    threshold = float(data.get("threshold", 12))
    w, h = COMPARE_W, COMPARE_H

    mask = None
    ref_texture = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, w, h)
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
        pa, pb = panos[i], panos[i + 1]

        try:
            bytes_a = _fetch_thumbnail_bytes(pa["pano_id"], pa["heading"], pa["pitch"], w, h)
            bytes_b = _fetch_thumbnail_bytes(pb["pano_id"], pb["heading"], pb["pitch"], w, h)
            img_a = _bytes_to_cv(bytes_a)
            img_b = _bytes_to_cv(bytes_b)

            if img_a is None or img_b is None:
                results.append({"date_a": pa["date"], "date_b": pb["date"], "error": "decode failed"})
                continue

            img_a = cv2.resize(img_a, (w, h))
            img_b = cv2.resize(img_b, (w, h))

            # Compute comparison
            cells, _, _ = _compute_masked_comparison(img_a, img_b, mask, cell_size, threshold)
            changed = sum(1 for c in cells if c["changed"])
            total = len(cells)
            change_pct = round(changed / total * 100, 1) if total > 0 else 0.0

            # Obstruction
            vis_a_pct, obs_a_pct = _detect_obstruction_pct(img_a, mask, ref_texture, cell_size)
            vis_b_pct, obs_b_pct = _detect_obstruction_pct(img_b, mask, ref_texture, cell_size)

            # Generate annotated images
            ann_a = _annotate_image(img_a, cells, cell_size, mask, is_b=False)
            ann_b = _annotate_image(img_b, cells, cell_size, mask, is_b=True)

            # Crop to wall bounding box
            if mask_polygon and len(mask_polygon) >= 3:
                ann_a = _crop_to_mask_bbox(ann_a, mask_polygon, w, h)
                ann_b = _crop_to_mask_bbox(ann_b, mask_polygon, w, h)

            # Store and get URLs
            id_a = _store_image(_cv_to_png_bytes(ann_a))
            id_b = _store_image(_cv_to_png_bytes(ann_b))

            # Also store plain wall crops (no annotations) for reference
            plain_a = img_a.copy()
            plain_b = img_b.copy()
            if mask_polygon and len(mask_polygon) >= 3:
                plain_a = _crop_to_mask_bbox(plain_a, mask_polygon, w, h)
                plain_b = _crop_to_mask_bbox(plain_b, mask_polygon, w, h)
            id_plain_a = _store_image(_cv_to_png_bytes(plain_a))
            id_plain_b = _store_image(_cv_to_png_bytes(plain_b))

            # Plain-language summary
            summary = f"Between {pa['date']} and {pb['date']}, {change_pct}% of the wall surface changed."
            if obs_b_pct > 5:
                summary += f" Note: {obs_b_pct}% of the wall was blocked by obstructions in {pb['date']}."
            if obs_a_pct > 5:
                summary += f" {obs_a_pct}% was blocked in {pa['date']}."

            results.append({
                "date_a": pa["date"],
                "date_b": pb["date"],
                "pano_id_a": pa["pano_id"],
                "pano_id_b": pb["pano_id"],
                "change_pct": change_pct,
                "changed_cells": changed,
                "total_cells": total,
                "visible_a_pct": vis_a_pct,
                "visible_b_pct": vis_b_pct,
                "obstructed_a_pct": obs_a_pct,
                "obstructed_b_pct": obs_b_pct,
                "annotated_a_url": f"/image/{id_a}",
                "annotated_b_url": f"/image/{id_b}",
                "plain_a_url": f"/image/{id_plain_a}",
                "plain_b_url": f"/image/{id_plain_b}",
                "summary": summary,
            })

        except Exception as e:
            results.append({"date_a": pa["date"], "date_b": pb["date"], "error": str(e)})

    return jsonify({"pairs": results})


@app.route("/wall-crop", methods=["POST"])
def wall_crop():
    """
    Return a high-res wall-only crop for a single panorama.
    Used for the mask drawing step (big, clear image).
    """
    data = request.get_json(force=True)
    pano_id = data["pano_id"]
    heading = float(data["heading"])
    pitch = float(data["pitch"])

    try:
        img_bytes = _fetch_thumbnail_bytes(pano_id, heading, pitch, COMPARE_W, COMPARE_H)
        img = _bytes_to_cv(img_bytes)
        if img is None:
            return jsonify({"error": "decode failed"}), 500
        img = cv2.resize(img, (COMPARE_W, COMPARE_H))
        img_id = _store_image(_cv_to_png_bytes(img))
        return jsonify({"image_url": f"/image/{img_id}", "width": COMPARE_W, "height": COMPARE_H})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("=" * 50)
    print("  Shrine Change Tracker Server")
    print("  Running on http://localhost:5000")
    print("=" * 50)
    app.run(host="127.0.0.1", port=5000, debug=True)
