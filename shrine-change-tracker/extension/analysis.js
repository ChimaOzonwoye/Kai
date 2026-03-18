const SERVER = "http://localhost:5000";

const params = new URLSearchParams(window.location.search);
const LAT = parseFloat(params.get("lat"));
const LNG = parseFloat(params.get("lng"));
const HEADING = parseFloat(params.get("heading"));
const PITCH = parseFloat(params.get("pitch"));

const THUMB_W = 180;
const THUMB_H = 90;

// ── State ──
let panoramas = [];
let panoAngles = {};
let refPanoIdx = 0;
let perImageData = [];
let pairResults = [];

let _analysisController = null;
let _analysisCancelled = false;

// Crop region (optional shrine wall focus)
let cropRegion = null; // {x, y, w, h} as 0.0-1.0 percentages, or null
let _cropDrawing = false;
let _cropStart = null;

// Adjust modal
let adjustingPanoIdx = null;
let adjustTempHeading = 0;
let adjustTempPitch = 0;

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const adjustModal = document.getElementById("adjust-modal");

function thumbnailUrl(panoId, heading, pitch, w = THUMB_W, h = THUMB_H) {
  return `${SERVER}/thumbnail?pano_id=${panoId}&heading=${heading}&pitch=${pitch}&w=${w}&h=${h}`;
}

function getAngles(panoId) {
  return panoAngles[panoId] || { heading: HEADING, pitch: PITCH };
}

function showLoading(msg) {
  loadingText.textContent = msg;
  loading.classList.remove("hidden");
}

function hideLoading() {
  loading.classList.add("hidden");
}

// ── Wizard Navigation ──
function goToStep(step) {
  ["step-1", "step-2", "step-3"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  document.getElementById(`step-${step}`).classList.remove("hidden");
  document.querySelectorAll(".step-dot").forEach((dot) => {
    const s = parseInt(dot.dataset.step);
    dot.classList.remove("active", "completed");
    if (s === step) dot.classList.add("active");
    else if (s < step) dot.classList.add("completed");
  });
  window.scrollTo(0, 0);
}

// ── Step 1 ──
function initStep1() {
  document.getElementById("info-lat").textContent = LAT.toFixed(7);
  document.getElementById("info-lng").textContent = LNG.toFixed(7);
  document.getElementById("info-heading").textContent = `${HEADING.toFixed(1)}\u00B0`;
  document.getElementById("info-pitch").textContent = `${PITCH.toFixed(1)}\u00B0`;
}

async function searchPanoramas() {
  showLoading("Searching for historical images...");
  const resp = await fetch(`${SERVER}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: LAT, lon: LNG }),
  });
  const data = await resp.json();
  panoramas = data.panoramas || [];
  panoramas.forEach((p) => {
    panoAngles[p.pano_id] = { heading: HEADING, pitch: PITCH };
  });
  return panoramas;
}

// ── Step 2: Timeline ──
function buildTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";
  panoramas.forEach((pano, idx) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    if (idx === refPanoIdx) item.classList.add("selected-ref");

    const angles = getAngles(pano.pano_id);
    const img = document.createElement("img");
    img.src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
    img.alt = pano.date;
    img.loading = "lazy";

    const dateLabel = document.createElement("div");
    dateLabel.className = "timeline-date";
    dateLabel.textContent = pano.date;

    const adjBtn = document.createElement("button");
    adjBtn.className = "adjust-btn";
    adjBtn.textContent = "\u2699";
    adjBtn.title = "Adjust viewing angle";
    adjBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAdjustModal(idx);
    });

    item.addEventListener("click", () => selectReference(idx));
    item.appendChild(img);
    item.appendChild(dateLabel);
    item.appendChild(adjBtn);
    timeline.appendChild(item);
  });
  updateRefPicker();
}

function selectReference(idx) {
  refPanoIdx = idx;
  document.querySelectorAll(".timeline-item").forEach((el, i) =>
    el.classList.toggle("selected-ref", i === idx)
  );
  updateRefPicker();
}

function updateRefPicker() {
  document.getElementById("ref-picker").classList.remove("hidden");
  const pano = panoramas[refPanoIdx];
  const angles = getAngles(pano.pano_id);
  document.getElementById("ref-thumb").src = thumbnailUrl(
    pano.pano_id, angles.heading, angles.pitch
  );
  document.getElementById("ref-date").textContent = pano.date;
  initCropSection(pano.pano_id, angles.heading, angles.pitch);
}

// ── Crop Region ──
function initCropSection(panoId, heading, pitch) {
  const section = document.getElementById("crop-section");
  section.classList.remove("hidden");
  const img = document.getElementById("crop-img");
  img.src = thumbnailUrl(panoId, heading, pitch, 800, 400);
  cropRegion = null;
  updateCropStatus();

  img.onload = () => {
    const canvas = document.getElementById("crop-canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    drawCropOverlay();
  };
}

function getCropCanvasCoords(e) {
  const canvas = document.getElementById("crop-canvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

document.getElementById("crop-canvas").addEventListener("mousedown", (e) => {
  _cropDrawing = true;
  _cropStart = getCropCanvasCoords(e);
  cropRegion = null;
});

document.getElementById("crop-canvas").addEventListener("mousemove", (e) => {
  if (!_cropDrawing || !_cropStart) return;
  const pos = getCropCanvasCoords(e);
  cropRegion = {
    x: Math.min(_cropStart.x, pos.x),
    y: Math.min(_cropStart.y, pos.y),
    w: Math.abs(pos.x - _cropStart.x),
    h: Math.abs(pos.y - _cropStart.y),
  };
  drawCropOverlay();
});

document.getElementById("crop-canvas").addEventListener("mouseup", () => {
  _cropDrawing = false;
  _cropStart = null;
  if (cropRegion && cropRegion.w < 0.02 && cropRegion.h < 0.02) {
    cropRegion = null; // Too small, treat as a click (clear)
  }
  drawCropOverlay();
  updateCropStatus();
});

document.getElementById("crop-clear").addEventListener("click", () => {
  cropRegion = null;
  drawCropOverlay();
  updateCropStatus();
});

function drawCropOverlay() {
  const canvas = document.getElementById("crop-canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!cropRegion) return;

  // Dim everything outside the crop region
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, w, h);

  // Clear the crop region (show original image)
  const rx = cropRegion.x * w;
  const ry = cropRegion.y * h;
  const rw = cropRegion.w * w;
  const rh = cropRegion.h * h;
  ctx.clearRect(rx, ry, rw, rh);

  // Draw crop border
  ctx.strokeStyle = "#4a69bd";
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);
}

function updateCropStatus() {
  const status = document.getElementById("crop-status");
  if (cropRegion && cropRegion.w > 0.02 && cropRegion.h > 0.02) {
    status.textContent = "Focus region selected — model will analyze this area only";
    status.style.color = "#2ed573";
  } else {
    status.textContent = "No region selected — full image will be used";
    status.style.color = "#888";
  }
}

// ── Adjust Modal ──
function openAdjustModal(idx) {
  adjustingPanoIdx = idx;
  const pano = panoramas[idx];
  const angles = getAngles(pano.pano_id);
  adjustTempHeading = angles.heading - HEADING;
  adjustTempPitch = angles.pitch - PITCH;

  document.getElementById("adjust-pano-date").textContent = `Date: ${pano.date}`;
  document.getElementById("adjust-heading").value = adjustTempHeading;
  document.getElementById("adjust-pitch").value = adjustTempPitch;
  document.getElementById("adjust-heading-val").textContent = adjustTempHeading.toFixed(1);
  document.getElementById("adjust-pitch-val").textContent = adjustTempPitch.toFixed(1);
  updateAdjustPreview(angles.heading, angles.pitch);
  adjustModal.classList.remove("hidden");
}

function updateAdjustPreview(h, p) {
  document.getElementById("adjust-preview-img").src = thumbnailUrl(
    panoramas[adjustingPanoIdx].pano_id, h, p, 400, 200
  );
}

document.getElementById("adjust-heading").addEventListener("input", (e) => {
  adjustTempHeading = parseFloat(e.target.value);
  document.getElementById("adjust-heading-val").textContent = adjustTempHeading.toFixed(1);
  updateAdjustPreview(HEADING + adjustTempHeading, PITCH + adjustTempPitch);
});
document.getElementById("adjust-pitch").addEventListener("input", (e) => {
  adjustTempPitch = parseFloat(e.target.value);
  document.getElementById("adjust-pitch-val").textContent = adjustTempPitch.toFixed(1);
  updateAdjustPreview(HEADING + adjustTempHeading, PITCH + adjustTempPitch);
});
document.getElementById("adjust-reset").addEventListener("click", () => {
  adjustTempHeading = 0;
  adjustTempPitch = 0;
  document.getElementById("adjust-heading").value = 0;
  document.getElementById("adjust-pitch").value = 0;
  document.getElementById("adjust-heading-val").textContent = "0";
  document.getElementById("adjust-pitch-val").textContent = "0";
  updateAdjustPreview(HEADING, PITCH);
});
document.getElementById("adjust-cancel").addEventListener("click", () => {
  adjustModal.classList.add("hidden");
});
document.getElementById("adjust-apply").addEventListener("click", () => {
  const pano = panoramas[adjustingPanoIdx];
  panoAngles[pano.pano_id] = {
    heading: HEADING + adjustTempHeading,
    pitch: PITCH + adjustTempPitch,
  };
  const items = document.querySelectorAll(".timeline-item");
  if (items[adjustingPanoIdx]) {
    const angles = getAngles(pano.pano_id);
    items[adjustingPanoIdx].querySelector("img").src = thumbnailUrl(
      pano.pano_id, angles.heading, angles.pitch
    );
  }
  if (adjustingPanoIdx === refPanoIdx) updateRefPicker();
  adjustModal.classList.add("hidden");
});

// ── Auto-Align ──
async function autoAlignAll() {
  if (panoramas.length < 2) return;
  const ref = panoramas[refPanoIdx];
  for (let i = 0; i < panoramas.length; i++) {
    if (i === refPanoIdx) continue;
    updateProgress(
      `Aligning image ${i + 1} of ${panoramas.length}...`,
      i / panoramas.length * 0.2
    );
    try {
      const resp = await fetch(`${SERVER}/auto-align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref_pano_id: ref.pano_id,
          target_pano_id: panoramas[i].pano_id,
          heading: HEADING,
          pitch: PITCH,
        }),
      });
      const result = await resp.json();
      const cur = panoAngles[panoramas[i].pano_id];
      if (cur.heading === HEADING && cur.pitch === PITCH) {
        panoAngles[panoramas[i].pano_id] = {
          heading: result.heading,
          pitch: result.pitch,
        };
      }
    } catch (e) {
      console.warn(`Align failed for ${panoramas[i].pano_id}:`, e);
    }
  }
}

// ── Progress UI ──
function showProgress(text, pct) {
  document.getElementById("analysis-progress").classList.remove("hidden");
  document.getElementById("results-section").classList.add("hidden");
  updateProgress(text, pct);
}

function updateProgress(text, pct) {
  document.getElementById("progress-text").textContent = text;
  document.getElementById("progress-bar-fill").style.width = `${Math.round(pct * 100)}%`;
}

function hideProgress() {
  document.getElementById("analysis-progress").classList.add("hidden");
  document.getElementById("results-section").classList.remove("hidden");
}

// ── Step 3: Run Analysis ──
async function runAnalysis() {
  showProgress("Aligning images...", 0);

  _analysisCancelled = false;
  _analysisController = new AbortController();

  await autoAlignAll();

  if (_analysisCancelled) return;

  perImageData = [];

  for (let i = 0; i < panoramas.length; i++) {
    if (_analysisCancelled) break;

    const pct = 0.2 + (i / panoramas.length) * 0.8;
    updateProgress(`Analyzing image ${i + 1} of ${panoramas.length}...`, pct);

    const p = panoramas[i];
    const angles = getAngles(p.pano_id);

    try {
      const payload = {
        pano_id: p.pano_id,
        heading: angles.heading,
        pitch: angles.pitch,
      };
      // If user drew a focus region, send it so the server crops before analysis
      if (cropRegion && cropRegion.w > 0.02 && cropRegion.h > 0.02) {
        payload.crop = cropRegion;
      }
      const resp = await fetch(`${SERVER}/analyze-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: _analysisController.signal,
      });

      const data = await resp.json();
      data.date = p.date;

      if (data.error) {
        data.plaques = 0; data.flowers = 0; data.candles = 0;
        data.pictures = 0; data.other = 0; data.total = 0;
      }

      perImageData.push(data);

      // Update chart as each image completes
      renderChart();
    } catch (err) {
      if (_analysisCancelled) break;
      perImageData.push({
        date: p.date,
        plaques: 0, flowers: 0, candles: 0, pictures: 0, other: 0, total: 0,
        error: err.message,
      });
    }
  }

  _analysisController = null;

  if (_analysisCancelled) {
    document.getElementById("results-summary").textContent = "Analysis cancelled.";
    hideProgress();
    document.getElementById("results-section").classList.remove("hidden");
    return;
  }

  computePairResults();
  hideProgress();
  renderResults();
}

function cancelAnalysis() {
  _analysisCancelled = true;
  if (_analysisController) _analysisController.abort();
}

document.getElementById("cancel-btn").addEventListener("click", cancelAnalysis);

// ── Compute Pair Results ──
function computePairResults() {
  pairResults = [];
  const categories = ["plaques", "flowers", "candles", "pictures", "other"];

  for (let i = 0; i < perImageData.length - 1; i++) {
    const ca = perImageData[i];
    const cb = perImageData[i + 1];

    const delta = {};
    for (const k of categories) {
      delta[k] = (cb[k] || 0) - (ca[k] || 0);
    }

    const changes = [];
    for (const k of categories) {
      const d = delta[k];
      if (d > 0) changes.push(`+${d} ${k}`);
      else if (d < 0) changes.push(`${d} ${k}`);
    }

    // Use ~ prefix to signal these are estimates
    let summary =
      `${ca.date}: ~${ca.total || 0} items. ` +
      `${cb.date}: ~${cb.total || 0} items.`;
    if (changes.length) summary += ` Estimated changes: ${changes.join(", ")}.`;
    else summary += " No changes detected by model.";

    pairResults.push({
      date_a: ca.date,
      date_b: cb.date,
      counts_a: { plaques: ca.plaques || 0, flowers: ca.flowers || 0, candles: ca.candles || 0, pictures: ca.pictures || 0, other: ca.other || 0, total: ca.total || 0 },
      counts_b: { plaques: cb.plaques || 0, flowers: cb.flowers || 0, candles: cb.candles || 0, pictures: cb.pictures || 0, other: cb.other || 0, total: cb.total || 0 },
      range_a: ca.range || null,
      range_b: cb.range || null,
      confidence_a: ca.confidence || "none",
      confidence_b: cb.confidence || "none",
      visibility_a: ca.visibility || "clear",
      visibility_b: cb.visibility || "clear",
      delta,
      image_a_url: ca.image_url || null,
      image_b_url: cb.image_url || null,
      crop_image_a_url: ca.crop_image_url || null,
      crop_image_b_url: cb.crop_image_url || null,
      runs_a: ca.runs || null,
      runs_b: cb.runs || null,
      summary,
    });
  }
}

// ── Render Results ──
function renderResults() {
  renderSummary();
  renderChart();
  renderPairCards();
}

function renderSummary() {
  if (perImageData.length === 0) return;

  const first = perImageData[0];
  const last = perImageData[perImageData.length - 1];

  const highConf = perImageData.filter((d) => d.confidence === "high").length;
  const modConf = perImageData.filter((d) => d.confidence === "moderate").length;
  const lowConf = perImageData.filter((d) => d.confidence === "low" || d.confidence === "none").length;

  let text = `Analyzed ${perImageData.length} time periods from ${first.date} to ${last.date}. `;
  text += `Each image was analyzed ${perImageData[0].runs ? perImageData[0].runs.length : "multiple"} times for consistency. `;
  text += `Agreement: ${highConf} high, ${modConf} moderate, ${lowConf} low/none.`;

  document.getElementById("results-summary").textContent = text;
}

function _confColor(confidence) {
  if (confidence === "high") return "#2ed573";
  if (confidence === "moderate") return "#ffa502";
  return "#ff4757";
}

function renderChart() {
  const canvas = document.getElementById("chart-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (perImageData.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 280 * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width, H = 280;
  const padL = 60, padR = 20, padT = 20, padB = 60;
  const cW = W - padL - padR, cH = H - padT - padB;

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Max must account for range maximums too
  let maxItems = 5;
  for (const d of perImageData) {
    const rangeMax = d.range && d.range.total ? d.range.total[1] : (d.total || 0);
    if (rangeMax > maxItems) maxItems = rangeMax;
    if ((d.total || 0) > maxItems) maxItems = d.total;
  }

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + cH);
  ctx.stroke();

  ctx.fillStyle = "#666";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  const yStep = Math.ceil(maxItems / 5);
  for (let n = 0; n <= maxItems; n += yStep) {
    const y = padT + cH - (n / maxItems) * cH;
    ctx.fillText(`${n}`, padL - 8, y + 4);
    ctx.strokeStyle = "#222";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cW, y);
    ctx.stroke();
  }

  const barW = Math.min(50, (cW / perImageData.length) * 0.7);
  const gap = (cW - barW * perImageData.length) / (perImageData.length + 1);
  canvas._bars = [];

  perImageData.forEach((d, i) => {
    const total = d.total || 0;
    const barH = maxItems > 0 ? (total / maxItems) * cH : 0;
    const x = padL + gap + i * (barW + gap);
    const y = padT + cH - barH;

    // Color by confidence
    const conf = d.confidence || "none";
    ctx.fillStyle = d.error ? "#555" : _confColor(conf);
    ctx.globalAlpha = 0.8;
    ctx.fillRect(x, y, barW, barH);
    ctx.globalAlpha = 1.0;
    canvas._bars.push({ x, w: barW, idx: i });

    // Draw whiskers for range
    if (d.range && d.range.total) {
      const [lo, hi] = d.range.total;
      const loY = padT + cH - (lo / maxItems) * cH;
      const hiY = padT + cH - (hi / maxItems) * cH;
      const cx = x + barW / 2;

      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, hiY);
      ctx.lineTo(cx, loY);
      ctx.stroke();

      // Whisker caps
      const capW = barW * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx - capW / 2, hiY);
      ctx.lineTo(cx + capW / 2, hiY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - capW / 2, loY);
      ctx.lineTo(cx + capW / 2, loY);
      ctx.stroke();
    }

    // Label: show ~ to signal estimate
    ctx.fillStyle = "#ccc";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const labelY = d.range && d.range.total ? padT + cH - (d.range.total[1] / maxItems) * cH - 6 : y - 6;
    ctx.fillText(`~${total}`, x + barW / 2, labelY);

    ctx.save();
    ctx.translate(x + barW / 2, padT + cH + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(d.date, 0, 0);
    ctx.restore();
  });

  ctx.save();
  ctx.translate(14, padT + cH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#666";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Estimated Items (median)", 0, 0);
  ctx.restore();
}

document.getElementById("chart-canvas").addEventListener("click", (e) => {
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  for (const bar of canvas._bars || []) {
    if (x >= bar.x - 5 && x <= bar.x + bar.w + 5) {
      const pairIdx = Math.min(bar.idx, pairResults.length - 1);
      const card = document.getElementById(`pair-card-${pairIdx}`);
      if (card) {
        document.querySelectorAll(".pair-card").forEach((c) =>
          c.classList.remove("highlighted")
        );
        card.classList.add("highlighted");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
  }
});

function _confidenceBadge(conf) {
  const cls = `confidence-badge confidence-${conf || "none"}`;
  const label = (conf || "none").charAt(0).toUpperCase() + (conf || "none").slice(1);
  return `<span class="${cls}">${label} agreement</span>`;
}

function _visibilityBadge(vis) {
  const cls = `visibility-badge visibility-${vis || "clear"}`;
  return `<span class="${cls}">${vis || "unknown"} visibility</span>`;
}

function _runVarianceHTML(runs, category) {
  if (!runs || runs.length < 2) return "";
  const vals = runs.filter((r) => !r.error).map((r) => r[category] || 0);
  if (vals.length < 2) return "";
  return `<span class="run-values">[${vals.join(", ")}]</span>`;
}

function renderPairCards() {
  const container = document.getElementById("pairs-container");
  container.innerHTML = "";

  pairResults.forEach((pair, idx) => {
    const card = document.createElement("div");
    card.className = "pair-card";
    card.id = `pair-card-${idx}`;

    const ca = pair.counts_a || {};
    const cb = pair.counts_b || {};
    const delta = pair.delta || {};

    let deltaBadges = "";
    for (const k of ["plaques", "flowers", "candles", "pictures", "other"]) {
      const d = delta[k] || 0;
      if (d > 0) deltaBadges += `<span class="count-badge delta-up">+${d} ${k}</span>`;
      else if (d < 0) deltaBadges += `<span class="count-badge delta-down">${d} ${k}</span>`;
    }
    if (!deltaBadges) deltaBadges = `<span class="count-badge delta-same">No changes detected</span>`;

    function countsHTML(counts, range, runs) {
      return ["plaques", "flowers", "candles", "pictures", "other"]
        .filter((k) => (counts[k] || 0) > 0)
        .map((k) => {
          let rangeStr = "";
          if (range && range[k] && range[k][0] !== range[k][1]) {
            rangeStr = `<span class="cat-range">(${range[k][0]}\u2013${range[k][1]})</span>`;
          }
          const variance = _runVarianceHTML(runs, k);
          return `<span class="cat-count">~${counts[k]} ${k}${rangeStr}</span>`;
        })
        .join("") || `<span class="cat-count">0 items</span>`;
    }

    // Cropped images (what the model actually saw)
    let cropImagesHTML = "";
    if (pair.crop_image_a_url || pair.crop_image_b_url) {
      const cropA = pair.crop_image_a_url
        ? `<div class="crop-img-col"><div class="crop-date">${pair.date_a}</div><div class="img-wrapper"><img src="${SERVER}${pair.crop_image_a_url}" alt="Cropped ${pair.date_a}"></div></div>`
        : "";
      const cropB = pair.crop_image_b_url
        ? `<div class="crop-img-col"><div class="crop-date">${pair.date_b}</div><div class="img-wrapper"><img src="${SERVER}${pair.crop_image_b_url}" alt="Cropped ${pair.date_b}"></div></div>`
        : "";
      cropImagesHTML = `
        <div class="crop-image-section">
          <h4>Analyzed region (what the model saw)</h4>
          <div class="crop-image-compare">${cropA}${cropB}</div>
        </div>`;
    }

    // Full street view images — collapsed by default
    const imgA = pair.image_a_url
      ? `<img src="${SERVER}${pair.image_a_url}" alt="${pair.date_a}">`
      : "";
    const imgB = pair.image_b_url
      ? `<img src="${SERVER}${pair.image_b_url}" alt="${pair.date_b}">`
      : "";

    // Show run-level details
    let runsDetailHTML = "";
    if (pair.runs_a || pair.runs_b) {
      const fmtRuns = (runs) => {
        if (!runs || runs.length < 2) return "";
        const vals = runs.filter((r) => !r.error).map((r) => r.total);
        return `Runs: [${vals.join(", ")}]`;
      };
      const ra = fmtRuns(pair.runs_a);
      const rb = fmtRuns(pair.runs_b);
      if (ra || rb) {
        runsDetailHTML = `<div class="run-variance">${pair.date_a}: ${ra || "n/a"} &nbsp;|&nbsp; ${pair.date_b}: ${rb || "n/a"}</div>`;
      }
    }

    card.innerHTML = `
      <div class="pair-header">
        <h3>${pair.date_a} \u2192 ${pair.date_b}</h3>
        <div class="pair-deltas">${deltaBadges}</div>
      </div>
      <p class="pair-summary">${pair.summary}</p>
      <div class="pair-counts-row">
        <div class="counts-col">
          <div class="counts-col-header">
            <span class="counts-label">${pair.date_a} (~${ca.total || 0} items)</span>
            ${_confidenceBadge(pair.confidence_a)}
            ${_visibilityBadge(pair.visibility_a)}
          </div>
          <div class="counts-cats">${countsHTML(ca, pair.range_a, pair.runs_a)}</div>
        </div>
        <div class="counts-col">
          <div class="counts-col-header">
            <span class="counts-label">${pair.date_b} (~${cb.total || 0} items)</span>
            ${_confidenceBadge(pair.confidence_b)}
            ${_visibilityBadge(pair.visibility_b)}
          </div>
          <div class="counts-cats">${countsHTML(cb, pair.range_b, pair.runs_b)}</div>
        </div>
      </div>
      ${runsDetailHTML}
      <div class="pair-images-section">
        ${cropImagesHTML}
        <details class="full-images-section">
          <summary>Show full Street View images (context)</summary>
          <div class="pair-images-stacked">
            <div class="pair-img-full">
              <h4>${pair.date_a}</h4>
              <div class="img-wrapper">${imgA}</div>
            </div>
            <div class="pair-img-full">
              <h4>${pair.date_b}</h4>
              <div class="img-wrapper">${imgB}</div>
            </div>
          </div>
        </details>
      </div>
      <div class="verify-row">
        <input type="checkbox" id="verify-${idx}" data-pair-idx="${idx}">
        <label for="verify-${idx}">I have manually verified these counts are reasonable</label>
      </div>
    `;

    container.appendChild(card);
  });
}

// ── Data Export ──
function exportCSV() {
  if (perImageData.length === 0) return;
  const cats = ["plaques", "flowers", "candles", "pictures", "other", "total"];
  const header = [
    "date", "pano_id",
    ...cats.map((c) => `${c}_median`),
    ...cats.map((c) => `${c}_min`),
    ...cats.map((c) => `${c}_max`),
    "confidence", "agreement", "visibility", "num_runs",
    ...cats.map((c) => `${c}_run_values`),
    "human_verified",
  ];
  const rows = [header.join(",")];

  perImageData.forEach((d, i) => {
    const pano = panoramas[i];
    const verified = document.querySelector(`input[data-pair-idx]`)
      ? "false"
      : "false";
    const run_count = d.runs ? d.runs.length : 1;
    const row = [
      d.date,
      pano ? pano.pano_id : "",
      ...cats.map((c) => d.median ? d.median[c] : (d[c] || 0)),
      ...cats.map((c) => d.range && d.range[c] ? d.range[c][0] : (d[c] || 0)),
      ...cats.map((c) => d.range && d.range[c] ? d.range[c][1] : (d[c] || 0)),
      d.confidence || "unknown",
      d.agreement || "",
      d.visibility || "",
      run_count,
      ...cats.map((c) =>
        d.runs
          ? `"${d.runs.filter((r) => !r.error).map((r) => r[c]).join(";")}"` : ""
      ),
      verified,
    ];
    rows.push(row.join(","));
  });

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shrine_analysis_${LAT.toFixed(4)}_${LNG.toFixed(4)}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJSON() {
  if (perImageData.length === 0) return;
  const exportData = {
    location: { lat: LAT, lng: LNG, heading: HEADING, pitch: PITCH },
    model: "gemma3:4b",
    num_runs_per_image: perImageData[0].runs ? perImageData[0].runs.length : 1,
    crop_region: cropRegion,
    analysis_date: new Date().toISOString(),
    disclaimer: "These counts are model estimates. Each image was analyzed multiple times. "
      + "Results must be manually verified before use in research.",
    images: perImageData.map((d, i) => ({
      date: d.date,
      pano_id: panoramas[i] ? panoramas[i].pano_id : null,
      median_counts: d.median || { plaques: d.plaques, flowers: d.flowers, candles: d.candles, pictures: d.pictures, other: d.other, total: d.total },
      ranges: d.range || null,
      confidence: d.confidence || "unknown",
      agreement: d.agreement || null,
      visibility: d.visibility || null,
      individual_runs: d.runs || null,
    })),
    pair_comparisons: pairResults.map((p) => ({
      from: p.date_a,
      to: p.date_b,
      delta: p.delta,
      confidence_from: p.confidence_a,
      confidence_to: p.confidence_b,
    })),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shrine_analysis_${LAT.toFixed(4)}_${LNG.toFixed(4)}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("btn-export-csv").addEventListener("click", exportCSV);
document.getElementById("btn-export-json").addEventListener("click", exportJSON);

// ── Navigation ──
document.getElementById("btn-to-step2").addEventListener("click", () => goToStep(2));
document.getElementById("btn-back-to-1").addEventListener("click", () => goToStep(1));
document.getElementById("btn-to-step3").addEventListener("click", async () => {
  goToStep(3);
  await runAnalysis();
  renderResults();
});
document.getElementById("btn-back-to-2").addEventListener("click", () => {
  _analysisCancelled = true;
  if (_analysisController) _analysisController.abort();
  goToStep(2);
});

// ── Init ──
async function init() {
  initStep1();
  goToStep(1);
  try {
    const healthResp = await fetch(`${SERVER}/health`);
    const healthData = await healthResp.json();

    if (healthData.ollama !== "connected") {
      document.getElementById("server-dot").className = "dot dot-warn";
      document.getElementById("server-text").textContent = "Analysis engine not running";
      document.getElementById("engine-warning").classList.remove("hidden");
    } else if (!healthData.model) {
      document.getElementById("server-dot").className = "dot dot-warn";
      document.getElementById("server-text").textContent = "Analysis model not installed";
      document.getElementById("engine-warning").classList.remove("hidden");
      document.getElementById("engine-warning").textContent =
        "The analysis model is not installed. See the README for setup instructions.";
    } else {
      document.getElementById("server-dot").className = "dot dot-ok";
      document.getElementById("server-text").textContent = "Server ready";
    }

    await searchPanoramas();
    if (panoramas.length === 0) {
      hideLoading();
      document.getElementById("pano-found-msg").textContent =
        "No historical images found. Try a different Street View location.";
      document.getElementById("pano-found-msg").style.color = "#ff4757";
      return;
    }
    hideLoading();
    document.getElementById("pano-found-msg").textContent =
      `Found ${panoramas.length} images: ${panoramas[0].date} to ${panoramas[panoramas.length - 1].date}.`;
    document.getElementById("btn-to-step2").disabled = false;
    buildTimeline();
  } catch (err) {
    hideLoading();
    document.getElementById("server-dot").className = "dot dot-err";
    document.getElementById("server-text").textContent = "Server offline";
    document.getElementById("pano-found-msg").textContent = `Cannot connect to server. Make sure it is running.`;
    document.getElementById("pano-found-msg").style.color = "#ff4757";
  }
}

init();
