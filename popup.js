// LinkedIn Extractor — Popup Script v3.1
// The extraction itself runs in content.js on the LinkedIn tab, so it keeps
// going if this popup closes. The popup picks the sections, starts the run,
// mirrors its progress messages, and offers the last result (kept in
// chrome.storage.local) to download (via background.js) or copy.

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
const $choose        = document.getElementById("choose");
const $chooseGrid    = document.getElementById("chooseGrid");
const $selAll        = document.getElementById("selAll");
const $selNone       = document.getElementById("selNone");
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
const $copyBtn       = document.getElementById("copyBtn");
const $previewBtn    = document.getElementById("previewBtn");
const $resultsPanel  = document.getElementById("resultsPanel");
const $resultsPre    = document.getElementById("resultsPre");
const $copyAllBtn    = document.getElementById("copyAllBtn");
const $clearBtn      = document.getElementById("clearBtn");
const $footerTip     = document.getElementById("footerTip");

const PROFILE_URL_RX = /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/;

// Keys match content.js's ALL_KEYS.
const OPTIONS = [
  ["header", "Personal info"], ["contact", "Contact info"],
  ["about", "About"], ["experience", "Experience"],
  ["education", "Education"], ["skills", "Skills"],
  ["certifications", "Certifications"], ["projects", "Projects"],
  ["volunteering", "Volunteering"], ["honors", "Honors & awards"],
  ["courses", "Courses"], ["testScores", "Test scores"],
  ["languages", "Languages"], ["publications", "Publications"],
  ["patents", "Patents"], ["organizations", "Organizations"],
  ["recommendations", "Recommendations"], ["featured", "Featured"],
  ["interests", "Interests"], ["causes", "Causes"],
];
const LABEL_OF = Object.fromEntries(OPTIONS);

let activeTab = null;
let last = null;      // lastExtract record from storage
let running = false;
let choices = { sections: OPTIONS.map(([k]) => k), skillCategories: true };

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

function onProfile() {
  return !!activeTab && PROFILE_URL_RX.test(activeTab.url || "");
}

function extractLabel() {
  const n = choices.sections.length;
  if (!n) return "PICK A SECTION";
  return n === OPTIONS.length ? "EXTRACT ALL SECTIONS" : `EXTRACT ${n} SECTION${n === 1 ? "" : "S"}`;
}

function setRunning(yes) {
  running = yes;
  $spinner.classList.toggle("visible", yes);
  $btnIcon.style.display = yes ? "none" : "inline";
  $extractBtn.disabled   = yes || !onProfile() || !choices.sections.length;
  $btnText.textContent   = yes ? "EXTRACTING…" : extractLabel();
  $progress.classList.toggle("visible", yes);
  $choose.classList.toggle("disabled", yes);
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

// ─────────────────────────────────────────────
// SECTION PICKER
// ─────────────────────────────────────────────
function renderChooser() {
  $chooseGrid.replaceChildren();
  const box = (id, label, checked, onChange, cls = "opt") => {
    const wrap = document.createElement("label");
    wrap.className = cls;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `opt-${id}`;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    wrap.append(input, document.createTextNode(label));
    $chooseGrid.appendChild(wrap);
    return input;
  };
  const picked = new Set(choices.sections);
  for (const [key, label] of OPTIONS) {
    box(key, label, picked.has(key), on => {
      choices.sections = OPTIONS.map(([k]) => k).filter(k => (k === key ? on : choices.sections.includes(k)));
      saveChoices();
      renderChooser();
    });
  }
  const cat = box("skillCategories", "Tag each skill's category (slower)", choices.skillCategories, on => {
    choices.skillCategories = on;
    saveChoices();
  }, "opt sub");
  cat.disabled = !picked.has("skills");
  setRunning(running);
}

function saveChoices() {
  chrome.storage.local.set({ choices }).catch(() => {});
}

async function loadChoices() {
  const { choices: saved } = await chrome.storage.local.get("choices");
  if (saved && Array.isArray(saved.sections)) {
    choices = {
      sections: OPTIONS.map(([k]) => k).filter(k => saved.sections.includes(k)),
      skillCategories: saved.skillCategories !== false,
    };
  }
}

$selAll.addEventListener("click", () => { choices.sections = OPTIONS.map(([k]) => k); saveChoices(); renderChooser(); });
$selNone.addEventListener("click", () => { choices.sections = []; saveChoices(); renderChooser(); });

// ─────────────────────────────────────────────
// LAST RESULT
// ─────────────────────────────────────────────
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
    chip.textContent = `${(LABEL_OF[key] || key).toLowerCase()} (${count})`;
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
async function sendToContent(tabId, message) {
  const send = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, res => {
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
    loadLast().then(() => {
      setRunning(false);
      setBadge("detail", "✓", `Extracted: ${msg.name || "profile"}`, "Download or copy it below");
      const total = Object.values(msg.counts || {}).reduce((a, b) => a + b, 0);
      setFooter("", String(total), " entries extracted");
      flashSuccess();
    });
  } else if (msg.type === "li-error") {
    setRunning(false);
    setBadge("unknown", "⚠", msg.error === "Cancelled" ? "Extraction cancelled" : "Extraction failed", msg.error || "Reload the page and try again");
  }
});

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([loadLast(), loadChoices()]);
  renderChooser();

  if (!onProfile()) {
    setBadge("unknown", "🔗", "Not a LinkedIn Profile", "Navigate to linkedin.com/in/someone");
    setFooter("Go to a ", "linkedin.com/in/", " page");
    setRunning(false);
    return;
  }

  const name = (activeTab.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  setBadge("main", "👤", name || "LinkedIn Profile", "Pick sections below, then extract");
  setFooter("Saves as ", ".txt", " when you click Download");
  $tip.classList.add("visible");
  setRunning(false);

  try {
    const res = await sendToContent(activeTab.id, { action: "status" });
    if (res?.data?.running) showProgress(res.data.progress || { label: "Extracting…" });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────
$extractBtn.addEventListener("click", async () => {
  if (!activeTab?.id || !choices.sections.length) return;
  $resultsPanel.classList.remove("visible");
  showProgress({ label: "Starting…", frac: 0 });
  setBadge("main", "⏳", "Extracting…", "Keep the LinkedIn tab in front");
  try {
    const res = await sendToContent(activeTab.id, { action: "extractAll", options: choices });
    if (!res?.success) throw new Error(res?.error || "Could not start");
  } catch (err) {
    setRunning(false);
    setBadge("unknown", "⚠", "Extraction failed", err.message);
  }
});

$dlTxtBtn.addEventListener("click", async () => {
  const label = $dlTxtBtn.textContent;
  try {
    const res = await chrome.runtime.sendMessage({ action: "download" });
    if (!res?.success) throw new Error(res?.error || "Download failed");
    $dlTxtBtn.textContent = "✓ Saved";
  } catch (e) {
    $dlTxtBtn.textContent = "⚠ Failed";
    console.error("[LinkedIn Extractor]", e);
  }
  setTimeout(() => { $dlTxtBtn.textContent = label; }, 1800);
});

async function copyText(btn, idle) {
  if (!last?.txt) return;
  try {
    await navigator.clipboard.writeText(last.txt);
    btn.textContent = "✓ Copied!";
    btn.classList.add("copied");
  } catch (e) {
    btn.textContent = "⚠ Failed";
  }
  setTimeout(() => {
    btn.textContent = idle;
    btn.classList.remove("copied");
  }, 1800);
}

$copyBtn.addEventListener("click", () => copyText($copyBtn, "📋 Copy text"));
$copyAllBtn.addEventListener("click", () => copyText($copyAllBtn, "📋 Copy All"));

$previewBtn.addEventListener("click", () => {
  if (!last?.txt) return;
  $resultsPre.textContent = last.txt;
  $resultsPanel.classList.add("visible");
  $resultsPre.scrollTop = 0;
});

$clearBtn.addEventListener("click", () => {
  $resultsPanel.classList.remove("visible");
  $resultsPre.textContent = "";
});

init();
