"""
Shrine Change Tracker - Local Python Server

Flask server that handles panorama searching, image fetching,
auto-alignment, polygon-mask-based comparison, and object-level
color-coded annotated output for the Shrine Change Tracker Chrome extension.

Plaque detection approach (MSER + edge contours):
  1. MSER (Maximally Stable Extremal Regions) finds stable blob regions
     on the wall — plaques are the textbook use case for MSER
  2. Canny edge detection + contour analysis finds objects with clear
     rectangular boundaries
  3. Shape filtering: aspect ratio, solidity, rectangularity
  4. Non-maximum suppression merges overlapping detections
  5. Match detections between consecutive years by centroid proximity
  6. Color-code: Red = same position in both, Yellow = new, Green = gone
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


# ───────── Plaque Detection (MSER + Edge Contours) ─────────

def _bbox_iou(b1, b2):
    """Intersection-over-union for two (x, y, w, h) bounding boxes."""
    x1, y1, w1, h1 = b1
    x2, y2, w2, h2 = b2
    xi1 = max(x1, x2)
    yi1 = max(y1, y2)
    xi2 = min(x1 + w1, x2 + w2)
    yi2 = min(y1 + h1, y2 + h2)
    if xi2 <= xi1 or yi2 <= yi1:
        return 0.0
    inter = (xi2 - xi1) * (yi2 - yi1)
    union = w1 * h1 + w2 * h2 - inter
    return inter / union if union > 0 else 0.0


def _nms_candidates(candidates, iou_threshold=0.35):
    """Non-maximum suppression: keep the best-scoring detection per region."""
    if not candidates:
        return []
    candidates.sort(key=lambda c: c.get("score", 0), reverse=True)
    kept = []
    suppressed = set()
    for i, cand in enumerate(candidates):
        if i in suppressed:
            continue
        kept.append(cand)
        for j in range(i + 1, len(candidates)):
            if j in suppressed:
                continue
            if _bbox_iou(cand["bbox"], candidates[j]["bbox"]) > iou_threshold:
                suppressed.add(j)
    return kept


def _detect_objects(img, mask, min_obj_diameter=15, sensitivity=12):
    """
    Detect individual plaques / objects on the wall using two complementary
    methods, merged with non-maximum suppression.

    Method 1 — MSER (Maximally Stable Extremal Regions):
      MSER finds blob-like regions that remain stable across many intensity
      thresholds.  A marble plaque on a stone wall is the textbook example
      of a maximally stable region — it has consistent interior intensity
      and a sharp boundary against the wall.

    Method 2 — Canny edges + closed contours:
      Edge detection finds objects with clear rectangular boundaries.
      After morphological closing (to seal small gaps) we keep only
      closed contours whose shape looks plaque-like.

    Both methods are filtered by:
      • area (reasonable plaque size, not noise or half the wall)
      • aspect ratio (< 5 — not a thin line)
      • solidity (contour area / convex hull area > 0.5 — compact shape)
      • rectangularity (contour area / bounding rect area > 0.35)
      • must be inside the user's wall mask

    Returns list of detected objects:
      [{centroid, bbox, area, contour, score}, ...]
    """
    h, w = img.shape[:2]
    mask_area = np.count_nonzero(mask)
    if mask_area < 100:
        return []

    # Size bounds — proportional to wall area
    min_area = max(80, int(mask_area * 0.0008))       # ~0.08 % of wall
    min_area = max(min_area, min_obj_diameter ** 2)    # slider override
    max_area = int(mask_area * 0.08)                   # 8 % of wall

    # Preprocessing: bilateral filter preserves edges, smooths wall texture
    filtered = cv2.bilateralFilter(img, 9, 75, 75)
    gray = cv2.cvtColor(filtered, cv2.COLOR_BGR2GRAY)

    # Fill outside mask with wall median so detectors don't trigger on
    # the mask boundary itself
    wall_gray_vals = gray[mask == 255]
    if len(wall_gray_vals) < 50:
        return []
    median_val = int(np.median(wall_gray_vals))
    gray_for_detect = gray.copy()
    gray_for_detect[mask == 0] = median_val

    candidates = []

    # ── Method 1: MSER ──────────────────────────────────────────────
    mser_delta = max(2, int(sensitivity / 3))         # 1→2  12→4  50→16
    max_var = 0.15 + sensitivity / 200.0              # 0.155 … 0.40

    mser = cv2.MSER_create(
        _delta=mser_delta,
        _min_area=min_area,
        _max_area=max_area,
        _max_variation=max_var,
    )
    regions, bboxes = mser.detectRegions(gray_for_detect)

    for region, bbox in zip(regions, bboxes):
        x, y, rw, rh = bbox
        if rw < 5 or rh < 5:
            continue
        area = len(region)
        if area < min_area or area > max_area:
            continue
        cx, cy = x + rw // 2, y + rh // 2
        if cy >= h or cx >= w or mask[cy, cx] == 0:
            continue

        hull = cv2.convexHull(region.reshape(-1, 1, 2))
        hull_area = cv2.contourArea(hull)
        if hull_area == 0:
            continue

        solidity = area / hull_area
        aspect = max(rw, rh) / (min(rw, rh) + 1)
        rect_area = rw * rh
        rectangularity = area / rect_area if rect_area > 0 else 0

        if solidity < 0.5 or aspect > 5.0 or rectangularity < 0.35:
            continue

        score = solidity * rectangularity
        candidates.append({
            "bbox": (x, y, rw, rh),
            "centroid": (cx, cy),
            "area": int(area),
            "contour": hull,
            "score": score,
        })

    # ── Method 2: Canny edges → closed contours ────────────────────
    # Auto-threshold using Otsu on the wall pixels
    median_v = float(np.median(wall_gray_vals))
    canny_lo = int(max(10, median_v * 0.33))
    canny_hi = int(min(250, median_v * 1.0))

    edges = cv2.Canny(gray_for_detect, canny_lo, canny_hi)
    edges = cv2.bitwise_and(edges, mask)

    # Close small edge gaps so contours form closed shapes
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges_closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k3, iterations=2)

    contours_edge, _ = cv2.findContours(
        edges_closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    for cnt in contours_edge:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue
        x, y, rw, rh = cv2.boundingRect(cnt)
        cx, cy = x + rw // 2, y + rh // 2
        if cy >= h or cx >= w or mask[cy, cx] == 0:
            continue

        peri = cv2.arcLength(cnt, True)
        if peri == 0:
            continue
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
        if len(approx) < 4 or len(approx) > 12:
            continue

        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        if hull_area == 0:
            continue

        solidity = area / hull_area
        aspect = max(rw, rh) / (min(rw, rh) + 1)
        rect_area = rw * rh
        rectangularity = area / rect_area if rect_area > 0 else 0

        if solidity < 0.45 or aspect > 5.0 or rectangularity < 0.3:
            continue

        score = solidity * rectangularity * 0.9  # slight preference for MSER
        candidates.append({
            "bbox": (x, y, rw, rh),
            "centroid": (cx, cy),
            "area": int(area),
            "contour": hull,
            "score": score,
        })

    # ── Merge overlapping detections ──
    objects = _nms_candidates(candidates, iou_threshold=0.35)
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

    min_obj_diameter = max(5, cell_size)
    sensitivity = max(1, int(threshold))

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
                objs = _detect_objects(img, mask, min_obj_diameter, sensitivity)
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
