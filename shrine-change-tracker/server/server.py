"""
Shrine Change Tracker - Local Python Server

Flask server that handles panorama searching, image fetching,
auto-alignment, polygon-mask-based comparison, and AI-powered
object counting for the Shrine Change Tracker Chrome extension.

Detection approach (Gemma 3 Vision via Ollama):
  1. Each wall image is sent to a local Gemma 3 Vision model running
     in Ollama for semantic understanding and object counting.
  2. The model counts objects by category: plaques, flowers, candles,
     pictures, and other devotional items.
  3. Changes between consecutive years are computed from count deltas.
  4. No training data needed — the model understands natural language
     descriptions of what to look for.
"""

import base64
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

# Store generated images keyed by unique ID
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


def _crop_to_mask_bbox(img, polygon_pct, w, h, pad=20):
    bx, by, bw, bh = _polygon_bbox(polygon_pct, w, h)
    x1 = max(0, bx - pad)
    y1 = max(0, by - pad)
    x2 = min(w, bx + bw + pad)
    y2 = min(h, by + bh + pad)
    return img[y1:y2, x1:x2]


def _store_image(img_bytes):
    img_id = str(uuid.uuid4())[:12]
    _image_store[img_id] = img_bytes
    return img_id


def _demo_key(lat, lon):
    return f"{lat:.3f}_{lon:.3f}"


# ───────── Object Counting (Ollama Vision Language Model) ─────────

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "gemma3:4b"

_VLM_PROMPT = (
    "Look at this image of a wall from a Roman votive shrine in Italy. "
    "Count every distinct object you can see mounted on or placed against the wall.\n\n"
    "Categories:\n"
    "- plaques: marble or stone tablets, ceramic tiles, memorial inscriptions, any flat mounted items\n"
    "- flowers: flower bouquets, arrangements, potted plants\n"
    "- candles: candles, lamps, any light sources placed as offerings\n"
    "- pictures: framed photographs, religious images, paintings, icons, prints\n"
    "- other: any other distinct devotional objects on the wall\n\n"
    "Return ONLY a JSON object with integer counts:\n"
    '{"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}'
)

_COUNT_CATEGORIES = ["plaques", "flowers", "candles", "pictures", "other"]


def _analyze_image_vlm(img):
    """Send image to Ollama Gemma 3 Vision for semantic object counting."""
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64_img = base64.b64encode(buf).decode("utf-8")

    resp = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL,
            "messages": [
                {"role": "user", "content": _VLM_PROMPT, "images": [b64_img]}
            ],
            "stream": False,
            "format": "json",
        },
        timeout=120,
    )
    resp.raise_for_status()

    data = resp.json()
    text = data["message"]["content"]
    counts = json.loads(text)

    for key in _COUNT_CATEGORIES:
        counts[key] = int(counts.get(key, 0))
    counts["total"] = sum(counts[k] for k in _COUNT_CATEGORIES)
    return counts


# ───────── API Endpoints ─────────

@app.route("/health", methods=["GET"])
def health():
    ollama_ok = False
    model_ready = False
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        if r.status_code == 200:
            ollama_ok = True
            models = r.json().get("models", [])
            model_ready = any(OLLAMA_MODEL in m.get("name", "") for m in models)
    except Exception:
        pass

    return jsonify({
        "status": "ok",
        "ollama": "connected" if ollama_ok else "not_connected",
        "model": OLLAMA_MODEL if model_ready else None,
    })


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
    Analyze each image using Gemma 3 Vision via Ollama.
    Returns categorized object counts per image and deltas between pairs.
    """
    data = request.get_json(force=True)
    panos = data["panoramas"]
    mask_polygon = data.get("mask_polygon")
    w, h = COMPARE_W, COMPARE_H

    has_mask = mask_polygon and len(mask_polygon) >= 3

    per_image = []
    crop_ids = []

    for i, p in enumerate(panos):
        try:
            img_bytes = _fetch_thumbnail_bytes(
                p["pano_id"], p["heading"], p["pitch"], w, h
            )
            img = _bytes_to_cv(img_bytes)
            if img is None:
                raise ValueError("Failed to decode image")
            img = cv2.resize(img, (w, h))

            # Crop to wall area if polygon provided
            if has_mask:
                display_img = _crop_to_mask_bbox(img, mask_polygon, w, h)
            else:
                display_img = img

            counts = _analyze_image_vlm(display_img)
            counts["date"] = p["date"]
            per_image.append(counts)

            crop_id = _store_image(_cv_to_png_bytes(display_img))
            crop_ids.append(crop_id)
        except Exception as e:
            per_image.append({
                "date": p["date"], "plaques": 0, "flowers": 0,
                "candles": 0, "pictures": 0, "other": 0, "total": 0,
                "error": str(e),
            })
            crop_ids.append(None)

    # Build pair comparisons
    pairs = []
    for i in range(len(panos) - 1):
        ca, cb = per_image[i], per_image[i + 1]

        delta = {k: cb.get(k, 0) - ca.get(k, 0) for k in _COUNT_CATEGORIES}

        changes = []
        for k in _COUNT_CATEGORIES:
            d = delta[k]
            if d > 0:
                changes.append(f"+{d} {k}")
            elif d < 0:
                changes.append(f"{d} {k}")

        summary = (
            f"{ca['date']}: {ca.get('total', 0)} items. "
            f"{cb['date']}: {cb.get('total', 0)} items."
        )
        if changes:
            summary += f" Changes: {', '.join(changes)}."
        else:
            summary += " No changes detected."

        pairs.append({
            "date_a": ca["date"],
            "date_b": cb["date"],
            "counts_a": {k: ca.get(k, 0) for k in _COUNT_CATEGORIES + ["total"]},
            "counts_b": {k: cb.get(k, 0) for k in _COUNT_CATEGORIES + ["total"]},
            "delta": delta,
            "crop_a_url": f"/image/{crop_ids[i]}" if crop_ids[i] else None,
            "crop_b_url": f"/image/{crop_ids[i + 1]}" if crop_ids[i + 1] else None,
            "summary": summary,
        })

    return jsonify({"per_image": per_image, "pairs": pairs})


@app.route("/wall-crop", methods=["POST"])
def wall_crop():
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
