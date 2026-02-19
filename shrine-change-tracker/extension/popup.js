const SERVER = "http://localhost:5000";

const statusBar = document.getElementById("status-bar");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const locationInfo = document.getElementById("location-info");
const noStreetview = document.getElementById("no-streetview");
const serverDown = document.getElementById("server-down");
const analyzeBtn = document.getElementById("analyze-btn");

let serverOk = false;
let parsedLocation = null;

// Parse Street View parameters from a Google Maps URL
function parseStreetViewUrl(url) {
  const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const headingMatch = url.match(/([\d.]+)h/);
  const tiltMatch = url.match(/([\d.]+)t/);
  const isSV = url.includes(",3a,");

  if (!coordMatch || !isSV) return null;

  const lat = parseFloat(coordMatch[1]);
  const lng = parseFloat(coordMatch[2]);
  const heading = headingMatch ? parseFloat(headingMatch[1]) : 0;
  const tilt = tiltMatch ? parseFloat(tiltMatch[1]) : 90;
  const pitch = -(90 - tilt); // negative = look down for the thumbnail endpoint

  return { lat, lng, heading, pitch };
}

// Check if Python server is running
async function checkServer() {
  try {
    const resp = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    return data.status === "ok";
  } catch {
    return false;
  }
}

// Get the current tab URL
async function getCurrentTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.url || "");
    });
  });
}

// Initialize the popup
async function init() {
  // Check server
  serverOk = await checkServer();

  if (serverOk) {
    statusBar.className = "status connected";
    statusText.textContent = "Server connected";
  } else {
    statusBar.className = "status disconnected";
    statusText.textContent = "Server offline";
    serverDown.classList.remove("hidden");
    return;
  }

  // Parse current tab URL
  const url = await getCurrentTabUrl();
  parsedLocation = parseStreetViewUrl(url);

  if (parsedLocation) {
    document.getElementById("lat-val").textContent = parsedLocation.lat.toFixed(7);
    document.getElementById("lng-val").textContent = parsedLocation.lng.toFixed(7);
    document.getElementById("heading-val").textContent = parsedLocation.heading.toFixed(2) + "°";
    document.getElementById("pitch-val").textContent = parsedLocation.pitch.toFixed(2) + "°";
    locationInfo.classList.remove("hidden");
    analyzeBtn.classList.remove("hidden");
  } else {
    noStreetview.classList.remove("hidden");
  }
}

// Launch analysis page when Analyze button is clicked
analyzeBtn.addEventListener("click", () => {
  const params = new URLSearchParams({
    lat: parsedLocation.lat,
    lng: parsedLocation.lng,
    heading: parsedLocation.heading,
    pitch: parsedLocation.pitch,
  });
  chrome.tabs.create({
    url: chrome.runtime.getURL(`analysis.html?${params.toString()}`),
  });
});

init();
