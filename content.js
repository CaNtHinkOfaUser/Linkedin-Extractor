// LinkedIn Profile Extractor — Content Script v8.1
// ── Accessibility-tree-first rewrite ────────────────────────────────
//
//  WHY v8.1 (root causes of v7.0 returning nothing):
//    1. getTexts() read raw innerText of each item. LinkedIn emits every
//       field TWICE — a visible <span aria-hidden="true">VALUE</span> and
//       a sibling screen-reader-only span. innerText merges them, so the
//       positional field guesses (rest[0]=title, rest[1]=company…)
//       silently broke and empty results got filtered out.
//    2. No scroll between retries → lazy-loaded entries never appeared.
//    3. No tab handling → Recommendations/Interests incomplete.
//
//  FIXES:
//    • itemFields() reads <span aria-hidden="true"> leaves of the entry's
//      profile-component-entity container, in DOM order — no SR dupes.
//    • Two-anchor invariant: a[0]=entity (company/school/issuer),
//      a[1]=detail container. Robust company vs. role separation.
//    • Dates split on literal "·" then " - " (not regex char classes).
//    • getItems(): role=list>listitem → bare listitem → li → pvs fallback.
//    • findSection(): h2/h3 text → data-view-name=profile-card → aria-label.
//    • Scroll between retries + tabpanel iteration for tabbed sections.
// ────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  if (window.__liExtractHandler) {
    try { chrome.runtime.onMessage.removeListener(window.__liExtractHandler); } catch (_) {}
  }

  const SECTION_MAP = {
    "certifications":              "certifications",
    "licenses-and-certifications": "certifications",
    "experience":                  "experience",
    "education":                   "education",
    "skills":                      "skills",
    "projects":                    "projects",
    "volunteering-experiences":    "volunteering",
    "volunteer-experiences":       "volunteering",
    "languages":                   "languages",
    "honors":                      "honors",
    "honors-and-awards":           "honors",
    "awards":                      "honors",
    "publications":                "publications",
    "courses":                     "courses",
    "recommendations":             "recommendations",
    "organizations":               "organizations",
    "patents":                     "patents",
    "interests":                   "interests",
  };

  const q   = (root, sel) => (root || document).querySelector(sel);
  const qa  = (root, sel) => Array.from((root || document).querySelectorAll(sel));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function clean(t) {
    return String(t || "")
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const JUNK = new Set([
    "·","•","|","–","-","…","...","Show credential","Show all",
    "See credential","See more","View","Edit","Follow","Connect","Message",
    "More","Save","Share","…see more","… See more",
  ]);

  // ─────────────────────────────────────────────────────────────
  // ACCESSIBLE NAME
  // ─────────────────────────────────────────────────────────────
  function accessibleName(el) {
    if (!el) return "";
    const direct = el.getAttribute("aria-label");
    if (direct) return clean(direct).toLowerCase();
    const labelId = el.getAttribute("aria-labelledby");
    if (labelId) {
      const text = labelId.split(/\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(e => clean(e.innerText || e.textContent))
        .join(" ");
      if (text) return text.toLowerCase();
    }
    return "";
  }

  // ─────────────────────────────────────────────────────────────
  // VISIBILITY HELPERS
  // ─────────────────────────────────────────────────────────────
  function isVisuallyHidden(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return true;
    // LinkedIn's screen-reader-only containers (clip/absolute 1px trick)
    if (s.position === "absolute" && (s.width === "1px" || s.height === "1px")) return true;
    const cls = (el.className || "").toString();
    return /visually-hidden|sr-only|a11y-text|screen-reader-text|__visually-hidden/.test(cls);
  }

  // ─────────────────────────────────────────────────────────────
  // CORE FIELD READER  (the heart of v8.1)
  //
  // LinkedIn lays each entry out as nested wrappers ending in
  // <span aria-hidden="true">VALUE</span> — one per visible line.
  // Reading those leaves directly avoids the SR-only duplicate that
  // breaks positional innerText parsing.
  //
  // Strategy:
  //   1. Find the entry's primary container (the 2nd <a> / data-view-name
  //      "profile-component-entity" / the item itself).
  //   2. Collect visible <span aria-hidden="true"> leaves in DOM order.
  //   3. If none found, fall back to a visible-text-node walk + dedupe.
  // ─────────────────────────────────────────────────────────────
  function primaryContainer(item) {
    // The detail/drill-down anchor (links[1], the /overlay/ or /edit/forms/
    // link) holds the field cluster. But the entity anchor (links[0]) may
    // hold more text because it wraps the logo + name. Pick whichever of
    // the first two anchors exposes the MOST aria-hidden field spans —
    // that's the true field cluster, regardless of raw text length.
    const anchors = qa(item, "a[href]");
    if (anchors.length >= 2) {
      const cands = anchors.slice(0, 2);
      let best = cands[0], bestN = -1;
      for (const a of cands) {
        const n = visibleAriaHiddenSpans(a).length;
        if (n > bestN) { bestN = n; best = a; }
      }
      // Only trust the anchor if it actually carries fields; otherwise the
      // item itself is a better field source (e.g. tabbed/card entries).
      if (bestN > 0) return best;
    }
    const entity = q(item, '[data-view-name="profile-component-entity"]');
    if (entity && visibleAriaHiddenSpans(entity).length) return entity;
    return item;
  }

  function visibleAriaHiddenSpans(root) {
    const out = [];
    for (const span of qa(root, 'span[aria-hidden="true"]')) {
      if (isVisuallyHidden(span)) continue;
      // Skip spans nested inside another matched span — we want leaves
      if (span.querySelector('span[aria-hidden="true"]')) continue;
      const t = clean(span.innerText || span.textContent);
      if (t && !JUNK.has(t.toLowerCase())) out.push(t);
    }
    return out;
  }

  function visibleTextWalk(root, opts = {}) {
    // Walk text nodes, skipping visually-hidden + nested listitem subtrees.
    const out = [];
    const skipRoles = opts.skipNestedItems !== false;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = clean(node.nodeValue);
        if (t && !JUNK.has(t.toLowerCase())) out.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (isVisuallyHidden(node)) return;
      if (skipRoles && node !== root) {
        const role = (node.getAttribute("role") || "").toLowerCase();
        if (node.tagName === "LI" || role === "listitem") return;
      }
      for (const c of node.childNodes) walk(c);
    }
    walk(root);
    return out.filter((t, i) => t !== out[i - 1]);
  }

  function itemFields(item) {
    if (!item) return [];
    const container = primaryContainer(item);
    const spans = visibleAriaHiddenSpans(container);
    if (spans.length >= 2) return dedupeSeq(spans);
    // Too few spans from the chosen container — broaden to the whole item,
    // which catches entries where the field cluster isn't under an anchor
    // (tabbed recommendations, bare div entries on detail pages).
    const itemSpans = visibleAriaHiddenSpans(item);
    if (itemSpans.length > spans.length) return dedupeSeq(itemSpans);
    if (spans.length) return dedupeSeq(spans);
    // Last resort: visible text-node walk.
    const walked = visibleTextWalk(container);
    if (walked.length) return walked;
    return visibleTextWalk(item);
  }

  // Top-level item header line (company name for a multi-role experience item)
  function itemHeader(item) {
    const spans = visibleAriaHiddenSpans(item);
    return spans[0] || "";
  }

  function dedupeSeq(arr) {
    return arr.filter((t, i) => t !== arr[i - 1]);
  }

  // First non-empty visible text from a list of selectors (a11y-first)
  function firstText(root, ...sels) {
    for (const sel of sels) {
      try {
        const el = (root || document).querySelector(sel);
        if (el && !isVisuallyHidden(el)) {
          const t = clean(el.innerText || el.textContent);
          if (t) return t;
        }
      } catch (_) {}
    }
    return "";
  }

  // Legacy helper kept for header/about-style extraction
  function getTexts(el) {
    if (!el) return [];
    return visibleTextWalk(el);
  }

  // ─────────────────────────────────────────────────────────────
  // MODE DETECTION
  // ─────────────────────────────────────────────────────────────
  function detectMode() {
    const path = window.location.pathname;
    const m    = path.match(/\/in\/[^/?#]+\/details\/([^/?#]+)/);
    if (m) {
      const slug    = m[1].toLowerCase();
      const section = SECTION_MAP[slug] || slug;
      return { mode: "detail", section, slug };
    }
    if (/\/in\/[^/?#]+\/?$/.test(path) || /\/in\/[^/?#]+$/.test(path)) return { mode: "main" };
    return { mode: "unknown" };
  }

  // ─────────────────────────────────────────────────────────────
  // LIST / ITEM HELPERS
  // ─────────────────────────────────────────────────────────────
  const isListEl = el => {
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    return role === "list" || el.tagName === "UL" || el.tagName === "OL";
  };
  const isItemEl = el => {
    const role = (el.getAttribute?.("role") || "").toLowerCase();
    return role === "listitem" || el.tagName === "LI" ||
           (el.className || "").toString().includes("pvs-list__paged-list-item");
  };
  const listScore = el => (el.innerText || "").length;

  // ─────────────────────────────────────────────────────────────
  // getItems()  —  v8.1 cascade (no assumption of role="list" wrapper)
  //   Returns { items, via } when getItemsDebug is used; plain array otherwise.
  // ─────────────────────────────────────────────────────────────
  function getItemsDebug(root) {
    if (!root) return { items: [], via: "empty-root" };

    // ── Strategy 1: root IS a list → its direct item children ──
    if (isListEl(root)) {
      const direct = Array.from(root.children).filter(isItemEl);
      if (direct.length) return { items: direct, via: "1-root-is-list" };
    }

    // ── Strategy 2: best child [role="list"] / <ul> / pvs container ──
    const childLists = qa(root, '[role="list"], ul, ol, .pvs-list__container');
    if (childLists.length) {
      const best = childLists.reduce((a, b) => listScore(b) > listScore(a) ? b : a);
      if (listScore(best) > 10) {
        const direct = Array.from(best.children).filter(isItemEl);
        if (direct.length) return { items: direct, via: "2-child-list" };
      }
    }

    // ── Strategy 3: bare role="listitem" anywhere in root (top-level only) ──
    const bareItems = qa(root, '[role="listitem"], li, .pvs-list__paged-list-item');
    if (bareItems.length) {
      const topLevel = bareItems.filter(item => {
        const parent = item.parentElement?.closest('[role="listitem"], li, .pvs-list__paged-list-item');
        return !parent || !root.contains(parent);
      });
      if (topLevel.length) return { items: topLevel, via: "3-bare-listitem" };
    }

    // ── Strategy 4: discover entries by their drill-down anchor ──
    // On some detail views (certifications, licenses) entries are bare <div>s
    // with NO role="listitem", NO <li>, NO role="list" wrapper. The one stable
    // marker is the drill-down <a>: /overlay/... (others) or /edit/forms/...
    // (own profile). Anchor on these and walk up to the entry container.
    const DRILL_RX = /\/(overlay|edit\/forms)\//;
    const drillAnchors = qa(root, 'a[href]').filter(a => DRILL_RX.test(a.getAttribute("href") || ""));
    if (drillAnchors.length) {
      const seen = new Set();
      const items = [];
      for (const a of drillAnchors) {
        // Walk up to the nearest ancestor that is a sibling-level entry block
        // directly under a list-like wrapper inside root.
        let node = a;
        for (let up = a.parentElement; up && root.contains(up) && up !== root; up = up.parentElement) {
          node = up;
          const parent = node.parentElement;
          if (parent && (parent === root || root.contains(parent)) &&
              (node.innerText || "").length > 15) break;
        }
        if (node && !seen.has(node) && node !== root) {
          seen.add(node);
          items.push(node);
        }
      }
      // De-duplicate nested picks: drop a pick that contains another pick
      // (keep the more specific inner one) UNLESS it's meaningfully larger.
      const flat = items.filter(it =>
        !items.some(other => other !== it && it.contains(other) &&
          (it.innerText || "").length > (other.innerText || "").length + 20));
      if (flat.length) return { items: flat, via: "4-drill-anchor" };
    }

    return { items: [], via: "none" };
  }

  function getItems(root) {
    return getItemsDebug(root).items;
  }

  // Items across all tabpanels of a tablist (Recommendations / Interests).
  function getTabbedItems(root) {
    const panels = qa(root, '[role="tabpanel"]');
    if (!panels.length) return null;
    const all = [];
    for (const p of panels) {
      const items = getItems(p);
      for (const it of items) if (!all.includes(it)) all.push(it);
    }
    return all.length ? all : null;
  }

  // ─────────────────────────────────────────────────────────────
  // DETAIL ROOT FINDER — anchors to "primary content" region
  // ─────────────────────────────────────────────────────────────
  function getDetailRoot() {
    const main = q(document, '[role="main"]') || q(document, "main") || document.body;

    // Priority 1: named "primary content" region
    const CONTENT_NAMES = ["primary content", "main content"];
    const regions = qa(main, '[role="region"], section, [aria-label], [aria-labelledby]');
    for (const region of regions) {
      const name = accessibleName(region);
      if (!name) continue;
      if (CONTENT_NAMES.some(n => name.includes(n))) {
        const lists = qa(region, '[role="list"], ul');
        if (lists.length) {
          const best = lists.reduce((a, b) => listScore(b) > listScore(a) ? b : a);
          if (listScore(best) > 10) return best;
        }
        return region;
      }
    }

    // Priority 2: richest list anywhere in main
    const allLists = qa(main, '[role="list"], ul');
    if (allLists.length) {
      const best = allLists.reduce((a, b) => listScore(b) > listScore(a) ? b : a);
      if (listScore(best) > 10) return best;
    }

    return main;
  }

  // ─────────────────────────────────────────────────────────────
  // SECTION FINDER — main profile page (a11y-first)
  //   1. h2/h3 heading text
  //   2. data-view-name="profile-card" with matching aria-label
  //   3. any region/section with matching accessible name
  //   4. id contains keyword
  // ─────────────────────────────────────────────────────────────
  const SECTION_ALIASES = {
    "certifications":  ["licenses", "certification", "credential"],
    "experience":      ["experience"],
    "education":       ["education"],
    "skills":          ["skills"],
    "projects":        ["projects"],
    "volunteering":    ["volunteer"],
    "languages":       ["languages"],
    "honors":          ["honors", "awards", "honors & awards"],
    "publications":    ["publications"],
    "courses":         ["courses"],
    "recommendations": ["recommendations"],
    "organizations":   ["organizations", "organization"],
    "patents":         ["patents"],
    "interests":       ["interests"],
  };

  function sectionNameMatches(name, keyword) {
    if (!name) return false;
    const aliases = SECTION_ALIASES[keyword] || [keyword];
    return aliases.some(a => name.includes(a));
  }

  function findSection(keyword) {
    const kw = keyword.toLowerCase();

    // 1. Heading text (most stable)
    for (const h of qa(document, "h2, h3")) {
      const t = clean(h.innerText || h.textContent).toLowerCase();
      if (sectionNameMatches(t, kw)) {
        const sec = h.closest("section") || h.closest('[data-view-name="profile-card"]') || h.parentElement;
        if (sec) return sec;
      }
    }

    // 2. data-view-name="profile-card" by accessible name
    for (const card of qa(document, '[data-view-name="profile-card"], section, [role="region"]')) {
      if (sectionNameMatches(accessibleName(card), kw)) return card;
    }

    // 3. aria-labeled divs
    for (const el of qa(document, 'div[aria-label], div[aria-labelledby]')) {
      if (sectionNameMatches(accessibleName(el), kw)) return el;
    }

    // 4. id fallback
    try {
      const byId = document.querySelector(`section[id*="${kw}"], div[id*="${kw}-section"]`);
      if (byId) return byId.closest("section") || byId;
    } catch (_) {}
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // DATE / FIELD PATTERNS
  //   LinkedIn date strings: "Jan 2020 - Present · 3 yrs 2 mos"
  //   Split on "·" (range|duration) then " - " (from|to).
  // ─────────────────────────────────────────────────────────────
  const DATE_RX   = /([A-Z][a-z]{2,8}\.?\s+\d{4}|Present|\d{4})\s*[–\-—]\s*([A-Z][a-z]{2,8}\.?\s+\d{4}|Present|\d{4})/;
  const YEAR_RX   = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
  const DUR_RX    = /\d+\s*(yr|yrs|mo|mos)/i;
  const ISSUED_RX = /^issued/i;
  const EXPIRY_RX = /expir/i;
  const CRED_RX   = /credential\s*id/i;
  const isDate    = s => DATE_RX.test(s) || YEAR_RX.test(s);
  const isDur     = s => DUR_RX.test(s);

  // Pull (range, duration) out of a combined "Range · Duration" string.
  function splitDateAndDuration(s) {
    if (!s) return { date: "", duration: "" };
    const parts = s.split(/\s*·\s*/);
    let date = "", duration = "";
    for (const p of parts) {
      if (!date && (isDate(p) || /\b(Present|present)\b/.test(p))) date = p;
      else if (!duration && isDur(p)) duration = p;
    }
    if (!date && parts[0]) date = parts[0];
    return { date: clean(date), duration: clean(duration) };
  }

  // Employment-type label LinkedIn inserts between title and company.
  // Real-world examples from debug: "Full-time", "Part-time", "Contract",
  // "Freelance", "Internship", "Self-employed", "Temporary", "Apprenticeship".
  const EMP_TYPE_RX = /^(full[-\s]?time|part[-\s]?time|contract|freelance|internship|self[-\s]?employed|temporary|apprenticeship|seasonal|commission)$/i;
  const isEmpType   = s => EMP_TYPE_RX.test(clean(s));
  // "Skills" line that sometimes follows: "· 3 skills" / "1 skill"
  const isSkillsLine = s => /^\d+\s+skill/i.test(clean(s));

  // First non-/in/ non-/company/ external link = credential/project URL
  function externalUrl(item) {
    for (const a of qa(item, "a[href]")) {
      const href = a.href || "";
      if (!href) continue;
      if (/linkedin\.com\/(in|company|school)\//.test(href)) continue;
      if (/linkedin\.com\/in\//.test(href)) continue;
      if (/^https?:\/\//.test(href)) return href;
    }
    return "";
  }

  // ─────────────────────────────────────────────────────────────
  // SECTION EXTRACTORS
  // ─────────────────────────────────────────────────────────────
  function extractHeader() {
    return {
      name:        firstText(document, "h1.text-heading-xlarge", '[role="main"] h1', "main h1", "h1"),
      headline:    firstText(document, ".text-body-medium.break-words", ".text-body-medium"),
      location:    firstText(document, ".text-body-small.inline.t-black--light.break-words", ".text-body-small.t-black--light"),
      connections: firstText(document, "a[href*='connections'] span.t-bold", ".pvs-header__optional-link .t-bold", "a[href*='connections'] .t-bold"),
    };
  }

  function extractAbout() {
    const sec = findSection("about") || q(document, "section[data-section='summary']");
    if (!sec) return "";
    const texts = getTexts(sec);
    // About is the longest non-heading line (skip the "About" heading itself)
    return texts.reduce((a, b) => (b.length > a.length && b.toLowerCase() !== "about") ? b : a, "");
  }

  // Pull the longest "description-like" remaining string (heuristic).
  function pickDescription(rest, minLen = 30) {
    return rest.find(s => s.length >= minLen) || "";
  }

  function parseExpItem(item, overrideCompany) {
    const fields = itemFields(item);
    let dateStr = "", durStr = "";
    // First pass: peel off dates/durations, and drop employment-type +
    // skill-count noise lines that would otherwise shift positions.
    const rest = fields.filter(s => {
      if (isEmpType(s) || isSkillsLine(s)) return false;
      if (!dateStr && (isDate(s) || isDur(s))) {
        const split = splitDateAndDuration(s);
        if (split.date) { dateStr = split.date; durStr = durStr || split.duration; return false; }
        if (isDur(s) && !durStr) { durStr = s; return false; }
      }
      return true;
    });
    const e = {
      title:    rest[0] || "",
      company:  overrideCompany || rest[1] || "",
      duration: [dateStr, durStr].filter(Boolean).join(" · "),
      location: "", description: "",
    };
    rest.slice(overrideCompany ? 1 : 2).forEach(s => {
      if (!e.location && s.length < 60)          e.location    = s;
      else if (!e.description && s.length >= 30) e.description = s;
    });
    return e;
  }

  function extractExperience(root) {
    root = root || findSection("experience");
    if (!root) return [];
    const entries = [];
    for (const item of getItems(root)) {
      // Detect nested positions: item has its own sub-list of roles
      const subItems = getItems(item).filter(s => s !== item);
      if (subItems.length > 0) {
        const company = itemHeader(item) || "";
        for (const sub of subItems) {
          const e = parseExpItem(sub, company);
          if (e.title) entries.push(e);
        }
      } else {
        const e = parseExpItem(item);
        if (e.title) entries.push(e);
      }
    }
    return entries;
  }

  function extractEducation(root) {
    root = root || findSection("education");
    if (!root) return [];
    return getItems(root).map(item => {
      const fields = itemFields(item);
      let dur = "";
      const rest = fields.filter(s => { if (!dur && (isDate(s) || YEAR_RX.test(s))) { dur = splitDateAndDuration(s).date; return false; } return true; });
      return {
        school: rest[0] || "", degree: rest[1] || "", field: rest[2] || "",
        duration: dur, description: pickDescription(rest.slice(3)),
      };
    }).filter(e => e.school);
  }

  function extractSkills(root) {
    root = root || findSection("skills");
    if (!root) return [];
    const seen = new Set();
    return getItems(root).flatMap(item => {
      const fields = itemFields(item);
      const name = fields[0] || "";
      if (!name || seen.has(name)) return []; seen.add(name);
      const rest = fields.slice(1);
      return [{
        name,
        category:   rest.find(s => !/endorsement|people/i.test(s) && s.length < 60) || "",
        endorsements: rest.find(s => /endorsement|people/i.test(s)) || "",
      }];
    });
  }

  function extractCertifications(root) {
    root = root || findSection("certifications");
    if (!root) return [];
    return getItems(root).map(item => {
      const fields = itemFields(item);
      let issued = "", expiry = "", credentialId = "";
      const rest = fields.filter(s => {
        if (ISSUED_RX.test(s) && !issued)         { issued = s; return false; }
        if (EXPIRY_RX.test(s) && !expiry)         { expiry = s; return false; }
        if (CRED_RX.test(s) && !credentialId)     { credentialId = s.replace(/credential\s*id[:\s]*/i, "").trim(); return false; }
        if (/^(show|see|view)\s/i.test(s) && s.length < 30) return false;
        return true;
      });
      const url = externalUrl(item);
      return { name: rest[0] || "", issuer: rest[1] || "", issued, expiry, credentialId, url };
    }).filter(e => e.name);
  }

  function extractProjects(root) {
    root = root || findSection("projects");
    if (!root) return [];
    return getItems(root).map(item => {
      const fields = itemFields(item);
      let dur = "";
      const rest = fields.filter(s => { if (!dur && (isDate(s) || isDur(s))) { dur = splitDateAndDuration(s).date; return false; } return true; });
      return { name: rest[0] || "", association: rest[1] || "", duration: dur, description: pickDescription(rest.slice(2), 40), url: externalUrl(item) };
    }).filter(e => e.name);
  }

  function extractVolunteering(root) {
    root = root || findSection("volunteering");
    if (!root) return [];
    return getItems(root).map(item => {
      const fields = itemFields(item);
      let dur = "", cause = "";
      const rest = fields.filter(s => {
        if (!dur && (isDate(s) || isDur(s))) { dur = splitDateAndDuration(s).date; return false; }
        if (!cause && /cause|social/i.test(s)) { cause = s; return false; }
        return true;
      });
      return { role: rest[0] || "", organization: rest[1] || "", duration: dur, cause, description: pickDescription(rest.slice(2), 40) };
    }).filter(e => e.role);
  }

  function extractLanguages(root) {
    root = root || findSection("languages");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { language: f[0] || "", proficiency: f[1] || "" };
    }).filter(e => e.language);
  }

  function extractHonors(root) {
    root = root || findSection("honors");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { title: f[0] || "", issuer: f[1] || "", date: f[2] || "", description: pickDescription(f.slice(3), 40) };
    }).filter(e => e.title);
  }

  function extractPublications(root) {
    root = root || findSection("publications");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { title: f[0] || "", publisher: f[1] || "", date: f[2] || "", description: pickDescription(f.slice(3), 40), url: externalUrl(item) };
    }).filter(e => e.title);
  }

  function extractCourses(root) {
    root = root || findSection("courses");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { name: f[0] || "", number: f[1] || "" };
    }).filter(e => e.name);
  }

  function extractRecommendations(root) {
    root = root || findSection("recommendations");
    if (!root) return [];
    // Recommendations are tabbed (Received/Given). Merge all tabpanels.
    const items = getTabbedItems(root) || getItems(root);
    return items.map(item => {
      const f = itemFields(item);
      return { from: f[0] || "", role: f[1] || "", text: pickDescription(f.slice(2), 60) };
    }).filter(e => e.from || e.text);
  }

  function extractOrganizations(root) {
    root = root || findSection("organizations");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { name: f[0] || "", role: f[1] || "", duration: f[2] || "", description: pickDescription(f.slice(3), 40) };
    }).filter(e => e.name);
  }

  function extractPatents(root) {
    root = root || findSection("patents");
    if (!root) return [];
    return getItems(root).map(item => {
      const f = itemFields(item);
      return { title: f[0] || "", status: f[1] || "", number: f[2] || "", date: f[3] || "", description: pickDescription(f.slice(4), 40) };
    }).filter(e => e.title);
  }

  // ─────────────────────────────────────────────────────────────
  // FORMATTERS
  // ─────────────────────────────────────────────────────────────
  const DIV  = "═".repeat(60);
  const THIN = "─".repeat(50);
  const H    = t => ["", DIV, `  ${t.toUpperCase()}`, DIV].join("\n");
  const SH   = t => ["", `  ▸ ${t}`, `  ${THIN}`].join("\n");
  const FLD  = (l, v) => (v && v.toString().trim()) ? `  ${l}: ${v}` : null;

  function formatMain(profile) {
    const lines = [];
    const f = (l, v) => { const r = FLD(l, v); if (r) lines.push(r); };
    lines.push(DIV,"  LINKEDIN PROFILE EXTRACT",
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Mode      : Full Profile`, DIV, H("Personal Information"));
    f("Name",profile.header.name); f("Headline",profile.header.headline);
    f("Location",profile.header.location); f("Connections",profile.header.connections);
    if (profile.about) { lines.push(H("About"), `  ${profile.about}`); }
    const SECS = [
      ["experience",     "Experience",               (e,i)=>{ lines.push(SH(`Role ${i+1}`));     f("Title",e.title);f("Company",e.company);f("Duration",e.duration);f("Location",e.location);f("Description",e.description); }],
      ["education",      "Education",                (e,i)=>{ lines.push(SH(`Entry ${i+1}`));    f("School",e.school);f("Degree",e.degree);f("Field",e.field);f("Duration",e.duration);f("Description",e.description); }],
      ["skills",         "Skills",                   (e)=>  { const x=[e.category,e.endorsements].filter(Boolean).join(" · "); lines.push(`  • ${e.name}${x?`  [${x}]`:""}`); }],
      ["certifications", "Licenses & Certifications",(e,i)=>{ lines.push(SH(`Cert ${i+1}`));    f("Name",e.name);f("Issuer",e.issuer);f("Issued",e.issued);f("Expires",e.expiry);f("Credential ID",e.credentialId);f("URL",e.url); }],
      ["projects",       "Projects",                 (e,i)=>{ lines.push(SH(`Project ${i+1}`)); f("Name",e.name);f("Association",e.association);f("Duration",e.duration);f("Description",e.description);f("URL",e.url); }],
      ["volunteering",   "Volunteer Experience",     (e,i)=>{ lines.push(SH(`Entry ${i+1}`));    f("Role",e.role);f("Organization",e.organization);f("Duration",e.duration);f("Cause",e.cause);f("Description",e.description); }],
      ["languages",      "Languages",                (e)=>  { lines.push(`  • ${e.language}${e.proficiency?` — ${e.proficiency}`:""}`); }],
      ["honors",         "Honors & Awards",          (e,i)=>{ lines.push(SH(`Award ${i+1}`));    f("Title",e.title);f("Issuer",e.issuer);f("Date",e.date);f("Description",e.description); }],
      ["publications",   "Publications",             (e,i)=>{ lines.push(SH(`Pub ${i+1}`));      f("Title",e.title);f("Publisher",e.publisher);f("Date",e.date);f("Description",e.description);f("URL",e.url); }],
      ["courses",        "Courses",                  (e)=>  { lines.push(`  • ${e.name}${e.number?` [${e.number}]`:""}`); }],
      ["recommendations","Recommendations",          (e,i)=>{ lines.push(SH(`Rec ${i+1}`));      f("From",e.from);f("Their Role",e.role); if(e.text){lines.push(`  Text:`);lines.push(`    "${e.text}"`);} }],
    ];
    for (const [key,label,renderer] of SECS) {
      const data = profile[key]; if (!data?.length) continue;
      lines.push(H(`${label} (${data.length})`)); data.forEach(renderer);
    }
    lines.push("",DIV,"  END OF PROFILE EXTRACT",DIV,"");
    return lines.filter(l=>l!==null).join("\n");
  }

  function formatDetail(sectionName, data, profileName) {
    const lines = [
      DIV, `  LINKEDIN — ${sectionName.toUpperCase()}`,
      profileName ? `  Profile   : ${profileName}` : null,
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Entries   : ${data.length}`, DIV,
    ];
    if (!data.length) {
      lines.push("","  No entries found. Scroll the full page first, then try again.","");
    } else {
      data.forEach((entry, i) => {
        lines.push(SH(`Entry ${i + 1}`));
        for (const [key, val] of Object.entries(entry)) {
          if (!val || !val.toString().trim()) continue;
          const label = key.replace(/([A-Z])/g," $1").replace(/^./,c=>c.toUpperCase());
          if (key==="text") { lines.push(`  ${label}:`); lines.push(`    "${val}"`); }
          else lines.push(`  ${label}: ${val}`);
        }
      });
    }
    lines.push("",DIV,`  END — ${data.length} ENTRIES EXTRACTED`,DIV,"");
    return lines.filter(l=>l!==null).join("\n");
  }

  // ─────────────────────────────────────────────────────────────
  // ORCHESTRATION with scroll + retry
  // ─────────────────────────────────────────────────────────────
  function runExtractMain() {
    const profile = {
      header:extractHeader(), about:extractAbout(),
      experience:extractExperience(), education:extractEducation(),
      skills:extractSkills(), certifications:extractCertifications(),
      projects:extractProjects(), volunteering:extractVolunteering(),
      languages:extractLanguages(), honors:extractHonors(),
      publications:extractPublications(), courses:extractCourses(),
      recommendations:extractRecommendations(),
    };
    return { mode:"main", profile, formatted:formatMain(profile) };
  }

  function runExtractDetail(section) {
    const root = getDetailRoot();
    const profileName = firstText(document, ".profile-detail__header-link", '[role="main"] h1', "h1");
    const MAP = {
      certifications:  ()=>extractCertifications(root),
      experience:      ()=>extractExperience(root),
      education:       ()=>extractEducation(root),
      skills:          ()=>extractSkills(root),
      projects:        ()=>extractProjects(root),
      volunteering:    ()=>extractVolunteering(root),
      languages:       ()=>extractLanguages(root),
      honors:          ()=>extractHonors(root),
      publications:    ()=>extractPublications(root),
      courses:         ()=>extractCourses(root),
      recommendations: ()=>extractRecommendations(root),
      organizations:   ()=>extractOrganizations(root),
      patents:         ()=>extractPatents(root),
    };
    const data  = (MAP[section]??(() => []))();
    const label = section.charAt(0).toUpperCase()+section.slice(1);
    return { mode:"detail", section, data, count:data.length, formatted:formatDetail(label,data,profileName) };
  }

  // Scroll progressively to the bottom so LinkedIn's lazy loader renders.
  async function scrollToBottom() {
    try {
      const main = q(document, '[role="main"]') || document.body;
      let last = -1, stable = 0;
      for (let i = 0; i < 12 && stable < 2; i++) {
        const before = main.scrollHeight;
        window.scrollTo(0, main.scrollHeight);
        await sleep(450);
        const after = main.scrollHeight;
        if (after === last) stable++; else stable = 0;
        last = after;
      }
      window.scrollTo(0, 0);
    } catch (_) {}
  }

  // Click any "See more" / "Show more" expand buttons inside a scope.
  async function expandSeeMore(scope) {
    try {
      const root = scope || document;
      const btns = qa(root, 'button[aria-label*="see more" i], button[aria-label*="show more" i]');
      for (const b of btns) {
        if (isVisuallyHidden(b)) continue;
        try { b.click(); } catch (_) {}
        await sleep(80);
      }
    } catch (_) {}
  }

  async function extractWithRetry(mode, section) {
    const MAX = 3, DELAY = 800;
    let result;
    for (let i = 0; i < MAX; i++) {
      if (i > 0) {
        console.log(`[Li Extractor v8.1] Retry ${i}/${MAX-1} — scrolling + waiting ${DELAY}ms`);
        await scrollToBottom();
        await expandSeeMore(document);
        await sleep(DELAY);
      }
      result = mode === "main" ? runExtractMain() : runExtractDetail(section);
      const hasData = mode === "main"
        ? Object.entries(result.profile).some(([k,v]) => k !== "header" && (Array.isArray(v) ? v.length > 0 : !!v))
        : result.count > 0;
      if (hasData) break;
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // DEBUG
  // ─────────────────────────────────────────────────────────────
  window.__liDebug = function () {
    const main  = q(document,'[role="main"]') || document.body;
    const mode  = detectMode();
    const root  = mode.mode === "detail" ? getDetailRoot() : (findSection("experience") || findSection("certifications") || main);
    const { items, via } = getItemsDebug(root);

    console.group("[Li Extractor v8.1] Debug");
    console.log("URL:", window.location.href);
    console.log("Mode:", mode);

    console.log("Named regions:");
    qa(main,'section,[role="region"],[aria-label],[aria-labelledby]').forEach((el,i) => {
      const name = accessibleName(el);
      if (name && ["SECTION","DIV","MAIN"].includes(el.tagName)) {
        console.log(`  [${i}] ${el.tagName} name="${name}" | items=${qa(el,'[role="listitem"],li').length}`);
      }
    });

    console.log("All lists:");
    qa(main,'[role="list"],ul').forEach((l,i) => {
      console.log(`  [${i}] score=${listScore(l)} items=${l.querySelectorAll('[role="listitem"],li').length} tag=${l.tagName} | "${(l.innerText||"").slice(0,60).replace(/\n/g," ")}"`);
    });

    console.log("role=listitem in main:", qa(main,'[role="listitem"]').length);
    console.log("Chosen root:", root);
    console.log("Root score:", listScore(root), "| isListEl:", isListEl(root));
    console.log(`getItems() → ${items.length} items  (via strategy: ${via})`);

    if (items.length === 0) {
      // Diagnostics for the 0-items case: which markers ARE present in root?
      const DRILL_RX = /\/(overlay|edit\/forms)\//;
      const drillAnchors = qa(root, 'a[href]').filter(a => DRILL_RX.test(a.getAttribute("href") || ""));
      console.log("── 0-items diagnostics ──");
      console.log(`   role=listitem in root: ${qa(root,'[role="listitem"]').length}`);
      console.log(`   <li> in root:          ${qa(root,'li').length}`);
      console.log(`   [role=list] in root:   ${qa(root,'[role="list"]').length}`);
      console.log(`   <ul> in root:          ${qa(root,'ul').length}`);
      console.log(`   pvs paged-list-item:   ${qa(root,'.pvs-list__paged-list-item').length}`);
      console.log(`   drill-down anchors:    ${drillAnchors.length}`, drillAnchors.slice(0,5).map(a=>a.getAttribute("href")));
      console.log(`   root innerText(400):   "${(root.innerText||"").slice(0,400).replace(/\n/g," | ")}"`);
    }

    items.slice(0,3).forEach((item,i) => {
      console.log(`── Item[${i}] role="${item.getAttribute('role')}" tag=${item.tagName}`);
      console.log(`   itemFields():`, itemFields(item));
      console.log(`   itemHeader():`, itemHeader(item));
      console.log(`   anchors:`, qa(item,"a[href]").map(a=>a.href));
      console.log(`   externalUrl:`, externalUrl(item));
    });

    console.groupEnd();
  };

  // ─────────────────────────────────────────────────────────────
  // MESSAGE HANDLER
  // ─────────────────────────────────────────────────────────────
  window.__liExtractHandler = function (request, _sender, sendResponse) {
    if (request.action === "detectMode") {
      sendResponse({ success:true, data:detectMode() });
      return true;
    }
    if (request.action === "debug") {
      window.__liDebug();
      sendResponse({ success:true, data:{ message:"Check DevTools on the LinkedIn tab." } });
      return true;
    }
    if (request.action === "extract") {
      const { mode, section } = detectMode();
      if (mode === "unknown") {
        sendResponse({ success:false, error:"Not on a LinkedIn profile or detail page." });
        return true;
      }
      extractWithRetry(mode, section)
        .then(result => sendResponse({ success:true, data:result }))
        .catch(err => {
          console.error("[LinkedIn Extractor v8.1]", err);
          sendResponse({ success:false, error:err.message });
        });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__liExtractHandler);
  console.log("[LinkedIn Extractor v8.1] Ready —", window.location.pathname);

})();
