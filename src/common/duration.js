/**
 * Duration parsing and formatting.
 *
 * The scanner feeds this arbitrary heading text ("Warm-up (10 min)",
 * "Discussion — 5-10 minutes", "Lab 1:30:00") and needs a number of seconds
 * back, or null when the text carries no time at all.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});

  const UNIT_SECONDS = {
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1
  };

  const UNIT_PATTERN = 'hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s';
  const NUMBER = '\\d+(?:[.,]\\d+)?';

  /** Lower-cases, unifies dashes and collapses whitespace. */
  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[‐-―−]/g, '-') // – — − etc.
      .replace(/[   ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toNumber(raw) {
    return parseFloat(String(raw).replace(',', '.'));
  }

  const UNICODE_FRACTIONS = {
    '\u00bd': 0.5, '\u2153': 1 / 3, '\u2154': 2 / 3, '\u00bc': 0.25,
    '\u00be': 0.75, '\u2155': 0.2, '\u2159': 1 / 6, '\u215b': 0.125
  };

  /**
   * Rewrites fractional amounts into decimals before anything else looks at
   * the text, so "1/4 hour" cannot be misread as the "4 hour" inside it.
   */
  function expandFractions(text) {
    let out = text.replace(
      new RegExp(`(?:^|[^\\d.])(\\d+)\\s*/\\s*(\\d+)(\\s*(?:${UNIT_PATTERN})\\b)`, 'g'),
      (match, num, den, unit) => {
        const value = Number(num) / Number(den);
        if (!Number.isFinite(value) || value <= 0) return match;
        const lead = match[0] === num[0] ? '' : match[0];
        return `${lead}${Number(value.toFixed(4))}${unit}`;
      }
    );
    out = out.replace(
      new RegExp(`([\\u00bc-\\u00be\\u2153-\\u215e])\\s*(?:of\\s+)?(?:an?\\s+)?(${UNIT_PATTERN})\\b`, 'g'),
      (match, glyph, unit) => {
        const value = UNICODE_FRACTIONS[glyph];
        return value ? `${Number(value.toFixed(4))} ${unit}` : match;
      }
    );
    return out
      .replace(/\bhalf\s+(?:an?\s+)?hour\b/g, '0.5 hours')
      .replace(/\b(?:a\s+)?quarter\s+(?:of\s+)?(?:an?\s+)?hour\b/g, '0.25 hours')
      .replace(/\bhalf\s+(?:a\s+)?minute\b/g, '30 seconds');
  }

  /**
   * Collapses "5-10 minutes" / "5 to 10 min" down to "10 minutes" so the
   * summing pass below sees a single value. The upper bound is used because a
   * timer that runs short is more disruptive than one that runs long.
   */
  function collapseRanges(text) {
    const range = new RegExp(
      `(${NUMBER})\\s*(?:-|to)\\s*(${NUMBER})(\\s*(?:${UNIT_PATTERN})\\b)`,
      'g'
    );
    return text.replace(range, (match, low, high, unit) => `${high}${unit}`);
  }

  /**
   * Sums every "<number> <unit>" pair in the text: "1 hr 30 min" -> 5400.
   * Returns null when no pair is present.
   */
  function parseUnitForm(text) {
    const re = new RegExp(`(${NUMBER})\\s*(${UNIT_PATTERN})(?![a-z])`, 'g');
    let total = 0;
    let found = false;
    let match;
    while ((match = re.exec(text)) !== null) {
      const value = toNumber(match[1]);
      const seconds = UNIT_SECONDS[match[2]];
      if (!Number.isFinite(value) || !seconds) continue;
      total += value * seconds;
      found = true;
    }
    return found ? Math.round(total) : null;
  }

  /**
   * Parses "mm:ss" and "h:mm:ss". Bare clock-like text is ambiguous ("due
   * 3:30"), so callers that scan free text pass requireContext = true, which
   * only accepts the form when it is bracketed or introduced by a time word.
   */
  function parseColonForm(text, requireContext) {
    const re = /(?:^|[\s([\-|:])(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?=$|[\s)\]\-|,.])/;
    const match = re.exec(text);
    if (!match) return null;

    if (requireContext) {
      const bracketed = /[([][^)\]]*\d{1,3}:[0-5]\d/.test(text);
      const introduced =
        /\b(time|timer|duration|length|takes|approx|approximately|about|~|for)\b[^:]{0,16}\d{1,3}:[0-5]\d/.test(
          text
        );
      if (!bracketed && !introduced) return null;
    }

    const a = parseInt(match[1], 10);
    const b = parseInt(match[2], 10);
    const c = match[3] === undefined ? null : parseInt(match[3], 10);
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  /**
   * Extracts a duration from free-form text such as a heading or list item.
   * Returns seconds, or null when the text carries no recognisable time.
   */
  function parseDuration(text) {
    const normalized = collapseRanges(expandFractions(normalize(text)));
    if (!normalized) return null;

    // Bracketed text is the strongest signal: "Warm-up (10 min)".
    const brackets = normalized.match(/[([]([^)\]]{1,40})[)\]]/g) || [];
    for (const bracket of brackets) {
      const inner = bracket.slice(1, -1);
      const colon = parseColonForm(inner, false);
      if (colon !== null && colon > 0) return colon;
      const units = parseUnitForm(inner);
      if (units !== null && units > 0) return units;
    }

    const units = parseUnitForm(normalized);
    if (units !== null && units > 0) return units;

    const colon = parseColonForm(normalized, true);
    if (colon !== null && colon > 0) return colon;

    return null;
  }

  /**
   * Parses what a person types into a duration field. A bare number means
   * minutes here ("20" -> 20 minutes), which is what the input label promises.
   */
  function parseUserDuration(input) {
    let normalized = collapseRanges(expandFractions(normalize(input)));
    if (!normalized) return null;

    // People type "1h30" and "5m30" meaning the next unit down; the free-text
    // scanner must not guess like this, but a duration field can.
    normalized = normalized
      .replace(/(\d+)\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})(?!\s*[a-z\d])/, '$1h $2m')
      .replace(/(\d+)\s*(?:m|min|mins|minute|minutes)\s*(\d{1,2})(?!\s*[a-z\d])/, '$1m $2s');

    if (/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(normalized)) {
      return parseColonForm(normalized, false);
    }
    if (/^\d+(?:[.,]\d+)?$/.test(normalized)) {
      const minutes = toNumber(normalized);
      return Number.isFinite(minutes) ? Math.round(minutes * 60) : null;
    }
    const units = parseUnitForm(normalized);
    return units !== null && units > 0 ? units : null;
  }

  /**
   * A table cell or badge whose entire text is a time is unambiguous, so the
   * bare "0:20" form is accepted here but not in free-running prose.
   */
  function parseCellDuration(text) {
    const normalized = normalize(text);
    // "0:20" in an agenda column is 20 minutes (h:mm); no one schedules a
    // twenty-second step. Any other two-part value keeps the mm:ss reading.
    const leadingZero = /^0:([0-5]\d)$/.exec(normalized);
    if (leadingZero) return parseInt(leadingZero[1], 10) * 60;
    if (/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(normalized)) {
      return parseColonForm(normalized, false);
    }
    return parseDuration(text);
  }

  /**
   * "9:05" / "1:02:30" — the countdown readout. Rounded up so every displayed
   * second is shown for its whole second and "0:00" appears exactly at zero.
   */
  function formatClock(seconds) {
    const total = Math.max(0, Math.ceil((seconds || 0) - 1e-6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** "1h 30m" / "45m" / "30s" — compact labels next to subsection names. */
  function formatHuman(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    if (total < 60) return `${total}s`;
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  CAT.duration = {
    parseDuration,
    parseUserDuration,
    parseCellDuration,
    expandFractions,
    formatClock,
    formatHuman,
    normalize
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
