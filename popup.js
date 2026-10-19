// LinkedIn Extractor — Popup Script v3.0
// The extraction itself runs in content.js on the LinkedIn tab, so it keeps
// going if this popup closes. The popup starts it, mirrors its progress
// messages, and offers the last result (kept in chrome.storage.local) for
// download through background.js.

// ─────────────────────────────────────────────
// ELEMENT REFS
// ─────────────────────────────────────────────
const $modeBadge     = document.getElementById("modeBadge");
const $modeIcon      = document.getElementById("modeIcon");
const $modeLabel     = document.getElementById("modeLabel");
const $modeSub       = document.getElementById("modeSub");
const $progress      = document.getElementById("progress");
const $progressFill  = document.getElementById("progressFill");
const $progressLabel = document.getElementById("progressLabel");
const $chipsWrap     = document.getElementById("chipsWrap");
const $chipsLabel    = document.getElementById("chipsLabel");
const $chipsGrid     = document.getElementById("chipsGrid");
const $warn          = document.getElementById("warn");
const $tip           = document.getElementById("tip");
const $extractBtn    = document.getElementById("extractBtn");
const $btnIcon       = document.getElementById("btnIcon");
const $btnText       = document.getElementById("btnText");
const $spinner       = document.getElementById("spinner");
const $dlRow         = document.getElementById("dlRow");
const $dlTxtBtn      = document.getElementById("dlTxtBtn");
const $dlJsonBtn     = document.getElementById("dlJsonBtn");
const $previewBtn    = document.getElementById("previewBtn");
const $resultsPanel  = document.getElementById("resultsPanel");
const $resultsPre    = document.getElementById("resultsPre");
const $copyAllBtn    = document.getElementById("copyAllBtn");
const $clearBtn      = document.getElementById("clearBtn");
const $footerTip     = document.getElementById("footerTip");

const PROFILE_URL_RX = /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/;

const SECTION_LABELS = {
  experience: "experience", education: "education", certifications: "certifications",
  projects: "projects", volunteering: "volunteering", skills: "skills", honors: "honors",
  courses: "courses", testScores: "test scores", languages: "languages",
  publications: "publications", patents: "patents", organizations: "organizations",
  recommendations: "recommendations", featured: "featured", interests: "interests", causes: "causes",
};

let activeTab = null;
let last = null;      // lastExtract record from storage
let running = false;

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────
function setBadge(kind, icon, label, sub) {
  $modeBadge.className   = `mode-badge mode-${kind}`;
  $modeIcon.textContent  = icon;
  $modeLabel.textContent = label;
  $modeSub.textContent   = sub;
}

function setFooter(prefix, strong, suffix = "") {
  $footerTip.replaceChildren(document.createTextNode(prefix));
  const s = document.createElement("span");
  s.textContent = strong;
  $footerTip.append(s, document.createTextNode(suffix));
}

function setRunning(yes) {
  running = yes;
  $spinner.classList.toggle("visible", yes);
  $btnIcon.style.display = yes ? "none" : "inline";
  $extractBtn.disabled   = yes || !activeTab || !PROFILE_URL_RX.test(activeTab.url || "");
  $btnText.textContent   = yes ? "EXTRACTING…" : last ? "EXTRACT AGAIN" : "EXTRACT FULL PROFILE";
  $progress.classList.toggle("visible", yes);
  if (yes) $tip.classList.add("visible");
}

function showProgress({ label, frac }) {
  if (!running) setRunning(true);
  if (frac != null) $progressFill.style.width = `${Math.round(frac * 100)}%`;
  if (label) $progressLabel.textContent = label;
}

function flashSuccess() {
  $modeBadge.classList.add("flash");
  setTimeout(() => $modeBadge.classList.remove("flash"), 1000);
}

function renderLast() {
  if (!last) {
    $chipsWrap.classList.remove("visible");
    $dlRow.classList.remove("visible");
    $warn.classList.remove("visible");
    return;
  }
  $chipsGrid.replaceChildren();
  for (const [key, count] of Object.entries(last.counts || {})) {
    const chip = document.createElement("div");
    chip.className   = `chip${count === 0 ? " empty" : ""}`;
    chip.textContent = `${SECTION_LABELS[key] || key} (${count})`;
    $chipsGrid.appendChild(chip);
  }
  const when = new Date(last.extractedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  $chipsLabel.textContent = `Last extract · ${last.name || "profile"} · ${when}`;
  $chipsWrap.classList.add("visible");
  $dlRow.classList.add("visible");

  const warnings = last.warnings || [];
  $warn.textContent = warnings.length ? `⚠ ${warnings.join("  ·  ")}` : "";
  $warn.classList.toggle("visible", warnings.length > 0);
}

async function loadLast() {
  const { lastExtract } = await chrome.storage.local.get("lastExtract");
  last = lastExtract || null;
  renderLast();
}

// ─────────────────────────────────────────────
// MESSAGING
// ─────────────────────────────────────────────
// Sends a message to the content script. If no listener is registered yet
// (the tab was open before the extension loaded, or LinkedIn navigated to the
// profile client-side), inject the script once and retry.
async function sendToContent(tabId, action) {
  const send = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });

  try {
    return await send();
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise(r => setTimeout(r, 150));
      return await send();
    } catch (err) {
      throw new Error("Could not reach the page. Try reloading the LinkedIn tab.");
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.type || !sender.tab || sender.tab.id !== activeTab?.id) return;
  if (msg.type === "li-progress") {
    showProgress(msg);
  } else if (msg.type === "li-done") {
    setRunning(false);
    loadLast().then(() => {
      setRunning(false);
      setBadge("detail", "✓", `Extracted: ${msg.name || "profile"}`, "The .txt is downloading — JSON below");
      const total = Object.values(msg.counts || {}).reduce((a, b) => a + b, 0);
      setFooter("", String(total), " entries across all sections");
      flashSuccess();
    });
  } else if (msg.type === "li-error") {
    setRunning(false);
    setBadge("unknown", "⚠", msg.error === "Cancelled" ? "Extraction cancelled" : "Extraction failed", msg.error || "Reload the page and try again");
  }
});

async function download(format) {
  const res = await chrome.runtime.sendMessage({ action: "download", format });
  if (!res?.success) throw new Error(res?.error || "Download failed");
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await loadLast();
  const url = activeTab?.url || "";

  if (!PROFILE_URL_RX.test(url)) {
    setBadge("unknown", "🔗", "Not a LinkedIn Profile", "Navigate to linkedin.com/in/someone");
    setFooter("Go to a ", "linkedin.com/in/", " page");
    setRunning(false);
    return;
  }

  const name = (activeTab.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  setBadge("main", "👤", name || "LinkedIn Profile", "Extracts every section, including all skills");
  setFooter("Saves as ", ".txt", " + .json");
  $tip.classList.add("visible");
  setRunning(false);

  try {
    const res = await sendToContent(activeTab.id, "status");
    if (res?.data?.running) showProgress(res.data.progress || { label: "Extracting…" });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────
$extractBtn.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  $resultsPanel.classList.remove("visible");
  showProgress({ label: "Starting…", frac: 0 });
  setBadge("main", "⏳", "Extracting…", "Watch the overlay on the LinkedIn tab");
  try {
    const res = await sendToContent(activeTab.id, "extractAll");
    if (!res?.success) throw new Error(res?.error || "Could not start");
  } catch (err) {
    setRunning(false);
    setBadge("unknown", "⚠", "Extraction failed", err.message);
  }
});

for (const [btn, format] of [[$dlTxtBtn, "txt"], [$dlJsonBtn, "json"]]) {
  btn.addEventListener("click", async () => {
    const label = btn.textContent;
    try {
      await download(format);
      btn.textContent = "✓ Saved";
    } catch (e) {
      btn.textContent = "⚠ Failed";
      console.error("[LinkedIn Extractor]", e);
    }
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
}

$previewBtn.addEventListener("click", () => {
  if (!last?.txt) return;
  $resultsPre.textContent = last.txt;
  $resultsPanel.classList.add("visible");
  $resultsPre.scrollTop = 0;
});

$copyAllBtn.addEventListener("click", async () => {
  if (!last?.txt) return;
  try {
    await navigator.clipboard.writeText(last.txt);
    $copyAllBtn.textContent = "✓ Copied!";
    $copyAllBtn.classList.add("copied");
  } catch (e) {
    $copyAllBtn.textContent = "⚠ Failed";
  }
  setTimeout(() => {
    $copyAllBtn.textContent = "📋 Copy All";
    $copyAllBtn.classList.remove("copied");
  }, 2000);
});

$clearBtn.addEventListener("click", () => {
  $resultsPanel.classList.remove("visible");
  $resultsPre.textContent = "";
});

init();
