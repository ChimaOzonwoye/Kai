const SERVER = "http://localhost:5000";

// ── Parse URL parameters ──
const params = new URLSearchParams(window.location.search);
const LAT = parseFloat(params.get("lat"));
const LNG = parseFloat(params.get("lng"));
const HEADING = parseFloat(params.get("heading"));
const PITCH = parseFloat(params.get("pitch"));

// ── High-res size for comparisons, small for timeline thumbnails ──
const COMPARE_W = 1600;
const COMPARE_H = 800;
const THUMB_W = 180;
const THUMB_H = 90;

// ── State ──
let panoramas = [];
// Per-panorama heading/pitch overrides: { [pano_id]: { heading, pitch } }
let panoAngles = {};
// ROI as percentages (0-1): { x, y, w, h }
let roiPct = null;
// Consecutive comparison results
let consecutiveResults = [];
// Currently selected pair index in the chart
let selectedPairIdx = null;
// Current wizard step
let currentStep = 1;

// ── ROI drag state ──
let roiDragging = false;
let roiStartX = 0;
let roiStartY = 0;
let roiImage = null;

// ── DOM refs ──
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");

// Step sections
const step1 = document.getElementById("step-1");
const step2 = document.getElementById("step-2");
const step3 = document.getElementById("step-3");
const step4 = document.getElementById("step-4");

// ROI
const roiContainer = document.getElementById("roi-container");
const roiCanvas = document.getElementById("roi-canvas");
const roiCtx = roiCanvas.getContext("2d");
const clearRoiBtn = document.getElementById("clear-roi-btn");
const roiStatusEl = document.getElementById("roi-status");

// Adjust modal
const adjustModal = document.getElementById("adjust-modal");
let adjustingPanoIdx = null;
let adjustTempHeading = 0;
let adjustTempPitch = 0;

// ── Helpers ──
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
  currentStep = step;
  [step1, step2, step3, step4].forEach((s) => s.classList.add("hidden"));
  document.getElementById(`step-${step}`).classList.remove("hidden");

  // Update step indicator
  document.querySelectorAll(".step-dot").forEach((dot) => {
    const s = parseInt(dot.dataset.step);
    dot.classList.remove("active", "completed");
    if (s === step) dot.classList.add("active");
    else if (s < step) dot.classList.add("completed");
  });

  // Scroll to top
  window.scrollTo(0, 0);
}

// ── Step 1: Location Detected ──
function initStep1() {
  document.getElementById("info-lat").textContent = LAT.toFixed(7);
  document.getElementById("info-lng").textContent = LNG.toFixed(7);
  document.getElementById("info-heading").textContent = `${HEADING.toFixed(1)}\u00B0`;
  document.getElementById("info-pitch").textContent = `${PITCH.toFixed(1)}\u00B0`;
}

// ── Search panoramas ──
async function searchPanoramas() {
  showLoading("Searching for historical images...");
  const resp = await fetch(`${SERVER}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: LAT, lon: LNG }),
  });
  const data = await resp.json();
  panoramas = data.panoramas || [];

  // Initialize default angles for each panorama
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
    item.dataset.index = idx;

    const angles = getAngles(pano.pano_id);

    const img = document.createElement("img");
    img.src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
    img.alt = pano.date;
    img.loading = "lazy";

    const dateLabel = document.createElement("div");
    dateLabel.className = "timeline-date";
    dateLabel.textContent = pano.date;

    // Adjust button
    const adjBtn = document.createElement("button");
    adjBtn.className = "adjust-btn";
    adjBtn.textContent = "\u2699";
    adjBtn.title = "Adjust viewing angle";
    adjBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAdjustModal(idx);
    });

    item.appendChild(img);
    item.appendChild(dateLabel);
    item.appendChild(adjBtn);
    timeline.appendChild(item);
  });
}

// ── Adjust Modal ──
function openAdjustModal(idx) {
  adjustingPanoIdx = idx;
  const pano = panoramas[idx];
  const angles = getAngles(pano.pano_id);

  adjustTempHeading = 0;
  adjustTempPitch = 0;

  document.getElementById("adjust-pano-date").textContent = `Date: ${pano.date}`;

  const headingSlider = document.getElementById("adjust-heading");
  const pitchSlider = document.getElementById("adjust-pitch");
  headingSlider.value = 0;
  pitchSlider.value = 0;
  document.getElementById("adjust-heading-val").textContent = "0";
  document.getElementById("adjust-pitch-val").textContent = "0";

  updateAdjustPreview(angles.heading, angles.pitch);
  adjustModal.classList.remove("hidden");
}

function updateAdjustPreview(h, p) {
  const pano = panoramas[adjustingPanoIdx];
  const img = document.getElementById("adjust-preview-img");
  img.src = thumbnailUrl(pano.pano_id, h, p, 400, 200);
}

document.getElementById("adjust-heading").addEventListener("input", (e) => {
  adjustTempHeading = parseFloat(e.target.value);
  document.getElementById("adjust-heading-val").textContent = adjustTempHeading.toFixed(1);
  const pano = panoramas[adjustingPanoIdx];
  const base = getAngles(pano.pano_id);
  updateAdjustPreview(HEADING + adjustTempHeading, PITCH + adjustTempPitch);
});

document.getElementById("adjust-pitch").addEventListener("input", (e) => {
  adjustTempPitch = parseFloat(e.target.value);
  document.getElementById("adjust-pitch-val").textContent = adjustTempPitch.toFixed(1);
  const pano = panoramas[adjustingPanoIdx];
  const base = getAngles(pano.pano_id);
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
  adjustingPanoIdx = null;
});

document.getElementById("adjust-apply").addEventListener("click", () => {
  const pano = panoramas[adjustingPanoIdx];
  panoAngles[pano.pano_id] = {
    heading: HEADING + adjustTempHeading,
    pitch: PITCH + adjustTempPitch,
  };

  // Refresh that timeline thumbnail
  const items = document.querySelectorAll(".timeline-item");
  if (items[adjustingPanoIdx]) {
    const img = items[adjustingPanoIdx].querySelector("img");
    const angles = getAngles(pano.pano_id);
    img.src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
  }

  adjustModal.classList.add("hidden");
  adjustingPanoIdx = null;
});

// ── Step 3: ROI Selection (Fixed Canvas) ──
function loadRoiImage() {
  // Use the earliest panorama for the ROI selection image
  const pano = panoramas[0];
  const angles = getAngles(pano.pano_id);
  const url = `${SERVER}/thumbnail?pano_id=${pano.pano_id}&heading=${angles.heading}&pitch=${angles.pitch}&w=800&h=400`;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    roiImage = img;
    roiCanvas.width = 800;
    roiCanvas.height = 400;
    drawRoiCanvas();
  };
  img.src = url;
}

function drawRoiCanvas() {
  if (!roiImage) return;
  roiCtx.drawImage(roiImage, 0, 0, 800, 400);

  if (roiPct) {
    const x = roiPct.x * 800;
    const y = roiPct.y * 400;
    const w = roiPct.w * 800;
    const h = roiPct.h * 400;

    // Dim outside ROI
    roiCtx.fillStyle = "rgba(0, 0, 0, 0.6)";
    roiCtx.fillRect(0, 0, 800, y);
    roiCtx.fillRect(0, y + h, 800, 400 - y - h);
    roiCtx.fillRect(0, y, x, h);
    roiCtx.fillRect(x + w, y, 800 - x - w, h);

    // ROI border
    roiCtx.strokeStyle = "#4a69bd";
    roiCtx.lineWidth = 2;
    roiCtx.setLineDash([6, 3]);
    roiCtx.strokeRect(x, y, w, h);
    roiCtx.setLineDash([]);

    // Corner handles
    const hs = 8;
    roiCtx.fillStyle = "#4a69bd";
    [
      [x - hs / 2, y - hs / 2],
      [x + w - hs / 2, y - hs / 2],
      [x - hs / 2, y + h - hs / 2],
      [x + w - hs / 2, y + h - hs / 2],
    ].forEach(([cx, cy]) => roiCtx.fillRect(cx, cy, hs, hs));
  }
}

function getCanvasCoords(e) {
  const rect = roiCanvas.getBoundingClientRect();
  const scaleX = roiCanvas.width / rect.width;
  const scaleY = roiCanvas.height / rect.height;
  return {
    x: Math.max(0, Math.min((e.clientX - rect.left) * scaleX, roiCanvas.width)),
    y: Math.max(0, Math.min((e.clientY - rect.top) * scaleY, roiCanvas.height)),
  };
}

roiCanvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const pos = getCanvasCoords(e);
  roiStartX = pos.x;
  roiStartY = pos.y;
  roiDragging = true;

  // Lock the container position to prevent scroll-induced movement
  roiContainer.style.position = "relative";
});

// Listen on document to catch mouse moves outside canvas
document.addEventListener("mousemove", (e) => {
  if (!roiDragging) return;
  e.preventDefault();

  const rect = roiCanvas.getBoundingClientRect();
  const scaleX = roiCanvas.width / rect.width;
  const scaleY = roiCanvas.height / rect.height;

  // Clamp to canvas boundaries even if mouse is outside
  const rawX = (e.clientX - rect.left) * scaleX;
  const rawY = (e.clientY - rect.top) * scaleY;
  const clampedX = Math.max(0, Math.min(rawX, roiCanvas.width));
  const clampedY = Math.max(0, Math.min(rawY, roiCanvas.height));

  const x = Math.min(roiStartX, clampedX);
  const y = Math.min(roiStartY, clampedY);
  const w = Math.abs(clampedX - roiStartX);
  const h = Math.abs(clampedY - roiStartY);

  // Store as percentages
  roiPct = {
    x: x / 800,
    y: y / 400,
    w: w / 800,
    h: h / 400,
  };

  drawRoiCanvas();
});

document.addEventListener("mouseup", (e) => {
  if (!roiDragging) return;
  roiDragging = false;

  if (roiPct && roiPct.w > 0.02 && roiPct.h > 0.02) {
    updateRoiStatus();
    clearRoiBtn.classList.remove("hidden");
    document.getElementById("btn-to-step4").disabled = false;
  } else {
    roiPct = null;
    updateRoiStatus();
    document.getElementById("btn-to-step4").disabled = true;
  }
});

function updateRoiStatus() {
  if (roiPct) {
    const wPx = Math.round(roiPct.w * 800);
    const hPx = Math.round(roiPct.h * 400);
    roiStatusEl.textContent = `Region selected: ${wPx} \u00D7 ${hPx} pixels`;
    roiStatusEl.style.color = "#4a69bd";
  } else {
    roiStatusEl.textContent = "No region selected yet";
    roiStatusEl.style.color = "#888";
    clearRoiBtn.classList.add("hidden");
    document.getElementById("btn-to-step4").disabled = true;
  }
}

clearRoiBtn.addEventListener("click", () => {
  roiPct = null;
  updateRoiStatus();
  drawRoiCanvas();
});

// ── Auto-Align All Panoramas ──
async function autoAlignAll() {
  if (panoramas.length < 2) return;

  const refPano = panoramas[0];
  let aligned = 0;
  const total = panoramas.length - 1;

  for (let i = 1; i < panoramas.length; i++) {
    showLoading(`Aligning image ${i} of ${total}...`);
    try {
      const body = {
        ref_pano_id: refPano.pano_id,
        target_pano_id: panoramas[i].pano_id,
        heading: HEADING,
        pitch: PITCH,
      };
      if (roiPct) {
        body.roi_pct = roiPct;
      }

      const resp = await fetch(`${SERVER}/auto-align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();

      // Only apply if the user hasn't manually adjusted this panorama
      const current = panoAngles[panoramas[i].pano_id];
      if (current.heading === HEADING && current.pitch === PITCH) {
        panoAngles[panoramas[i].pano_id] = {
          heading: result.heading,
          pitch: result.pitch,
        };
      }
      aligned++;
    } catch (e) {
      console.warn(`Auto-align failed for ${panoramas[i].pano_id}:`, e);
    }
  }
}

// ── Step 4: Run All Consecutive Comparisons ──
async function runConsecutiveComparisons() {
  showLoading("Aligning images for best comparison...");
  await autoAlignAll();

  showLoading("Comparing all date pairs...");

  const panoList = panoramas.map((p) => {
    const angles = getAngles(p.pano_id);
    return {
      pano_id: p.pano_id,
      date: p.date,
      heading: angles.heading,
      pitch: angles.pitch,
    };
  });

  const cellSize = parseInt(document.getElementById("cell-size").value);
  const threshold = parseInt(document.getElementById("threshold").value);

  const resp = await fetch(`${SERVER}/compare-consecutive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      panoramas: panoList,
      roi_pct: roiPct,
      cell_size: cellSize,
      threshold: threshold,
    }),
  });

  const data = await resp.json();
  consecutiveResults = data.pairs || [];
  hideLoading();
}

// ── Chart Rendering ──
function renderChart() {
  const canvas = document.getElementById("chart-canvas");
  const ctx = canvas.getContext("2d");

  const pairs = consecutiveResults;
  if (pairs.length === 0) return;

  // Set canvas resolution
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 280 * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = 280;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 60;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  // Clear
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Find max change %
  const maxPct = Math.max(10, ...pairs.map((p) => p.change_pct || 0));

  // Y axis
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, padTop + chartH);
  ctx.stroke();

  // Y labels
  ctx.fillStyle = "#666";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.textAlign = "right";
  for (let pct = 0; pct <= maxPct; pct += Math.ceil(maxPct / 5)) {
    const y = padTop + chartH - (pct / maxPct) * chartH;
    ctx.fillText(`${pct}%`, padLeft - 8, y + 4);
    ctx.strokeStyle = "#222";
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();
  }

  // Bars
  const barWidth = Math.min(50, (chartW / pairs.length) * 0.7);
  const gap = (chartW - barWidth * pairs.length) / (pairs.length + 1);

  // Store bar positions for click detection
  canvas._barRects = [];

  pairs.forEach((pair, i) => {
    const pct = pair.change_pct || 0;
    const barH = (pct / maxPct) * chartH;
    const x = padLeft + gap + i * (barWidth + gap);
    const y = padTop + chartH - barH;

    // Bar color based on change level
    let color = "#2ed573";
    if (pct >= 30) color = "#ff4757";
    else if (pct >= 15) color = "#ffc700";
    else if (pct >= 5) color = "#4a69bd";

    // Highlight selected
    if (selectedPairIdx === i) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 2, y - 2, barWidth + 4, barH + 4);
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, y, barWidth, barH);

    // Store rect for click detection
    canvas._barRects.push({ x, y, w: barWidth, h: barH, idx: i });

    // Value label on top
    if (pct > 0) {
      ctx.fillStyle = "#ccc";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${pct}%`, x + barWidth / 2, y - 6);
    }

    // Date label (x-axis)
    ctx.save();
    ctx.translate(x + barWidth / 2, padTop + chartH + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#888";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "left";
    const label = `${pair.date_a} \u2192 ${pair.date_b}`;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });

  // Y axis label
  ctx.save();
  ctx.translate(14, padTop + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#666";
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Change %", 0, 0);
  ctx.restore();
}

// Chart click handler
document.getElementById("chart-canvas").addEventListener("click", (e) => {
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = (e.clientX - rect.left);
  const y = (e.clientY - rect.top);

  const bars = canvas._barRects || [];
  for (const bar of bars) {
    // Use generous click area
    if (x >= bar.x - 5 && x <= bar.x + bar.w + 5 && y >= 0 && y <= 280) {
      selectedPairIdx = bar.idx;
      renderChart();
      showPairDetail(bar.idx);
      return;
    }
  }
});

// ── Show Detail for a Pair ──
async function showPairDetail(idx) {
  const pair = consecutiveResults[idx];
  if (!pair) return;

  const section = document.getElementById("detail-section");
  section.classList.remove("hidden");

  document.getElementById("detail-title").textContent =
    `${pair.date_a} vs ${pair.date_b}`;

  document.getElementById("detail-summary").textContent =
    `Between ${pair.date_a} and ${pair.date_b}, ${pair.change_pct}% of the selected area changed.`;

  document.getElementById("detail-label-a").textContent = pair.date_a;
  document.getElementById("detail-label-b").textContent = pair.date_b;

  // Find panorama objects
  const panoA = panoramas.find((p) => p.pano_id === pair.pano_id_a);
  const panoB = panoramas.find((p) => p.pano_id === pair.pano_id_b);
  if (!panoA || !panoB) return;

  const anglesA = getAngles(panoA.pano_id);
  const anglesB = getAngles(panoB.pano_id);

  // Load high-res images cropped to ROI
  const urlA = thumbnailUrl(panoA.pano_id, anglesA.heading, anglesA.pitch, COMPARE_W, COMPARE_H);
  const urlB = thumbnailUrl(panoB.pano_id, anglesB.heading, anglesB.pitch, COMPARE_W, COMPARE_H);

  loadDetailCanvas("detail-canvas-a", urlA);
  loadDetailCanvas("detail-canvas-b", urlB);

  // Scroll to detail
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function loadDetailCanvas(canvasId, url) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (roiPct) {
      // Crop to ROI
      const sx = roiPct.x * img.width;
      const sy = roiPct.y * img.height;
      const sw = roiPct.w * img.width;
      const sh = roiPct.h * img.height;
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    }
  };
  img.src = url;
}

// ── Results Summary ──
function renderResultsSummary() {
  const pairs = consecutiveResults;
  if (pairs.length === 0) return;

  const validPairs = pairs.filter((p) => p.change_pct !== null);
  const maxChange = validPairs.reduce(
    (max, p) => (p.change_pct > max.change_pct ? p : max),
    validPairs[0]
  );
  const avgChange = (
    validPairs.reduce((sum, p) => sum + p.change_pct, 0) / validPairs.length
  ).toFixed(1);

  let summary = `Analyzed ${validPairs.length} time periods from ${panoramas[0].date} to ${panoramas[panoramas.length - 1].date}. `;
  summary += `Average change between periods: ${avgChange}%. `;

  if (maxChange && maxChange.change_pct > 0) {
    summary += `The biggest change (${maxChange.change_pct}%) happened between ${maxChange.date_a} and ${maxChange.date_b}.`;
  }

  document.getElementById("results-summary").textContent = summary;
}

// ── Advanced: Run Single Comparison for Overlays ──
async function runSingleComparison(pairIdx) {
  const pair = consecutiveResults[pairIdx];
  if (!pair) return;

  const panoA = panoramas.find((p) => p.pano_id === pair.pano_id_a);
  const panoB = panoramas.find((p) => p.pano_id === pair.pano_id_b);
  if (!panoA || !panoB) return;

  const anglesA = getAngles(panoA.pano_id);
  const anglesB = getAngles(panoB.pano_id);

  const cellSize = parseInt(document.getElementById("cell-size").value);
  const threshold = parseInt(document.getElementById("threshold").value);

  showLoading("Running detailed comparison...");

  const resp = await fetch(`${SERVER}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pano_id_a: panoA.pano_id,
      pano_id_b: panoB.pano_id,
      heading_a: anglesA.heading,
      pitch_a: anglesA.pitch,
      heading_b: anglesB.heading,
      pitch_b: anglesB.pitch,
      cell_size: cellSize,
      threshold: threshold,
      width: COMPARE_W,
      height: COMPARE_H,
      roi_pct: roiPct,
    }),
  });

  const result = await resp.json();
  hideLoading();
  return result;
}

async function showAdvancedDetail(pairIdx) {
  const result = await runSingleComparison(pairIdx);
  if (!result) return;

  const pair = consecutiveResults[pairIdx];

  // Overlays
  document.getElementById("overlay-label-a").textContent = pair.date_a;
  document.getElementById("overlay-label-b").textContent = pair.date_b;

  loadImageToCanvas("canvas-a", `${SERVER}${result.overlay_a_url}`);
  loadImageToCanvas("canvas-b", `${SERVER}${result.overlay_b_url}`);
  loadImageToCanvas("canvas-diff", `${SERVER}${result.diff_map_url}`);
  document.getElementById("overlay-section").classList.remove("hidden");

  // Grid table
  buildGridTable(result);
  document.getElementById("grid-section").classList.remove("hidden");

  // Changed cells list
  buildChangedList(result);
  document.getElementById("changed-list-section").classList.remove("hidden");

  // Cell detail
  document.getElementById("cell-detail").classList.remove("hidden");
}

function loadImageToCanvas(canvasId, url) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  };
  img.src = url;
}

function updateCellDetail(cell) {
  document.getElementById("cell-label").textContent = cell.label;
  document.getElementById("cell-pos").textContent = `(${cell.x}, ${cell.y})`;
  document.getElementById("cell-diff").textContent = `Diff: ${cell.diff}`;
  const statusEl = document.getElementById("cell-status");
  if (cell.changed) {
    statusEl.textContent = "CHANGED";
    statusEl.style.color = "#ff4757";
  } else {
    statusEl.textContent = "Unchanged";
    statusEl.style.color = "#2ed573";
  }
}

function buildGridTable(result) {
  const container = document.getElementById("grid-container");
  container.innerHTML = "";
  const table = document.createElement("table");

  const grid = {};
  result.cells.forEach((c) => {
    if (!grid[c.row]) grid[c.row] = {};
    grid[c.row][c.col] = c;
  });

  for (let r = 0; r < result.grid_rows; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < result.grid_cols; c++) {
      const td = document.createElement("td");
      const cell = grid[r] && grid[r][c];
      if (cell) {
        if (!cell.changed) {
          td.style.background = "#1a5c2a";
        } else if (cell.diff < 25) {
          td.style.background = "#8a7a00";
        } else {
          td.style.background = "#8a1a1a";
        }
        td.title = `${cell.label}  Diff: ${cell.diff}`;
        td.addEventListener("mouseenter", () => updateCellDetail(cell));
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  container.appendChild(table);
}

function buildChangedList(result) {
  const list = document.getElementById("changed-list");
  list.innerHTML = "";

  const changed = result.cells
    .filter((c) => c.changed)
    .sort((a, b) => b.diff - a.diff);

  document.getElementById("changed-count").textContent = changed.length;

  changed.forEach((cell) => {
    const item = document.createElement("div");
    item.className = "changed-item";

    let severityClass, severityText;
    if (cell.diff >= 40) {
      severityClass = "severity-high";
      severityText = "High";
    } else if (cell.diff >= 20) {
      severityClass = "severity-medium";
      severityText = "Medium";
    } else {
      severityClass = "severity-low";
      severityText = "Low";
    }

    item.innerHTML = `
      <span class="ci-label">${cell.label}</span>
      <span class="ci-diff">Diff: ${cell.diff}</span>
      <span class="ci-severity ${severityClass}">${severityText}</span>
    `;
    list.appendChild(item);
  });
}

// ── Slider updates ──
document.getElementById("cell-size").addEventListener("input", (e) => {
  document.getElementById("cell-size-val").textContent = e.target.value;
});
document.getElementById("threshold").addEventListener("input", (e) => {
  document.getElementById("threshold-val").textContent = e.target.value;
});

// ── Re-analyze button ──
document.getElementById("reanalyze-btn").addEventListener("click", async () => {
  await runConsecutiveComparisons();
  renderChart();
  renderResultsSummary();

  // Refresh advanced detail if a pair is selected
  if (selectedPairIdx !== null) {
    await showAdvancedDetail(selectedPairIdx);
  }
});

// ── Navigation Buttons ──
document.getElementById("btn-to-step2").addEventListener("click", () => goToStep(2));
document.getElementById("btn-back-to-1").addEventListener("click", () => goToStep(1));
document.getElementById("btn-to-step3").addEventListener("click", () => {
  goToStep(3);
  loadRoiImage();
});
document.getElementById("btn-back-to-2").addEventListener("click", () => goToStep(2));

document.getElementById("btn-to-step4").addEventListener("click", async () => {
  goToStep(4);
  await runConsecutiveComparisons();
  renderChart();
  renderResultsSummary();

  // Auto-select first pair
  if (consecutiveResults.length > 0) {
    selectedPairIdx = 0;
    renderChart();
    showPairDetail(0);
  }
});

document.getElementById("btn-back-to-3").addEventListener("click", () => goToStep(3));

// ── Advanced section: load detail when opened ──
document.getElementById("advanced-section").addEventListener("toggle", async (e) => {
  if (e.target.open && selectedPairIdx !== null) {
    await showAdvancedDetail(selectedPairIdx);
  }
});

// ── Initialize ──
async function init() {
  initStep1();
  goToStep(1);

  try {
    await searchPanoramas();

    if (panoramas.length === 0) {
      hideLoading();
      document.getElementById("server-dot").className = "dot dot-ok";
      document.getElementById("server-text").textContent = "Server connected";
      document.getElementById("pano-found-msg").textContent =
        "No historical images found at this location. Try a different Street View location.";
      document.getElementById("pano-found-msg").style.color = "#ff4757";
      return;
    }

    hideLoading();
    document.getElementById("pano-found-msg").textContent =
      `Found ${panoramas.length} historical images spanning ${panoramas[0].date} to ${panoramas[panoramas.length - 1].date}.`;
    document.getElementById("btn-to-step2").disabled = false;

    // Pre-build timeline
    buildTimeline();
  } catch (err) {
    hideLoading();
    document.getElementById("server-dot").className = "dot dot-err";
    document.getElementById("server-text").textContent = "Server offline";
    document.getElementById("pano-found-msg").textContent =
      `Error: ${err.message}. Make sure the Python server is running on localhost:5000.`;
    document.getElementById("pano-found-msg").style.color = "#ff4757";
  }
}

init();
