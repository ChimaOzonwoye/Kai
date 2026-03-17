"""
Shrine Change Tracker - Local Python Server

Flask server that handles panorama searching, image fetching,
auto-alignment, and image analysis via a local vision model (Gemma 3)
running in Ollama.
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


def _crop_to_region(img, crop_pct):
    """Crop image to a rectangular region defined by percentage coordinates.

    crop_pct: {"x": float, "y": float, "w": float, "h": float}
    where all values are 0.0 to 1.0 representing percentages of image dimensions.
    """
    h, w = img.shape[:2]
    x1 = max(0, int(crop_pct["x"] * w))
    y1 = max(0, int(crop_pct["y"] * h))
    x2 = min(w, int((crop_pct["x"] + crop_pct["w"]) * w))
    y2 = min(h, int((crop_pct["y"] + crop_pct["h"]) * h))
    if x2 <= x1 or y2 <= y1:
        return img
    return img[y1:y2, x1:x2]


def _compute_ssim(img_a, img_b):
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)
    if gray_a.shape != gray_b.shape:
        gray_b = cv2.resize(gray_b, (gray_a.shape[1], gray_a.shape[0]))
    score, _ = ssim(gray_a, gray_b, full=True)
    return float(score)


def _store_image(img_bytes):
    img_id = str(uuid.uuid4())[:12]
    _image_store[img_id] = img_bytes
    return img_id


def _demo_key(lat, lon):
    return f"{lat:.3f}_{lon:.3f}"


# ───────── Vision Model ─────────

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "gemma3:4b"
OLLAMA_TEMPERATURE = 0.1  # Low temperature for consistent, deterministic counting

_VLM_PROMPT = (
    "This is a Google Street View image of a devotional shrine — a wall-mounted "
    "religious site, often called a madonnella in Rome, where worshippers leave "
    "votive offerings. The shrine typically has a central religious image (such as "
    "the Virgin Mary or a saint) surrounded by items left by visitors.\n\n"
    "YOUR TASK: Count every distinct devotional object on the shrine wall. "
    "Scan the wall systematically from left to right, top to bottom. "
    "Count each individual item separately, even if items overlap or cluster.\n\n"
    "Categories:\n"
    "- plaques: marble tablets, stone slabs, ceramic tiles, engraved memorial "
    "inscriptions, ex-voto tablets, any flat rectangular items mounted flush "
    "against the wall. These are often white or light-colored and arranged in "
    "rows or clusters around the central shrine image.\n"
    "- flowers: flower bouquets, floral arrangements, potted plants, wreaths "
    "placed at the base of or attached to the shrine.\n"
    "- candles: candles, votive lights, oil lamps, electric candle substitutes "
    "placed as offerings at or near the shrine.\n"
    "- pictures: framed photographs, printed religious images, painted icons, "
    "holy cards, laminated images attached to the wall.\n"
    "- other: rosaries, ribbons, letters, stuffed animals, or any other "
    "devotional object on the shrine wall that does not fit the above.\n\n"
    "DO NOT COUNT any of the following:\n"
    "- Cars, motorcycles, bicycles, or any vehicles\n"
    "- Pedestrians or people\n"
    "- Street signs, traffic lights, or road markings\n"
    "- Shop signs, advertisements, or business signage\n"
    "- Windows, doors, or architectural features of buildings\n"
    "- Graffiti or paint on the wall (only count mounted/attached objects)\n"
    "- Objects on the ground, sidewalk, or street not part of the shrine\n"
    "- Trees, utility poles, wires, or street furniture\n\n"
    "If the shrine wall is not clearly visible or the image is too unclear to "
    "count reliably, return all zeros.\n\n"
    "Return ONLY a JSON object with integer counts:\n"
    '{"plaques": 0, "flowers": 0, "candles": 0, "pictures": 0, "other": 0, "total": 0}'
)

_COUNT_CATEGORIES = ["plaques", "flowers", "candles", "pictures", "other"]


def _analyze_image_vlm(img):
    """Send image to local vision model for object counting."""
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64_img = base64.b64encode(buf).decode("utf-8")

    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "user", "content": _VLM_PROMPT, "images": [b64_img]}
                ],
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": OLLAMA_TEMPERATURE,
                },
            },
            timeout=300,
        )
        resp.raise_for_status()
    except requests.exceptions.ConnectionError:
        raise ValueError(
            "Cannot connect to the image analysis engine. "
            "Make sure Ollama is running."
        )
    except requests.exceptions.Timeout:
        raise ValueError("Image analysis timed out. The model may still be loading.")

    data = resp.json()
    text = data["message"]["content"]

    try:
        counts = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("Model returned an unexpected response.")

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
        results = [
            {"pano_id": p.pano_id, "date": p.date, "lat": p.lat, "lon": p.lon}
            for p in dated
        ]
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

    align_cache = _load_align_cache()
    cache_key = f"{ref_pano_id}_{target_pano_id}_{base_heading}_{base_pitch}"
    if cache_key in align_cache:
        return jsonify(align_cache[cache_key])

    try:
        ref_bytes = _fetch_thumbnail_bytes(
            ref_pano_id, base_heading, base_pitch, COMPARE_W, COMPARE_H
        )
        ref_img = _bytes_to_cv(ref_bytes)
        if ref_img is None:
            return jsonify({"error": "Failed to decode reference image"}), 500
        ref_img = cv2.resize(ref_img, (COMPARE_W, COMPARE_H))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    best_score, best_heading, best_pitch = -1, base_heading, base_pitch
    for dh in [-5, 0, 5]:
        for dp in [-3, 0, 3]:
            try:
                t_bytes = _fetch_thumbnail_bytes(
                    target_pano_id, base_heading + dh, base_pitch + dp,
                    COMPARE_W, COMPARE_H
                )
                t_img = _bytes_to_cv(t_bytes)
                if t_img is None:
                    continue
                t_img = cv2.resize(t_img, (COMPARE_W, COMPARE_H))
                score = _compute_ssim(ref_img, t_img)
                if score > best_score:
                    best_score = score
                    best_heading = base_heading + dh
                    best_pitch = base_pitch + dp
            except Exception:
                continue

    result = {
        "heading": best_heading,
        "pitch": best_pitch,
        "ssim_score": round(best_score, 4),
    }
    align_cache[cache_key] = result
    _save_align_cache(align_cache)
    return jsonify(result)


@app.route("/analyze-image", methods=["POST"])
def analyze_image():
    """Analyze a single panorama image and return categorized counts.

    Accepts optional 'crop' parameter: {"x": 0.0-1.0, "y": 0.0-1.0, "w": 0.0-1.0, "h": 0.0-1.0}
    to focus analysis on a specific region (e.g. the shrine wall area).
    """
    data = request.get_json(force=True)
    pano_id = data["pano_id"]
    heading = float(data["heading"])
    pitch = float(data["pitch"])
    crop_pct = data.get("crop")  # Optional: {"x", "y", "w", "h"} as percentages

    try:
        img_bytes = _fetch_thumbnail_bytes(
            pano_id, heading, pitch, COMPARE_W, COMPARE_H
        )
        img = _bytes_to_cv(img_bytes)
        if img is None:
            return jsonify({"error": "Failed to decode image"}), 500
        img = cv2.resize(img, (COMPARE_W, COMPARE_H))

        # Store the full image for display
        img_id = _store_image(_cv_to_png_bytes(img))

        # If a crop region is provided, crop before sending to the model
        analysis_img = img
        if crop_pct and all(k in crop_pct for k in ("x", "y", "w", "h")):
            analysis_img = _crop_to_region(img, crop_pct)

        counts = _analyze_image_vlm(analysis_img)
        counts["image_url"] = f"/image/{img_id}"

        return jsonify(counts)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("=" * 50)
    print("  Shrine Change Tracker Server")
    print("  Running on http://localhost:5000")
    print("=" * 50)
    app.run(host="127.0.0.1", port=5000, debug=True)
