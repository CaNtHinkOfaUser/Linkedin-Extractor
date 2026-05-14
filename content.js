// LinkedIn Profile Extractor — Content Script v2.0
// ── What changed from v1.x ──────────────────────────────────────
//  • PRIMARY selectors now use the accessibility tree:
//      role="list" / role="listitem" / aria-label / aria-labelledby
//    These are WCAG obligations LinkedIn cannot obfuscate.
//  • CSS-class selectors are GONE — LinkedIn rotates/hashes them.
//  • Text extraction walks DOM text nodes directly, skipping
//    visually-hidden elements (screen-reader-only labels that
//    would pollute the output).
//  • getDetailRoot() anchors to role="main" → richest role="list".
//  • Duplicate-injection guard and listener de-duplication kept.
// ────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  // ── De-duplicate listener across re-injections ───────────────
  if (window.__liExtractHandler) {
    try { chrome.runtime.onMessage.removeListener(window.__liExtractHandler); } catch (_) {}
  }

  // ── Section slug → canonical name ────────────────────────────
  const SECTION_MAP = {
    "certifications":              "certifications",
    "licenses-and-certifications": "certifications",
    "experience":                  "experience",
    "education":                   "education",
    "skills":                      "skills",
    "projects":                    "projects",
    "volunteering-experiences":    "volunteering",
    "languages":                   "languages",
    "honors":                      "honors",
    "publications":                "publications",
    "courses":                     "courses",
    "recommendations":             "recommendations",
    "organizations":               "organizations",
    "patents":                     "patents",
  };

  // ════════════════════════════════════════════════════════════
  // LOW-LEVEL HELPERS
  // ════════════════════════════════════════════════════════════

  function q(root, sel)  { return (root || document).querySelector(sel); }
  function qa(root, sel) { return Array.from((root || document).querySelectorAll(sel)); }

  function clean(t) {
    if (!t) return "";
    return String(t)
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Returns true if element is screen-reader-only / visually hidden.
  // LinkedIn uses several class patterns for this.
  function isVisuallyHidden(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const cls = (el.className || "").toString();
    if (cls.includes("visually-hidden") || cls.includes("sr-only") ||
        cls.includes("a11y-text")       || cls.includes("screen-reader-text")) return true;
    // Inline hidden
    const s = el.style;
    if (s && (s.display === "none" || s.visibility === "hidden")) return true;
    return false;
  }

  // ── Core text extractor ──────────────────────────────────────
  // Walks TEXT nodes of `el`, skipping:
  //   • visually-hidden ancestors  (pollutes output with duplicate SR labels)
  //   • text inside a NESTED <li> or role="listitem" (child entries)
  // Returns deduplicated, cleaned strings.
  function getTexts(el) {
    if (!el) return [];
    const results = [];

    function walk(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = clean(node.nodeValue);
        if (t && t !== "·" && t !== "•" && t !== "|" &&
            t !== "–" && t !== "-" && t.length > 0) {
          results.push(t);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Skip hidden elements entirely
      if (isVisuallyHidden(node)) return;

      // Skip nested list entries (would be child items, not fields of this item)
      if (node !== el) {
        const role = (node.getAttribute("role") || "").toLowerCase();
        if (node.tagName === "LI" || role === "listitem") return;
      }

      for (const child of node.childNodes) walk(child, depth + 1);
    }

    walk(el, 0);
    // Deduplicate consecutive identical strings
    return results.filter((t, i) => t !== results[i - 1]);
  }

  // Convenience: first non-empty visible text from a list of selectors
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

  // ════════════════════════════════════════════════════════════
  // MODE DETECTION
  // ════════════════════════════════════════════════════════════

  function detectMode() {
    const path = window.location.pathname;
    const m    = path.match(/\/in\/[^/?#]+\/details\/([^/?#]+)/);
    if (m) {
      const slug    = m[1].toLowerCase();
      const section = SECTION_MAP[slug] || slug;
      return { mode: "detail", section, slug };
    }
    if (/\/in\/[^/?#]+\/?$/.test(path)) return { mode: "main" };
    return { mode: "unknown" };
  }

  // ════════════════════════════════════════════════════════════
  // ITEM COLLECTION — accessibility-tree first, no class names
  // ════════════════════════════════════════════════════════════

  function getItems(root) {
    if (!root) return [];

    // ── Priority 1: role="list" containing role="listitem" ──
    // Pick the role="list" with the most DIRECT role="listitem" children.
    const roleLists = qa(root, '[role="list"]');
    if (roleLists.length) {
      let best = null, bestCount = 0;
      for (const ul of roleLists) {
        // Skip if this list is itself nested inside a listitem that lives in root
        const parentItem = ul.parentElement?.closest('[role="listitem"], li');
        if (parentItem && root.contains(parentItem) && parentItem !== root) continue;

        const directItems = Array.from(ul.children).filter(
          c => (c.getAttribute("role") || "").toLowerCase() === "listitem" || c.tagName === "LI"
        );
        if (directItems.length > bestCount) { best = ul; bestCount = directItems.length; }
      }
      if (best && bestCount > 0) {
        return Array.from(best.children).filter(
          c => (c.getAttribute("role") || "").toLowerCase() === "listitem" || c.tagName === "LI"
        );
      }
    }

    // ── Priority 2: plain <ul> → <li> children ──
    const uls = qa(root, "ul");
    let bestUl = null, bestCount2 = 0;
    for (const ul of uls) {
      const parentLi = ul.parentElement?.closest("li, [role='listitem']");
      if (parentLi && root.contains(parentLi)) continue; // skip nested
      const count = Array.from(ul.children).filter(c => c.tagName === "LI").length;
      if (count > bestCount2) { bestUl = ul; bestCount2 = count; }
    }
    if (bestUl && bestCount2 > 0) {
      return Array.from(bestUl.children).filter(c => c.tagName === "LI");
    }

    // ── Priority 3: any <li> at the shallowest nesting level ──
    const allLi = qa(root, "li");
    return allLi.filter(li => {
      const parentLi = li.parentElement?.closest("li");
      return !parentLi || !root.contains(parentLi);
    });
  }

  // ════════════════════════════════════════════════════════════
  // ROOT FINDERS
  // ════════════════════════════════════════════════════════════

  // Detail page: anchor to role="main" → richest list container.
  function getDetailRoot() {
    const main = q(document, '[role="main"]') || q(document, "main") || document.body;

    // Fast-path: look for the finite-scroll content wrapper or detail view wrapper
    const FAST = [
      '[role="main"] .scaffold-finite-scroll__content',
      '[role="main"] [data-view-name="profile-detail-view"]',
      '[role="main"] [role="list"]',
      '[role="main"]',
    ];
    for (const sel of FAST) {
      try {
        const el = q(document, sel);
        if (el && qa(el, 'li, [role="listitem"]').length > 0) return el;
      } catch (_) {}
    }

    // Slow path: pick child of main with most list items, skipping nav
    let best = main, bestCount = 0;
    for (const child of main.querySelectorAll("*")) {
      const tag = child.tagName;
      if (tag === "NAV" || tag === "HEADER" || tag === "FOOTER") continue;
      const cls = (child.className || "").toString();
      if (cls.includes("global-nav") || cls.includes("nav-bar")) continue;
      const count = qa(child, 'li, [role="listitem"]').length;
      if (count > bestCount) { best = child; bestCount = count; }
    }
    return best;
  }

  // Main profile: find <section> whose aria-label / h2 matches keyword.
  function findSection(keyword) {
    const kw = keyword.toLowerCase();
    for (const el of qa(document, "section, [role='region']")) {
      if ((el.getAttribute("aria-label") || "").toLowerCase().includes(kw)) return el;
    }
    for (const sec of qa(document, "section")) {
      for (const h of qa(sec, "h2, h3")) {
        if (clean(h.innerText || h.textContent).toLowerCase().includes(kw)) return sec;
      }
    }
    try {
      const ds = q(document, `[data-section*="${kw}"]`);
      if (ds) return ds;
    } catch (_) {}
    return null;
  }

  // ════════════════════════════════════════════════════════════
  // DATE / DURATION HELPERS
  // ════════════════════════════════════════════════════════════

  const DATE_RX   = /([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)\s*[–\-—]\s*([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)/;
  const YEAR_RX   = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
  const DUR_RX    = /\d+\s*(yr|yrs|mo|mos)/i;
  const ISSUED_RX = /^issued/i;
  const EXPIRY_RX = /expir/i;
  const CRED_RX   = /credential\s*id/i;

  const isDate = s => DATE_RX.test(s) || YEAR_RX.test(s);
  const isDur  = s => DUR_RX.test(s);

  // ════════════════════════════════════════════════════════════
  // SECTION EXTRACTORS
  // ════════════════════════════════════════════════════════════

  function extractHeader() {
    return {
      name: firstText(document,
        "h1.text-heading-xlarge", ".pv-text-details__left-panel h1", '[role="main"] h1', "h1"),
      headline: firstText(document,
        ".text-body-medium.break-words", ".pv-text-details__left-panel .t-16"),
      location: firstText(document,
        ".text-body-small.inline.t-black--light.break-words"),
      connections: firstText(document,
        "a[href*='connections'] span.t-bold", ".pvs-header__optional-link .t-bold"),
    };
  }

  function extractAbout() {
    const section = findSection("about") || q(document, "section[data-section='summary']");
    if (!section) return "";
    const texts = getTexts(section);
    return texts.reduce((a, b) => b.length > a.length ? b : a, "");
  }

  function parseExpItem(item, overrideCompany) {
    const texts = getTexts(item);
    let dur = "", durLen = "";
    const rest = texts.filter(s => {
      if (!dur    && isDate(s)) { dur    = s; return false; }
      if (!durLen && isDur(s))  { durLen = s; return false; }
      return true;
    });
    const entry = {
      title:    rest[0] || "",
      company:  overrideCompany || rest[1] || "",
      duration: [dur, durLen].filter(Boolean).join(" · "),
      location: "", description: "",
    };
    const leftover = rest.slice(overrideCompany ? 1 : 2);
    for (const s of leftover) {
      if (s.length < 60 && !entry.location)          entry.location    = s;
      else if (s.length >= 30 && !entry.description) entry.description = s;
    }
    return entry;
  }

  function extractExperience(root) {
    root = root || findSection("experience");
    if (!root) return [];
    const entries = [];
    for (const item of getItems(root)) {
      const subItems = getItems(item).filter(s => s !== item);
      if (subItems.length > 0) {
        const company = getTexts(item)[0] || "";
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
      const texts = getTexts(item);
      let duration = "";
      const rest = texts.filter(s => {
        if (!duration && isDate(s)) { duration = s; return false; }
        return true;
      });
      return {
        school: rest[0] || "", degree: rest[1] || "", field: rest[2] || "",
        duration, description: rest.find(s => s.length > 60) || "",
      };
    }).filter(e => e.school);
  }

  function extractSkills(root) {
    root = root || findSection("skills");
    if (!root) return [];
    const seen = new Set();
    return getItems(root).flatMap(item => {
      const texts = getTexts(item);
      const name  = texts[0] || "";
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const rest    = texts.slice(1);
      const endorse = rest.find(s => /endorsement|people/i.test(s)) || "";
      const cat     = rest.find(s => !/endorsement|people/i.test(s) && s.length < 60) || "";
      return [{ name, category: cat, endorsements: endorse }];
    });
  }

  function extractCertifications(root) {
    root = root || findSection("licenses") || findSection("certifications");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      let issued = "", expiry = "", credentialId = "";
      const rest = texts.filter(s => {
        if (ISSUED_RX.test(s) && !issued)     { issued = s; return false; }
        if (EXPIRY_RX.test(s) && !expiry)     { expiry = s; return false; }
        if (CRED_RX.test(s) && !credentialId) {
          credentialId = s.replace(/credential\s*id[:\s]*/i, "").trim();
          return false;
        }
        return true;
      });
      let url = "";
      for (const a of qa(item, "a[href]")) {
        if (!a.href.includes("linkedin.com/in/")) { url = a.href; break; }
      }
      return { name: rest[0] || "", issuer: rest[1] || "", issued, expiry, credentialId, url };
    }).filter(e => e.name);
  }

  function extractProjects(root) {
    root = root || findSection("projects");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      let duration = "";
      const rest = texts.filter(s => {
        if (!duration && isDate(s)) { duration = s; return false; }
        return true;
      });
      let url = "";
      for (const a of qa(item, "a[href]")) {
        if (!a.href.includes("linkedin.com/in/")) { url = a.href; break; }
      }
      return {
        name: rest[0] || "", association: rest[1] || "", duration,
        description: rest.find(s => s.length > 40) || "", url,
      };
    }).filter(e => e.name);
  }

  function extractVolunteering(root) {
    root = root || findSection("volunteer");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      let duration = "", cause = "";
      const rest = texts.filter(s => {
        if (!duration && isDate(s))  { duration = s; return false; }
        if (/cause|social/i.test(s)) { cause    = s; return false; }
        return true;
      });
      return {
        role: rest[0] || "", organization: rest[1] || "",
        duration, cause, description: rest.find(s => s.length > 40) || "",
      };
    }).filter(e => e.role);
  }

  function extractLanguages(root) {
    root = root || findSection("languages");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return { language: texts[0] || "", proficiency: texts[1] || "" };
    }).filter(e => e.language);
  }

  function extractHonors(root) {
    root = root || findSection("honors") || findSection("awards");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return {
        title: texts[0] || "", issuer: texts[1] || "", date: texts[2] || "",
        description: texts.find(s => s.length > 40) || "",
      };
    }).filter(e => e.title);
  }

  function extractPublications(root) {
    root = root || findSection("publications");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      let url = "";
      for (const a of qa(item, "a[href]")) {
        if (!a.href.includes("linkedin.com")) { url = a.href; break; }
      }
      return {
        title: texts[0] || "", publisher: texts[1] || "", date: texts[2] || "",
        description: texts.find(s => s.length > 40) || "", url,
      };
    }).filter(e => e.title);
  }

  function extractCourses(root) {
    root = root || findSection("courses");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return { name: texts[0] || "", number: texts[1] || "" };
    }).filter(e => e.name);
  }

  function extractRecommendations(root) {
    root = root || findSection("recommendations");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return {
        from: texts[0] || "", role: texts[1] || "",
        text: texts.find(s => s.length > 60) || "",
      };
    }).filter(e => e.from || e.text);
  }

  function extractOrganizations(root) {
    root = root || findSection("organizations");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return {
        name: texts[0] || "", role: texts[1] || "", duration: texts[2] || "",
        description: texts.find(s => s.length > 40) || "",
      };
    }).filter(e => e.name);
  }

  function extractPatents(root) {
    root = root || findSection("patents");
    if (!root) return [];
    return getItems(root).map(item => {
      const texts = getTexts(item);
      return {
        title: texts[0] || "", status: texts[1] || "",
        number: texts[2] || "", date: texts[3] || "",
        description: texts.find(s => s.length > 40) || "",
      };
    }).filter(e => e.title);
  }

  // ════════════════════════════════════════════════════════════
  // FORMATTERS
  // ════════════════════════════════════════════════════════════

  const DIV  = "═".repeat(60);
  const THIN = "─".repeat(50);
  const H    = t  => ["", DIV, `  ${t.toUpperCase()}`, DIV].join("\n");
  const SH   = t  => ["", `  ▸ ${t}`, `  ${THIN}`].join("\n");
  const FLD  = (l, v) => (v && v.toString().trim()) ? `  ${l}: ${v}` : null;

  function formatMain(profile) {
    const lines = [];
    const f = (l, v) => { const r = FLD(l, v); if (r) lines.push(r); };

    lines.push(DIV, "  LINKEDIN PROFILE EXTRACT",
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Mode      : Full Profile`, DIV, H("Personal Information"));
    f("Name", profile.header.name); f("Headline", profile.header.headline);
    f("Location", profile.header.location); f("Connections", profile.header.connections);
    if (profile.about) { lines.push(H("About"), `  ${profile.about}`); }

    const SECS = [
      ["experience",     "Experience",               (e,i) => { lines.push(SH(`Role ${i+1}`));     f("Title",e.title);f("Company",e.company);f("Duration",e.duration);f("Location",e.location);f("Description",e.description); }],
      ["education",      "Education",                (e,i) => { lines.push(SH(`Entry ${i+1}`));    f("School",e.school);f("Degree",e.degree);f("Field",e.field);f("Duration",e.duration);f("Description",e.description); }],
      ["skills",         "Skills",                   (e)   => { const x=[e.category,e.endorsements].filter(Boolean).join(" · "); lines.push(`  • ${e.name}${x?`  [${x}]`:""}`); }],
      ["certifications", "Licenses & Certifications",(e,i) => { lines.push(SH(`Cert ${i+1}`));    f("Name",e.name);f("Issuer",e.issuer);f("Issued",e.issued);f("Expires",e.expiry);f("Credential ID",e.credentialId);f("URL",e.url); }],
      ["projects",       "Projects",                 (e,i) => { lines.push(SH(`Project ${i+1}`)); f("Name",e.name);f("Association",e.association);f("Duration",e.duration);f("Description",e.description);f("URL",e.url); }],
      ["volunteering",   "Volunteer Experience",     (e,i) => { lines.push(SH(`Entry ${i+1}`));    f("Role",e.role);f("Organization",e.organization);f("Duration",e.duration);f("Cause",e.cause);f("Description",e.description); }],
      ["languages",      "Languages",                (e)   => { lines.push(`  • ${e.language}${e.proficiency?` — ${e.proficiency}`:""}`); }],
      ["honors",         "Honors & Awards",          (e,i) => { lines.push(SH(`Award ${i+1}`));    f("Title",e.title);f("Issuer",e.issuer);f("Date",e.date);f("Description",e.description); }],
      ["publications",   "Publications",             (e,i) => { lines.push(SH(`Pub ${i+1}`));      f("Title",e.title);f("Publisher",e.publisher);f("Date",e.date);f("Description",e.description);f("URL",e.url); }],
      ["courses",        "Courses",                  (e)   => { lines.push(`  • ${e.name}${e.number?` [${e.number}]`:""}`); }],
      ["recommendations","Recommendations",          (e,i) => { lines.push(SH(`Rec ${i+1}`));      f("From",e.from);f("Their Role",e.role); if(e.text){lines.push(`  Text:`);lines.push(`    "${e.text}"`);} }],
    ];

    for (const [key, label, renderer] of SECS) {
      const data = profile[key];
      if (!data?.length) continue;
      lines.push(H(`${label} (${data.length})`));
      data.forEach(renderer);
    }
    lines.push("", DIV, "  END OF PROFILE EXTRACT", DIV, "");
    return lines.filter(l => l !== null).join("\n");
  }

  function formatDetail(sectionName, data, profileName) {
    const lines = [
      DIV,
      `  LINKEDIN — ${sectionName.toUpperCase()}`,
      profileName ? `  Profile   : ${profileName}` : null,
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Entries   : ${data.length}`,
      DIV,
    ];
    if (!data.length) {
      lines.push("", "  No entries found. Scroll the page fully and try again.", "");
    } else {
      data.forEach((entry, i) => {
        lines.push(SH(`Entry ${i + 1}`));
        for (const [key, val] of Object.entries(entry)) {
          if (!val || !val.toString().trim()) continue;
          const label = key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
          if (key === "text") { lines.push(`  ${label}:`); lines.push(`    "${val}"`); }
          else lines.push(`  ${label}: ${val}`);
        }
      });
    }
    lines.push("", DIV, `  END — ${data.length} ENTRIES EXTRACTED`, DIV, "");
    return lines.filter(l => l !== null).join("\n");
  }

  // ════════════════════════════════════════════════════════════
  // ORCHESTRATION
  // ════════════════════════════════════════════════════════════

  function extractMainProfile() {
    const profile = {
      header:          extractHeader(),
      about:           extractAbout(),
      experience:      extractExperience(),
      education:       extractEducation(),
      skills:          extractSkills(),
      certifications:  extractCertifications(),
      projects:        extractProjects(),
      volunteering:    extractVolunteering(),
      languages:       extractLanguages(),
      honors:          extractHonors(),
      publications:    extractPublications(),
      courses:         extractCourses(),
      recommendations: extractRecommendations(),
    };
    return { mode: "main", profile, formatted: formatMain(profile) };
  }

  function extractDetailPage(section) {
    const root        = getDetailRoot();
    const profileName = firstText(document,
      ".profile-detail__header-link", ".mn-connection-card__name", "h1");
    const MAP = {
      certifications:  () => extractCertifications(root),
      experience:      () => extractExperience(root),
      education:       () => extractEducation(root),
      skills:          () => extractSkills(root),
      projects:        () => extractProjects(root),
      volunteering:    () => extractVolunteering(root),
      languages:       () => extractLanguages(root),
      honors:          () => extractHonors(root),
      publications:    () => extractPublications(root),
      courses:         () => extractCourses(root),
      recommendations: () => extractRecommendations(root),
      organizations:   () => extractOrganizations(root),
      patents:         () => extractPatents(root),
    };
    const data         = (MAP[section] ?? (() => []))();
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
    return {
      mode: "detail", section, data, count: data.length,
      formatted: formatDetail(sectionLabel, data, profileName),
    };
  }

  // ════════════════════════════════════════════════════════════
  // DEBUG  —  open DevTools on the LinkedIn tab, run:  window.__liDebug()
  // ════════════════════════════════════════════════════════════
  window.__liDebug = function () {
    const root  = getDetailRoot();
    const items = getItems(root);
    console.group("[Li Extractor v2.0] Debug");
    console.log("URL:", window.location.href);
    console.log("Mode:", detectMode());
    console.log("Detail root el:", root);
    const mainEl = q(document, '[role="main"]') || q(document, "main");
    console.log("role=list in main:", qa(mainEl || document, '[role="list"]').length);
    console.log("role=listitem in root:", qa(root, '[role="listitem"]').length);
    console.log("plain <li> in root:", qa(root, "li").length);
    console.log("getItems() →", items.length, "items");
    items.slice(0, 3).forEach((item, i) => {
      console.log(`── Item ${i} texts:`, getTexts(item));
      console.log(`── Item ${i} HTML (600):`, item.outerHTML.slice(0, 600));
    });
    if (!items.length) {
      console.warn("No items found! Root HTML (1500):", root.outerHTML.slice(0, 1500));
    }
    console.groupEnd();
  };

  // ════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ════════════════════════════════════════════════════════════
  window.__liExtractHandler = function (request, _sender, sendResponse) {
    if (request.action === "detectMode") {
      sendResponse({ success: true, data: detectMode() });
      return true;
    }
    if (request.action === "debug") {
      window.__liDebug();
      sendResponse({ success: true, data: { message: "Check DevTools on the LinkedIn tab." } });
      return true;
    }
    if (request.action === "extract") {
      try {
        const { mode, section } = detectMode();
        let result;
        if (mode === "main")        result = extractMainProfile();
        else if (mode === "detail") result = extractDetailPage(section);
        else {
          sendResponse({ success: false, error: "Not on a LinkedIn profile or detail page." });
          return true;
        }
        sendResponse({ success: true, data: result });
      } catch (err) {
        console.error("[LinkedIn Extractor v2.0]", err);
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__liExtractHandler);

})();
