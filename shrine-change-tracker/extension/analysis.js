const SERVER = "http://localhost:5000";

// ── Parse URL parameters ──
const params = new URLSearchParams(window.location.search);
const LAT = parseFloat(params.get("lat"));
const LNG = parseFloat(params.get("lng"));
const HEADING = parseFloat(params.get("heading"));
const PITCH = parseFloat(params.get("pitch"));

// ── Display info bar ──
document.getElementById("info-lat").textContent = `Lat: ${LAT.toFixed(7)}`;
document.getElementById("info-lng").textContent = `Lng: ${LNG.toFixed(7)}`;
document.getElementById("info-heading").textContent = `Heading: ${HEADING.toFixed(2)}°`;
document.getElementById("info-pitch").textContent = `Pitch: ${PITCH.toFixed(2)}°`;

// ── State ──
let panoramas = [];
let selectedA = null; // index
let selectedB = null; // index
let comparisonResult = null;

// ── ROI State ──
let roi = null; // { x, y, w, h } in image pixel coordinates (800×400 space)
let roiDragging = false;
let roiStartX = 0;
let roiStartY = 0;
let roiImage = null;
let lastRoiPanoA = null;

// ── DOM refs ──
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const mainContent = document.getElementById("main-content");
const timeline = document.getElementById("timeline");
const panoCount = document.getElementById("pano-count");
const compareBtn = document.getElementById("compare-btn");
const cellSizeSlider = document.getElementById("cell-size");
const cellSizeVal = document.getElementById("cell-size-val");
const thresholdSlider = document.getElementById("threshold");
const thresholdVal = document.getElementById("threshold-val");

// ROI DOM refs
const roiCanvas = document.getElementById("roi-canvas");
const roiCtx = roiCanvas.getContext("2d");
const clearRoiBtn = document.getElementById("clear-roi-btn");
const roiStatusEl = document.getElementById("roi-status");

// ── Helpers ──
function thumbnailUrl(panoId, w = 160, h = 80) {
  return `${SERVER}/thumbnail?pano_id=${panoId}&heading=${HEADING}&pitch=${PITCH}&w=${w}&h=${h}`;
}

function showLoading(msg) {
  loadingText.textContent = msg;
  loading.classList.remove("hidden");
}

function hideLoading() {
  loading.classList.add("hidden");
}

// ── Slider updates ──
cellSizeSlider.addEventListener("input", () => {
  cellSizeVal.textContent = cellSizeSlider.value;
});
thresholdSlider.addEventListener("input", () => {
  thresholdVal.textContent = thresholdSlider.value;
});

// ── ROI Selection ──
function showRoiSection() {
  document.getElementById("roi-section").classList.remove("hidden");
  const panoId = panoramas[selectedA].pano_id;
  if (panoId !== lastRoiPanoA) {
    lastRoiPanoA = panoId;
    loadRoiImage();
  }
}

function loadRoiImage() {
  if (selectedA === null) return;
  const panoId = panoramas[selectedA].pano_id;
  const url = `${SERVER}/thumbnail?pano_id=${panoId}&heading=${HEADING}&pitch=${PITCH}&w=800&h=400`;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    roiImage = img;
    roiCanvas.width = img.width;
    roiCanvas.height = img.height;
    drawRoiCanvas();
  };
  img.src = url;
}

function drawRoiCanvas() {
  if (!roiImage) return;
  roiCtx.drawImage(roiImage, 0, 0);

  if (roi) {
    // Dim outside ROI
    roiCtx.fillStyle = "rgba(0, 0, 0, 0.6)";
    roiCtx.fillRect(0, 0, roiCanvas.width, roi.y);
    roiCtx.fillRect(0, roi.y + roi.h, roiCanvas.width, roiCanvas.height - roi.y - roi.h);
    roiCtx.fillRect(0, roi.y, roi.x, roi.h);
    roiCtx.fillRect(roi.x + roi.w, roi.y, roiCanvas.width - roi.x - roi.w, roi.h);

    // ROI border (dashed blue)
    roiCtx.strokeStyle = "#4a69bd";
    roiCtx.lineWidth = 2;
    roiCtx.setLineDash([6, 3]);
    roiCtx.strokeRect(roi.x, roi.y, roi.w, roi.h);
    roiCtx.setLineDash([]);

    // Corner handles
    const hs = 8;
    roiCtx.fillStyle = "#4a69bd";
    roiCtx.fillRect(roi.x - hs / 2, roi.y - hs / 2, hs, hs);
    roiCtx.fillRect(roi.x + roi.w - hs / 2, roi.y - hs / 2, hs, hs);
    roiCtx.fillRect(roi.x - hs / 2, roi.y + roi.h - hs / 2, hs, hs);
    roiCtx.fillRect(roi.x + roi.w - hs / 2, roi.y + roi.h - hs / 2, hs, hs);

    // Dimension label
    roiCtx.fillStyle = "rgba(74, 105, 189, 0.85)";
    roiCtx.fillRect(roi.x, roi.y - 22, 120, 20);
    roiCtx.fillStyle = "#fff";
    roiCtx.font = "12px monospace";
    roiCtx.fillText(`${roi.w} × ${roi.h} px`, roi.x + 4, roi.y - 7);
  }
}

function getCanvasCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

roiCanvas.addEventListener("mousedown", (e) => {
  const pos = getCanvasCoords(e, roiCanvas);
  roiStartX = pos.x;
  roiStartY = pos.y;
  roiDragging = true;
});

roiCanvas.addEventListener("mousemove", (e) => {
  if (!roiDragging) return;
  const pos = getCanvasCoords(e, roiCanvas);
  const clampedX = Math.max(0, Math.min(pos.x, roiCanvas.width));
  const clampedY = Math.max(0, Math.min(pos.y, roiCanvas.height));

  roi = {
    x: Math.round(Math.min(roiStartX, clampedX)),
    y: Math.round(Math.min(roiStartY, clampedY)),
    w: Math.round(Math.abs(clampedX - roiStartX)),
    h: Math.round(Math.abs(clampedY - roiStartY)),
  };

  drawRoiCanvas();
});

roiCanvas.addEventListener("mouseup", () => {
  if (!roiDragging) return;
  roiDragging = false;

  if (roi && roi.w > 10 && roi.h > 10) {
    updateRoiStatus();
    clearRoiBtn.classList.remove("hidden");
  } else {
    roi = null;
    updateRoiStatus();
  }
});

function updateRoiStatus() {
  if (roi) {
    roiStatusEl.textContent = `ROI: (${roi.x}, ${roi.y}) → (${roi.x + roi.w}, ${roi.y + roi.h})  |  ${roi.w} × ${roi.h} px`;
    roiStatusEl.style.color = "#4a69bd";
  } else {
    roiStatusEl.textContent = "No ROI selected — full image will be analyzed";
    roiStatusEl.style.color = "#666";
    clearRoiBtn.classList.add("hidden");
  }
}

function clearRoi() {
  roi = null;
  updateRoiStatus();
  drawRoiCanvas();
}

clearRoiBtn.addEventListener("click", clearRoi);

function isCellInRoi(cell) {
  if (!roi) return true;
  const cx = cell.x + cell.w / 2;
  const cy = cell.y + cell.h / 2;
  return cx >= roi.x && cx <= roi.x + roi.w && cy >= roi.y && cy <= roi.y + roi.h;
}

// ── Step 1: Search panoramas ──
async function searchPanoramas() {
  showLoading("Searching for panoramas...");
  const resp = await fetch(`${SERVER}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: LAT, lon: LNG }),
  });
  const data = await resp.json();
  panoramas = data.panoramas || [];
  return panoramas;
}

// ── Step 2: Build timeline ──
function buildTimeline() {
  panoCount.textContent = `${panoramas.length} dates`;
  timeline.innerHTML = "";

  panoramas.forEach((pano, idx) => {
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.dataset.index = idx;

    const img = document.createElement("img");
    img.src = thumbnailUrl(pano.pano_id);
    img.alt = pano.date;
    img.loading = "lazy";

    const dateLabel = document.createElement("div");
    dateLabel.className = "timeline-date";
    dateLabel.textContent = pano.date;

    item.appendChild(img);
    item.appendChild(dateLabel);
    item.addEventListener("click", () => onTimelineClick(idx));
    timeline.appendChild(item);
  });

  // Auto-select oldest and newest
  if (panoramas.length >= 2) {
    selectA(0);
    selectB(panoramas.length - 1);
  }
}

function clearSelections() {
  document.querySelectorAll(".timeline-item").forEach((el) => {
    el.classList.remove("selected-a", "selected-b");
  });
}

function selectA(idx) {
  selectedA = idx;
  refreshSelectionUI();
}

function selectB(idx) {
  selectedB = idx;
  refreshSelectionUI();
}

function refreshSelectionUI() {
  clearSelections();
  const items = document.querySelectorAll(".timeline-item");
  if (selectedA !== null && items[selectedA]) {
    items[selectedA].classList.add("selected-a");
  }
  if (selectedB !== null && items[selectedB]) {
    items[selectedB].classList.add("selected-b");
  }
  compareBtn.disabled = selectedA === null || selectedB === null || selectedA === selectedB;

  // Show ROI section when both dates are selected
  if (selectedA !== null && selectedB !== null && selectedA !== selectedB) {
    showRoiSection();
  }
}

function onTimelineClick(idx) {
  if (selectedA === null) {
    selectA(idx);
  } else if (selectedB === null && idx !== selectedA) {
    selectB(idx);
  } else {
    // Reset: new A, clear B
    selectedA = idx;
    selectedB = null;
    refreshSelectionUI();
  }
}

// ── Step 3: Run comparison ──
async function runComparison() {
  const cellSize = parseInt(cellSizeSlider.value);
  const threshold = parseInt(thresholdSlider.value);

  showLoading("Fetching and comparing images...");

  const resp = await fetch(`${SERVER}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pano_id_a: panoramas[selectedA].pano_id,
      pano_id_b: panoramas[selectedB].pano_id,
      heading: HEADING,
      pitch: PITCH,
      cell_size: cellSize,
      threshold: threshold,
      width: 800,
      height: 400,
    }),
  });

  comparisonResult = await resp.json();
  hideLoading();
  renderResults();
}

// ── Step 4: Render results ──
function renderResults() {
  const r = comparisonResult;

  // Filter cells by ROI
  const roiCells = r.cells.filter(isCellInRoi);
  const roiChangedCount = roiCells.filter((c) => c.changed).length;
  const roiTotal = roiCells.length;
  const roiPct = roiTotal > 0 ? ((roiChangedCount / roiTotal) * 100).toFixed(1) : "0.0";

  // Stats (ROI-filtered)
  document.getElementById("stat-total").textContent = roiTotal.toLocaleString();
  document.getElementById("stat-changed").textContent = roiChangedCount.toLocaleString();
  document.getElementById("stat-pct").textContent = roiPct + "%";
  document.getElementById("stat-grid").textContent = `${r.grid_cols} x ${r.grid_rows}`;
  document.getElementById("stats-section").classList.remove("hidden");

  // Labels
  document.getElementById("label-a").textContent = `Image A — ${panoramas[selectedA].date}`;
  document.getElementById("label-b").textContent = `Image B — ${panoramas[selectedB].date}`;

  // Load overlay images onto canvases (with ROI dimming)
  loadImageToCanvas("canvas-a", `${SERVER}${r.overlay_a_url}`, r);
  loadImageToCanvas("canvas-b", `${SERVER}${r.overlay_b_url}`, r);
  loadImageToCanvas("canvas-diff", `${SERVER}${r.diff_map_url}`, r);
  document.getElementById("comparison-section").classList.remove("hidden");
  document.getElementById("cell-detail").classList.remove("hidden");

  // Side-by-side detail view (raw images, cropped to ROI)
  loadDetailView();
  document.getElementById("detail-section").classList.remove("hidden");

  // Build grid table (with ROI graying)
  buildGridTable(r);
  document.getElementById("grid-section").classList.remove("hidden");

  // Build changed cells list (ROI-filtered)
  buildChangedList(r);
  document.getElementById("changed-list-section").classList.remove("hidden");
}

function loadImageToCanvas(canvasId, url, result) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    // Draw ROI overlay: dim area outside ROI
    if (roi) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, canvas.width, roi.y);
      ctx.fillRect(0, roi.y + roi.h, canvas.width, canvas.height - roi.y - roi.h);
      ctx.fillRect(0, roi.y, roi.x, roi.h);
      ctx.fillRect(roi.x + roi.w, roi.y, canvas.width - roi.x - roi.w, roi.h);

      ctx.strokeStyle = "#4a69bd";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
      ctx.setLineDash([]);
    }
  };
  img.src = url;

  // Hover handler
  canvas.onmousemove = (e) => {
    const pos = getCanvasCoords(e, canvas);
    const cellSize = parseInt(cellSizeSlider.value);
    const col = Math.floor(pos.x / cellSize);
    const row = Math.floor(pos.y / cellSize);
    const cell = result.cells.find((c) => c.row === row && c.col === col);
    if (cell) {
      updateCellDetail(cell);
    }
  };
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

  // Build a 2D lookup
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
        const inRoi = isCellInRoi(cell);
        if (!inRoi) {
          td.style.background = "#1a1a2e";
          td.style.opacity = "0.25";
        } else if (!cell.changed) {
          td.style.background = "#1a5c2a"; // green
        } else if (cell.diff < 25) {
          td.style.background = "#8a7a00"; // yellow
        } else {
          td.style.background = "#8a1a1a"; // red
        }
        td.title = `${cell.label}  Diff: ${cell.diff}${inRoi ? "" : "  (outside ROI)"}`;
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
    .filter((c) => c.changed && isCellInRoi(c))
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

// ── Side-by-Side Detail View ──
function loadDetailView() {
  const dateA = panoramas[selectedA].date;
  const dateB = panoramas[selectedB].date;
  document.getElementById("detail-label-a").textContent = `Image A — ${dateA}`;
  document.getElementById("detail-label-b").textContent = `Image B — ${dateB}`;

  const urlA = `${SERVER}/thumbnail?pano_id=${panoramas[selectedA].pano_id}&heading=${HEADING}&pitch=${PITCH}&w=800&h=400`;
  const urlB = `${SERVER}/thumbnail?pano_id=${panoramas[selectedB].pano_id}&heading=${HEADING}&pitch=${PITCH}&w=800&h=400`;

  loadDetailCanvas("detail-canvas-a", urlA);
  loadDetailCanvas("detail-canvas-b", urlB);
}

function loadDetailCanvas(canvasId, url) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (roi) {
      // Crop to ROI and scale up 2x for pixel detail
      const scale = 2;
      canvas.width = roi.w * scale;
      canvas.height = roi.h * scale;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        img,
        roi.x, roi.y, roi.w, roi.h,   // source rect
        0, 0, roi.w * scale, roi.h * scale  // dest rect (2x zoom)
      );
    } else {
      // No ROI: show full image at native resolution
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
    }
  };
  img.src = url;
}

// ── Compare button ──
compareBtn.addEventListener("click", runComparison);

// ── Initialize ──
async function init() {
  try {
    await searchPanoramas();

    if (panoramas.length === 0) {
      hideLoading();
      document.body.innerHTML =
        '<div style="padding:40px;text-align:center;color:#888;">' +
        "<h2>No dated panoramas found at this location.</h2>" +
        "<p>Try a different Street View location.</p></div>";
      return;
    }

    hideLoading();
    mainContent.classList.remove("hidden");
    buildTimeline();
  } catch (err) {
    hideLoading();
    document.body.innerHTML =
      '<div style="padding:40px;text-align:center;color:#ff4757;">' +
      "<h2>Error</h2>" +
      `<p>${err.message}</p>` +
      "<p>Make sure the Python server is running on localhost:5000</p></div>";
  }
}

init();
