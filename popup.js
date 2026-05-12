// LinkedIn Extractor — Popup Script v1.2
// Detects whether user is on a main profile or a /details/* sub-page
// and adapts the UI and extraction accordingly.
// Changes from v1.1:
//   - No file download; extracted text shown in inline results panel
//   - Fixed: setLoading(false) in finally no longer clobbers "RETRY" text
//   - Fixed: null guard on modeData.section before .charAt()
//   - Fixed: null guard on tab before accessing tab.id
//   - Fixed: sendToContent delay to let re-injected script register its listener
//   - Fixed: textContent used instead of innerHTML for copy button reset

// ─────────────────────────────────────────────
// ELEMENT REFS
// ─────────────────────────────────────────────

const $modeBadge    = document.getElementById("modeBadge");
const $modeIcon     = document.getElementById("modeIcon");
const $modeLabel    = document.getElementById("modeLabel");
const $modeSub      = document.getElementById("modeSub");
const $chipsWrap    = document.getElementById("chipsWrap");
const $chipsGrid    = document.getElementById("chipsGrid");
const $tip          = document.getElementById("tip");
const $extractBtn   = document.getElementById("extractBtn");
const $btnIcon      = document.getElementById("btnIcon");
const $btnText      = document.getElementById("btnText");
const $spinner      = document.getElementById("spinner");
const $resultsPanel = document.getElementById("resultsPanel");
const $resultsPre   = document.getElementById("resultsPre");
const $copyAllBtn   = document.getElementById("copyAllBtn");
const $clearBtn     = document.getElementById("clearBtn");
const $footerTip    = document.getElementById("footerTip");

let lastFormatted  = "";
let currentMode    = "unknown"; // "main" | "detail" | "unknown"
let extractionDone = false;     // true once we have a successful result

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

// FIX: extractionDone flag ensures setLoading(false) never overwrites
// the "RETRY" label set in the catch block.
function setLoading(yes) {
  $spinner.classList.toggle("visible", yes);
  $btnIcon.style.display = yes ? "none" : "inline";
  $extractBtn.disabled = yes;
  if (yes) {
    $btnText.textContent = "EXTRACTING…";
  } else if (!extractionDone) {
    // Only reset to default label when we haven't completed an extraction yet
    $btnText.textContent = currentMode === "detail" ? "EXTRACT THIS SECTION" : "EXTRACT";
  }
  // If extractionDone is true, the button already says "EXTRACT AGAIN" or "RETRY" — leave it.
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

function showResults(text) {
  $resultsPre.textContent = text;
  $resultsPanel.classList.add("visible");
  // Scroll the pre to top
  $resultsPre.scrollTop = 0;
}

function hideResults() {
  $resultsPanel.classList.remove("visible");
  $resultsPre.textContent = "";
  $chipsWrap.classList.remove("visible");
  lastFormatted = "";
  extractionDone = false;
}

// ─────────────────────────────────────────────
// SEND MESSAGE TO CONTENT SCRIPT (with auto-inject)
// ─────────────────────────────────────────────

async function sendToContent(tabId, action) {
  // Re-inject so we always have the latest script version running.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_) {
    // Already injected or CSP issue — proceed anyway.
  }

  // FIX: Small delay so the freshly injected script has time to register
  // its chrome.runtime.onMessage listener before we send the message.
  await new Promise((r) => setTimeout(r, 80));

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
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
    $modeBadge.className   = "mode-badge mode-unknown";
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
    // FIX: guard against tab being undefined
    if (tab?.id != null) {
      const res = await sendToContent(tab.id, "detectMode");
      if (res?.success) modeData = res.data;
    }
  } catch (_) {}

  currentMode = modeData.mode;

  if (modeData.mode === "main") {
    $modeBadge.className   = "mode-badge mode-main";
    $modeIcon.textContent  = "👤";
    $modeLabel.textContent = "Full Profile Page";
    $modeSub.textContent   = "Will extract all sections visible on the page";
    $extractBtn.disabled   = false;
    $extractBtn.className  = "extract-btn";
    $btnText.textContent   = "EXTRACT";
    $tip.classList.add("visible");
    $footerTip.innerHTML   = `Tip: scroll the page + click <span>Show all</span> first`;

  } else if (modeData.mode === "detail") {
    // FIX: guard modeData.section before calling .charAt()
    const rawSection  = modeData.section || "section";
    const sectionName = rawSection.charAt(0).toUpperCase() + rawSection.slice(1);
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
  extractionDone = false;
  setLoading(true);
  $modeLabel.textContent = "Extracting…";
  $modeSub.textContent   = "Reading the page, please wait";
  hideResults();

  try {
    // FIX: guard against tab being undefined/null
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Could not access the active tab.");

    const res = await sendToContent(tab.id, "extract");

    if (!res?.success) throw new Error(res?.error || "Unknown error from content script");

    const result  = res.data;
    lastFormatted = result.formatted || "";

    // Show extracted text in the results panel
    showResults(lastFormatted);

    // Update status UI
    if (result.mode === "main") {
      const name = result.profile?.header?.name || "Profile";
      $modeLabel.textContent = `✓ Extracted: ${name}`;
      $modeSub.textContent   = "Ready to copy";
      renderChips(result.profile);
      const filled = SECTION_KEYS.filter((k) => {
        const d = result.profile[k];
        return Array.isArray(d) ? d.length > 0 : !!d;
      }).length;
      $footerTip.innerHTML = `<span>${filled}</span> sections found`;

    } else if (result.mode === "detail") {
      const rawSection  = result.section || "section";
      const sectionName = rawSection.charAt(0).toUpperCase() + rawSection.slice(1);
      $modeLabel.textContent = `✓ ${sectionName}: ${result.count} entries`;
      $modeSub.textContent   = "Ready to copy";
      $footerTip.innerHTML   = `<span>${result.count}</span> entries extracted`;
    }

    flashSuccess();
    extractionDone = true;
    $btnIcon.textContent = "↺";
    $btnText.textContent = "EXTRACT AGAIN";

  } catch (err) {
    console.error("[LinkedIn Extractor]", err);
    $modeBadge.className   = "mode-badge mode-unknown";
    $modeLabel.textContent = "Extraction Failed";
    $modeSub.textContent   = err.message || "Reload the page and try again";
    // FIX: set extractionDone to true so setLoading(false) won't clobber these labels
    extractionDone = true;
    $btnIcon.textContent = "⬇";
    $btnText.textContent = "RETRY";
  } finally {
    setLoading(false);
  }
}

// ─────────────────────────────────────────────
// COPY ALL
// ─────────────────────────────────────────────

$copyAllBtn.addEventListener("click", async () => {
  if (!lastFormatted) return;
  try {
    await navigator.clipboard.writeText(lastFormatted);
    $copyAllBtn.textContent = "✓ Copied!";
    $copyAllBtn.classList.add("copied");
    setTimeout(() => {
      // FIX: use textContent, not innerHTML
      $copyAllBtn.textContent = "📋 Copy All";
      $copyAllBtn.classList.remove("copied");
    }, 2000);
  } catch (e) {
    $copyAllBtn.textContent = "⚠ Failed";
    setTimeout(() => { $copyAllBtn.textContent = "📋 Copy All"; }, 2000);
  }
});

// ─────────────────────────────────────────────
// CLEAR
// ─────────────────────────────────────────────

$clearBtn.addEventListener("click", () => {
  hideResults();
  // Reset status back to mode detection
  detectAndUpdateUI();
});

// ─────────────────────────────────────────────
// EXTRACT BUTTON
// ─────────────────────────────────────────────

$extractBtn.addEventListener("click", doExtract);

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

detectAndUpdateUI();
