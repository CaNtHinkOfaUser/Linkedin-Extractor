// LinkedIn Profile Extractor — Content Script v1.2
// Supports two modes:
//   1. MAIN PROFILE  : linkedin.com/in/username
//   2. DETAIL PAGE   : linkedin.com/in/username/details/* sub-pages
//
// FIX: Wrapped in a guard so re-injection doesn't register duplicate listeners.

(function () {
  "use strict";

  // ── Guard against duplicate listener registration on re-inject ──
  if (window.__linkedinExtractorLoaded) return;
  window.__linkedinExtractorLoaded = true;

  // ─────────────────────────────────────────────────────────
  // URL → section name mapping for /details/* sub-pages
  // ─────────────────────────────────────────────────────────

  const DETAIL_PAGE_MAP = {
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
  // UTILITY
  // ─────────────────────────────────────────────────────────

  function clean(text) {
    if (!text) return "";
    return text
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getText(el, selector) {
    if (!el) return "";
    const found = selector ? el.querySelector(selector) : el;
    return found ? clean(found.innerText || found.textContent) : "";
  }

  function getAll(root, selector) {
    return root ? Array.from(root.querySelectorAll(selector)) : [];
  }

  // FIX: Only get direct aria-hidden spans, not deeply nested ones that
  // belong to child list items — avoids duplicating nested experience roles.
  function getSpans(el) {
    if (!el) return [];
    // Collect spans but exclude those that are inside a nested list item
    return Array.from(el.querySelectorAll("span[aria-hidden='true']"))
      .filter((s) => {
        // Exclude if this span lives inside a nested <li> that is a descendant of el
        let parent = s.parentElement;
        while (parent && parent !== el) {
          if (parent.tagName === "LI" && parent !== el) return false;
          parent = parent.parentElement;
        }
        return true;
      })
      .map((s) => clean(s.innerText))
      .filter((s) => s && s !== "·" && s !== "•" && s !== "|");
  }

  function getDescription(item) {
    const candidates = [
      ".inline-show-more-text span[aria-hidden='true']",
      ".pvs-list__outer-container span[aria-hidden='true']",
      ".display-flex.full-width span[aria-hidden='true']",
    ];
    for (const sel of candidates) {
      const el = item.querySelector(sel);
      if (el) {
        const t = clean(el.innerText);
        if (t.length > 30) return t;
      }
    }
    const all = getSpans(item);
    return all.reduce((longest, s) => (s.length > longest.length ? s : longest), "");
  }

  // ─────────────────────────────────────────────────────────
  // PAGE MODE DETECTION
  // ─────────────────────────────────────────────────────────

  function detectMode() {
    const path = window.location.pathname;
    const detailMatch = path.match(/\/in\/[^/]+\/details\/([^/]+)\/?/);
    if (detailMatch) {
      const slug = detailMatch[1].toLowerCase();
      const section = DETAIL_PAGE_MAP[slug] || slug;
      return { mode: "detail", section, slug };
    }
    if (path.match(/\/in\/[^/]+\/?$/)) {
      return { mode: "main" };
    }
    return { mode: "unknown" };
  }

  // ─────────────────────────────────────────────────────────
  // SECTION FINDER (for main profile page)
  // ─────────────────────────────────────────────────────────

  function findSectionByHeading(keyword) {
    const kw = keyword.toLowerCase();
    for (const sec of getAll(document, "section")) {
      const label = (sec.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes(kw)) return sec;
      const h2 = sec.querySelector("h2");
      if (h2 && clean(h2.innerText).toLowerCase().includes(kw)) return sec;
      const dataSec = (sec.getAttribute("data-section") || "").toLowerCase();
      if (dataSec.includes(kw)) return sec;
    }
    return null;
  }

  // Detail page: items live inside main
  function getDetailRoot() {
    return (
      document.querySelector("main .scaffold-finite-scroll__content") ||
      document.querySelector("main") ||
      document.body
    );
  }

  // ─────────────────────────────────────────────────────────
  // HEADER
  // ─────────────────────────────────────────────────────────

  function extractHeader() {
    const name =
      getText(document, "h1.text-heading-xlarge") ||
      getText(document, "h1");

    const headline =
      getText(document, ".text-body-medium.break-words") ||
      getText(document, ".pv-text-details__left-panel .t-16");

    const locationEl = document.querySelector(
      ".text-body-small.inline.t-black--light.break-words, " +
      ".pv-text-details__left-panel .t-14 span[aria-hidden='true']"
    );
    const location = locationEl ? clean(locationEl.innerText) : "";

    const connectionsEl = document.querySelector(
      ".pvs-header__optional-link .t-bold, " +
      ".pv-text-details__right-panel span.t-bold"
    );
    const connections = connectionsEl ? clean(connectionsEl.innerText) : "";

    return { name, headline, location, connections };
  }

  // ─────────────────────────────────────────────────────────
  // ABOUT
  // ─────────────────────────────────────────────────────────

  function extractAbout() {
    const section =
      findSectionByHeading("about") ||
      document.querySelector("section[data-section='summary']");
    if (!section) return "";
    const spans = getAll(section, "span[aria-hidden='true']")
      .map((s) => clean(s.innerText))
      .filter(Boolean);
    return spans.reduce((a, b) => (b.length > a.length ? b : a), "");
  }

  // ─────────────────────────────────────────────────────────
  // EXPERIENCE
  // ─────────────────────────────────────────────────────────

  function parseExpItem(item, overrideCompany) {
    const spans = getSpans(item);
    const datePattern = /([A-Z][a-z]{2,9}\.?\s+\d{4}|Present)\s*[–\-—]\s*([A-Z][a-z]{2,9}\.?\s+\d{4}|Present)/;
    const yearPattern  = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
    const durationPattern = /\d+\s*(yr|yrs|mo|mos)/i;

    let duration = "", durationLen = "";
    for (const s of spans) {
      if (!duration && (datePattern.test(s) || yearPattern.test(s))) { duration = s; }
      else if (!durationLen && durationPattern.test(s)) { durationLen = s; }
    }

    const meaningful = spans.filter(
      (s) => !datePattern.test(s) && !yearPattern.test(s) && !durationPattern.test(s)
    );

    const entry = {
      title:       meaningful[0] || "",
      company:     overrideCompany || meaningful[1] || "",
      duration:    [duration, durationLen].filter(Boolean).join(" · "),
      location:    "",
      description: "",
    };

    const nonHeader = meaningful.slice(overrideCompany ? 1 : 2);
    for (const s of nonHeader) {
      if (s.length < 60 && !entry.location) entry.location = s;
      else if (s.length > 30 && !entry.description) entry.description = s;
    }
    return entry;
  }

  function extractExperience(root) {
    root = root || findSectionByHeading("experience");
    if (!root) return [];
    const entries = [];
    // FIX: Only get top-level list items, not nested ones inside sub-lists.
    const topLevelItems = Array.from(root.querySelectorAll("li.artdeco-list__item")).filter((li) => {
      // Exclude if this li is nested inside another li that is also artdeco-list__item
      return !li.parentElement?.closest("li.artdeco-list__item");
    });

    for (const item of topLevelItems) {
      const nested = getAll(item, ".pvs-entity--with-path li.artdeco-list__item");
      if (nested.length > 0) {
        const companyEl = item.querySelector(".t-16.t-black.t-bold span[aria-hidden='true'], .t-bold span[aria-hidden='true']");
        const company = companyEl ? clean(companyEl.innerText) : "";
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
    root = root || findSectionByHeading("education");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const yearPat = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
        let duration = "";
        const rest = spans.filter((s) => {
          if (!duration && yearPat.test(s)) { duration = s; return false; }
          return true;
        });
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        return {
          school:      rest[0] || "",
          degree:      rest[1] || "",
          field:       rest[2] || "",
          duration,
          grade:       rest.find((s) => /grade|cgpa|gpa/i.test(s)) || "",
          activities:  rest.find((s) => /activities|clubs|societies/i.test(s)) || "",
          description: descEl ? clean(descEl.innerText) : "",
        };
      })
      .filter((e) => e.school);
  }

  // ─────────────────────────────────────────────────────────
  // SKILLS
  // ─────────────────────────────────────────────────────────

  function extractSkills(root) {
    root = root || findSectionByHeading("skills");
    if (!root) return [];
    const seen = new Set();
    const skills = [];
    getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .forEach((item) => {
        const nameEl =
          item.querySelector(".t-bold span[aria-hidden='true']") ||
          item.querySelector(".t-16 span[aria-hidden='true']");
        const name = nameEl ? clean(nameEl.innerText) : "";
        if (!name || seen.has(name)) return;
        seen.add(name);
        const subSpans = getSpans(item).filter((s) => s !== name);
        const endorseText = subSpans.find((s) => /endorsement|people/i.test(s)) || "";
        const category    = subSpans.find((s) => !/endorsement|people/i.test(s) && s.length < 60) || "";
        skills.push({ name, category, endorsements: endorseText });
      });
    return skills;
  }

  // ─────────────────────────────────────────────────────────
  // CERTIFICATIONS
  // ─────────────────────────────────────────────────────────

  function extractCertifications(root) {
    root = root ||
      findSectionByHeading("licenses & certifications") ||
      findSectionByHeading("certifications");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        let issued = "", expiry = "", credentialId = "";
        const rest = spans.filter((s) => {
          if (/^issued/i.test(s))       { issued = s;        return false; }
          if (/expir/i.test(s))         { expiry = s;        return false; }
          if (/credential id/i.test(s)) {
            credentialId = s.replace(/credential id[:\s]*/i, "").trim();
            return false;
          }
          return true;
        });
        const link = item.querySelector("a[href*='http']");
        const url  = link && !link.href.includes("linkedin.com") ? link.href : "";
        return { name: rest[0] || "", issuer: rest[1] || "", issued, expiry, credentialId, url };
      })
      .filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // PROJECTS
  // ─────────────────────────────────────────────────────────

  function extractProjects(root) {
    root = root || findSectionByHeading("projects");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const datePat = /([A-Z][a-z]{2,9}\.?\s+\d{4}|Present)\s*[–\-—]/;
        let duration = "";
        const rest = spans.filter((s) => {
          if (!duration && datePat.test(s)) { duration = s; return false; }
          return true;
        });
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        const link = item.querySelector("a[href*='http']");
        return {
          name:        rest[0] || "",
          association: rest[1] || "",
          duration,
          description: descEl ? clean(descEl.innerText) : getDescription(item),
          url:         link && !link.href.includes("linkedin.com/in/") ? link.href : "",
        };
      })
      .filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // VOLUNTEERING
  // ─────────────────────────────────────────────────────────

  function extractVolunteering(root) {
    root = root ||
      findSectionByHeading("volunteer experience") ||
      findSectionByHeading("volunteering");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const datePat = /([A-Z][a-z]{2,9}\.?\s+\d{4}|Present)\s*[–\-—]/;
        let duration = "", cause = "";
        const rest = spans.filter((s) => {
          if (!duration && datePat.test(s))  { duration = s; return false; }
          if (/cause|social/i.test(s))       { cause = s;    return false; }
          return true;
        });
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        return {
          role:         rest[0] || "",
          organization: rest[1] || "",
          duration,
          cause,
          description: descEl ? clean(descEl.innerText) : "",
        };
      })
      .filter((e) => e.role);
  }

  // ─────────────────────────────────────────────────────────
  // LANGUAGES
  // ─────────────────────────────────────────────────────────

  function extractLanguages(root) {
    root = root || findSectionByHeading("languages");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        return { language: spans[0] || "", proficiency: spans[1] || "" };
      })
      .filter((e) => e.language);
  }

  // ─────────────────────────────────────────────────────────
  // HONORS & AWARDS
  // ─────────────────────────────────────────────────────────

  function extractHonors(root) {
    root = root ||
      findSectionByHeading("honors & awards") ||
      findSectionByHeading("honors");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        return {
          title:       spans[0] || "",
          issuer:      spans[1] || "",
          date:        spans[2] || "",
          description: descEl ? clean(descEl.innerText) : "",
        };
      })
      .filter((e) => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // PUBLICATIONS
  // ─────────────────────────────────────────────────────────

  function extractPublications(root) {
    root = root || findSectionByHeading("publications");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        const link = item.querySelector("a[href*='http']");
        return {
          title:       spans[0] || "",
          publisher:   spans[1] || "",
          date:        spans[2] || "",
          description: descEl ? clean(descEl.innerText) : "",
          url:         link && !link.href.includes("linkedin.com") ? link.href : "",
        };
      })
      .filter((e) => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // COURSES
  // ─────────────────────────────────────────────────────────

  function extractCourses(root) {
    root = root || findSectionByHeading("courses");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        return { name: spans[0] || "", number: spans[1] || "" };
      })
      .filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────

  function extractRecommendations(root) {
    root = root || findSectionByHeading("recommendations");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const nameEl = item.querySelector(".t-bold span[aria-hidden='true'], .t-16 span[aria-hidden='true']");
        const roleEl = item.querySelector(".t-14.t-normal span[aria-hidden='true']");
        const textEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        const from   = nameEl ? clean(nameEl.innerText) : "";
        const text   = textEl ? clean(textEl.innerText) : getDescription(item);
        return {
          from,
          role: roleEl ? clean(roleEl.innerText) : "",
          text,
        };
      })
      .filter((e) => e.from || e.text);
  }

  // ─────────────────────────────────────────────────────────
  // ORGANIZATIONS
  // ─────────────────────────────────────────────────────────

  function extractOrganizations(root) {
    root = root || findSectionByHeading("organizations");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        return {
          name:        spans[0] || "",
          role:        spans[1] || "",
          duration:    spans[2] || "",
          description: descEl ? clean(descEl.innerText) : "",
        };
      })
      .filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // PATENTS
  // ─────────────────────────────────────────────────────────

  function extractPatents(root) {
    root = root || findSectionByHeading("patents");
    if (!root) return [];
    return getAll(root, "li.artdeco-list__item")
      .filter((li) => !li.parentElement?.closest("li.artdeco-list__item"))
      .map((item) => {
        const spans = getSpans(item);
        const descEl = item.querySelector(".inline-show-more-text span[aria-hidden='true']");
        return {
          title:       spans[0] || "",
          status:      spans[1] || "",
          number:      spans[2] || "",
          date:        spans[3] || "",
          description: descEl ? clean(descEl.innerText) : "",
        };
      })
      .filter((e) => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // FORMATTERS
  // ─────────────────────────────────────────────────────────

  const DIV  = "═".repeat(60);
  const THIN = "─".repeat(50);

  function heading(title) {
    return ["", DIV, `  ${title.toUpperCase()}`, DIV].join("\n");
  }
  function subHeading(title) {
    return ["", `  ▸ ${title}`, `  ${THIN}`].join("\n");
  }
  function field(label, value) {
    if (!value || !value.toString().trim()) return null;
    return `  ${label}: ${value}`;
  }

  function formatMain(profile) {
    const lines = [];
    const f = (label, val) => { const r = field(label, val); if (r) lines.push(r); };

    lines.push(DIV, "  LINKEDIN PROFILE EXTRACT",
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Mode      : Full Profile`, DIV);

    lines.push(heading("Personal Information"));
    f("Name", profile.header.name); f("Headline", profile.header.headline);
    f("Location", profile.header.location); f("Connections", profile.header.connections);

    if (profile.about) { lines.push(heading("About")); lines.push(`  ${profile.about}`); }

    const sections = [
      ["experience",      "Experience",                  (e, i) => { lines.push(subHeading(`Role ${i+1}`)); f("Title",e.title);f("Company",e.company);f("Duration",e.duration);f("Location",e.location);f("Description",e.description); }],
      ["education",       "Education",                   (e, i) => { lines.push(subHeading(`Entry ${i+1}`)); f("School",e.school);f("Degree",e.degree);f("Field",e.field);f("Duration",e.duration);f("Grade",e.grade);f("Activities",e.activities);f("Description",e.description); }],
      ["skills",          "Skills",                      (e)    => { const x=[e.category,e.endorsements].filter(Boolean).join(" · "); lines.push(`  • ${e.name}${x?`  [${x}]`:""}`); }],
      ["certifications",  "Licenses & Certifications",   (e, i) => { lines.push(subHeading(`Cert ${i+1}`)); f("Name",e.name);f("Issuer",e.issuer);f("Issued",e.issued);f("Expires",e.expiry);f("Credential ID",e.credentialId);f("URL",e.url); }],
      ["projects",        "Projects",                    (e, i) => { lines.push(subHeading(`Project ${i+1}`)); f("Name",e.name);f("Association",e.association);f("Duration",e.duration);f("Description",e.description);f("URL",e.url); }],
      ["volunteering",    "Volunteer Experience",        (e, i) => { lines.push(subHeading(`Entry ${i+1}`)); f("Role",e.role);f("Organization",e.organization);f("Duration",e.duration);f("Cause",e.cause);f("Description",e.description); }],
      ["languages",       "Languages",                   (e)    => { lines.push(`  • ${e.language}${e.proficiency ? ` — ${e.proficiency}` : ""}`); }],
      ["honors",          "Honors & Awards",             (e, i) => { lines.push(subHeading(`Award ${i+1}`)); f("Title",e.title);f("Issuer",e.issuer);f("Date",e.date);f("Description",e.description); }],
      ["publications",    "Publications",                (e, i) => { lines.push(subHeading(`Pub ${i+1}`)); f("Title",e.title);f("Publisher",e.publisher);f("Date",e.date);f("Description",e.description);f("URL",e.url); }],
      ["courses",         "Courses",                     (e)    => { lines.push(`  • ${e.name}${e.number ? ` [${e.number}]` : ""}`); }],
      ["recommendations", "Recommendations",             (e, i) => { lines.push(subHeading(`Rec ${i+1}`)); f("From",e.from);f("Their Role",e.role); if(e.text){lines.push(`  Text:`);lines.push(`    "${e.text}"`);} }],
    ];

    for (const [key, label, renderer] of sections) {
      const data = profile[key];
      if (!data || !data.length) continue;
      lines.push(heading(`${label} (${data.length})`));
      data.forEach(renderer);
    }

    lines.push("", DIV, "  END OF PROFILE EXTRACT", DIV, "");
    return lines.filter((l) => l !== null).join("\n");
  }

  function formatDetailSection(sectionName, data, profileName) {
    const lines = [];
    lines.push(
      DIV,
      `  LINKEDIN — ${sectionName.toUpperCase()}`,
      profileName ? `  Profile   : ${profileName}` : null,
      `  Extracted : ${new Date().toLocaleString()}`,
      `  Source    : ${window.location.href}`,
      `  Mode      : Detail Page — all ${data.length} entries`,
      DIV
    );

    if (!data.length) {
      lines.push("", "  No entries found on this page.", "");
    } else {
      data.forEach((entry, i) => {
        lines.push(subHeading(`Entry ${i + 1}`));
        for (const [key, val] of Object.entries(entry)) {
          if (!val || !val.toString().trim()) continue;
          const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
          if (key === "text") {
            lines.push(`  ${label}:`);
            lines.push(`    "${val}"`);
          } else {
            lines.push(`  ${label}: ${val}`);
          }
        }
      });
    }

    lines.push("", DIV, `  END — ${data.length} ENTRIES EXTRACTED`, DIV, "");
    return lines.filter((l) => l !== null).join("\n");
  }

  // ─────────────────────────────────────────────────────────
  // MAIN EXTRACT FUNCTIONS
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
    const root = getDetailRoot();
    const profileName =
      getText(document, ".profile-detail__header-link") ||
      getText(document, "h1") || "";

    const EXTRACTOR_MAP = {
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

    const extractor = EXTRACTOR_MAP[section];
    const data = extractor ? extractor() : [];
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);

    return {
      mode:      "detail",
      section,
      data,
      count:     data.length,
      formatted: formatDetailSection(sectionLabel, data, profileName),
    };
  }

  // ─────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "detectMode") {
      sendResponse({ success: true, data: detectMode() });
      return true;
    }

    if (request.action === "extract") {
      try {
        const { mode, section } = detectMode();
        let result;
        if (mode === "main") {
          result = extractMainProfile();
        } else if (mode === "detail") {
          result = extractDetailPage(section);
        } else {
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
  });

})();
