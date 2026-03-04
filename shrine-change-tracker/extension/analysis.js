const SERVER = "http://localhost:5000";

const params = new URLSearchParams(window.location.search);
const LAT = parseFloat(params.get("lat"));
const LNG = parseFloat(params.get("lng"));
const HEADING = parseFloat(params.get("heading"));
const PITCH = parseFloat(params.get("pitch"));

const COMPARE_W = 1600;
const COMPARE_H = 800;
const THUMB_W = 180;
const THUMB_H = 90;

// State
let panoramas = [];
let panoAngles = {};
let refPanoIdx = 0;
let maskPolygon = [];
let maskClosed = false;
let maskImage = null;
let maskCanvasW = COMPARE_W;
let maskCanvasH = COMPARE_H;
let pairResults = [];
let perImageData = [];
let currentStep = 1;

// Adjust modal
let adjustingPanoIdx = null;
let adjustTempHeading = 0;
let adjustTempPitch = 0;
let _analysisController = null;
let _analysisCancelled = false;

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const adjustModal = document.getElementById("adjust-modal");
const maskCanvas = document.getElementById("mask-canvas");
const maskCtx = maskCanvas.getContext("2d");

function thumbnailUrl(panoId, heading, pitch, w = THUMB_W, h = THUMB_H) {
  return `${SERVER}/thumbnail?pano_id=${panoId}&heading=${heading}&pitch=${pitch}&w=${w}&h=${h}`;
}

function getAngles(panoId) {
  return panoAngles[panoId] || { heading: HEADING, pitch: PITCH };
}

function showLoading(msg, cancelable = false) {
  loadingText.textContent = msg;
  const cancelBtn = document.getElementById("cancel-analysis-btn");
  if (cancelBtn) cancelBtn.classList.toggle("hidden", !cancelable);
  loading.classList.remove("hidden");
}

function hideLoading() {
  loading.classList.add("hidden");
  const cancelBtn = document.getElementById("cancel-analysis-btn");
  if (cancelBtn) cancelBtn.classList.add("hidden");
}

// ── Wizard Navigation ──
function goToStep(step) {
  currentStep = step;
  ["step-1", "step-2", "step-3", "step-4"].forEach((id) =>
    document.getElementById(id).classList.add("hidden")
  );
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
    adjBtn.addEventListener("click", (e) => { e.stopPropagation(); openAdjustModal(idx); });

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
  document.getElementById("ref-thumb").src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
  document.getElementById("ref-date").textContent = pano.date;
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
  document.getElementById("adjust-preview-img").src =
    thumbnailUrl(panoramas[adjustingPanoIdx].pano_id, h, p, 400, 200);
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
  adjustTempHeading = 0; adjustTempPitch = 0;
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
  panoAngles[pano.pano_id] = { heading: HEADING + adjustTempHeading, pitch: PITCH + adjustTempPitch };
  const items = document.querySelectorAll(".timeline-item");
  if (items[adjustingPanoIdx]) {
    const angles = getAngles(pano.pano_id);
    items[adjustingPanoIdx].querySelector("img").src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
  }
  if (adjustingPanoIdx === refPanoIdx) updateRefPicker();
  adjustModal.classList.add("hidden");
});

// ── Step 3: Polygon Mask (High-Res) ──
async function loadMaskImage() {
  showLoading("Loading high-resolution image for wall marking...");
  const pano = panoramas[refPanoIdx];
  const angles = getAngles(pano.pano_id);

  const resp = await fetch(`${SERVER}/wall-crop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pano_id: pano.pano_id, heading: angles.heading, pitch: angles.pitch }),
  });
  const data = await resp.json();
  hideLoading();

  if (data.error) { console.error(data.error); return; }

  maskCanvasW = data.width;
  maskCanvasH = data.height;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    maskImage = img;
    maskCanvas.width = maskCanvasW;
    maskCanvas.height = maskCanvasH;
    drawMaskCanvas();
  };
  img.src = `${SERVER}${data.image_url}`;
}

function drawMaskCanvas() {
  if (!maskImage) return;
  maskCtx.drawImage(maskImage, 0, 0, maskCanvasW, maskCanvasH);

  if (maskPolygon.length === 0) return;

  const pts = maskPolygon.map((p) => ({
    x: p.x * maskCanvasW, y: p.y * maskCanvasH,
  }));

  if (maskClosed && pts.length >= 3) {
    maskCtx.save();
    maskCtx.beginPath();
    maskCtx.rect(0, 0, maskCanvasW, maskCanvasH);
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) maskCtx.lineTo(pts[i].x, pts[i].y);
    maskCtx.closePath();
    maskCtx.fillStyle = "rgba(0, 0, 0, 0.55)";
    maskCtx.fill("evenodd");
    maskCtx.restore();

    maskCtx.beginPath();
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) maskCtx.lineTo(pts[i].x, pts[i].y);
    maskCtx.closePath();
    maskCtx.strokeStyle = "#4a69bd";
    maskCtx.lineWidth = 3;
    maskCtx.stroke();

    pts.forEach((pt) => {
      maskCtx.beginPath();
      maskCtx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      maskCtx.fillStyle = "#4a69bd";
      maskCtx.fill();
      maskCtx.strokeStyle = "#fff";
      maskCtx.lineWidth = 1.5;
      maskCtx.stroke();
    });
  } else {
    maskCtx.beginPath();
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) maskCtx.lineTo(pts[i].x, pts[i].y);
    maskCtx.strokeStyle = "#4a69bd";
    maskCtx.lineWidth = 2;
    maskCtx.setLineDash([8, 4]);
    maskCtx.stroke();
    maskCtx.setLineDash([]);

    pts.forEach((pt, i) => {
      maskCtx.beginPath();
      maskCtx.arc(pt.x, pt.y, i === 0 ? 8 : 5, 0, Math.PI * 2);
      maskCtx.fillStyle = i === 0 ? "#2ed573" : "#4a69bd";
      maskCtx.fill();
      maskCtx.strokeStyle = "#fff";
      maskCtx.lineWidth = 1.5;
      maskCtx.stroke();
    });

    if (pts.length >= 3) {
      maskCtx.beginPath();
      maskCtx.arc(pts[0].x, pts[0].y, 16, 0, Math.PI * 2);
      maskCtx.strokeStyle = "rgba(46, 213, 115, 0.5)";
      maskCtx.lineWidth = 2;
      maskCtx.stroke();
    }
  }
}

function getMaskCoords(e) {
  const rect = maskCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min((e.clientX - rect.left) * (maskCanvasW / rect.width), maskCanvasW)),
    y: Math.max(0, Math.min((e.clientY - rect.top) * (maskCanvasH / rect.height), maskCanvasH)),
  };
}

function isNearFirst(pos) {
  if (maskPolygon.length < 3) return false;
  const f = maskPolygon[0];
  const dist = Math.sqrt((pos.x - f.x * maskCanvasW) ** 2 + (pos.y - f.y * maskCanvasH) ** 2);
  return dist < 20;
}

maskCanvas.addEventListener("click", (e) => {
  if (maskClosed) return;
  e.preventDefault();
  const pos = getMaskCoords(e);
  if (isNearFirst(pos)) { maskClosed = true; drawMaskCanvas(); updateMaskStatus(); return; }
  maskPolygon.push({ x: pos.x / maskCanvasW, y: pos.y / maskCanvasH });
  drawMaskCanvas();
  updateMaskStatus();
});

maskCanvas.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (maskPolygon.length >= 3 && !maskClosed) {
    maskClosed = true;
    drawMaskCanvas();
    updateMaskStatus();
  }
});

maskCanvas.addEventListener("mousemove", (e) => {
  if (maskClosed || maskPolygon.length === 0) return;
  drawMaskCanvas();
  const pos = getMaskCoords(e);
  const last = maskPolygon[maskPolygon.length - 1];
  maskCtx.beginPath();
  maskCtx.moveTo(last.x * maskCanvasW, last.y * maskCanvasH);
  maskCtx.lineTo(pos.x, pos.y);
  maskCtx.strokeStyle = "rgba(74, 105, 189, 0.5)";
  maskCtx.lineWidth = 1;
  maskCtx.setLineDash([4, 4]);
  maskCtx.stroke();
  maskCtx.setLineDash([]);
  maskCanvas.style.cursor = isNearFirst(pos) ? "pointer" : "crosshair";
});

function updateMaskStatus() {
  const status = document.getElementById("mask-status");
  const undoBtn = document.getElementById("undo-point-btn");
  const clearBtn = document.getElementById("clear-mask-btn");
  const analyzeBtn = document.getElementById("btn-to-step4");

  // Analyze is always enabled — wall marking is optional
  analyzeBtn.disabled = false;

  if (maskClosed) {
    status.textContent = `Wall outline complete (${maskPolygon.length} points). Ready to analyze.`;
    status.style.color = "#2ed573";
    undoBtn.classList.add("hidden");
    clearBtn.classList.remove("hidden");
  } else if (maskPolygon.length > 0) {
    const need = Math.max(0, 3 - maskPolygon.length);
    status.textContent = need > 0
      ? `${maskPolygon.length} point(s). Add ${need} more to close.`
      : `${maskPolygon.length} points. Click the green dot to close.`;
    status.style.color = "#4a69bd";
    undoBtn.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
  } else {
    status.textContent = "Optional: Outline the wall for focused analysis, or click Analyze to scan the full image.";
    status.style.color = "#888";
    undoBtn.classList.add("hidden");
    clearBtn.classList.add("hidden");
  }
}

document.getElementById("undo-point-btn").addEventListener("click", () => {
  if (maskPolygon.length > 0) { maskPolygon.pop(); maskClosed = false; drawMaskCanvas(); updateMaskStatus(); }
});
document.getElementById("clear-mask-btn").addEventListener("click", () => {
  maskPolygon = []; maskClosed = false; drawMaskCanvas(); updateMaskStatus();
});

// ── Auto-Align ──
async function autoAlignAll() {
  if (panoramas.length < 2) return;
  const ref = panoramas[refPanoIdx];
  for (let i = 0; i < panoramas.length; i++) {
    if (i === refPanoIdx) continue;
    showLoading(`Aligning image ${i + 1} of ${panoramas.length}...`);
    try {
      const body = {
        ref_pano_id: ref.pano_id,
        target_pano_id: panoramas[i].pano_id,
        heading: HEADING,
        pitch: PITCH,
      };
      if (maskClosed && maskPolygon.length >= 3) body.mask_polygon = maskPolygon;
      const resp = await fetch(`${SERVER}/auto-align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      const cur = panoAngles[panoramas[i].pano_id];
      if (cur.heading === HEADING && cur.pitch === PITCH) {
        panoAngles[panoramas[i].pano_id] = { heading: result.heading, pitch: result.pitch };
      }
    } catch (e) {
      console.warn(`Align failed for ${panoramas[i].pano_id}:`, e);
    }
  }
}

// ── Step 4: Run Analysis ──
async function runAnalysis() {
  showLoading("Aligning images...");
  await autoAlignAll();

  const n = panoramas.length;
  showLoading(`Analyzing ${n} images... (~${n * 4} seconds)`, true);
  _analysisCancelled = false;
  _analysisController = new AbortController();

  const panoList = panoramas.map((p) => {
    const a = getAngles(p.pano_id);
    return { pano_id: p.pano_id, date: p.date, heading: a.heading, pitch: a.pitch };
  });

  const body = { panoramas: panoList };
  if (maskClosed && maskPolygon.length >= 3) body.mask_polygon = maskPolygon;

  try {
    const resp = await fetch(`${SERVER}/compare-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: _analysisController.signal,
    });

    const data = await resp.json();
    pairResults = data.pairs || [];
    perImageData = data.per_image || [];
  } catch (err) {
    if (_analysisCancelled) {
      document.getElementById("results-summary").textContent = "Analysis cancelled.";
      document.getElementById("results-summary").style.color = "#888";
    } else {
      console.error("Analysis failed:", err);
      document.getElementById("results-summary").textContent =
        "Analysis failed. Please check that the server is running and try again.";
      document.getElementById("results-summary").style.color = "#ff4757";
    }
  }
  _analysisController = null;
  hideLoading();
}

function cancelAnalysis() {
  _analysisCancelled = true;
  if (_analysisController) _analysisController.abort();
  hideLoading();
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

  let text = `Tracked items from ${first.date} to ${last.date} (${perImageData.length} time periods). `;
  text += `${first.total || 0} items in ${first.date}, ${last.total || 0} in ${last.date}. `;

  // Sum up net changes across all pairs
  let totalAdded = 0, totalRemoved = 0;
  for (const pair of pairResults) {
    if (!pair.delta) continue;
    for (const k of ["plaques", "flowers", "candles", "pictures", "other"]) {
      const d = pair.delta[k] || 0;
      if (d > 0) totalAdded += d;
      else if (d < 0) totalRemoved += Math.abs(d);
    }
  }
  if (totalAdded > 0 || totalRemoved > 0) {
    text += `Net changes: +${totalAdded} added, -${totalRemoved} removed.`;
  }
  document.getElementById("results-summary").textContent = text;
}

function renderChart() {
  const canvas = document.getElementById("chart-canvas");
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

  const maxItems = Math.max(5, ...perImageData.map((d) => d.total || 0));

  // Y axis + gridlines
  ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + cH); ctx.stroke();
  ctx.fillStyle = "#666"; ctx.font = "11px sans-serif"; ctx.textAlign = "right";
  const yStep = Math.ceil(maxItems / 5);
  for (let n = 0; n <= maxItems; n += yStep) {
    const y = padT + cH - (n / maxItems) * cH;
    ctx.fillText(`${n}`, padL - 8, y + 4);
    ctx.strokeStyle = "#222";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cW, y); ctx.stroke();
  }

  const barW = Math.min(50, (cW / perImageData.length) * 0.7);
  const gap = (cW - barW * perImageData.length) / (perImageData.length + 1);
  canvas._bars = [];

  perImageData.forEach((d, i) => {
    const total = d.total || 0;
    const barH = (total / maxItems) * cH;
    const x = padL + gap + i * (barW + gap);
    const y = padT + cH - barH;

    ctx.fillStyle = "#4a69bd";
    ctx.fillRect(x, y, barW, barH);
    canvas._bars.push({ x, w: barW, idx: i });

    // Item count on top
    ctx.fillStyle = "#ccc"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${total}`, x + barW / 2, y - 6);

    // Date label
    ctx.save();
    ctx.translate(x + barW / 2, padT + cH + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#888"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(d.date, 0, 0);
    ctx.restore();
  });

  // Y axis label
  ctx.save();
  ctx.translate(14, padT + cH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#666"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Items Detected", 0, 0);
  ctx.restore();
}

// Chart click → scroll to nearest pair card
document.getElementById("chart-canvas").addEventListener("click", (e) => {
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  for (const bar of canvas._bars || []) {
    if (x >= bar.x - 5 && x <= bar.x + bar.w + 5) {
      const pairIdx = Math.min(bar.idx, pairResults.length - 1);
      const card = document.getElementById(`pair-card-${pairIdx}`);
      if (card) {
        document.querySelectorAll(".pair-card").forEach((c) => c.classList.remove("highlighted"));
        card.classList.add("highlighted");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
  }
});

function renderPairCards() {
  const container = document.getElementById("pairs-container");
  container.innerHTML = "";

  pairResults.forEach((pair, idx) => {
    if (pair.error) return;

    const card = document.createElement("div");
    card.className = "pair-card";
    card.id = `pair-card-${idx}`;

    const ca = pair.counts_a || {};
    const cb = pair.counts_b || {};
    const delta = pair.delta || {};

    // Build delta badges
    let deltaBadges = "";
    for (const k of ["plaques", "flowers", "candles", "pictures", "other"]) {
      const d = delta[k] || 0;
      if (d > 0) {
        deltaBadges += `<span class="count-badge delta-up">+${d} ${k}</span>`;
      } else if (d < 0) {
        deltaBadges += `<span class="count-badge delta-down">${d} ${k}</span>`;
      }
    }
    if (!deltaBadges) {
      deltaBadges = `<span class="count-badge delta-same">No changes</span>`;
    }

    // Build counts rows
    function countsHTML(counts) {
      const cats = ["plaques", "flowers", "candles", "pictures", "other"];
      return cats
        .filter((k) => (counts[k] || 0) > 0)
        .map((k) => `<span class="cat-count">${counts[k]} ${k}</span>`)
        .join("") || `<span class="cat-count">0 items</span>`;
    }

    const imgA = pair.crop_a_url ? `<img src="${SERVER}${pair.crop_a_url}" alt="${pair.date_a}">` : "";
    const imgB = pair.crop_b_url ? `<img src="${SERVER}${pair.crop_b_url}" alt="${pair.date_b}">` : "";

    card.innerHTML = `
      <div class="pair-header">
        <h3>${pair.date_a} \u2192 ${pair.date_b}</h3>
        <div class="pair-deltas">${deltaBadges}</div>
      </div>
      <p class="pair-summary">${pair.summary}</p>
      <div class="pair-counts-row">
        <div class="counts-col">
          <div class="counts-label">${pair.date_a} (${ca.total || 0} items)</div>
          <div class="counts-cats">${countsHTML(ca)}</div>
        </div>
        <div class="counts-col">
          <div class="counts-label">${pair.date_b} (${cb.total || 0} items)</div>
          <div class="counts-cats">${countsHTML(cb)}</div>
        </div>
      </div>
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
    `;

    container.appendChild(card);
  });
}

// ── Navigation ──
document.getElementById("btn-to-step2").addEventListener("click", () => goToStep(2));
document.getElementById("btn-back-to-1").addEventListener("click", () => goToStep(1));
document.getElementById("btn-to-step3").addEventListener("click", async () => {
  goToStep(3);
  await loadMaskImage();
  updateMaskStatus();
});
document.getElementById("btn-back-to-2").addEventListener("click", () => goToStep(2));
document.getElementById("btn-to-step4").addEventListener("click", async () => {
  goToStep(4);
  await runAnalysis();
  renderResults();
});
document.getElementById("btn-back-to-3").addEventListener("click", () => goToStep(3));

// ── Init ──
async function init() {
  initStep1();
  goToStep(1);
  try {
    // Check Ollama status
    const healthResp = await fetch(`${SERVER}/health`);
    const healthData = await healthResp.json();

    if (healthData.ollama !== "connected") {
      document.getElementById("server-dot").className = "dot dot-warn";
      document.getElementById("server-text").textContent = "Vision model not running";
      document.getElementById("ollama-warning").classList.remove("hidden");
    } else if (!healthData.model) {
      document.getElementById("server-dot").className = "dot dot-warn";
      document.getElementById("server-text").textContent = "Vision model not installed";
      document.getElementById("ollama-warning").classList.remove("hidden");
      document.getElementById("ollama-warning").textContent =
        "Model not installed. Run: ollama pull gemma3:4b";
    } else {
      document.getElementById("server-dot").className = "dot dot-ok";
      document.getElementById("server-text").textContent = "Server ready";
    }

    await searchPanoramas();
    if (panoramas.length === 0) {
      hideLoading();
      document.getElementById("pano-found-msg").textContent = "No historical images found. Try a different Street View location.";
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
    document.getElementById("pano-found-msg").textContent = `Error: ${err.message}`;
    document.getElementById("pano-found-msg").style.color = "#ff4757";
  }
}

init();
