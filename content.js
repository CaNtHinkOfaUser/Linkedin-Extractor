// LinkedIn Profile Extractor — Content Script v2.0
//
// A full extract can't just read the page the user is looking at: the
// profile only previews each section ("Show all 97 skills →"), and the full
// lists live on /in/<id>/details/<section>/ pages that lazy-load ten entries
// at a time as the end of the list scrolls into a *visible* viewport. So
// extractAll() opens an overlay on the current tab holding a same-origin
// <iframe>, and in it:
//   1. loads the profile, scrolls until every section card has rendered and
//      reads the header, About and each section's preview,
//   2. loads every section's details page, scrolls / clicks "Load more" until
//      the list stops growing, then re-reads the full list (skills are also
//      re-read per category tab to tag each skill with its category),
//   3. loads the contact-info overlay.
// The result is stored in chrome.storage.local and background.js downloads it.
//
// Markup notes (LinkedIn's 2025+ React profile): class names are hashed per
// deploy, so nothing here keys on classes. Stable hooks:
//   [componentkey^="entity-collection-item"]  one per entry
//   [data-testid="expandable-text-box"]       descriptions (full text in DOM)
//   [data-testid^="profile_"]                 the list on a details page
//   [data-testid="lazy-column"]               tabbed lists (interests, recs)
// Text is read per rendered block (extractLines), skipping visually hidden
// screen-reader copies and button labels. The page enforces Trusted Types,
// so the overlay is built with DOM calls, never innerHTML.

(function () {
  "use strict";

  const VERSION = "2.0.0";
  const hasExt = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);

  if (hasExt && window.__liExtractHandler) {
    try { chrome.runtime.onMessage.removeListener(window.__liExtractHandler); } catch (_) {}
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const qa = (root, sel) => Array.from(root.querySelectorAll(sel));
  const log = (...a) => console.log("[Li Extractor]", ...a);

  // An entry is one element, or (for hr-separated lists) an array of siblings.
  const roots = e => (Array.isArray(e) ? e : [e]);
  const within = (e, n) => roots(e).some(r => r === n || r.contains(n));
  const qe = (e, sel) => roots(e).flatMap(r => (r.matches(sel) ? [r] : []).concat(qa(r, sel)));

  // ─────────────────────────────────────────────────────────────
  // TEXT
  // ─────────────────────────────────────────────────────────────
  function tidy(t) {
    return String(t || "")
      .replace(/[​-‍⁠﻿­]/g, "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^([A-Z][\w &]{1,30}):(?=\S)/, "$1: ")
      .trim();
  }
  const oneLine = t => tidy(t).replace(/\s*\n\s*/g, " ");

  const JUNK = new Set([
    "·", "•", "|", "-", "–", "—", "…", "...", "more", "… more", "…more",
    "see more", "show more", "see less", "show less", "show all",
    "show credential", "see credential", "show project", "show publication",
    "show patent", "edit", "endorse", "endorsed", "follow", "following",
    "connect", "message", "pending", "add section", "add profile section",
    "open to", "enhance profile", "resources",
  ]);
  const isJunk = t => JUNK.has(t.toLowerCase()) || /^·?\s*(1st|2nd|3rd\+?)$/i.test(t);

  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "svg", "img", "picture", "video",
    "audio", "canvas", "iframe", "button", "input", "select", "textarea",
    "option", "dialog", "hr",
  ]);
  const INLINE = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "inline-table", "contents", "ruby"]);
  const PRE_RX = /^(pre|pre-wrap|pre-line|break-spaces)$/;

  function isHidden(el, s) {
    if (el.hidden || s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
    // Screen-reader-only copies: absolutely positioned and clipped to 0–1px.
    if (s.position === "absolute" || s.position === "fixed") {
      if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip)) return true;
      if (parseFloat(s.width) <= 1 && parseFloat(s.height) <= 1) return true;
    }
    if (/inset\(\s*50%/.test(s.clipPath || "")) return true;
    return /\b(visually-hidden|sr-only|a11y-text|screen-reader-text)\b/.test(String(el.className || ""));
  }

  // Visible text under the given roots, one line per rendered block, in DOM
  // order: [{ text, node }] where node is the element holding the first run
  // of text (parsers use node.closest(...) to learn what a line belongs to).
  // <br> inside a block becomes "\n" so multi-paragraph descriptions survive.
  function extractLines(rootList, skip) {
    const out = [];
    const styles = new Map();
    const styleOf = el => {
      let s = styles.get(el);
      if (!s) { s = el.ownerDocument.defaultView.getComputedStyle(el); styles.set(el, s); }
      return s;
    };
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const text = tidy(cur.text);
      if (text && !isJunk(text)) out.push({ text, node: cur.node });
      cur = null;
    };
    const walk = (node, pre, isRoot) => {
      if (node.nodeType === 3) {
        const v = pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");
        if (!v.trim()) { if (cur) cur.text += v; return; }
        if (!cur) cur = { text: "", node: node.parentElement };
        cur.text += v;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (tag === "br") { if (cur) cur.text += "\n"; return; }
      if (!isRoot && (SKIP_TAGS.has(tag) || (skip && skip(node)))) return;
      const s = styleOf(node);
      if (!isRoot && isHidden(node, s)) return;
      const block = !INLINE.has(s.display);
      if (block) flush();
      const childPre = PRE_RX.test(s.whiteSpace);
      for (const c of node.childNodes) walk(c, childPre, false);
      if (block) flush();
    };
    for (const r of rootList) { walk(r, false, true); flush(); }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // ENTRIES
  // ─────────────────────────────────────────────────────────────
  const ENTRY_SEL = '[componentkey^="entity-collection-item"]';
  const LEGACY_ENTRY_SEL = 'li.pvs-list__paged-list-item, li.artdeco-list__item, [data-view-name="profile-component-entity"]';

  function topLevel(nodes) {
    const set = new Set(nodes);
    return nodes.filter(n => {
      for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  // Lists without per-entry wrappers (interests, recommendations) separate
  // entries with <hr>s; group the siblings between them.
  function splitByRules(container) {
    const hr = container.querySelector("hr");
    if (!hr) return [];
    const groups = [];
    let g = [];
    for (const c of hr.parentElement.children) {
      if (c.localName === "hr") { if (g.length) groups.push(g); g = []; }
      else g.push(c);
    }
    if (g.length) groups.push(g);
    return groups.filter(grp => grp.some(e => (e.textContent || "").trim()));
  }

  function findEntries(container, sel) {
    if (!container) return [];
    if (sel) return topLevel(qa(container, sel));
    let items = topLevel(qa(container, ENTRY_SEL));
    if (items.length) return items;
    items = topLevel(qa(container, LEGACY_ENTRY_SEL));
    if (items.length) return items;
    items = splitByRules(container);
    if (items.length) return items;
    // A lazy column holding a single entry has no <hr> to split on.
    if (container.matches('[data-testid="lazy-column"]')) {
      return Array.from(container.children).filter(c => c.localName !== "hr" && (c.textContent || "").trim());
    }
    return topLevel(qa(container, '[role="listitem"], li'));
  }

  function decodeHref(href) {
    try {
      const u = new URL(href, location.href);
      if (/\/(safety\/go|redir\/redirect)\/?$/.test(u.pathname)) return u.searchParams.get("url") || u.href;
      return u.href;
    } catch (_) { return href || ""; }
  }
  const isLinkedIn = h => /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com(\/|$)/i.test(h);

  function externalLinks(entry, except) {
    const out = [];
    for (const a of qe(entry, "a[href]")) {
      if (a === except) continue;
      const h = decodeHref(a.getAttribute("href"));
      if (/^https?:/i.test(h) && !isLinkedIn(h) && !out.includes(h)) out.push(h);
    }
    return out;
  }

  function orgUrl(entry) {
    const a = qe(entry, "a[href]").find(x => /linkedin\.com\/(company|school|showcase)\//.test(x.href));
    return a ? a.href.split("?")[0] : "";
  }

  const MEDIA_HREF_RX = /\/treasury(\/|\?|$)/i;
  const SKILLS_HREF_RX = /skill-associations/i;

  // Owner-only controls inside an entry, e.g. a recommendation's
  // "All LinkedIn members [On]" visibility switch.
  const isControlBlock = el =>
    !!el.querySelector('input[role="switch"]') && !el.querySelector('[data-testid="expandable-text-box"], a[href]');

  function entryLines(entry) {
    const lines = extractLines(roots(entry), isControlBlock);
    for (const l of lines) {
      const a = l.node.closest("a[href]");
      l.anchor = a && within(entry, a) ? a : null;
      const href = l.anchor ? l.anchor.getAttribute("href") || "" : "";
      l.desc = !!l.node.closest('[data-testid="expandable-text-box"], .inline-show-more-text, .pv-shared-text-with-see-more');
      l.skills = /^skills:/i.test(l.text) || SKILLS_HREF_RX.test(href);
      l.media = !l.skills && MEDIA_HREF_RX.test(href);
    }
    return lines;
  }
  const plain = lines => lines.filter(l => !l.media && !l.skills);

  // Attachments: each treasury link holds a title line and maybe a description.
  function collectMedia(lines) {
    const groups = new Map();
    for (const l of lines) {
      if (!l.media) continue;
      if (!groups.has(l.anchor)) groups.set(l.anchor, []);
      groups.get(l.anchor).push(l.text);
    }
    return [...groups.values()].map(ts => (ts.length > 1 ? { title: ts[0], description: ts.slice(1).join("\n") } : { title: ts[0] }));
  }

  // "Skills: Swift (Programming Language), iOS Development, +2 skills"
  function parseSkillsLines(lines) {
    const out = [];
    let more = 0;
    for (const l of lines) {
      let t = l.text.replace(/^skills:\s*/i, "");
      t = t.replace(/(?:,\s*|\s+and\s+)?\+(\d+)\s+skills?$/i, (_, n) => { more += +n; return ""; });
      for (const s of t.split(/\s*,\s*/)) if (s && !out.includes(s)) out.push(s);
    }
    if (more) out.push(`+${more} more`);
    return out;
  }

  function extras(entry, lines) {
    return {
      skills: parseSkillsLines(lines.filter(l => l.skills)),
      media: collectMedia(lines),
      links: externalLinks(entry),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // FIELD PATTERNS
  // ─────────────────────────────────────────────────────────────
  const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  const DTOK = `(?:${MON}\\s+)?(?:\\d{1,2},?\\s+)?\\d{4}|present`;
  const RANGE_RX = new RegExp(`^(${DTOK})\\s*[-–—]\\s*(${DTOK})$`, "i");
  const SINGLE_RX = new RegExp(`^(${MON}\\s+(?:\\d{1,2},?\\s+)?\\d{4}|\\d{4})$`, "i");
  const DUR_RX = /^(?:less than a year|\d+\s*(?:yrs?|years?|mos?|months?)(?:\s+\d+\s*(?:mos?|months?))?)$/i;
  const EMP_RX = /^(full[- ]time|part[- ]time|self[- ]employed|freelance|contract|internship|apprenticeship|seasonal|temporary|permanent|trainee)$/i;
  const WORKPLACE_RX = /^(on[- ]site|remote|hybrid)$/i;
  const ASSOC_RX = /^associated with\s+/i;

  // "Sep 2025 - Present · 1 yr 2 mos" → { dates, duration }
  function parseDates(s) {
    const parts = s.split(/\s+·\s+/).map(p => p.trim());
    if (RANGE_RX.test(parts[0]) || SINGLE_RX.test(parts[0])) {
      return { dates: parts[0], duration: parts.slice(1).find(p => DUR_RX.test(p)) || "" };
    }
    if (parts.length === 1 && DUR_RX.test(parts[0])) return { dates: "", duration: parts[0] };
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // SECTION PARSERS  (entry element → object, or array for grouped roles)
  // ─────────────────────────────────────────────────────────────
  function parsePosition(lines, company) {
    const e = {
      title: "", company: company || "", employmentType: "", dates: "", duration: "", totalTenure: "",
      location: "", workplace: "", description: "", skills: [], media: [], links: [], companyUrl: "", details: [],
    };
    const desc = [];
    let afterDates = false, haveCompany = !!company;
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.title) { e.title = t; continue; }
      if (l.desc) { desc.push(t); continue; }
      if (!e.dates && !e.duration) {
        const d = parseDates(t);
        if (d) { e.dates = d.dates; e.duration = d.duration; afterDates = true; continue; }
      }
      if (EMP_RX.test(t)) { e.employmentType = t; continue; }
      if (!haveCompany && !afterDates) {
        const parts = t.split(/\s+·\s+/);
        if (parts.length > 1 && EMP_RX.test(parts[parts.length - 1])) e.employmentType = parts.pop();
        e.company = parts.join(" · ");
        haveCompany = true;
        continue;
      }
      if (afterDates && !e.location && !e.workplace && t.length <= 120) {
        const parts = t.split(/\s+·\s+/);
        if (WORKPLACE_RX.test(parts[parts.length - 1])) e.workplace = parts.pop();
        e.location = parts.join(" · ");
        continue;
      }
      if (t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    return e;
  }

  function parseExperience(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return [];
    // Several roles at one company: header (company, total tenure) + one <li> per role.
    const roles = topLevel(qe(entry, "li")).filter(li => lines.some(l => li.contains(l.node) && parseDates(l.text)));
    if (roles.length) {
      const head = plain(lines.filter(l => !roles.some(li => li.contains(l.node))));
      const company = head[0] ? head[0].text : "";
      const tenure = head.slice(1).map(l => parseDates(l.text)).find(Boolean);
      return roles.map(li => {
        const ls = lines.filter(l => li.contains(l.node));
        return Object.assign(parsePosition(ls, company), extras(li, ls), {
          companyUrl: orgUrl(entry),
          totalTenure: tenure ? tenure.duration || tenure.dates : "",
        });
      });
    }
    return [Object.assign(parsePosition(lines, ""), extras(entry, lines), { companyUrl: orgUrl(entry) })];
  }

  function parseEducation(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = {
      school: "", degree: "", field: "", dates: "", grade: "", activities: "", description: "",
      skills: [], media: [], links: [], schoolUrl: orgUrl(entry), details: [],
    };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.school) { e.school = t; continue; }
      if (/^grade:/i.test(t)) { e.grade = t.replace(/^grade:\s*/i, ""); continue; }
      if (/^activities and societies:/i.test(t)) { e.activities = t.replace(/^activities and societies:\s*/i, ""); continue; }
      if (l.desc) { desc.push(t); continue; }
      if (!e.dates) {
        const d = parseDates(t);
        if (d) { e.dates = [d.dates, d.duration].filter(Boolean).join(" · "); continue; }
      }
      if (!e.degree && !e.dates) {
        const i = t.indexOf(", ");
        if (i > 0) { e.degree = t.slice(0, i); e.field = t.slice(i + 2); } else e.degree = t;
        continue;
      }
      if (t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    return Object.assign(e, extras(entry, lines));
  }

  function parseCertification(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = {
      name: "", issuer: "", issued: "", expires: "", credentialId: "", credentialUrl: "", description: "",
      skills: [], media: [], links: [], details: [],
    };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.name) { e.name = t; continue; }
      if (/^issued\b/i.test(t) && !/^issued by\b/i.test(t)) {
        for (const p of t.split(/\s+·\s+/)) {
          if (/^issued\b/i.test(p)) e.issued = p.replace(/^issued\s*/i, "");
          else if (/no expiration/i.test(p)) e.expires = "No expiration date";
          else if (/^expire[sd]?\b/i.test(p)) e.expires = p.replace(/^expire[sd]?\s*/i, "");
          else e.details.push(p);
        }
        continue;
      }
      if (/^expire[sd]?\b/i.test(t)) { e.expires = t.replace(/^expire[sd]?\s*/i, ""); continue; }
      if (/^credential id\b/i.test(t)) { e.credentialId = t.replace(/^credential id[:\s]*/i, ""); continue; }
      if (!e.issuer && !e.issued && !l.desc) { e.issuer = t; continue; }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    const cred = qe(entry, "a[href]").find(a => /credential/i.test(a.getAttribute("aria-label") || a.textContent || ""));
    Object.assign(e, extras(entry, lines));
    if (cred) {
      e.credentialUrl = decodeHref(cred.getAttribute("href"));
      e.links = e.links.filter(h => h !== e.credentialUrl);
    }
    return e;
  }

  function parseProject(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { name: "", dates: "", associatedWith: "", description: "", url: "", skills: [], media: [], links: [], details: [] };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.name) { e.name = t; continue; }
      if (ASSOC_RX.test(t)) { e.associatedWith = t.replace(ASSOC_RX, ""); continue; }
      if (!e.dates) {
        const d = parseDates(t);
        if (d) { e.dates = [d.dates, d.duration].filter(Boolean).join(" · "); continue; }
      }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    Object.assign(e, extras(entry, lines));
    if (e.links.length) e.url = e.links.shift();
    return e;
  }

  function parseVolunteering(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { role: "", organization: "", dates: "", duration: "", cause: "", description: "", media: [], links: [], details: [] };
    const desc = [];
    let afterDates = false;
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.role) { e.role = t; continue; }
      if (l.desc) { desc.push(t); continue; }
      if (!e.dates && !e.duration) {
        const d = parseDates(t);
        if (d) { e.dates = d.dates; e.duration = d.duration; afterDates = true; continue; }
      }
      if (!e.organization && !afterDates) { e.organization = t; continue; }
      if (afterDates && !e.cause && t.length <= 80) { e.cause = t; continue; }
      if (t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    const x = extras(entry, lines);
    e.media = x.media; e.links = x.links;
    return e;
  }

  function parseHonor(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { title: "", issuer: "", date: "", associatedWith: "", description: "", media: [], links: [], details: [] };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.title) { e.title = t; continue; }
      if (/^issued by\s+/i.test(t)) {
        const parts = t.replace(/^issued by\s+/i, "").split(/\s+·\s+/);
        e.issuer = parts.shift();
        e.date = parts.join(" · ");
        continue;
      }
      if (/^issued\s+/i.test(t)) { e.date = t.replace(/^issued\s+/i, ""); continue; }
      if (ASSOC_RX.test(t)) { e.associatedWith = t.replace(ASSOC_RX, ""); continue; }
      if (!e.date && SINGLE_RX.test(t)) { e.date = t; continue; }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    const x = extras(entry, lines);
    e.media = x.media; e.links = x.links;
    return e;
  }

  function parseCourse(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    const e = { name: lines[0].text, number: "", associatedWith: "", details: [] };
    for (const l of lines.slice(1)) {
      if (ASSOC_RX.test(l.text)) e.associatedWith = l.text.replace(ASSOC_RX, "");
      else if (!e.number && l.text.length <= 40) e.number = l.text;
      else e.details.push(l.text);
    }
    return e;
  }

  function parseTestScore(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    const e = { name: lines[0].text, score: "", date: "", associatedWith: "", description: "", details: [] };
    const desc = [];
    for (const l of lines.slice(1)) {
      const t = l.text;
      if (/^score:/i.test(t)) {
        const parts = t.replace(/^score:\s*/i, "").split(/\s+·\s+/);
        e.score = parts.shift();
        e.date = parts.join(" · ");
      } else if (ASSOC_RX.test(t)) e.associatedWith = t.replace(ASSOC_RX, "");
      else if (l.desc || t.length > 160) desc.push(t);
      else e.details.push(t);
    }
    e.description = desc.join("\n");
    return e;
  }

  function parseLanguage(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    return { language: lines[0].text, proficiency: lines[1] ? lines[1].text : "", details: lines.slice(2).map(l => l.text) };
  }

  // "Publisher · Jan 1, 2024" / "US 1234567 · Issued Jan 2020"
  function splitMetaLine(t) {
    const parts = t.split(/\s+·\s+/);
    const dateIdx = parts.findIndex(p => SINGLE_RX.test(p.replace(/^(issued|filed)\s+/i, "")));
    const date = dateIdx >= 0 ? parts.splice(dateIdx, 1)[0] : "";
    return { main: parts.join(" · "), date };
  }

  function parsePublication(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { title: "", publisher: "", date: "", description: "", url: "", links: [], details: [] };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.title) { e.title = t; continue; }
      if (!e.publisher && !e.date && !l.desc) { const m = splitMetaLine(t); e.publisher = m.main; e.date = m.date; continue; }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    e.links = externalLinks(entry);
    if (e.links.length) e.url = e.links.shift();
    return e;
  }

  function parsePatent(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { title: "", number: "", date: "", description: "", url: "", links: [], details: [] };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.title) { e.title = t; continue; }
      if (!e.number && !e.date && !l.desc) { const m = splitMetaLine(t); e.number = m.main; e.date = m.date; continue; }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    e.links = externalLinks(entry);
    if (e.links.length) e.url = e.links.shift();
    return e;
  }

  function parseOrganization(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const e = { name: "", position: "", dates: "", associatedWith: "", description: "", details: [] };
    const desc = [];
    for (const l of plain(lines)) {
      const t = l.text;
      if (!e.name) { e.name = t; continue; }
      if (ASSOC_RX.test(t)) { e.associatedWith = t.replace(ASSOC_RX, ""); continue; }
      if (!e.position && !e.dates && !l.desc) {
        const parts = t.split(/\s+·\s+/);
        const i = parts.findIndex(p => parseDates(p));
        if (i >= 0) e.dates = parts.splice(i, 1)[0];
        e.position = parts.join(" · ");
        continue;
      }
      if (l.desc || t.length > 160) { desc.push(t); continue; }
      e.details.push(t);
    }
    e.description = desc.join("\n");
    return e;
  }

  function parseRecommendation(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    const e = { from: lines[0].text, headline: "", date: "", relationship: "", text: "", profileUrl: "", details: [] };
    const a = qe(entry, "a[href]").find(x => /\/in\//.test(x.href));
    if (a) e.profileUrl = a.href.split("?")[0];
    const body = [];
    for (const l of lines.slice(1)) {
      const t = l.text;
      const m = t.match(/^([A-Z][a-z]+ \d{1,2}, \d{4}),\s*(.+)$/);
      if (m && !e.date) { e.date = m[1]; e.relationship = m[2]; continue; }
      if (!e.headline && !l.desc && t.length <= 220 && !body.length) { e.headline = t; continue; }
      if (l.desc || t.length > 80) { body.push(t); continue; }
      e.details.push(t);
    }
    e.text = body.join("\n");
    return e;
  }

  function parseSkill(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const s = { name: lines[0].text, category: "", endorsements: [], usedIn: [], details: [] };
    for (const l of lines.slice(1)) {
      const list = l.node.closest('[role="list"], ul');
      if (/endors/i.test(l.text)) s.endorsements.push(l.text);
      else if (list && within(entry, list)) s.usedIn.push(l.text);
      else s.details.push(l.text);
    }
    return s;
  }

  function parseInterest(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    const a = qe(entry, "a[href]")[0];
    return { name: lines[0].text, subtitle: lines.slice(1).map(l => l.text).join(" · "), url: a ? a.href.split("?")[0] : "" };
  }

  // Featured cards lead with their kind ("Link", "Post", …), then the title.
  function parseFeatured(entry) {
    const lines = plain(entryLines(entry));
    if (!lines.length) return null;
    const KIND_RX = /^(link|post|article|document|image|video|newsletter|media|event|service)$/i;
    const kind = KIND_RX.test(lines[0].text) ? lines.shift().text : "";
    if (!lines.length) return null;
    return {
      type: kind, title: lines[0].text, description: lines.slice(1).map(l => l.text).join("\n"),
      links: externalLinks(entry),
    };
  }

  function parseGeneric(entry) {
    const lines = entryLines(entry);
    if (!lines.length) return null;
    const p = plain(lines);
    if (!p.length) return null;
    return {
      title: p[0].text, subtitle: p[1] ? p[1].text : "", details: p.slice(2).map(l => l.text),
      ...extras(entry, lines),
    };
  }

  // key, label, heading match, details-page slug, parser, how to title an entry
  const SECTIONS = [
    { key: "experience",      label: "Experience",                rx: /^experience$/i,                                          slug: "experience",               parse: parseExperience,     title: e => [e.title, e.company].filter(Boolean).join(" — ") },
    { key: "education",       label: "Education",                 rx: /^education$/i,                                           slug: "education",                parse: parseEducation,      title: e => e.school },
    { key: "certifications",  label: "Licenses & Certifications", rx: /^(licen[cs]es?\s*(&|and)\s*)?certifications?$/i,           slug: "certifications",           parse: parseCertification,  title: e => e.name },
    { key: "projects",        label: "Projects",                  rx: /^projects$/i,                                            slug: "projects",                 parse: parseProject,        title: e => e.name },
    { key: "volunteering",    label: "Volunteering",              rx: /^volunteer(ing|\s+experiences?)?$/i,                     slug: "volunteering-experiences", parse: parseVolunteering,   title: e => [e.role, e.organization].filter(Boolean).join(" — ") },
    { key: "skills",          label: "Skills",                    rx: /^skills$/i,                                              slug: "skills",                   parse: parseSkill },
    { key: "honors",          label: "Honors & Awards",           rx: /^(hono(u)?rs?\s*(&|and)\s*awards?|hono(u)?rs|awards)$/i,  slug: "honors",                   parse: parseHonor,          title: e => e.title },
    { key: "courses",         label: "Courses",                   rx: /^courses$/i,                                             slug: "courses",                  parse: parseCourse,         title: e => e.name },
    { key: "testScores",      label: "Test Scores",               rx: /^test scores$/i,                                         slug: "test-scores",              parse: parseTestScore,      title: e => e.name },
    { key: "languages",       label: "Languages",                 rx: /^languages$/i,                                           slug: "languages",                parse: parseLanguage },
    { key: "publications",    label: "Publications",              rx: /^publications$/i,                                        slug: "publications",             parse: parsePublication,    title: e => e.title },
    { key: "patents",         label: "Patents",                   rx: /^patents$/i,                                             slug: "patents",                  parse: parsePatent,         title: e => e.title },
    { key: "organizations",   label: "Organizations",             rx: /^organizations$/i,                                       slug: "organizations",            parse: parseOrganization,   title: e => e.name },
    { key: "recommendations", label: "Recommendations",           rx: /^recommendations$/i,                                     slug: "recommendations",          parse: parseRecommendation, title: e => e.from, tabField: "direction" },
    { key: "featured",        label: "Featured",                  rx: /^featured$/i,                                            slug: null,                       parse: parseFeatured,       title: e => [e.type, e.title].filter(Boolean).join(": "), entrySel: '[role="listitem"], li' },
    { key: "interests",       label: "Interests",                 rx: /^interests$/i,                                           slug: "interests",                parse: parseInterest,       tabField: "category" },
    { key: "causes",          label: "Causes",                    rx: /^causes$/i,                                              slug: null,                       text: true },
  ];
  const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map(s => [s.key, s]));
  const IGNORED_SECTIONS = /^(suggested for you|analytics|activity|people you may know|you might like|who your viewers also viewed|people also viewed|more profiles for you|explore premium profiles|profile language|public profile & url|connected apps|ad options|don.t want to see this|resources|pages for you|people you may know from .*)$/i;

  // Placeholder cards ("You haven't written any recommendations yet").
  const EMPTY_STATE_RX = /^(you haven.t|you have no|no \w+( \w+)? yet|nothing to (see|show)|.* will (appear|show) here)/i;

  function parseEntries(cfg, container) {
    return findEntries(container, cfg.entrySel).flatMap(e => {
      const r = cfg.parse(e);
      return (Array.isArray(r) ? r : r ? [r] : [])
        .filter(x => !EMPTY_STATE_RX.test(String(Object.values(x).find(v => typeof v === "string" && v) || "")));
    });
  }

  // ─────────────────────────────────────────────────────────────
  // PROFILE PAGE: header, about, contact, section cards
  // ─────────────────────────────────────────────────────────────
  function topCard(d) {
    const a = d.querySelector('main a[href*="/overlay/contact-info"]');
    if (a && a.closest("section")) return a.closest("section");
    return qa(d, "main section").find(s => s.querySelector("h1, h2")) || null;
  }

  function parseHeader(d) {
    const h = { name: "", pronouns: "", headline: "", current: "", location: "", connections: "", followers: "", other: [] };
    const card = topCard(d);
    if (!card) return h;
    const nameEl = card.querySelector("h1") || card.querySelector("h2");
    if (nameEl) h.name = oneLine(extractLines([nameEl]).map(l => l.text).join(" "));
    const contactA = card.querySelector('a[href*="/overlay/contact-info"]');
    const lines = extractLines([card], el =>
      el.localName === "a" && /\/(trust|premium|edit|overlay\/contact-info)\b/.test(el.getAttribute("href") || ""))
      .filter(l => !(nameEl && nameEl.contains(l.node)) && l.text !== h.name);
    const before = l => contactA && (l.node.compareDocumentPosition(contactA) & Node.DOCUMENT_POSITION_FOLLOWING);
    const locLine = contactA ? lines.filter(before).pop() : null;
    if (locLine) h.location = locLine.text;
    const seen = new Set([h.name, h.location]);
    for (const l of lines) {
      const t = l.text;
      if (l === locLine || seen.has(t)) continue;
      seen.add(t);
      if (!h.pronouns && /^(he|she|they|xe|ze|it)\s*\/\s*\w+/i.test(t) && t.length < 30) { h.pronouns = t; continue; }
      if (/^·?\s*(1st|2nd|3rd\+?)$/i.test(t)) continue;
      if (/verif|premium|try .* for (free|\w+ 0)/i.test(t)) continue;
      if (/\bconnections?\b/i.test(t) && t.length < 40) { h.connections = t; continue; }
      if (/\bfollowers?\b/i.test(t) && t.length < 40) { h.followers = t; continue; }
      if (!h.headline) { h.headline = t; continue; }
      if (!h.current && / · /.test(t)) { h.current = t; continue; }
      // Current-company / school chips repeat the "Company · School" line.
      if (h.current && h.current.split(" · ").includes(t)) continue;
      h.other.push(t);
    }
    return h;
  }

  function sectionTitle(sec) {
    const h = sec.querySelector("h2");
    const t = h ? oneLine(extractLines([h]).map(l => l.text).join(" ")) : "";
    const m = t.match(/^(.*?)\s*\((\d[\d,]*)\)$/);
    return m ? { title: m[1], count: +m[2].replace(/,/g, "") } : { title: t, count: 0 };
  }

  function profileSections(d) {
    return qa(d, "main section").filter(s => {
      const h = s.querySelector("h2");
      return h && h.closest("section") === s && s !== topCard(d);
    });
  }

  function parseAbout(sec) {
    const lines = extractLines([sec], el => /^h[1-6]$/.test(el.localName));
    const out = { about: "", topSkills: [] };
    const i = lines.findIndex(l => /^top skills$/i.test(l.text));
    const body = (i >= 0 ? lines.slice(0, i) : lines);
    out.about = body.map(l => l.text).join("\n");
    if (i >= 0 && lines[i + 1]) out.topSkills = lines[i + 1].text.split(/\s*•\s*/).filter(Boolean);
    return out;
  }

  function detailsUrlFor(sec, cfg) {
    const urls = qa(sec, 'a[href*="/details/"]')
      .map(a => { try { return new URL(a.getAttribute("href"), location.href); } catch (_) { return null; } })
      .filter(u => u && /\/details\/[^/]+\/?$/.test(u.pathname));
    const u = urls.find(x => cfg.slug && x.pathname.includes(`/details/${cfg.slug}`)) || urls[0];
    return u ? u.href : "";
  }

  function expectedCount(sec, headingCount) {
    if (headingCount) return headingCount;
    for (const a of qa(sec, "a")) {
      const m = oneLine(a.textContent).match(/show all (\d[\d,]*)/i);
      if (m) return +m[1].replace(/,/g, "");
    }
    return 0;
  }

  function parseContact(d) {
    const h = qa(d, "dialog h1, dialog h2, [role=dialog] h1, [role=dialog] h2").find(x => /contact info/i.test(x.textContent));
    if (!h) return null;
    const dlg = h.closest('dialog, [role="dialog"]');
    const root = dlg.querySelector('[data-testid="dialog-content"]') || dlg;
    const LABELS = {
      "your profile": "profileUrl", "profile": "profileUrl", "website": "websites", "websites": "websites",
      "email": "email", "phone": "phone", "address": "address", "birthday": "birthday", "twitter": "twitter",
      "x": "twitter", "im": "im", "instant messaging": "im", "wechat": "wechat", "connected": "connectedSince",
    };
    const STOP_RX = /premium|refine your profile|members can receive|free trial|edit contact info|millions of other members/i;
    const out = {};
    let key = null;
    for (const l of extractLines([root], el => /^h[1-6]$/.test(el.localName))) {
      const t = l.text;
      const label = LABELS[t.toLowerCase()];
      if (label) { key = label; continue; }
      if (STOP_RX.test(t)) { key = null; continue; }
      if (!key) continue;
      const a = l.node.closest("a[href]");
      let v = t;
      if (key === "websites" && a) {
        const url = decodeHref(a.getAttribute("href"));
        const kind = (t.match(/\(([^)]+)\)\s*$/) || [])[1];
        v = kind ? `${url} (${kind})` : url;
      }
      (out[key] = out[key] || []).push(v);
    }
    for (const k of Object.keys(out)) if (k !== "websites") out[k] = out[k].join(", ");
    return out;
  }

  // Cross-reference the skills page ("Used in: Employee at SST Inc.") so
  // entries whose skill line was cut off ("…, +2 skills") get the full list.
  // Only entries with a unique name are filled in: two certificates both
  // called "Certificate of Participation" can't be told apart.
  const MORE_RX = /^\+(\d+) more$/;
  function resolveSkillLinks(sections) {
    const skills = sections.skills;
    if (!skills || !skills.length) return;
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const usage = new Map();
    for (const s of skills) for (const u of s.usedIn || []) {
      const k = norm(u);
      if (!usage.has(k)) usage.set(k, []);
      if (!usage.get(k).includes(s.name)) usage.get(k).push(s.name);
    }
    const apply = (list, keyOf) => {
      const seen = new Map();
      for (const e of list || []) seen.set(norm(keyOf(e)), (seen.get(norm(keyOf(e))) || 0) + 1);
      for (const e of list || []) {
        const key = norm(keyOf(e));
        const found = usage.get(key);
        if (!found || seen.get(key) > 1) continue;
        const shown = (e.skills || []).filter(x => !MORE_RX.test(x));
        const more = +(((e.skills || []).find(x => MORE_RX.test(x)) || "").match(/\d+/) || [0])[0];
        const merged = [...new Set([...shown, ...found])];
        const missing = shown.length + more - merged.length;
        e.skills = missing > 0 ? [...merged, `+${missing} more`] : merged;
      }
    };
    apply(sections.experience, e => `${e.title} at ${e.company}`);
    apply(sections.education, e => e.school);
    apply(sections.certifications, e => e.name);
    apply(sections.projects, e => e.name);
    apply(sections.honors, e => e.title);
    apply(sections.courses, e => e.name);
  }

  // ─────────────────────────────────────────────────────────────
  // OVERLAY + IFRAME LOADING
  // ─────────────────────────────────────────────────────────────
  const NOTE = "Keep this tab in front while it runs. LinkedIn only loads more entries while the page is visible.";

  function el(doc, tag, props = {}, kids = []) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "style") e.style.cssText = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) e.appendChild(k);
    return e;
  }

  function createOverlay(onCancel) {
    const host = el(document, "div", { "data-li-extractor": "", style: "all:initial;position:fixed;inset:0;z-index:2147483647;" });
    const shadow = host.attachShadow({ mode: "open" });
    const css = `
      .backdrop{position:fixed;inset:0;background:rgba(5,8,15,.72)}
      .panel{position:fixed;inset:3vh 3vw;display:flex;flex-direction:column;background:#0a0a0f;border:1px solid #1e1e2e;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e8e8f0}
      .bar{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid #1e1e2e;background:linear-gradient(135deg,#0a1628,#0f1f3d)}
      .logo{width:26px;height:26px;border-radius:6px;background:#0a84ff;color:#fff;font:700 10px/26px monospace;text-align:center;flex:none}
      .info{flex:1;min-width:0}
      .step{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .note{font-size:11px;color:#8e8ea8;margin-top:2px}
      .track{height:4px;background:#1e1e2e;border-radius:2px;margin-top:8px;overflow:hidden}
      .fill{height:100%;width:0;background:#0a84ff;transition:width .3s}
      button{flex:none;background:transparent;color:#e8e8f0;border:1px solid #3a3a52;border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
      button:hover{background:#1e1e2e}
      .frame{flex:1;position:relative;background:#fff}
      iframe{position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none}`;
    const step = el(document, "div", { class: "step", text: "Starting…" });
    const note = el(document, "div", { class: "note", text: NOTE });
    const fill = el(document, "div", { class: "fill" });
    const cancel = el(document, "button", { type: "button", text: "Cancel" });
    const frameHost = el(document, "div", { class: "frame" });
    shadow.append(
      el(document, "style", { text: css }),
      el(document, "div", { class: "backdrop" }),
      el(document, "div", { class: "panel" }, [
        el(document, "div", { class: "bar" }, [
          el(document, "div", { class: "logo", text: "Li" }),
          el(document, "div", { class: "info" }, [step, note, el(document, "div", { class: "track" }, [fill])]),
          cancel,
        ]),
        frameHost,
      ]),
    );
    cancel.addEventListener("click", () => { cancel.disabled = true; cancel.textContent = "Cancelling…"; onCancel(); });
    (document.body || document.documentElement).appendChild(host);
    return {
      step(text, frac) {
        step.textContent = text;
        if (frac != null) fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      },
      note(text) { note.textContent = text || NOTE; },
      setFrame(f) { frameHost.replaceChildren(f); },
      remove() { host.remove(); },
    };
  }

  function checkCancel(ctx) { if (ctx.cancelled) throw new Error("Cancelled"); }

  async function waitVisible(ctx) {
    if (!document.hidden) return;
    ctx.overlay.note("Paused: switch back to this tab to continue.");
    while (document.hidden) { checkCancel(ctx); await sleep(400); }
    ctx.overlay.note();
  }

  // Load `url` in a fresh iframe and resolve with its document once
  // isReady(doc, elapsedMs) is true.
  async function openPage(ctx, url, isReady, timeout = 30000) {
    const frame = el(document, "iframe", { src: url, tabindex: "-1", "aria-hidden": "true" });
    ctx.overlay.setFrame(frame);
    const t0 = Date.now();
    let doc = null;
    while (Date.now() - t0 < timeout) {
      checkCancel(ctx);
      await waitVisible(ctx);
      await sleep(300);
      try { doc = frame.contentDocument; } catch (_) { doc = null; }
      if (!doc || !doc.URL.startsWith(location.origin) || doc.readyState === "loading") continue;
      const path = new URL(doc.URL).pathname;
      if (/^\/(authwall|login|checkpoint|uas\/login)/.test(path)) throw new Error("LinkedIn asked you to sign in again.");
      if (isReady(doc, Date.now() - t0)) { await sleep(500); return doc; }
    }
    if (doc && doc.URL.startsWith(location.origin)) return doc;
    throw new Error("Page took too long to load");
  }

  function findScroller(d) {
    const ok = e => {
      if (!e) return false;
      const s = d.defaultView.getComputedStyle(e);
      return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 4;
    };
    for (let e = d.querySelector("main"); e; e = e.parentElement) if (ok(e)) return e;
    return d.scrollingElement || d.documentElement;
  }

  // Scroll `target` to the bottom (or centre) of the scroller's viewport
  // without touching the outer page (scrollIntoView would).
  function scrollToEl(scroller, target, where) {
    const d = scroller.ownerDocument;
    const view = scroller === d.scrollingElement || scroller === d.documentElement
      ? { top: 0, bottom: d.defaultView.innerHeight }
      : scroller.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    scroller.scrollTop += where === "center"
      ? r.top - view.top - (view.bottom - view.top) / 2
      : r.bottom - view.bottom + 4;
  }

  function clickLoadMore(scope) {
    let clicked = false;
    for (const b of qa(scope, "button")) {
      if (/^(load more|show more results|see more results|show more)$/i.test(oneLine(b.textContent)) && !b.disabled) {
        b.click();
        clicked = true;
      }
    }
    return clicked;
  }

  // Keep nudging the end of the list into view (and clicking "Load more")
  // until the list stops growing or reaches the count LinkedIn advertised.
  async function loadAll(ctx, d, getContainer, { expected = 0, sel, onCount } = {}) {
    const scroller = findScroller(d);
    const sig = () => {
      const c = getContainer();
      return c ? `${findEntries(c, sel).length}|${(c.textContent || "").length}` : "";
    };
    let idle = 0;
    for (let round = 0; round < 200; round++) {
      checkCancel(ctx);
      await waitVisible(ctx);
      const c = getContainer();
      if (!c) break;
      const n = findEntries(c, sel).length;
      if (onCount) onCount(n);
      if (expected && n >= expected) break;
      const before = sig();
      const clicked = clickLoadMore(c.closest("section") || c);
      scroller.scrollTop -= 300;
      await sleep(60);
      scrollToEl(scroller, c.lastElementChild || c, "end");
      let changed = false;
      for (let i = 0; i < 12 && !changed; i++) { await sleep(250); changed = sig() !== before; }
      if (changed) { idle = 0; continue; }
      // Short lists (< one page of 10) rarely have more; don't wait long.
      if (++idle >= (clicked ? 2 : n < 8 && !expected ? 1 : 3)) break;
    }
    scroller.scrollTop = 0;
  }

  // Descriptions are already complete in the DOM (the "… more" button only
  // lifts a CSS clamp), so this is belt and braces. Only buttons inside
  // profile entries are clicked: the same button on an Activity post opens
  // the post, navigating the frame away.
  async function expandAll(scope) {
    if (!scope) return;
    const btns = qa(scope, 'button[data-testid="expandable-text-button"], button.inline-show-more-text__button')
      .filter(b => b.closest(`${ENTRY_SEL}, ${LEGACY_ENTRY_SEL}`));
    for (const b of btns) { try { b.click(); } catch (_) {} }
    if (btns.length) await sleep(400);
  }

  function ensureOn(d, url) {
    const want = new URL(url).pathname.replace(/\/$/, "");
    if (!d.location.pathname.replace(/\/$/, "").startsWith(want)) {
      throw new Error(`page navigated away to ${d.location.pathname}`);
    }
  }

  // The profile lazy-renders section cards: some as empty skeletons, the
  // rest (Skills onwards) in batches as a trigger near the end of the list
  // scrolls into view. Jumping straight to the bottom skips past that
  // trigger, so step down a screen at a time (centring any skeleton) until
  // the bottom stops growing.
  async function loadProfileSections(ctx, d) {
    const scroller = findScroller(d);
    const skeletons = () => qa(d, "main section").filter(s => !s.querySelector("h2") && !(s.textContent || "").trim());
    const count = () => `${qa(d, "main h2").length}|${skeletons().length}`;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    let idle = 0;
    for (let round = 0; round < 80 && idle < 2; round++) {
      checkCancel(ctx);
      await waitVisible(ctx);
      const before = count();
      const pending = skeletons();
      if (pending.length) scrollToEl(scroller, pending[0], "center");
      else scroller.scrollTop += Math.max(300, scroller.clientHeight * 0.85);
      let changed = false;
      const waits = atBottom() ? 10 : 2;
      for (let i = 0; i < waits && !changed; i++) { await sleep(250); changed = count() !== before; }
      if (changed) idle = 0;
      else if (atBottom()) idle++;
    }
    scroller.scrollTop = 0;
  }

  const detailsList = d => {
    const lists = qa(d, '[data-testid^="profile_"]').filter(x => x.querySelector(ENTRY_SEL));
    if (lists.length) return lists.sort((a, b) => qa(b, ENTRY_SEL).length - qa(a, ENTRY_SEL).length)[0];
    const prim = d.querySelector("main section");
    if (!prim) return d.querySelector("main");
    return prim.querySelector('[data-testid="lazy-column"]') || prim;
  };
  const detailsReady = (d, elapsed) =>
    !!d.querySelector(`main ${ENTRY_SEL}, main [data-testid="lazy-column"] a, main [data-testid="lazy-column"] button, main ${LEGACY_ENTRY_SEL}`) ||
    (elapsed > 7000 && !!d.querySelector("main section") && (d.querySelector("main section").textContent || "").trim().length > 20);

  // Tabs on details pages: checkbox+label pairs (interests, recommendations)
  // or role=tab.
  function findTabs(scope) {
    const labels = qa(scope, "label[for]").filter(l => {
      const input = l.ownerDocument.getElementById(l.htmlFor);
      return input && /^(checkbox|radio)$/.test(input.type);
    });
    if (labels.length >= 2) {
      return labels.map(l => ({ name: oneLine(l.textContent), el: l, active: () => l.ownerDocument.getElementById(l.htmlFor).checked }));
    }
    return qa(scope, '[role="tab"]').map(t => ({ name: oneLine(t.textContent), el: t, active: () => t.getAttribute("aria-selected") === "true" }));
  }

  async function scrapeTabbed(ctx, d, cfg, url, report) {
    const prim = d.querySelector("main section") || d.querySelector("main");
    const tabs = findTabs(prim);
    if (!tabs.length) {
      await loadAll(ctx, d, () => detailsList(d));
      await expandAll(detailsList(d));
      ensureOn(d, url);
      return parseEntries(cfg, detailsList(d));
    }
    const out = [];
    for (const tab of tabs) {
      checkCancel(ctx);
      report(`${cfg.label}: ${tab.name}`);
      if (!tab.active()) { tab.el.click(); await sleep(1800); }
      await loadAll(ctx, d, () => detailsList(d));
      await expandAll(detailsList(d));
      ensureOn(d, url);
      for (const e of parseEntries(cfg, detailsList(d))) out.push({ [cfg.tabField]: tab.name, ...e });
    }
    return out;
  }

  // Skills page filter buttons (All / Industry Knowledge / Tools & …):
  // re-read the list under each one to learn every skill's category. The
  // filtered views render skills in a lazy column rather than as
  // entity-collection items, but every skill row in either view carries
  // componentkey="com.linkedin.sdui.profile.skill(<profile>, <id>)". (The
  // trailing ")" excludes "…skill(<profile>)-maxSkillsCallout".)
  const SKILL_SEL = '[componentkey^="com.linkedin.sdui.profile.skill("][componentkey$=")"]';

  async function tagSkillCategories(ctx, d, skills, report) {
    const prim = () => d.querySelector("main section");
    const current = prim() && prim().querySelector("button[aria-current]");
    if (!current) return;
    let group = current.parentElement;
    while (group && group !== prim() && qa(group, "button").length < 2) group = group.parentElement;
    const cats = qa(group, "button").map(b => oneLine(b.textContent)).filter(Boolean).slice(1);
    const button = cat => qa(prim(), "button").find(b => oneLine(b.textContent) === cat);
    const rows = () => topLevel(qa(prim(), SKILL_SEL));
    const list = () => {
      const r = rows()[0];
      return (r && r.closest('[data-testid="lazy-column"], [data-testid^="profile_"]')) || prim();
    };
    const byName = new Map(skills.map(s => [s.name, s]));
    for (const cat of cats) {
      checkCancel(ctx);
      const b = button(cat);
      if (!b) continue;
      report(`Skills: ${cat}`);
      // Wait for the old list to be replaced before reading, or every skill
      // still on screen would be tagged with this category.
      const first = rows()[0];
      b.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 10000 && (!rows().length || rows()[0] === first)) {
        checkCancel(ctx);
        await sleep(200);
      }
      const active = button(cat);
      if (!active || !active.hasAttribute("aria-current") || !rows().length || rows()[0] === first) continue;
      await loadAll(ctx, d, list, { sel: SKILL_SEL });
      for (const row of rows()) {
        const s = parseSkill(row);
        const hit = s && byName.get(s.name);
        if (hit && !hit.category) hit.category = cat;
      }
    }
  }

  async function scrapeDetails(ctx, item, report) {
    const { cfg, url, expected } = item;
    const d = await openPage(ctx, url, detailsReady);
    if (cfg.tabField) return scrapeTabbed(ctx, d, cfg, url, report);
    await loadAll(ctx, d, () => detailsList(d), {
      expected,
      onCount: n => report(`${cfg.label}: ${n}${expected ? ` of ${expected}` : ""} loaded`),
    });
    await expandAll(detailsList(d));
    ensureOn(d, url);
    const entries = parseEntries(cfg, detailsList(d));
    if (cfg.key === "skills" && entries.length) {
      try { await tagSkillCategories(ctx, d, entries, report); } catch (e) { if (ctx.cancelled) throw e; }
    }
    return entries;
  }

  // ─────────────────────────────────────────────────────────────
  // ORCHESTRATION
  // ─────────────────────────────────────────────────────────────
  function profileId(path = location.pathname) {
    const m = path.match(/^\/in\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function extractAll(onProgress = () => {}) {
    const id = profileId();
    if (!id) throw new Error("Open a LinkedIn profile (linkedin.com/in/…) first.");
    const base = `${location.origin}/in/${encodeURIComponent(id)}/`;
    const ctx = { cancelled: false, warnings: [] };
    ctx.overlay = createOverlay(() => { ctx.cancelled = true; });
    let frac = 0;
    const report = (text, f) => {
      if (f != null) frac = f;
      ctx.overlay.step(text, frac);
      onProgress({ label: text, frac });
    };
    ctx.cancel = () => { ctx.cancelled = true; };
    currentJob = ctx;

    try {
      // 1. Profile page
      report("Loading profile…", 0.02);
      const doc = await openPage(ctx, base, d => !!topCard(d));
      report("Loading every section of the profile…", 0.05);
      await loadProfileSections(ctx, doc);
      ensureOn(doc, base);

      const profile = {
        meta: { extractedAt: new Date().toISOString(), profileUrl: base, extractor: `LinkedIn Profile Extractor ${VERSION}` },
        header: parseHeader(doc),
        contact: null,
        about: "",
        topSkills: [],
        sections: {},
        warnings: ctx.warnings,
      };
      if (!profile.header.name) profile.header.name = doc.title.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn.*$/i, "");

      const plan = [];
      for (const sec of profileSections(doc)) {
        const { title, count } = sectionTitle(sec);
        if (!title || IGNORED_SECTIONS.test(title)) continue;
        if (/^about$/i.test(title)) { Object.assign(profile, parseAbout(sec)); continue; }
        const cfg = SECTIONS.find(s => s.rx.test(title));
        if (!cfg) {
          // Unknown card with real entries — keep it under its own heading.
          const entries = parseEntries({ parse: parseGeneric }, sec);
          if (entries.length) profile.sections[title] = entries;
          continue;
        }
        if (cfg.text) {
          profile.sections[cfg.key] = extractLines([sec], x => /^h[1-6]$/.test(x.localName))
            .flatMap(l => l.text.split(/\s*•\s*/)).filter(Boolean);
          continue;
        }
        profile.sections[cfg.key] = parseEntries(cfg, sec);
        const url = cfg.slug ? detailsUrlFor(sec, cfg) : "";
        if (url) plan.push({ cfg, url, expected: expectedCount(sec, count) });
      }

      // 2. Every section's "Show all" page
      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        const f0 = 0.1 + (0.8 * i) / plan.length;
        report(`${item.cfg.label} (${i + 1}/${plan.length})…`, f0);
        try {
          const entries = await scrapeDetails(ctx, item, t => report(`${t}  ·  section ${i + 1}/${plan.length}`));
          // The details page is the full list; the profile preview is only a
          // fallback for when it comes back empty.
          if (entries.length) profile.sections[item.cfg.key] = entries;
          else if ((profile.sections[item.cfg.key] || []).length) ctx.warnings.push(`${item.cfg.label}: the "Show all" page came back empty; kept the profile preview.`);
          if (item.expected && entries.length < item.expected) {
            ctx.warnings.push(`${item.cfg.label}: got ${entries.length} of ${item.expected} entries (LinkedIn stopped loading more).`);
          }
        } catch (e) {
          if (ctx.cancelled) throw e;
          ctx.warnings.push(`${item.cfg.label}: ${e.message}`);
          log(item.cfg.label, e);
        }
      }

      // 3. Contact info
      report("Contact info…", 0.92);
      try {
        const d = await openPage(ctx, `${base}overlay/contact-info/`, (d, t) => !!parseContact(d) || t > 12000, 20000);
        profile.contact = parseContact(d);
      } catch (e) {
        if (ctx.cancelled) throw e;
        ctx.warnings.push(`Contact info: ${e.message}`);
      }

      resolveSkillLinks(profile.sections);
      report("Done", 1);
      return prune(profile);
    } finally {
      ctx.overlay.remove();
      currentJob = null;
    }
  }

  function prune(v) {
    if (Array.isArray(v)) return v.map(prune).filter(x => !isEmpty(x));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const p = prune(x);
        if (!isEmpty(p) || k === "warnings") o[k] = p;
      }
      return o;
    }
    return typeof v === "string" ? v.trim() : v;
  }
  function isEmpty(x) {
    return x == null || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length);
  }

  // ─────────────────────────────────────────────────────────────
  // TEXT OUTPUT
  // ─────────────────────────────────────────────────────────────
  const LABELS = {
    employmentType: "Employment type", totalTenure: "Total at company", companyUrl: "Company page",
    schoolUrl: "School page", credentialId: "Credential ID", credentialUrl: "Credential URL",
    associatedWith: "Associated with", usedIn: "Used in", details: "Other", url: "URL",
    profileUrl: "Profile URL", connectedSince: "Connected", im: "IM",
  };
  const labelOf = k => LABELS[k] || k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());

  function formatText(p) {
    const L = [];
    const DIV = "═".repeat(64), THIN = "─".repeat(56);
    const H = t => L.push("", DIV, `  ${t.toUpperCase()}`, DIV);
    const block = (text, ind) => { for (const ln of String(text).split("\n")) L.push(ln.trim() ? ind + ln : ""); };
    const field = (k, v, ind) => {
      if (isEmpty(v)) return;
      if (Array.isArray(v)) {
        if (v.every(x => typeof x === "string")) {
          if (["skills", "topSkills"].includes(k)) { L.push(`${ind}${labelOf(k)}: ${v.join(", ")}`); return; }
          L.push(`${ind}${labelOf(k)}:`);
          v.forEach(x => block(`• ${x}`, ind + "  "));
        } else {
          L.push(`${ind}${labelOf(k)}:`);
          v.forEach(m => { block(`• ${m.title}`, ind + "  "); if (m.description) block(m.description, ind + "    "); });
        }
        return;
      }
      const s = String(v);
      if (s.includes("\n") || s.length > 110) { L.push(`${ind}${labelOf(k)}:`); block(s, ind + "  "); }
      else L.push(`${ind}${labelOf(k)}: ${s}`);
    };

    L.push(DIV, "  LINKEDIN PROFILE EXTRACT",
      `  Name      : ${p.header?.name || ""}`,
      `  Profile   : ${p.meta.profileUrl}`,
      `  Extracted : ${new Date(p.meta.extractedAt).toLocaleString()}`, DIV);

    H("Personal Information");
    for (const [k, v] of Object.entries(p.header || {})) field(k, v, "  ");
    if (p.contact) { H("Contact Info"); for (const [k, v] of Object.entries(p.contact)) field(k, v, "  "); }
    if (p.about || p.topSkills) {
      H("About");
      if (p.about) block(p.about, "  ");
      if (p.topSkills) { L.push(""); field("topSkills", p.topSkills, "  "); }
    }

    const sections = p.sections || {};
    const keys = [...SECTIONS.map(s => s.key).filter(k => sections[k]), ...Object.keys(sections).filter(k => !SECTION_BY_KEY[k])];
    for (const key of keys) {
      const cfg = SECTION_BY_KEY[key] || { label: key };
      const data = sections[key];
      H(`${cfg.label} (${data.length})`);
      if (cfg.text) { data.forEach(t => block(`• ${t}`, "  ")); continue; }
      if (key === "skills") {
        for (const s of data) {
          L.push(`  • ${s.name}${s.category ? `  [${s.category}]` : ""}`);
          for (const k of ["usedIn", "endorsements", "details"]) if (s[k]) L.push(`      ${labelOf(k)}: ${s[k].join("; ")}`);
        }
        continue;
      }
      if (key === "languages") {
        data.forEach(e => L.push(`  • ${e.language}${e.proficiency ? ` — ${e.proficiency}` : ""}`));
        continue;
      }
      if (key === "interests") {
        let last = null;
        for (const e of data) {
          if (e.category !== last) { L.push("", `  ${e.category || "Other"}:`); last = e.category; }
          L.push(`    • ${e.name}${e.subtitle ? ` — ${e.subtitle}` : ""}`);
        }
        continue;
      }
      data.forEach((e, i) => {
        const title = (cfg.title && cfg.title(e)) || Object.values(e).find(v => typeof v === "string") || `Entry ${i + 1}`;
        L.push("", `  ▸ ${i + 1}. ${title}`, `  ${THIN}`);
        for (const [k, v] of Object.entries(e)) field(k, v, "    ");
      });
    }

    if (p.warnings && p.warnings.length) {
      H("Notes");
      p.warnings.forEach(w => block(`• ${w}`, "  "));
    }
    L.push("", DIV, "  END OF PROFILE EXTRACT", DIV, "");
    return L.join("\n");
  }

  function fileBase(name) {
    const slug = String(name || "linkedin-profile").normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "linkedin-profile";
    return `${slug}_${new Date().toISOString().slice(0, 10)}`;
  }

  function counts(p) {
    const out = {};
    for (const [k, v] of Object.entries(p.sections || {})) out[k] = Array.isArray(v) ? v.length : 0;
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // JOB + MESSAGING
  // ─────────────────────────────────────────────────────────────
  let currentJob = null;
  let lastProgress = null;

  const notify = msg => { if (hasExt) chrome.runtime.sendMessage(msg).catch(() => {}); };

  async function runJob() {
    lastProgress = { label: "Starting…", frac: 0 };
    try {
      const profile = await extractAll(p => { lastProgress = p; notify({ type: "li-progress", ...p }); });
      const record = {
        name: profile.header?.name || "",
        url: profile.meta.profileUrl,
        extractedAt: profile.meta.extractedAt,
        fileBase: fileBase(profile.header?.name),
        counts: counts(profile),
        warnings: profile.warnings || [],
        txt: formatText(profile),
        json: JSON.stringify(profile, null, 2),
      };
      await chrome.storage.local.set({ lastExtract: record });
      notify({ type: "li-done", name: record.name, counts: record.counts });
      notify({ action: "download", format: "txt" });
      log("Done", record.counts);
    } catch (e) {
      log("Failed:", e);
      notify({ type: "li-error", error: e.message || String(e) });
    } finally {
      lastProgress = null;
    }
  }

  window.__liExtractHandler = function (request, _sender, sendResponse) {
    if (request.action === "status") {
      sendResponse({ success: true, data: { profileId: profileId(), running: !!currentJob, progress: lastProgress } });
      return;
    }
    if (request.action === "extractAll") {
      if (!profileId()) { sendResponse({ success: false, error: "Open a LinkedIn profile (linkedin.com/in/…) first." }); return; }
      if (currentJob) { sendResponse({ success: true, data: { started: false, running: true } }); return; }
      runJob();
      sendResponse({ success: true, data: { started: true } });
      return;
    }
    if (request.action === "cancel") {
      if (currentJob) currentJob.cancel();
      sendResponse({ success: true });
    }
  };

  // Console hook for debugging from the content-script context.
  window.__liExtractor = { extractAll, formatText, parseHeader, parseEntries, SECTIONS, VERSION };

  if (hasExt) chrome.runtime.onMessage.addListener(window.__liExtractHandler);
  log(`v${VERSION} ready —`, location.pathname);
})();
