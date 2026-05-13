// LinkedIn Profile Extractor — Content Script v1.3
// Multi-strategy extraction: tries multiple selectors so it works
// regardless of which LinkedIn DOM variant is served.

(function () {
  "use strict";

  if (window.__linkedinExtractorLoaded) return;
  window.__linkedinExtractorLoaded = true;

  // ─────────────────────────────────────────────────────────
  // URL → section name mapping
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

  function $q(root, sel) {
    return (root || document).querySelector(sel);
  }

  function $qa(root, sel) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  // Get visible text spans inside an element, excluding those inside
  // a nested list item (to avoid absorbing child-entry text).
  function getSpans(el) {
    if (!el) return [];
    return $qa(el, "span[aria-hidden='true']")
      .filter((s) => {
        let p = s.parentElement;
        while (p && p !== el) {
          if (p.tagName === "LI") return false;
          p = p.parentElement;
        }
        return true;
      })
      .map((s) => clean(s.innerText || s.textContent))
      .filter((s) => s && s !== "·" && s !== "•" && s !== "|" && s !== "–" && s !== "-");
  }

  // Get ALL visible text spans (including nested) — used for about/text blocks.
  function getAllSpans(el) {
    if (!el) return [];
    return $qa(el, "span[aria-hidden='true']")
      .map((s) => clean(s.innerText || s.textContent))
      .filter((s) => s && s !== "·" && s !== "•" && s !== "|" && s !== "–" && s !== "-");
  }

  // innerText of the first matching selector that has text.
  function getText(root, ...selectors) {
    for (const sel of selectors) {
      const el = $q(root, sel);
      if (el) {
        const t = clean(el.innerText || el.textContent);
        if (t) return t;
      }
    }
    return "";
  }

  // ─────────────────────────────────────────────────────────
  // ITEM FINDERS — multiple strategies, most specific first
  // ─────────────────────────────────────────────────────────

  // Returns top-level list items from a root, trying several selectors.
  function getItems(root) {
    if (!root) return [];

    // Try each selector; return first that yields results.
    // "top-level" = not nested inside another matching li.
    const ITEM_SELECTORS = [
      "li.artdeco-list__item",
      "li.pvs-list__item--line-separated",
      "li.pvs-list__item--with-top-padding",
      "li[class*='pvs-list__item']",
      "li[data-view-name]",
    ];

    for (const sel of ITEM_SELECTORS) {
      const all   = $qa(root, sel);
      const items = all.filter((li) => !li.parentElement?.closest(sel));
      if (items.length > 0) return items;
    }

    // Last resort: direct <li> children of the first <ul> with multiple items.
    for (const ul of $qa(root, "ul")) {
      const lis = Array.from(ul.children).filter((c) => c.tagName === "LI");
      if (lis.length > 0) return lis;
    }

    return [];
  }

  // ─────────────────────────────────────────────────────────
  // PAGE MODE DETECTION
  // ─────────────────────────────────────────────────────────

  function detectMode() {
    const path = window.location.pathname;
    const detailMatch = path.match(/\/in\/[^/]+\/details\/([^/?]+)/);
    if (detailMatch) {
      const slug    = detailMatch[1].toLowerCase();
      const section = DETAIL_PAGE_MAP[slug] || slug;
      return { mode: "detail", section, slug };
    }
    if (path.match(/\/in\/[^/?]+\/?$/)) {
      return { mode: "main" };
    }
    return { mode: "unknown" };
  }

  // ─────────────────────────────────────────────────────────
  // ROOT FINDERS
  // ─────────────────────────────────────────────────────────

  function getDetailRoot() {
    return (
      $q(document, "main .scaffold-finite-scroll__content") ||
      $q(document, ".scaffold-finite-scroll__content")      ||
      $q(document, "main")                                  ||
      document.body
    );
  }

  function findSection(keyword) {
    const kw = keyword.toLowerCase();

    // 1. aria-label on <section>
    for (const sec of $qa(document, "section")) {
      if ((sec.getAttribute("aria-label") || "").toLowerCase().includes(kw)) return sec;
    }
    // 2. h2 text inside <section>
    for (const sec of $qa(document, "section")) {
      const h2 = $q(sec, "h2");
      if (h2 && clean(h2.innerText).toLowerCase().includes(kw)) return sec;
    }
    // 3. data-section attribute
    for (const sec of $qa(document, "section")) {
      if ((sec.getAttribute("data-section") || "").toLowerCase().includes(kw)) return sec;
    }
    // 4. id containing keyword
    const slug  = kw.replace(/\s/g, "-");
    const byId  = $q(document, `[id*="${slug}"]`);
    if (byId) return byId.closest("section") || byId;

    return null;
  }

  // ─────────────────────────────────────────────────────────
  // HEADER
  // ─────────────────────────────────────────────────────────

  function extractHeader() {
    const name = getText(document,
      "h1.text-heading-xlarge",
      ".pv-text-details__left-panel h1",
      "h1"
    );
    const headline = getText(document,
      ".text-body-medium.break-words",
      ".pv-text-details__left-panel .t-16",
      "[data-generated-suggestion-target] ~ div .t-16"
    );
    const location = getText(document,
      ".text-body-small.inline.t-black--light.break-words",
      ".pv-text-details__left-panel .t-14 span[aria-hidden='true']"
    );
    const connections = getText(document,
      ".pvs-header__optional-link .t-bold",
      ".pv-text-details__right-panel span.t-bold",
      "a[href*='connections'] span.t-bold"
    );
    return { name, headline, location, connections };
  }

  // ─────────────────────────────────────────────────────────
  // ABOUT
  // ─────────────────────────────────────────────────────────

  function extractAbout() {
    const section =
      findSection("about") ||
      $q(document, "section[data-section='summary']");
    if (!section) return "";

    const showMore = $q(section, ".inline-show-more-text span[aria-hidden='true']");
    if (showMore) {
      const t = clean(showMore.innerText);
      if (t.length > 10) return t;
    }

    const spans = getAllSpans(section).filter(Boolean);
    return spans.reduce((a, b) => (b.length > a.length ? b : a), "");
  }

  // ─────────────────────────────────────────────────────────
  // EXPERIENCE
  // ─────────────────────────────────────────────────────────

  const DATE_PAT     = /([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)\s*[–\-—]\s*([A-Z][a-z]{2,8}\.?\s+\d{4}|Present)/;
  const YEAR_PAT     = /\d{4}\s*[–\-—]\s*(\d{4}|Present)/;
  const DURATION_PAT = /\d+\s*(yr|yrs|mo|mos)/i;

  function parseExpItem(item, overrideCompany) {
    const spans = getSpans(item);
    let duration = "", durationLen = "";
    for (const s of spans) {
      if (!duration && (DATE_PAT.test(s) || YEAR_PAT.test(s))) { duration = s; }
      else if (!durationLen && DURATION_PAT.test(s)) { durationLen = s; }
    }
    const meaningful = spans.filter(
      (s) => !DATE_PAT.test(s) && !YEAR_PAT.test(s) && !DURATION_PAT.test(s)
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
      else if (s.length >= 30 && !entry.description) entry.description = s;
    }
    return entry;
  }

  function extractExperience(root) {
    root = root || findSection("experience");
    if (!root) return [];
    const entries = [];
    for (const item of getItems(root)) {
      const nested = $qa(item, "li.artdeco-list__item, li[class*='pvs-list__item']").filter(
        (li) => li !== item && item.contains(li)
      );
      if (nested.length > 0) {
        const companyEl =
          $q(item, ".t-16.t-black.t-bold span[aria-hidden='true']") ||
          $q(item, ".t-bold span[aria-hidden='true']");
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
    root = root || findSection("education");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      let duration = "";
      const rest = spans.filter((s) => {
        if (!duration && (YEAR_PAT.test(s) || DATE_PAT.test(s))) { duration = s; return false; }
        return true;
      });
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      return {
        school:      rest[0] || "",
        degree:      rest[1] || "",
        field:       rest[2] || "",
        duration,
        grade:       rest.find((s) => /grade|cgpa|gpa/i.test(s)) || "",
        activities:  rest.find((s) => /activities|clubs|societies/i.test(s)) || "",
        description: descEl ? clean(descEl.innerText) : "",
      };
    }).filter((e) => e.school);
  }

  // ─────────────────────────────────────────────────────────
  // SKILLS
  // ─────────────────────────────────────────────────────────

  function extractSkills(root) {
    root = root || findSection("skills");
    if (!root) return [];
    const seen = new Set();
    const skills = [];
    for (const item of getItems(root)) {
      const nameEl =
        $q(item, ".t-bold span[aria-hidden='true']") ||
        $q(item, ".t-16 span[aria-hidden='true']")   ||
        $q(item, "span[aria-hidden='true']");
      const name = nameEl ? clean(nameEl.innerText) : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const subSpans    = getSpans(item).filter((s) => s !== name);
      const endorseText = subSpans.find((s) => /endorsement|people/i.test(s)) || "";
      const category    = subSpans.find((s) => !/endorsement|people/i.test(s) && s.length < 60) || "";
      skills.push({ name, category, endorsements: endorseText });
    }
    return skills;
  }

  // ─────────────────────────────────────────────────────────
  // CERTIFICATIONS
  // ─────────────────────────────────────────────────────────

  function extractCertifications(root) {
    root = root ||
      findSection("licenses") ||
      findSection("certifications");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      let issued = "", expiry = "", credentialId = "";
      const rest = spans.filter((s) => {
        if (/^issued/i.test(s))       { issued = s; return false; }
        if (/expir/i.test(s))         { expiry = s; return false; }
        if (/credential id/i.test(s)) {
          credentialId = s.replace(/credential id[:\s]*/i, "").trim();
          return false;
        }
        return true;
      });
      const link = $q(item, "a[href*='http']");
      const url  = link && !link.href.includes("linkedin.com") ? link.href : "";
      return { name: rest[0] || "", issuer: rest[1] || "", issued, expiry, credentialId, url };
    }).filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // PROJECTS
  // ─────────────────────────────────────────────────────────

  function extractProjects(root) {
    root = root || findSection("projects");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      let duration = "";
      const rest = spans.filter((s) => {
        if (!duration && (DATE_PAT.test(s) || YEAR_PAT.test(s))) { duration = s; return false; }
        return true;
      });
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      const link   = $q(item, "a[href*='http']");
      return {
        name:        rest[0] || "",
        association: rest[1] || "",
        duration,
        description: descEl ? clean(descEl.innerText) : "",
        url:         link && !link.href.includes("linkedin.com/in/") ? link.href : "",
      };
    }).filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // VOLUNTEERING
  // ─────────────────────────────────────────────────────────

  function extractVolunteering(root) {
    root = root || findSection("volunteer") || findSection("volunteering");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      let duration = "", cause = "";
      const rest = spans.filter((s) => {
        if (!duration && (DATE_PAT.test(s) || YEAR_PAT.test(s))) { duration = s; return false; }
        if (/cause|social/i.test(s)) { cause = s; return false; }
        return true;
      });
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      return {
        role:         rest[0] || "",
        organization: rest[1] || "",
        duration, cause,
        description: descEl ? clean(descEl.innerText) : "",
      };
    }).filter((e) => e.role);
  }

  // ─────────────────────────────────────────────────────────
  // LANGUAGES
  // ─────────────────────────────────────────────────────────

  function extractLanguages(root) {
    root = root || findSection("languages");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      return { language: spans[0] || "", proficiency: spans[1] || "" };
    }).filter((e) => e.language);
  }

  // ─────────────────────────────────────────────────────────
  // HONORS & AWARDS
  // ─────────────────────────────────────────────────────────

  function extractHonors(root) {
    root = root || findSection("honors") || findSection("awards");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans  = getSpans(item);
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      return {
        title:       spans[0] || "",
        issuer:      spans[1] || "",
        date:        spans[2] || "",
        description: descEl ? clean(descEl.innerText) : "",
      };
    }).filter((e) => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // PUBLICATIONS
  // ─────────────────────────────────────────────────────────

  function extractPublications(root) {
    root = root || findSection("publications");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans  = getSpans(item);
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      const link   = $q(item, "a[href*='http']");
      return {
        title:       spans[0] || "",
        publisher:   spans[1] || "",
        date:        spans[2] || "",
        description: descEl ? clean(descEl.innerText) : "",
        url:         link && !link.href.includes("linkedin.com") ? link.href : "",
      };
    }).filter((e) => e.title);
  }

  // ─────────────────────────────────────────────────────────
  // COURSES
  // ─────────────────────────────────────────────────────────

  function extractCourses(root) {
    root = root || findSection("courses");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans = getSpans(item);
      return { name: spans[0] || "", number: spans[1] || "" };
    }).filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // RECOMMENDATIONS
  // ─────────────────────────────────────────────────────────

  function extractRecommendations(root) {
    root = root || findSection("recommendations");
    if (!root) return [];
    return getItems(root).map((item) => {
      const from   = getText(item, ".t-bold span[aria-hidden='true']", ".t-16 span[aria-hidden='true']");
      const role   = getText(item, ".t-14.t-normal span[aria-hidden='true']");
      const textEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      const text   = textEl ? clean(textEl.innerText) : "";
      return { from, role, text };
    }).filter((e) => e.from || e.text);
  }

  // ─────────────────────────────────────────────────────────
  // ORGANIZATIONS
  // ─────────────────────────────────────────────────────────

  function extractOrganizations(root) {
    root = root || findSection("organizations");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans  = getSpans(item);
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { name: spans[0]||"", role: spans[1]||"", duration: spans[2]||"", description: descEl ? clean(descEl.innerText) : "" };
    }).filter((e) => e.name);
  }

  // ─────────────────────────────────────────────────────────
  // PATENTS
  // ─────────────────────────────────────────────────────────

  function extractPatents(root) {
    root = root || findSection("patents");
    if (!root) return [];
    return getItems(root).map((item) => {
      const spans  = getSpans(item);
      const descEl = $q(item, ".inline-show-more-text span[aria-hidden='true']");
      return { title: spans[0]||"", status: spans[1]||"", number: spans[2]||"", date: spans[3]||"", description: descEl ? clean(descEl.innerText) : "" };
    }).filter((e) => e.title);
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
    f("Name", profile.header.name);
    f("Headline", profile.header.headline);
    f("Location", profile.header.location);
    f("Connections", profile.header.connections);

    if (profile.about) {
      lines.push(heading("About"));
      lines.push(`  ${profile.about}`);
    }

    const SECTIONS = [
      ["experience",      "Experience",               (e,i) => { lines.push(subHeading(`Role ${i+1}`));    f("Title",e.title);f("Company",e.company);f("Duration",e.duration);f("Location",e.location);f("Description",e.description); }],
      ["education",       "Education",                (e,i) => { lines.push(subHeading(`Entry ${i+1}`));   f("School",e.school);f("Degree",e.degree);f("Field",e.field);f("Duration",e.duration);f("Grade",e.grade);f("Activities",e.activities);f("Description",e.description); }],
      ["skills",          "Skills",                   (e)   => { const x=[e.category,e.endorsements].filter(Boolean).join(" · "); lines.push(`  • ${e.name}${x?`  [${x}]`:""}`); }],
      ["certifications",  "Licenses & Certifications",(e,i) => { lines.push(subHeading(`Cert ${i+1}`));   f("Name",e.name);f("Issuer",e.issuer);f("Issued",e.issued);f("Expires",e.expiry);f("Credential ID",e.credentialId);f("URL",e.url); }],
      ["projects",        "Projects",                 (e,i) => { lines.push(subHeading(`Project ${i+1}`)); f("Name",e.name);f("Association",e.association);f("Duration",e.duration);f("Description",e.description);f("URL",e.url); }],
      ["volunteering",    "Volunteer Experience",     (e,i) => { lines.push(subHeading(`Entry ${i+1}`));   f("Role",e.role);f("Organization",e.organization);f("Duration",e.duration);f("Cause",e.cause);f("Description",e.description); }],
      ["languages",       "Languages",                (e)   => { lines.push(`  • ${e.language}${e.proficiency ? ` — ${e.proficiency}` : ""}`); }],
      ["honors",          "Honors & Awards",          (e,i) => { lines.push(subHeading(`Award ${i+1}`));   f("Title",e.title);f("Issuer",e.issuer);f("Date",e.date);f("Description",e.description); }],
      ["publications",    "Publications",             (e,i) => { lines.push(subHeading(`Pub ${i+1}`));     f("Title",e.title);f("Publisher",e.publisher);f("Date",e.date);f("Description",e.description);f("URL",e.url); }],
      ["courses",         "Courses",                  (e)   => { lines.push(`  • ${e.name}${e.number ? ` [${e.number}]` : ""}`); }],
      ["recommendations", "Recommendations",          (e,i) => { lines.push(subHeading(`Rec ${i+1}`));     f("From",e.from);f("Their Role",e.role); if(e.text){lines.push(`  Text:`);lines.push(`    "${e.text}"`);} }],
    ];

    for (const [key, label, renderer] of SECTIONS) {
      const data = profile[key];
      if (!data || !data.length) continue;
      lines.push(heading(`${label} (${data.length})`));
      data.forEach(renderer);
    }

    lines.push("", DIV, "  END OF PROFILE EXTRACT", DIV, "");
    return lines.filter((l) => l !== null).join("\n");
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
      lines.push("", "  No entries found. Make sure the page has fully loaded.", "");
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
    const root        = getDetailRoot();
    const profileName = getText(document,
      ".profile-detail__header-link",
      ".mn-connection-card__name",
      "h1"
    );

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

    const extractor    = EXTRACTOR_MAP[section];
    const data         = extractor ? extractor() : [];
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);

    return {
      mode:      "detail",
      section,
      data,
      count:     data.length,
      formatted: formatDetail(sectionLabel, data, profileName),
    };
  }

  // ─────────────────────────────────────────────────────────
  // DEBUG HELPER — open DevTools console to see this output
  // ─────────────────────────────────────────────────────────

  function debugDump() {
    const root = getDetailRoot();
    const info = {
      url:              window.location.href,
      mode:             detectMode(),
      liTotal:          $qa(root, "li").length,
      artdecoItems:     $qa(root, "li.artdeco-list__item").length,
      pvsItems:         $qa(root, "li[class*='pvs-list__item']").length,
      dataViewItems:    $qa(root, "li[data-view-name]").length,
      getItemsResult:   getItems(root).length,
      firstItemHTML:    getItems(root)[0]?.outerHTML?.slice(0, 400) || "(none)",
    };
    console.group("[LinkedIn Extractor] Debug Dump");
    console.table(info);
    console.groupEnd();
    return info;
  }

  // ─────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "detectMode") {
      sendResponse({ success: true, data: detectMode() });
      return true;
    }

    if (request.action === "debug") {
      sendResponse({ success: true, data: debugDump() });
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
