const SERVER = "http://localhost:5000";

// ── Parse URL parameters ──
const params = new URLSearchParams(window.location.search);
const LAT = parseFloat(params.get("lat"));
const LNG = parseFloat(params.get("lng"));
const HEADING = parseFloat(params.get("heading"));
const PITCH = parseFloat(params.get("pitch"));

// ── Image sizes ──
const COMPARE_W = 1600;
const COMPARE_H = 800;
const THUMB_W = 180;
const THUMB_H = 90;
const MASK_CANVAS_W = 800;
const MASK_CANVAS_H = 400;

// ── State ──
let panoramas = [];
let panoAngles = {};           // { [pano_id]: { heading, pitch } }
let refPanoIdx = 0;            // Index of the reference image (clearest wall view)
let maskPolygon = [];          // [{x, y}, ...] as percentages (0-1), the wall outline
let maskClosed = false;        // Whether the polygon is closed
let maskImage = null;          // Reference image loaded on mask canvas
let consecutiveResults = [];   // Results from consecutive comparison
let selectedPairIdx = null;    // Currently selected bar in the chart
let currentStep = 1;

// ── Adjust modal state ──
let adjustingPanoIdx = null;
let adjustTempHeading = 0;
let adjustTempPitch = 0;

// ── DOM refs ──
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const adjustModal = document.getElementById("adjust-modal");

// Mask canvas
const maskContainer = document.getElementById("mask-container");
const maskCanvas = document.getElementById("mask-canvas");
const maskCtx = maskCanvas.getContext("2d");

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
  ["step-1", "step-2", "step-3", "step-4"].forEach((id) => {
    document.getElementById(id).classList.add("hidden");
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

  panoramas.forEach((p) => {
    panoAngles[p.pano_id] = { heading: HEADING, pitch: PITCH };
  });

  return panoramas;
}

// ── Step 2: Timeline + Reference Picker ──
function buildTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";

  panoramas.forEach((pano, idx) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    if (idx === refPanoIdx) item.classList.add("selected-ref");
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

    // Click to select as reference
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
  // Update selection highlight
  document.querySelectorAll(".timeline-item").forEach((el, i) => {
    el.classList.toggle("selected-ref", i === idx);
  });
  updateRefPicker();
}

function updateRefPicker() {
  const picker = document.getElementById("ref-picker");
  picker.classList.remove("hidden");

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

  const headingSlider = document.getElementById("adjust-heading");
  const pitchSlider = document.getElementById("adjust-pitch");
  headingSlider.value = adjustTempHeading;
  pitchSlider.value = adjustTempPitch;
  document.getElementById("adjust-heading-val").textContent = adjustTempHeading.toFixed(1);
  document.getElementById("adjust-pitch-val").textContent = adjustTempPitch.toFixed(1);

  updateAdjustPreview(angles.heading, angles.pitch);
  adjustModal.classList.remove("hidden");
}

function updateAdjustPreview(h, p) {
  const pano = panoramas[adjustingPanoIdx];
  document.getElementById("adjust-preview-img").src =
    thumbnailUrl(pano.pano_id, h, p, 400, 200);
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
  adjustingPanoIdx = null;
});

document.getElementById("adjust-apply").addEventListener("click", () => {
  const pano = panoramas[adjustingPanoIdx];
  panoAngles[pano.pano_id] = {
    heading: HEADING + adjustTempHeading,
    pitch: PITCH + adjustTempPitch,
  };

  // Refresh timeline thumbnail
  const items = document.querySelectorAll(".timeline-item");
  if (items[adjustingPanoIdx]) {
    const img = items[adjustingPanoIdx].querySelector("img");
    const angles = getAngles(pano.pano_id);
    img.src = thumbnailUrl(pano.pano_id, angles.heading, angles.pitch);
  }

  // Update ref picker if this was the reference
  if (adjustingPanoIdx === refPanoIdx) {
    updateRefPicker();
  }

  adjustModal.classList.add("hidden");
  adjustingPanoIdx = null;
});

// ── Step 3: Polygon Mask Drawing ──
function loadMaskImage() {
  const pano = panoramas[refPanoIdx];
  const angles = getAngles(pano.pano_id);
  const url = `${SERVER}/thumbnail?pano_id=${pano.pano_id}&heading=${angles.heading}&pitch=${angles.pitch}&w=${MASK_CANVAS_W}&h=${MASK_CANVAS_H}`;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    maskImage = img;
    maskCanvas.width = MASK_CANVAS_W;
    maskCanvas.height = MASK_CANVAS_H;
    drawMaskCanvas();
  };
  img.src = url;
}

function drawMaskCanvas() {
  if (!maskImage) return;

  // Draw the reference image
  maskCtx.drawImage(maskImage, 0, 0, MASK_CANVAS_W, MASK_CANVAS_H);

  // If we have polygon points, draw them
  if (maskPolygon.length === 0) return;

  const pts = maskPolygon.map((p) => ({
    x: p.x * MASK_CANVAS_W,
    y: p.y * MASK_CANVAS_H,
  }));

  if (maskClosed && pts.length >= 3) {
    // Draw the filled mask area
    // First dim everything outside the polygon
    maskCtx.save();

    // Create a path for the entire canvas minus the polygon
    maskCtx.beginPath();
    maskCtx.rect(0, 0, MASK_CANVAS_W, MASK_CANVAS_H);
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      maskCtx.lineTo(pts[i].x, pts[i].y);
    }
    maskCtx.closePath();
    // Use evenodd to fill outside the polygon
    maskCtx.fillStyle = "rgba(0, 0, 0, 0.6)";
    maskCtx.fill("evenodd");
    maskCtx.restore();

    // Draw polygon outline
    maskCtx.beginPath();
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      maskCtx.lineTo(pts[i].x, pts[i].y);
    }
    maskCtx.closePath();
    maskCtx.strokeStyle = "#4a69bd";
    maskCtx.lineWidth = 2;
    maskCtx.stroke();

    // Draw vertices
    pts.forEach((pt) => {
      maskCtx.beginPath();
      maskCtx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      maskCtx.fillStyle = "#4a69bd";
      maskCtx.fill();
      maskCtx.strokeStyle = "#fff";
      maskCtx.lineWidth = 1;
      maskCtx.stroke();
    });
  } else {
    // Drawing in progress: show lines and points
    maskCtx.beginPath();
    maskCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      maskCtx.lineTo(pts[i].x, pts[i].y);
    }
    maskCtx.strokeStyle = "#4a69bd";
    maskCtx.lineWidth = 2;
    maskCtx.setLineDash([6, 3]);
    maskCtx.stroke();
    maskCtx.setLineDash([]);

    // Draw vertices
    pts.forEach((pt, i) => {
      maskCtx.beginPath();
      maskCtx.arc(pt.x, pt.y, i === 0 ? 7 : 4, 0, Math.PI * 2);
      maskCtx.fillStyle = i === 0 ? "#2ed573" : "#4a69bd";
      maskCtx.fill();
      maskCtx.strokeStyle = "#fff";
      maskCtx.lineWidth = 1;
      maskCtx.stroke();
    });

    // Highlight the first point (close target)
    if (pts.length >= 3) {
      maskCtx.beginPath();
      maskCtx.arc(pts[0].x, pts[0].y, 12, 0, Math.PI * 2);
      maskCtx.strokeStyle = "rgba(46, 213, 115, 0.5)";
      maskCtx.lineWidth = 2;
      maskCtx.stroke();
    }
  }
}

function getMaskCanvasCoords(e) {
  const rect = maskCanvas.getBoundingClientRect();
  const scaleX = maskCanvas.width / rect.width;
  const scaleY = maskCanvas.height / rect.height;
  return {
    x: Math.max(0, Math.min((e.clientX - rect.left) * scaleX, maskCanvas.width)),
    y: Math.max(0, Math.min((e.clientY - rect.top) * scaleY, maskCanvas.height)),
  };
}

function isNearFirstPoint(pos) {
  if (maskPolygon.length < 3) return false;
  const first = maskPolygon[0];
  const fx = first.x * MASK_CANVAS_W;
  const fy = first.y * MASK_CANVAS_H;
  const dist = Math.sqrt((pos.x - fx) ** 2 + (pos.y - fy) ** 2);
  return dist < 15;
}

maskCanvas.addEventListener("click", (e) => {
  if (maskClosed) return; // Already closed, must clear to redraw
  e.preventDefault();

  const pos = getMaskCanvasCoords(e);

  // Check if clicking near the first point to close
  if (isNearFirstPoint(pos)) {
    maskClosed = true;
    drawMaskCanvas();
    updateMaskStatus();
    return;
  }

  // Add new point as percentages
  maskPolygon.push({
    x: pos.x / MASK_CANVAS_W,
    y: pos.y / MASK_CANVAS_H,
  });

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

// Hover: show preview line to cursor
maskCanvas.addEventListener("mousemove", (e) => {
  if (maskClosed || maskPolygon.length === 0) return;

  drawMaskCanvas();

  const pos = getMaskCanvasCoords(e);
  const lastPt = maskPolygon[maskPolygon.length - 1];

  maskCtx.beginPath();
  maskCtx.moveTo(lastPt.x * MASK_CANVAS_W, lastPt.y * MASK_CANVAS_H);
  maskCtx.lineTo(pos.x, pos.y);
  maskCtx.strokeStyle = "rgba(74, 105, 189, 0.5)";
  maskCtx.lineWidth = 1;
  maskCtx.setLineDash([4, 4]);
  maskCtx.stroke();
  maskCtx.setLineDash([]);

  // Highlight close target
  if (isNearFirstPoint(pos)) {
    maskCanvas.style.cursor = "pointer";
  } else {
    maskCanvas.style.cursor = "crosshair";
  }
});

function updateMaskStatus() {
  const statusEl = document.getElementById("mask-status");
  const undoBtn = document.getElementById("undo-point-btn");
  const clearBtn = document.getElementById("clear-mask-btn");
  const analyzeBtn = document.getElementById("btn-to-step4");

  if (maskClosed) {
    statusEl.textContent = `Wall outline complete (${maskPolygon.length} points). Ready to analyze.`;
    statusEl.style.color = "#2ed573";
    undoBtn.classList.add("hidden");
    clearBtn.classList.remove("hidden");
    analyzeBtn.disabled = false;
  } else if (maskPolygon.length > 0) {
    const remaining = Math.max(0, 3 - maskPolygon.length);
    if (remaining > 0) {
      statusEl.textContent = `${maskPolygon.length} point${maskPolygon.length > 1 ? "s" : ""} placed. Add ${remaining} more to close the shape.`;
    } else {
      statusEl.textContent = `${maskPolygon.length} points placed. Click the green dot to close, or keep adding points.`;
    }
    statusEl.style.color = "#4a69bd";
    undoBtn.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
    analyzeBtn.disabled = true;
  } else {
    statusEl.textContent = "Click on the image to start outlining the wall";
    statusEl.style.color = "#888";
    undoBtn.classList.add("hidden");
    clearBtn.classList.add("hidden");
    analyzeBtn.disabled = true;
  }
}

document.getElementById("undo-point-btn").addEventListener("click", () => {
  if (maskPolygon.length > 0) {
    maskPolygon.pop();
    maskClosed = false;
    drawMaskCanvas();
    updateMaskStatus();
  }
});

document.getElementById("clear-mask-btn").addEventListener("click", () => {
  maskPolygon = [];
  maskClosed = false;
  drawMaskCanvas();
  updateMaskStatus();
});

// ── Auto-Align All Panoramas ──
async function autoAlignAll() {
  if (panoramas.length < 2) return;

  const refPano = panoramas[refPanoIdx];
  const total = panoramas.length - 1;

  for (let i = 0; i < panoramas.length; i++) {
    if (i === refPanoIdx) continue;
    showLoading(`Aligning image ${i + 1} of ${panoramas.length}...`);
    try {
      const body = {
        ref_pano_id: refPano.pano_id,
        target_pano_id: panoramas[i].pano_id,
        heading: HEADING,
        pitch: PITCH,
      };
      if (maskClosed && maskPolygon.length >= 3) {
        body.mask_polygon = maskPolygon;
      }

      const resp = await fetch(`${SERVER}/auto-align`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();

      // Only apply if user hasn't manually adjusted
      const current = panoAngles[panoramas[i].pano_id];
      if (current.heading === HEADING && current.pitch === PITCH) {
        panoAngles[panoramas[i].pano_id] = {
          heading: result.heading,
          pitch: result.pitch,
        };
      }
    } catch (e) {
      console.warn(`Auto-align failed for ${panoramas[i].pano_id}:`, e);
    }
  }
}

// ── Step 4: Run Consecutive Comparisons ──
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

  const refAngles = getAngles(panoramas[refPanoIdx].pano_id);
  const cellSize = parseInt(document.getElementById("cell-size").value);
  const threshold = parseInt(document.getElementById("threshold").value);

  const body = {
    panoramas: panoList,
    cell_size: cellSize,
    threshold: threshold,
    ref_pano_id: panoramas[refPanoIdx].pano_id,
    ref_heading: refAngles.heading,
    ref_pitch: refAngles.pitch,
  };

  if (maskClosed && maskPolygon.length >= 3) {
    body.mask_polygon = maskPolygon;
  }

  const resp = await fetch(`${SERVER}/compare-consecutive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

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
  const yStep = Math.ceil(maxPct / 5);
  for (let pct = 0; pct <= maxPct; pct += yStep) {
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

  canvas._barRects = [];

  pairs.forEach((pair, i) => {
    const pct = pair.change_pct || 0;
    const barH = (pct / maxPct) * chartH;
    const x = padLeft + gap + i * (barWidth + gap);
    const y = padTop + chartH - barH;

    let color = "#2ed573";
    if (pct >= 30) color = "#ff4757";
    else if (pct >= 15) color = "#ffc700";
    else if (pct >= 5) color = "#4a69bd";

    if (selectedPairIdx === i) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 2, y - 2, barWidth + 4, barH + 4);
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, y, barWidth, barH);

    canvas._barRects.push({ x, y, w: barWidth, h: barH, idx: i });

    if (pct > 0) {
      ctx.fillStyle = "#ccc";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${pct}%`, x + barWidth / 2, y - 6);
    }

    // Date label
    ctx.save();
    ctx.translate(x + barWidth / 2, padTop + chartH + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#888";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${pair.date_a} \u2192 ${pair.date_b}`, 0, 0);
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
  const x = e.clientX - rect.left;

  const bars = canvas._barRects || [];
  for (const bar of bars) {
    if (x >= bar.x - 5 && x <= bar.x + bar.w + 5) {
      selectedPairIdx = bar.idx;
      renderChart();
      showPairDetail(bar.idx);
      return;
    }
  }
});

// ── Show Detail for a Pair ──
function showPairDetail(idx) {
  const pair = consecutiveResults[idx];
  if (!pair) return;

  const section = document.getElementById("detail-section");
  section.classList.remove("hidden");

  document.getElementById("detail-title").textContent =
    `${pair.date_a} vs ${pair.date_b}`;

  // Build a meaningful summary including obstruction info
  let summary = `Between ${pair.date_a} and ${pair.date_b}, ${pair.change_pct}% of the marked wall area changed.`;

  if (pair.obstruction_b && pair.obstruction_b.obstructed_pct > 0) {
    summary += ` In the ${pair.date_b} image, ${pair.obstruction_b.visible_pct}% of the wall was visible (${pair.obstruction_b.obstructed_pct}% was obstructed by objects in front).`;
  }
  if (pair.obstruction_a && pair.obstruction_a.obstructed_pct > 0) {
    summary += ` In the ${pair.date_a} image, ${pair.obstruction_a.obstructed_pct}% was obstructed.`;
  }

  document.getElementById("detail-summary").textContent = summary;

  document.getElementById("detail-label-a").textContent = pair.date_a;
  document.getElementById("detail-label-b").textContent = pair.date_b;

  const panoA = panoramas.find((p) => p.pano_id === pair.pano_id_a);
  const panoB = panoramas.find((p) => p.pano_id === pair.pano_id_b);
  if (!panoA || !panoB) return;

  const anglesA = getAngles(panoA.pano_id);
  const anglesB = getAngles(panoB.pano_id);

  const urlA = thumbnailUrl(panoA.pano_id, anglesA.heading, anglesA.pitch, COMPARE_W, COMPARE_H);
  const urlB = thumbnailUrl(panoB.pano_id, anglesB.heading, anglesB.pitch, COMPARE_W, COMPARE_H);

  loadDetailCanvas("detail-canvas-a", urlA);
  loadDetailCanvas("detail-canvas-b", urlB);

  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function loadDetailCanvas(canvasId, url) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    // Draw the polygon mask outline on the detail images
    if (maskClosed && maskPolygon.length >= 3) {
      const pts = maskPolygon.map((p) => ({
        x: p.x * img.width,
        y: p.y * img.height,
      }));

      // Dim outside
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, img.width, img.height);
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fill("evenodd");
      ctx.restore();

      // Outline
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(74, 105, 189, 0.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };
  img.src = url;
}

// ── Results Summary ──
function renderResultsSummary() {
  const pairs = consecutiveResults;
  if (pairs.length === 0) return;

  const validPairs = pairs.filter((p) => p.change_pct !== null);
  if (validPairs.length === 0) return;

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

  // Note any significant obstructions
  const obstructed = validPairs.filter(
    (p) => p.obstruction_b && p.obstruction_b.obstructed_pct > 15
  );
  if (obstructed.length > 0) {
    summary += ` Note: ${obstructed.length} image(s) had significant obstructions (cars, trees, etc.) blocking part of the wall.`;
  }

  document.getElementById("results-summary").textContent = summary;
}

// ── Advanced: Single Comparison ──
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

  const body = {
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
    ref_pano_id: panoramas[refPanoIdx].pano_id,
  };

  if (maskClosed && maskPolygon.length >= 3) {
    body.mask_polygon = maskPolygon;
  }

  const resp = await fetch(`${SERVER}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await resp.json();
  hideLoading();
  return result;
}

async function showAdvancedDetail(pairIdx) {
  const result = await runSingleComparison(pairIdx);
  if (!result) return;

  const pair = consecutiveResults[pairIdx];

  document.getElementById("overlay-label-a").textContent = pair.date_a;
  document.getElementById("overlay-label-b").textContent = pair.date_b;

  loadImageToCanvas("canvas-a", `${SERVER}${result.overlay_a_url}`);
  loadImageToCanvas("canvas-b", `${SERVER}${result.overlay_b_url}`);
  loadImageToCanvas("canvas-diff", `${SERVER}${result.diff_map_url}`);
  document.getElementById("overlay-section").classList.remove("hidden");

  buildGridTable(result);
  document.getElementById("grid-section").classList.remove("hidden");

  buildChangedList(result);
  document.getElementById("changed-list-section").classList.remove("hidden");

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
      } else {
        td.style.background = "#0a0a15";
        td.style.opacity = "0.2";
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

// ── Re-analyze ──
document.getElementById("reanalyze-btn").addEventListener("click", async () => {
  await runConsecutiveComparisons();
  renderChart();
  renderResultsSummary();
  if (selectedPairIdx !== null) {
    await showAdvancedDetail(selectedPairIdx);
  }
});

// ── Navigation Buttons ──
document.getElementById("btn-to-step2").addEventListener("click", () => goToStep(2));
document.getElementById("btn-back-to-1").addEventListener("click", () => goToStep(1));

document.getElementById("btn-to-step3").addEventListener("click", () => {
  goToStep(3);
  loadMaskImage();
});

document.getElementById("btn-back-to-2").addEventListener("click", () => goToStep(2));

document.getElementById("btn-to-step4").addEventListener("click", async () => {
  goToStep(4);
  await runConsecutiveComparisons();
  renderChart();
  renderResultsSummary();

  if (consecutiveResults.length > 0) {
    selectedPairIdx = 0;
    renderChart();
    showPairDetail(0);
  }
});

document.getElementById("btn-back-to-3").addEventListener("click", () => goToStep(3));

// Advanced toggle
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
