/**
 * Reads a Canvas page and proposes an activity name plus its timed
 * subsections. Canvas renders assignments, pages, quizzes and discussions with
 * different wrappers, so each selector list is tried in order of confidence
 * and the first hit wins.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});
  const { parseDuration, parseCellDuration } = CAT.duration;

  const TITLE_SELECTORS = [
    'h1.page-title',
    '.page-title',
    '#assignment_show h1.title',
    '.assignment-title h1',
    '.quiz-header h1',
    '#quiz_title',
    '.discussion-title',
    '[data-testid="discussion-topic-title"]',
    '#discussion_topic .discussion-title',
    '.announcement-title',
    '#content h1',
    '[role="main"] h1',
    'h1'
  ];

  const CONTENT_SELECTORS = [
    '.show-content.user_content',
    '.description.user_content',
    '#assignment_show .description',
    '.discussion-section .message',
    '[data-testid="message_body"]',
    '.user_content',
    '#course_syllabus',
    '.quiz-instructions',
    '#content .content',
    '[role="main"]',
    '#content'
  ];

  const SKIP_ANCESTORS =
    'nav, header, footer, script, style, noscript, #breadcrumbs, .ic-app-nav-toggle-and-crumbs, ' +
    '#right-side, #right-side-wrapper, .ui-dialog, [aria-hidden="true"], .screenreader-only, .hidden';

  const MAX_SEGMENTS = 24;
  const MAX_NAME_LENGTH = 160;
  /** A single subsection longer than this is a misparse, not a lesson step. */
  const MAX_SEGMENT_SECONDS = 8 * 3600;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest && el.closest(SKIP_ANCESTORS)) return false;
    const rects = el.getClientRects ? el.getClientRects() : null;
    if (rects && rects.length === 0) {
      // Elements inside a collapsed accordion still carry usable text.
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Removes the time token from "Warm-up (10 min)" so the name reads cleanly. */
  function stripDuration(text) {
    let out = String(text || '')
      .replace(/[([][^)\]]{0,40}\d[^)\]]{0,40}[)\]]/g, ' ')
      .replace(
        /\b\d+(?:[.,]\d+)?\s*(?:-|to)\s*\d+(?:[.,]\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
        ' '
      )
      .replace(
        /\b\d+(?:[.,]\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
        ' '
      )
      .replace(/\b\d{1,3}:[0-5]\d(?::[0-5]\d)?\b/g, ' ')
      .replace(
        /\b(approx\.?|approximately|about|around|est\.?|estimated|duration|time|timing|length)\b\s*[:-]?\s*$/gi,
        ' '
      )
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:•·*|,.]+/, '')
      .replace(/[\s\-–—:•·*|,]+$/, '')
      .trim();
    if (out.length > MAX_NAME_LENGTH) out = out.slice(0, MAX_NAME_LENGTH - 1).trim() + '…';
    return out;
  }

  function pushCandidate(list, seen, name, seconds, el) {
    if (!seconds || seconds <= 0 || seconds > MAX_SEGMENT_SECONDS) return;
    const label = stripDuration(name) || 'Subsection';
    const key = `${label.toLowerCase()}|${seconds}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ name: label, seconds, el });
  }

  /** Headings (h2–h6) that carry a time — the most common lesson-plan layout. */
  function scanHeadings(scopeEl) {
    const out = [];
    const seen = new Set();
    scopeEl.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el) => {
      if (!isVisible(el)) return;
      const text = textOf(el);
      if (!text || text.length > 200) return;
      pushCandidate(out, seen, text, parseDuration(text), el);
    });
    return out;
  }

  /** List items that carry a time. */
  function scanListItems(scopeEl) {
    const out = [];
    const seen = new Set();
    scopeEl.querySelectorAll('li').forEach((el) => {
      if (!isVisible(el)) return;
      if (el.querySelector('li')) return; // only leaf items
      const text = textOf(el);
      if (!text || text.length > 220) return;
      pushCandidate(out, seen, text, parseDuration(text), el);
    });
    return out;
  }

  /** Two-column tables of "step | duration". */
  function scanTableRows(scopeEl) {
    const out = [];
    const seen = new Set();
    scopeEl.querySelectorAll('tr').forEach((row) => {
      if (!isVisible(row)) return;
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (cells.length < 2) return;
      const texts = cells.map(textOf);
      let timeIndex = -1;
      let seconds = null;
      for (let i = texts.length - 1; i >= 0; i--) {
        const parsed = parseCellDuration(texts[i]);
        if (parsed) {
          timeIndex = i;
          seconds = parsed;
          break;
        }
      }
      if (timeIndex === -1) return;
      const name =
        texts.filter((_, i) => i !== timeIndex).find((t) => t && !/^\d+$/.test(t)) || texts[0];
      pushCandidate(out, seen, name, seconds, row);
    });
    return out;
  }

  /** Paragraphs and definition terms — noisiest, so used only as a fallback. */
  function scanParagraphs(scopeEl) {
    const out = [];
    const seen = new Set();
    scopeEl.querySelectorAll('p, dt, dd, div.cat-step').forEach((el) => {
      if (!isVisible(el)) return;
      if (el.querySelector('p, li, table')) return;
      const text = textOf(el);
      if (!text || text.length > 180) return;
      pushCandidate(out, seen, text, parseDuration(text), el);
    });
    return out;
  }

  function findTitle(doc) {
    for (const selector of TITLE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el && isVisible(el)) {
        const text = textOf(el);
        if (text) return text.slice(0, 200);
      }
    }
    const title = (doc.title || '').replace(/\s+/g, ' ').trim();
    // Canvas titles look like "Lesson 3: Cells" or "Cells: BIO 101".
    const cleaned = title.split(/\s+[:|]\s+/)[0];
    return (cleaned || title || 'Canvas activity').slice(0, 200);
  }

  function findContentRoot(doc) {
    for (const selector of CONTENT_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el && isVisible(el) && textOf(el).length > 20) return el;
    }
    return doc.body;
  }

  /** "Estimated time: 45 minutes" stated once for the whole activity. */
  function findTotalHint(scopeEl) {
    const text = textOf(scopeEl).slice(0, 4000);
    const match = text.match(
      /\b(?:estimated|total|approx\.?|approximate|expected)\s*(?:time|duration|length)?\s*[:-]?\s*([^.;\n]{1,32})/i
    );
    if (!match) return null;
    return parseDuration(match[1]);
  }

  /**
   * Runs every strategy and keeps the one that found the most subsections,
   * breaking ties in order of confidence (headings first).
   */
  function scan(doc) {
    const document_ = doc || root.document;
    const contentRoot = findContentRoot(document_);
    const strategies = [
      { source: 'headings', items: scanHeadings(contentRoot) },
      { source: 'list', items: scanListItems(contentRoot) },
      { source: 'table', items: scanTableRows(contentRoot) },
      { source: 'paragraphs', items: scanParagraphs(contentRoot) }
    ];

    let best = strategies[0];
    for (const strategy of strategies) {
      if (strategy.items.length > best.items.length) best = strategy;
    }

    let segments = best.items.slice(0, MAX_SEGMENTS).map((item) => ({
      name: item.name,
      seconds: item.seconds
    }));
    let source = best.items.length ? best.source : 'none';

    const totalHint = findTotalHint(contentRoot);
    if (!segments.length && totalHint) {
      segments = [{ name: 'Whole activity', seconds: totalHint }];
      source = 'total-hint';
    }

    return {
      activity: findTitle(document_),
      segments,
      source,
      totalHint,
      url: document_.location ? document_.location.href : null,
      scannedAt: Date.now()
    };
  }

  CAT.scanner = {
    scan,
    stripDuration,
    findTitle,
    findContentRoot,
    scanHeadings,
    scanListItems,
    scanTableRows,
    scanParagraphs
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
