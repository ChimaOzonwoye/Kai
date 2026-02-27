"""
Shrine Change Tracker - Local Python Server

Flask server that handles panorama searching, image fetching,
auto-alignment, polygon-mask-based comparison, and object-level
color-coded annotated output for the Shrine Change Tracker Chrome extension.

Object detection approach:
  1. Within the user's wall mask, compute the wall's background color (median in LAB)
  2. Find pixels that differ significantly from wall → foreground
  3. Contour detection to isolate individual objects (plaques, flowers, candles)
  4. Match objects between consecutive years by centroid proximity
  5. Color-code: Red = same position in both, Yellow = new, Green = gone
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


# ───────── Object Detection ─────────

def _detect_objects(img, mask, min_obj_diameter=15, dist_threshold=3.0):
    """
    Detect individual objects (plaques, flowers, candles) on the wall.

    Approach:
      1. Blur image slightly to reduce noise
      2. Convert to LAB color space (perceptual)
      3. Compute wall background as median color within mask
      4. Pixels far from wall color = foreground (objects)
      5. Morphological cleanup to merge fragments, remove noise
      6. Contour detection to isolate individual objects
      7. Filter by area (too small = noise, too large = wall chunk)

    Returns list of detected objects, each with:
      centroid (cx, cy), bbox (x, y, w, h), area, contour
    """
    h, w = img.shape[:2]
    mask_area = np.count_nonzero(mask)
    if mask_area < 100:
        return []

    min_area = int(3.14159 * (min_obj_diameter / 2) ** 2)
    max_area = int(mask_area * 0.20)

    blurred = cv2.GaussianBlur(img, (5, 5), 0)
    lab = cv2.cvtColor(blurred, cv2.COLOR_BGR2LAB).astype(np.float64)

    wall_pixels = lab[mask == 255]
    median_color = np.median(wall_pixels, axis=0)
    mad = np.median(np.abs(wall_pixels - median_color), axis=0)
    mad = np.maximum(mad, 3.0)

    diff = np.abs(lab - median_color) / mad
    dist = np.sqrt(np.sum(diff ** 2, axis=2))

    fg = (dist > dist_threshold).astype(np.uint8) * 255
    fg = cv2.bitwise_and(fg, mask)

    k_size = max(3, min_obj_diameter // 3)
    if k_size % 2 == 0:
        k_size += 1
    kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_size, k_size))
    k_open = max(3, k_size // 2)
    if k_open % 2 == 0:
        k_open += 1
    kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_open, k_open))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel_close)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel_open)

    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    objects = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue
        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])
        x, y, bw, bh = cv2.boundingRect(cnt)
        objects.append({
            "centroid": (cx, cy),
            "bbox": (x, y, bw, bh),
            "area": int(area),
            "contour": cnt,
        })

    return objects


def _match_objects(objs_a, objs_b, img_w, img_h, max_dist_pct=5.0):
    """
    Match objects between two images by centroid proximity.
    Uses greedy nearest-neighbor matching.

    Returns:
      matched_pairs: [(obj_a, obj_b), ...]
      gone:          [obj_a, ...]  (in A but no match in B)
      new:           [obj_b, ...]  (in B but no match in A)
    """
    max_dist = max_dist_pct / 100 * max(img_w, img_h)

    matched_a = set()
    matched_b = set()
    matched_pairs = []

    distances = []
    for i, oa in enumerate(objs_a):
        for j, ob in enumerate(objs_b):
            dx = oa["centroid"][0] - ob["centroid"][0]
            dy = oa["centroid"][1] - ob["centroid"][1]
            d = (dx ** 2 + dy ** 2) ** 0.5
            if d <= max_dist:
                distances.append((d, i, j))

    distances.sort()
    for d, i, j in distances:
        if i in matched_a or j in matched_b:
            continue
        matched_pairs.append((objs_a[i], objs_b[j]))
        matched_a.add(i)
        matched_b.add(j)

    gone = [objs_a[i] for i in range(len(objs_a)) if i not in matched_a]
    new = [objs_b[j] for j in range(len(objs_b)) if j not in matched_b]

    return matched_pairs, gone, new


def _annotate_with_objects(img, matched_pairs, gone_objs, new_objs, is_b=False):
    """
    Draw colored outlines and dots on detected objects.

    Image A: red = matched (same), green = gone (will disappear)
    Image B: red = matched (same), yellow = new (appeared)
    """
    annotated = img.copy()

    # Matched items — red
    for pair in matched_pairs:
        obj = pair[1] if is_b else pair[0]
        cv2.drawContours(annotated, [obj["contour"]], -1, (0, 0, 220), 3)
        cv2.circle(annotated, obj["centroid"], 6, (0, 0, 220), -1)
        cv2.circle(annotated, obj["centroid"], 6, (255, 255, 255), 1)

    if is_b:
        # New items in B — yellow
        for obj in new_objs:
            cv2.drawContours(annotated, [obj["contour"]], -1, (0, 255, 255), 3)
            cv2.circle(annotated, obj["centroid"], 6, (0, 255, 255), -1)
            cv2.circle(annotated, obj["centroid"], 6, (255, 255, 255), 1)
    else:
        # Gone items from A — green
        for obj in gone_objs:
            cv2.drawContours(annotated, [obj["contour"]], -1, (0, 200, 0), 3)
            cv2.circle(annotated, obj["centroid"], 6, (0, 200, 0), -1)
            cv2.circle(annotated, obj["centroid"], 6, (255, 255, 255), 1)

    return annotated


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
    Detect objects on every image, match consecutive pairs, return annotated results.

    For each image: detect individual objects (plaques, flowers, candles) on the wall.
    For each consecutive pair: match objects by position.
    Color code: Red = same, Yellow = new, Green = gone.

    Returns:
      per_image: [{date, items_detected}, ...] for the chart
      pairs: [{date_a, date_b, same_count, new_count, gone_count,
               items_a, items_b, annotated_a_url, annotated_b_url, summary}, ...]
    """
    data = request.get_json(force=True)
    panos = data["panoramas"]
    mask_polygon = data.get("mask_polygon")
    cell_size = int(data.get("cell_size", 15))
    threshold = float(data.get("threshold", 12))
    w, h = COMPARE_W, COMPARE_H

    mask = None
    if mask_polygon and len(mask_polygon) >= 3:
        mask = _polygon_pct_to_mask(mask_polygon, w, h)
    if mask is None:
        mask = np.ones((h, w), dtype=np.uint8) * 255

    dist_threshold = max(1.5, threshold / 4.0)
    min_obj_diameter = max(5, cell_size)

    # Fetch all images and detect objects
    images = []
    all_objects = []
    for p in panos:
        try:
            img_bytes = _fetch_thumbnail_bytes(p["pano_id"], p["heading"], p["pitch"], w, h)
            img = _bytes_to_cv(img_bytes)
            if img is not None:
                img = cv2.resize(img, (w, h))
                images.append(img)
                objs = _detect_objects(img, mask, min_obj_diameter, dist_threshold)
                all_objects.append(objs)
            else:
                images.append(None)
                all_objects.append([])
        except Exception:
            images.append(None)
            all_objects.append([])

    # Per-image item counts (for chart)
    per_image = []
    for i, p in enumerate(panos):
        per_image.append({
            "date": p["date"],
            "items_detected": len(all_objects[i]),
        })

    # Compare consecutive pairs
    results = []
    for i in range(len(panos) - 1):
        pa, pb = panos[i], panos[i + 1]

        if images[i] is None or images[i + 1] is None:
            results.append({"date_a": pa["date"], "date_b": pb["date"], "error": "image failed"})
            continue

        matched, gone, new = _match_objects(all_objects[i], all_objects[i + 1], w, h)

        same_count = len(matched)
        gone_count = len(gone)
        new_count = len(new)
        items_a = len(all_objects[i])
        items_b = len(all_objects[i + 1])

        # Generate annotated images
        ann_a = _annotate_with_objects(images[i], matched, gone, new, is_b=False)
        ann_b = _annotate_with_objects(images[i + 1], matched, gone, new, is_b=True)

        # Crop to wall bounding box for detail
        if mask_polygon and len(mask_polygon) >= 3:
            ann_a = _crop_to_mask_bbox(ann_a, mask_polygon, w, h)
            ann_b = _crop_to_mask_bbox(ann_b, mask_polygon, w, h)

        id_a = _store_image(_cv_to_png_bytes(ann_a))
        id_b = _store_image(_cv_to_png_bytes(ann_b))

        # Plain language summary
        parts = []
        parts.append(f"Found {items_a} items in {pa['date']} and {items_b} in {pb['date']}.")
        detail = []
        if same_count > 0:
            detail.append(f"{same_count} stayed the same")
        if new_count > 0:
            detail.append(f"{new_count} new")
        if gone_count > 0:
            detail.append(f"{gone_count} gone")
        if detail:
            parts.append(" ".join([", ".join(detail)] + ["."]))

        summary = " ".join(parts)

        results.append({
            "date_a": pa["date"],
            "date_b": pb["date"],
            "same_count": same_count,
            "new_count": new_count,
            "gone_count": gone_count,
            "items_a": items_a,
            "items_b": items_b,
            "annotated_a_url": f"/image/{id_a}",
            "annotated_b_url": f"/image/{id_b}",
            "summary": summary,
        })

    return jsonify({"per_image": per_image, "pairs": results})


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
