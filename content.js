// LinkedIn Profile Extractor — Content Script v1.4
// Key design changes from previous versions:
//   - Removed __linkedinExtractorLoaded guard (broke SPA navigation)
//   - Instead, remove old listener before adding new one via a named handler ref
//   - Detail page root is now scoped to the actual list, not entire <main>
//   - Broader item selectors handle 2024/2025 LinkedIn DOM variants
//   - Debug helper: open DevTools console and run window.__liDebug()

(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────
  // LISTENER DE-DUPLICATION
  // Store the handler on window so re-injection removes the old one first.
  // ─────────────────────────────────────────────────────────
  if (window.__liExtractHandler) {
    try { chrome.runtime.onMessage.removeListener(window.__liExtractHandler); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────
  // URL → canonical section name
  // ─────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────
  function clean(t) {
    if (!t) return "";
    return String(t)
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function q(root, sel)  { return (root || document).querySelector(sel); }
  function qa(root, sel) { return Array.from((root || document).querySelectorAll(sel)); }

  // Collect aria-hidden span texts from el, but NOT from spans that live
  // inside a nested <li> (avoids absorbing child entries' text).
  function getSpans(el) {
    if (!el) return [];
    return qa(el, "span[aria-hidden='true']")
      .filter(s => {
        let cur = s.parentElement;
        while (cur && cur !== el) {
          if (cur.tagName === "LI") return false;
          cur = cur.parentElement;
        }
        return true;
      })
      .map(s => clean(s.innerText || s.textContent))
      .filter(s => s && s !== "·" && s !== "•" && s !== "|" && s !== "–" && s !== "-");
  }

  // Try several selectors in order; return first non-empty text found.
  function firstText(root, ...sels) {
    for (const sel of sels) {
      const el = q(root, sel);
      if (el) { const t = clean(el.innerText || el.textContent); if (t) return t; }
    }
    return "";
  }

  // ─────────────────────────────────────────────────────────
  // MODE DETECTION
  // ─────────────────────────────────────────────────────────
  function detectMode() {
    const path = window.location.pathname;
    const m = path.match(/\/in\/[^/?#]+\/details\/([^/?#]+)/);
    if (m) {
      const slug    = m[1].toLowerCase();
      const section = SECTION_MAP[slug] || slug;
      return { mode: "detail", section, slug };
    }
    if (/\/in\/[^/?#]+\/?$/.test(path)) return { mode: "main" };
    return { mode: "unknown" };
  }

  // ─────────────────────────────────────────────────────────
  // ITEM COLLECTION
  // LinkedIn has changed class names several times across redesigns.
  // We try a priority list; take the first selector that yields top-level items.
  // "Top-level" = not nested inside another element matching the same selector.
  // ─────────────────────────────────────────────────────────
  const ITEM_SELS = [
    "li.artdeco-list__item",
    "li.pvs-list__item--line-separated",
    "li.pvs-list__item--with-top-padding",
    "li[class*='pvs-list__item']",
    "li[data-view-name]",
    "li",
  ];

  function getItems(root) {
    if (!root) return [];
    for (const sel of ITEM_SELS) {
      const all = qa(root, sel);
      if (!all.length) continue;
      // Keep only items not nested inside another item of the same type.
      const top = all.filter(li => {
        const parentMatch = li.parentElement?.closest(sel);
        return !parentMatch || parentMatch === root;
      });
      if (top.length) return top;
    }
    return [];
  }

  // ─────────────────────────────────────────────────────────
  // ROOT FINDERS
  // ─────────────────────────────────────────────────────────

  // For detail pages: scope to the scrollable list container, NOT all of <main>.
  // Grabbing all of <main> matches sidebar/nav items too — that's why 0 entries.
  function getDetailRoot() {
    const candidates = [
      // Most specific: the finite scroll content area
      "main .scaffold-finite-scroll__content",
      // Profile detail view wrapper
      "main [data-view-name='profile-detail-view']",
      // A <ul> directly inside main with pvs-list class
      "main ul.pvs-list",
      // Any pvs-list inside main
      "main .pvs-list",
      // Fallback: main itself
      "main",
    ];
    for (const sel of candidates) {
      const el = q(document, sel);
      if (el && qa(el, "li").length > 0) return el;
    }
    return document.body;
  }

  // For main profile: find the <section> whose heading matches a keyword.
  function findSection(keyword) {
    const kw = keyword.toLowerCase();
    // 1. aria-label
    for (const sec of qa(document, "section")) {
      if ((sec.getAttribute("aria-label") || "").toLowerCase().includes(kw)) return sec;
    }
    // 2. h2 text
    for (const sec of qa(document, "section")) {
      const h2 = q(sec, "h2");
      if (h2 && clean(h2.innerText).toLowerCase().includes(kw)) return sec;
    }
    // 3. data-section attribute
    for (const sec of qa(document, "section")) {
      if ((sec.getAttribute("data-section") || "").toLowerCase().includes(kw)) return sec;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // HEADER (main profile page)
  // ─────────────────────────────────────────────────────────
  function extractHeader() {
    return {
      name: firstText(document,
        "h1.text-heading-xlarge",
        ".pv-text-details__left-panel h1",
        "h1"),
      headline: firstText(document,
        ".text-body-medium.break-words",
        ".pv-text-details__left-panel .t-16"),
      location: firstText(document,
        ".text-body-small.inline.t-black--light.break-words",
        ".pv-text-details__left-panel .t-14 span[aria-hidden='true']"),
      connections: firstText(document,
        ".pvs-header__optional-link .t-bold",
        ".pv-text-details__right-panel span.t-bold",
        "a[href*='connections'] span.t-bold"),
    };
  }

  // ─────────────────────────────────────────────────────────
  // ABOUT
  // ─────────────────────────────────────────────────────────
  function extractAbout() {
    const section = findSection("about") || q(document, "section[data-section='summary']");
    if (!section) return "";
    const showMore = q(section, ".inline-show-more-text span[aria-hidden='true']");
    if (showMore) { const t = clean(showMore.innerText); if (t.length > 10) return t; }
    const spans = qa(section, "span[aria-hidden='true']")
      .map(s => clean(s.innerText || s.textContent))
      .filter(Boolean);
    return spans.reduce((a, b) => b.length > a.length ? b : a, "");
  }

  // ─────────────────────────────────────────────────────────
  // DATE / DURATION PATTERNS
  // ─────────────────────────────────────────────────────────
  const DATE_RX = /([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)\s*[–\-—]\s*([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)/;
  const YEAR_RX = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
  const DUR_RX  = /\d+\s*(yr|yrs|mo|mos)/i;
  const isDate  = s => DATE_RX.test(s) || YEAR_RX.test(s);
  const isDur   = s => DUR_RX.test(s);

  // ─────────────────────────────────────────────────────────
  // EXPERIENCE
  // ─────────────────────────────────────────────────────────
  function parseExpItem(item, overrideCompany) {
    const spans = getSpans(item);
    let dur = "", durLen = "";
    for (const s of spans) {
      if (!dur && isDate(s))   { dur = s; continue; }
      if (!durLen && isDur(s)) { durLen = s; continue; }
    }
    const meaningful = spans.filter(s => !isDate(s) && !isDur(s));
    const entry = {
      title:    meaningful[0] || "",
      company:  overrideCompany || meaningful[1] || "",
      duration: [dur, durLen].filter(Boolean).join(" · "),
      location: "", description: "",
    };
    const rest = meaningful.slice(overrideCompany ? 1 : 2);
    for (const s of rest) {
      if (s.length < 60 && !entry.location)         entry.location = s;
      else if (s.length >= 30 && !entry.description) entry.description = s;
    }
    return entry;
  }

  function extractExperience(root) {
    root = root || findSection("experience");
    if (!root) return [];
    const entries = [];
    for (const item of getItems(root)) {
      const nested = qa(item, "li.artdeco-list__item, li[class*='pvs-list__item']")
        .filter(li => li !== item && item.contains(li));
      if (nested.length > 0) {
        const companyEl = q(item, ".t-bold span[aria-hidden='true']");
        const company   = companyEl ? clean(companyEl.innerText) : "";
        for (const role of nested) {
          const e = parseExpItem(role, company);
          if (e.title) entries.push(e);
        }
      } else {
        const e = parseExpItem(item);
        if (e.title) entries.push(e);
      }
    }
    return entries;
  }

  // ─────────────────────────────────────────────────────────
  // EDUCATION
  // ─────────────────────────────────────────────────────────
  function extractEducation(root) {
    root = root || findSection("education");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      let duration = "";
      const rest = spans.filter(s => {
        if (!duration && isDate(s)) { duration = s; return false; }
        return true;
      });
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return {
        school: rest[0]||"", degree: rest[1]||"", field: rest[2]||"", duration,
        grade:       rest.find(s => /grade|cgpa|gpa/i.test(s)) || "",
        activities:  rest.find(s => /activities|clubs|societies/i.test(s)) || "",
        description: descEl ? clean(descEl.innerText) : "",
      };
    }).filter(e => e.school);
  }

  // ─────────────────────────────────────────────────────────
  // SKILLS
  // ─────────────────────────────────────────────────────────
  function extractSkills(root) {
    root = root || findSection("skills");
    if (!root) return [];
    const seen = new Set();
    return getItems(root).flatMap(item => {
      const nameEl =
        q(item, ".t-bold span[aria-hidden='true']") ||
        q(item, ".t-16 span[aria-hidden='true']")   ||
        q(item, "span[aria-hidden='true']");
      const name = nameEl ? clean(nameEl.innerText) : "";
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const sub     = getSpans(item).filter(s => s !== name);
      const endorse = sub.find(s => /endorsement|people/i.test(s)) || "";
      const cat     = sub.find(s => !/endorsement|people/i.test(s) && s.length < 60) || "";
      return [{ name, category: cat, endorsements: endorse }];
    });
  }

  // ─────────────────────────────────────────────────────────
  // CERTIFICATIONS
  // ─────────────────────────────────────────────────────────
  function extractCertifications(root) {
    root = root || findSection("licenses") || findSection("certifications");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      let issued = "", expiry = "", credentialId = "";
      const rest = spans.filter(s => {
        if (/^issued/i.test(s))       { issued = s; return false; }
        if (/expir/i.test(s))         { expiry = s; return false; }
        if (/credential id/i.test(s)) {
          credentialId = s.replace(/credential id[:\s]*/i, "").trim();
          return false;
        }
        return true;
      });
      const link = q(item, "a[href*='http']");
      const url  = link && !link.href.includes("linkedin.com") ? link.href : "";
      return { name: rest[0]||"", issuer: rest[1]||"", issued, expiry, credentialId, url };
    }).filter(e => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // PROJECTS
  // ─────────────────────────────────────────────────────────
  function extractProjects(root) {
    root = root || findSection("projects");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      let duration = "";
      const rest = spans.filter(s => {
        if (!duration && isDate(s)) { duration = s; return false; }
        return true;
      });
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      const link   = q(item, "a[href*='http']");
      return {
        name: rest[0]||"", association: rest[1]||"", duration,
        description: descEl ? clean(descEl.innerText) : "",
        url: link && !link.href.includes("linkedin.com/in/") ? link.href : "",
      };
    }).filter(e => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // VOLUNTEERING
  // ─────────────────────────────────────────────────────────
  function extractVolunteering(root) {
    root = root || findSection("volunteer") || findSection("volunteering");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      let duration = "", cause = "";
      const rest = spans.filter(s => {
        if (!duration && isDate(s))  { duration = s; return false; }
        if (/cause|social/i.test(s)) { cause = s;    return false; }
        return true;
      });
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { role: rest[0]||"", organization: rest[1]||"", duration, cause,
               description: descEl ? clean(descEl.innerText) : "" };
    }).filter(e => e.role);
  }

  // ─────────────────────────────────────────────────────────
  // LANGUAGES
  // ─────────────────────────────────────────────────────────
  function extractLanguages(root) {
    root = root || findSection("languages");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      return { language: spans[0]||"", proficiency: spans[1]||"" };
    }).filter(e => e.language);
  }

  // ─────────────────────────────────────────────────────────
  // HONORS & AWARDS
  // ─────────────────────────────────────────────────────────
  function extractHonors(root) {
    root = root || findSection("honors") || findSection("awards");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans  = getSpans(item);
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { title: spans[0]||"", issuer: spans[1]||"", date: spans[2]||"",
               description: descEl ? clean(descEl.innerText) : "" };
    }).filter(e => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // PUBLICATIONS
  // ─────────────────────────────────────────────────────────
  function extractPublications(root) {
    root = root || findSection("publications");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans  = getSpans(item);
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      const link   = q(item, "a[href*='http']");
      return { title: spans[0]||"", publisher: spans[1]||"", date: spans[2]||"",
               description: descEl ? clean(descEl.innerText) : "",
               url: link && !link.href.includes("linkedin.com") ? link.href : "" };
    }).filter(e => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // COURSES
  // ─────────────────────────────────────────────────────────
  function extractCourses(root) {
    root = root || findSection("courses");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans = getSpans(item);
      return { name: spans[0]||"", number: spans[1]||"" };
    }).filter(e => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────
  function extractRecommendations(root) {
    root = root || findSection("recommendations");
    if (!root) return [];
    return getItems(root).map(item => {
      const from   = firstText(item, ".t-bold span[aria-hidden='true']", ".t-16 span[aria-hidden='true']");
      const role   = firstText(item, ".t-14.t-normal span[aria-hidden='true']");
      const textEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { from, role, text: textEl ? clean(textEl.innerText) : "" };
    }).filter(e => e.from || e.text);
  }

  // ─────────────────────────────────────────────────────────
  // ORGANIZATIONS / PATENTS
  // ─────────────────────────────────────────────────────────
  function extractOrganizations(root) {
    root = root || findSection("organizations");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans  = getSpans(item);
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { name: spans[0]||"", role: spans[1]||"", duration: spans[2]||"",
               description: descEl ? clean(descEl.innerText) : "" };
    }).filter(e => e.name);
  }

  function extractPatents(root) {
    root = root || findSection("patents");
    if (!root) return [];
    return getItems(root).map(item => {
      const spans  = getSpans(item);
      const descEl = q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { title: spans[0]||"", status: spans[1]||"", number: spans[2]||"",
               date: spans[3]||"", description: descEl ? clean(descEl.innerText) : "" };
    }).filter(e => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // FORMATTERS
  // ─────────────────────────────────────────────────────────
  const DIV  = "═".repeat(60);
  const THIN = "─".repeat(50);
  const H    = t => ["", DIV, `  ${t.toUpperCase()}`, DIV].join("\n");
  const SH   = t => ["", `  ▸ ${t}`, `  ${THIN}`].join("\n");
  const FLD  = (label, val) => (val && val.toString().trim()) ? `  ${label}: ${val}` : null;

  function formatMain(profile) {
    const lines = [];
    const f = (label, val) => { const r = FLD(label, val); if (r) lines.push(r); };

    lines.push(DIV, "  LINKEDIN PROFILE EXTRACT",
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Mode      : Full Profile`, DIV,
      H("Personal Information"));
    f("Name", profile.header.name);
    f("Headline", profile.header.headline);
    f("Location", profile.header.location);
    f("Connections", profile.header.connections);
    if (profile.about) { lines.push(H("About"), `  ${profile.about}`); }

    const SECS = [
      ["experience",      "Experience",               (e,i) => { lines.push(SH(`Role ${i+1}`));     f("Title",e.title);f("Company",e.company);f("Duration",e.duration);f("Location",e.location);f("Description",e.description); }],
      ["education",       "Education",                (e,i) => { lines.push(SH(`Entry ${i+1}`));    f("School",e.school);f("Degree",e.degree);f("Field",e.field);f("Duration",e.duration);f("Description",e.description); }],
      ["skills",          "Skills",                   (e)   => { const x=[e.category,e.endorsements].filter(Boolean).join(" · "); lines.push(`  • ${e.name}${x?`  [${x}]`:""}`); }],
      ["certifications",  "Licenses & Certifications",(e,i) => { lines.push(SH(`Cert ${i+1}`));    f("Name",e.name);f("Issuer",e.issuer);f("Issued",e.issued);f("Expires",e.expiry);f("Credential ID",e.credentialId);f("URL",e.url); }],
      ["projects",        "Projects",                 (e,i) => { lines.push(SH(`Project ${i+1}`)); f("Name",e.name);f("Association",e.association);f("Duration",e.duration);f("Description",e.description);f("URL",e.url); }],
      ["volunteering",    "Volunteer Experience",     (e,i) => { lines.push(SH(`Entry ${i+1}`));    f("Role",e.role);f("Organization",e.organization);f("Duration",e.duration);f("Cause",e.cause);f("Description",e.description); }],
      ["languages",       "Languages",                (e)   => { lines.push(`  • ${e.language}${e.proficiency ? ` — ${e.proficiency}` : ""}`); }],
      ["honors",          "Honors & Awards",          (e,i) => { lines.push(SH(`Award ${i+1}`));    f("Title",e.title);f("Issuer",e.issuer);f("Date",e.date);f("Description",e.description); }],
      ["publications",    "Publications",             (e,i) => { lines.push(SH(`Pub ${i+1}`));      f("Title",e.title);f("Publisher",e.publisher);f("Date",e.date);f("Description",e.description);f("URL",e.url); }],
      ["courses",         "Courses",                  (e)   => { lines.push(`  • ${e.name}${e.number ? ` [${e.number}]` : ""}`); }],
      ["recommendations", "Recommendations",          (e,i) => { lines.push(SH(`Rec ${i+1}`));      f("From",e.from);f("Their Role",e.role); if(e.text){lines.push(`  Text:`);lines.push(`    "${e.text}"`);} }],
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
      lines.push("", "  No entries found. Scroll to fully load the page first.", "");
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

  // ─────────────────────────────────────────────────────────
  // EXTRACT ORCHESTRATION
  // ─────────────────────────────────────────────────────────
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
    const profileName = firstText(document, ".profile-detail__header-link", ".mn-connection-card__name", "h1");

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

    return { mode: "detail", section, data, count: data.length,
             formatted: formatDetail(sectionLabel, data, profileName) };
  }

  // ─────────────────────────────────────────────────────────
  // DEBUG HELPER
  // Open DevTools on the LinkedIn page and run: window.__liDebug()
  // This tells you exactly what the extractor sees in the DOM.
  // ─────────────────────────────────────────────────────────
  window.__liDebug = function () {
    const root = getDetailRoot();
    console.group("[Li Extractor] Debug Dump");
    console.log("URL:", window.location.href);
    console.log("Detected mode:", detectMode());
    console.log("Detail root el:", root);
    console.log("Total <li> in root:", qa(root, "li").length);
    console.log("artdeco-list__item:", qa(root, "li.artdeco-list__item").length);
    console.log("pvs-list__item (any):", qa(root, "li[class*='pvs-list__item']").length);
    console.log("data-view-name li:", qa(root, "li[data-view-name]").length);
    console.log("getItems() count:", getItems(root).length);
    const items = getItems(root);
    if (items.length) {
      console.log("First item spans:", getSpans(items[0]));
      console.log("First item HTML (600 chars):", items[0].outerHTML.slice(0, 600));
    }
    console.groupEnd();
  };

  // ─────────────────────────────────────────────────────────
  // MESSAGE HANDLER
  // ─────────────────────────────────────────────────────────
  window.__liExtractHandler = function (request, _sender, sendResponse) {
    if (request.action === "detectMode") {
      sendResponse({ success: true, data: detectMode() });
      return true;
    }
    if (request.action === "debug") {
      window.__liDebug();
      sendResponse({ success: true, data: { message: "Check DevTools console on the LinkedIn tab." } });
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
        console.error("[LinkedIn Extractor]", err);
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__liExtractHandler);

})();
