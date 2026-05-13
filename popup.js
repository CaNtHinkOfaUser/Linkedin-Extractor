// LinkedIn Extractor — Popup Script v1.1
// Detects whether user is on a main profile or a /details/* sub-page
// and adapts the UI and extraction accordingly.

// ─────────────────────────────────────────────
// ELEMENT REFS
// ─────────────────────────────────────────────

const $modeBadge  = document.getElementById("modeBadge");
const $modeIcon   = document.getElementById("modeIcon");
const $modeLabel  = document.getElementById("modeLabel");
const $modeSub    = document.getElementById("modeSub");
const $chipsWrap  = document.getElementById("chipsWrap");
const $chipsGrid  = document.getElementById("chipsGrid");
const $tip        = document.getElementById("tip");
const $extractBtn = document.getElementById("extractBtn");
const $btnIcon    = document.getElementById("btnIcon");
const $btnText    = document.getElementById("btnText");
const $spinner    = document.getElementById("spinner");
const $previewBtn = document.getElementById("previewBtn");
const $copyBtn    = document.getElementById("copyBtn");
const $footerTip  = document.getElementById("footerTip");

let lastFormatted = "";
let currentMode   = "unknown"; // "main" | "detail" | "unknown"

// ─────────────────────────────────────────────
// SECTION LABELS FOR CHIP DISPLAY
// ─────────────────────────────────────────────

const SECTION_KEYS = [
  "experience", "education", "skills", "certifications",
  "projects", "volunteering", "languages", "honors",
  "publications", "courses", "recommendations",
];

// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────

function setLoading(yes) {
  $spinner.classList.toggle("visible", yes);
  $btnIcon.style.display = yes ? "none" : "inline";
  $extractBtn.disabled = yes;
  $btnText.textContent  = yes ? "EXTRACTING…" : (
    currentMode === "detail" ? "EXTRACT THIS SECTION" : "EXTRACT & DOWNLOAD"
  );
}

function flashSuccess() {
  $modeBadge.classList.add("flash");
  setTimeout(() => $modeBadge.classList.remove("flash"), 1000);
}

function renderChips(profile) {
  $chipsGrid.innerHTML = "";
  for (const key of SECTION_KEYS) {
    const data  = profile[key];
    const count = Array.isArray(data) ? data.length : (data ? 1 : 0);
    const chip  = document.createElement("div");
    chip.className = `chip${count === 0 ? " empty" : ""}`;
    chip.textContent = count > 0 ? `${key} (${count})` : key;
    $chipsGrid.appendChild(chip);
  }
  $chipsWrap.classList.add("visible");
}

// ─────────────────────────────────────────────
// FILE DOWNLOAD
// ─────────────────────────────────────────────

function downloadTxt(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function makeFilename(result) {
  const date = new Date().toISOString().slice(0, 10);

  if (result.mode === "detail") {
    // e.g. "certifications_2026-02-24.txt"
    return `${result.section}_${date}.txt`;
  }

  // main profile — use person's name
  const name = (result.profile?.header?.name || "linkedin-profile")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${name}_${date}.txt`;
}

// ─────────────────────────────────────────────
// PREVIEW MODAL
// ─────────────────────────────────────────────

function showPreview(text) {
  document.getElementById("previewModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "previewModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:flex;flex-direction:column;backdrop-filter:blur(4px)";

  const box = document.createElement("div");
  box.style.cssText = "background:#0a0a0f;border:1px solid #1e1e2e;border-radius:10px;margin:12px;display:flex;flex-direction:column;flex:1;overflow:hidden";

  const hdr = document.createElement("div");
  hdr.style.cssText = "padding:9px 13px;border-bottom:1px solid #1e1e2e;display:flex;align-items:center;justify-content:space-between;font-family:'Space Mono',monospace;font-size:10px;color:#6e6e8a";
  hdr.innerHTML = `<span>PREVIEW</span><button id="closeP" style="background:none;border:none;color:#6e6e8a;cursor:pointer;font-size:15px">✕</button>`;

  const pre = document.createElement("pre");
  pre.textContent = text;
  pre.style.cssText = "flex:1;overflow:auto;padding:11px 13px;font-family:'Space Mono',monospace;font-size:8.5px;color:#e8e8f0;line-height:1.6;white-space:pre-wrap;word-break:break-word";

  box.appendChild(hdr); box.appendChild(pre);
  modal.appendChild(box);
  document.body.appendChild(modal);

  document.getElementById("closeP").onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// ─────────────────────────────────────────────
// SEND MESSAGE TO CONTENT SCRIPT (with auto-inject)
// ─────────────────────────────────────────────

async function sendToContent(tabId, action) {
  // Always re-inject to make sure the latest script is running
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_) { /* already injected or CSP issue — proceed anyway */ }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ─────────────────────────────────────────────
// PAGE MODE DETECTION → update UI
// ─────────────────────────────────────────────

async function detectAndUpdateUI() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url   = tab?.url || "";

  // Not on LinkedIn at all
  if (!url.includes("linkedin.com/in/")) {
    $modeBadge.className = "mode-badge mode-unknown";
    $modeIcon.textContent  = "🔗";
    $modeLabel.textContent = "Not a LinkedIn Profile";
    $modeSub.textContent   = "Navigate to linkedin.com/in/someone";
    $extractBtn.disabled   = true;
    $tip.classList.remove("visible");
    $footerTip.innerHTML   = `Go to a <span>linkedin.com/in/</span> page`;
    currentMode = "unknown";
    return;
  }

  // Ask content script for the mode (it knows the exact URL structure)
  let modeData = { mode: "unknown" };
  try {
    const res = await sendToContent(tab.id, "detectMode");
    if (res?.success) modeData = res.data;
  } catch (_) {}

  currentMode = modeData.mode;

  if (modeData.mode === "main") {
    $modeBadge.className   = "mode-badge mode-main";
    $modeIcon.textContent  = "👤";
    $modeLabel.textContent = "Full Profile Page";
    $modeSub.textContent   = "Will extract all sections visible on the page";
    $extractBtn.disabled   = false;
    $extractBtn.className  = "extract-btn";
    $btnText.textContent   = "EXTRACT & DOWNLOAD";
    $tip.classList.add("visible");
    $footerTip.innerHTML   = `Tip: scroll the page + click <span>Show all</span> first`;

  } else if (modeData.mode === "detail") {
    const sectionName = modeData.section.charAt(0).toUpperCase() + modeData.section.slice(1);
    $modeBadge.className   = "mode-badge mode-detail";
    $modeIcon.textContent  = "📋";
    $modeLabel.textContent = `Detail Page — ${sectionName}`;
    $modeSub.textContent   = "Will extract every entry on this page";
    $extractBtn.disabled   = false;
    $extractBtn.className  = "extract-btn detail-mode";
    $btnText.textContent   = "EXTRACT THIS SECTION";
    $tip.classList.add("visible");
    $footerTip.innerHTML   = `Tip: scroll to bottom so all <span>${sectionName}</span> entries load`;

  } else {
    $modeBadge.className   = "mode-badge mode-unknown";
    $modeIcon.textContent  = "❓";
    $modeLabel.textContent = "Unknown LinkedIn Page";
    $modeSub.textContent   = "Go to a profile or a /details/ sub-page";
    $extractBtn.disabled   = true;
    $tip.classList.remove("visible");
  }
}

// ─────────────────────────────────────────────
// EXTRACT FLOW
// ─────────────────────────────────────────────

async function doExtract() {
  setLoading(true);
  $modeLabel.textContent = "Extracting…";
  $modeSub.textContent   = "Reading the page, please wait";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res   = await sendToContent(tab.id, "extract");

    if (!res?.success) throw new Error(res?.error || "Unknown error");

    const result = res.data;
    lastFormatted = result.formatted;

    // Download the file
    downloadTxt(result.formatted, makeFilename(result));

    // Update UI
    if (result.mode === "main") {
      const name = result.profile?.header?.name || "Profile";
      $modeLabel.textContent = `✓ Extracted: ${name}`;
      $modeSub.textContent   = "File downloaded successfully";
      renderChips(result.profile);
      // Count non-empty sections
      const filled = SECTION_KEYS.filter((k) => {
        const d = result.profile[k];
        return Array.isArray(d) ? d.length > 0 : !!d;
      }).length;
      $footerTip.innerHTML = `<span>${filled}</span> sections found`;

    } else if (result.mode === "detail") {
      const sectionName = result.section.charAt(0).toUpperCase() + result.section.slice(1);
      $modeLabel.textContent = `✓ ${sectionName}: ${result.count} entries`;
      $modeSub.textContent   = "File downloaded successfully";
      $footerTip.innerHTML   = `<span>${result.count}</span> entries extracted`;
    }

    flashSuccess();
    $btnIcon.textContent = "✓";
    $btnText.textContent = "EXTRACT AGAIN";
    $previewBtn.classList.add("visible");
    $copyBtn.classList.add("visible");

  } catch (err) {
    console.error("[LinkedIn Extractor]", err);
    $modeBadge.className   = "mode-badge mode-unknown";
    $modeLabel.textContent = "Extraction Failed";
    $modeSub.textContent   = err.message || "Reload the page and try again";
    $btnIcon.textContent   = "⬇";
    $btnText.textContent   = "RETRY";
  } finally {
    setLoading(false);
  }
}

// ─────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────

$extractBtn.addEventListener("click", doExtract);

$previewBtn.addEventListener("click", () => {
  if (lastFormatted) showPreview(lastFormatted);
});

$copyBtn.addEventListener("click", async () => {
  if (!lastFormatted) return;
  await navigator.clipboard.writeText(lastFormatted);
  $copyBtn.innerHTML = "✓ Copied!";
  setTimeout(() => { $copyBtn.innerHTML = "📋 Copy"; }, 2000);
});

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

detectAndUpdateUI();
