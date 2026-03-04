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
      const resp = await fetch(`${SERVER}/analyze-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pano_id: p.pano_id,
          heading: angles.heading,
          pitch: angles.pitch,
        }),
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

    let summary =
      `${ca.date}: ${ca.total || 0} items. ` +
      `${cb.date}: ${cb.total || 0} items.`;
    if (changes.length) summary += ` Changes: ${changes.join(", ")}.`;
    else summary += " No changes detected.";

    pairResults.push({
      date_a: ca.date,
      date_b: cb.date,
      counts_a: { plaques: ca.plaques || 0, flowers: ca.flowers || 0, candles: ca.candles || 0, pictures: ca.pictures || 0, other: ca.other || 0, total: ca.total || 0 },
      counts_b: { plaques: cb.plaques || 0, flowers: cb.flowers || 0, candles: cb.candles || 0, pictures: cb.pictures || 0, other: cb.other || 0, total: cb.total || 0 },
      delta,
      image_a_url: ca.image_url || null,
      image_b_url: cb.image_url || null,
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

  let text = `Tracked items from ${first.date} to ${last.date} (${perImageData.length} time periods). `;
  text += `${first.total || 0} items in ${first.date}, ${last.total || 0} in ${last.date}.`;

  let totalAdded = 0, totalRemoved = 0;
  for (const pair of pairResults) {
    for (const k of ["plaques", "flowers", "candles", "pictures", "other"]) {
      const d = (pair.delta && pair.delta[k]) || 0;
      if (d > 0) totalAdded += d;
      else if (d < 0) totalRemoved += Math.abs(d);
    }
  }
  if (totalAdded > 0 || totalRemoved > 0) {
    text += ` Net changes: +${totalAdded} added, -${totalRemoved} removed.`;
  }

  document.getElementById("results-summary").textContent = text;
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

  const maxItems = Math.max(5, ...perImageData.map((d) => d.total || 0));

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

    ctx.fillStyle = d.error ? "#555" : "#4a69bd";
    ctx.fillRect(x, y, barW, barH);
    canvas._bars.push({ x, w: barW, idx: i });

    ctx.fillStyle = "#ccc";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${total}`, x + barW / 2, y - 6);

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
  ctx.fillText("Items Detected", 0, 0);
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
    if (!deltaBadges) deltaBadges = `<span class="count-badge delta-same">No changes</span>`;

    function countsHTML(counts) {
      return ["plaques", "flowers", "candles", "pictures", "other"]
        .filter((k) => (counts[k] || 0) > 0)
        .map((k) => `<span class="cat-count">${counts[k]} ${k}</span>`)
        .join("") || `<span class="cat-count">0 items</span>`;
    }

    const imgA = pair.image_a_url
      ? `<img src="${SERVER}${pair.image_a_url}" alt="${pair.date_a}">`
      : "";
    const imgB = pair.image_b_url
      ? `<img src="${SERVER}${pair.image_b_url}" alt="${pair.date_b}">`
      : "";

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
