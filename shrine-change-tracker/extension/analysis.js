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

  // Stats
  document.getElementById("stat-total").textContent = r.total_cells.toLocaleString();
  document.getElementById("stat-changed").textContent = r.changed_cells.toLocaleString();
  document.getElementById("stat-pct").textContent = r.change_pct + "%";
  document.getElementById("stat-grid").textContent = `${r.grid_cols} x ${r.grid_rows}`;
  document.getElementById("stats-section").classList.remove("hidden");

  // Labels
  document.getElementById("label-a").textContent = `Image A — ${panoramas[selectedA].date}`;
  document.getElementById("label-b").textContent = `Image B — ${panoramas[selectedB].date}`;

  // Load overlay images onto canvases
  loadImageToCanvas("canvas-a", `${SERVER}${r.overlay_a_url}`, r);
  loadImageToCanvas("canvas-b", `${SERVER}${r.overlay_b_url}`, r);
  loadImageToCanvas("canvas-diff", `${SERVER}${r.diff_map_url}`, r);
  document.getElementById("comparison-section").classList.remove("hidden");
  document.getElementById("cell-detail").classList.remove("hidden");

  // Build grid table
  buildGridTable(r);
  document.getElementById("grid-section").classList.remove("hidden");

  // Build changed cells list
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
  };
  img.src = url;

  // Hover handler
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const cellSize = parseInt(cellSizeSlider.value);
    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);
    const cell = result.cells.find((c) => c.row === row && c.col === col);
    if (cell) {
      updateCellDetail(cell);
    }
  });
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
        if (!cell.changed) {
          td.style.background = "#1a5c2a"; // green
        } else if (cell.diff < 25) {
          td.style.background = "#8a7a00"; // yellow
        } else {
          td.style.background = "#8a1a1a"; // red
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
