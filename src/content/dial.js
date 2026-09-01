/**
 * The segmented countdown dial.
 *
 * Each subsection owns a wedge of the circle sized by its share of the total,
 * so a 5-minute warm-up inside a 50-minute lab is visibly a tenth of the ring.
 * Time drains clockwise: the bright arc is what is left, the faint arc behind
 * it is what the plan allowed.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const VIEW = 100;
  const CENTER = VIEW / 2;
  const RADIUS = 40;
  const RING_WIDTH = 13;
  const GAP_DEGREES = 2.2;

  function polar(cx, cy, radius, degrees) {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(radians),
      y: cy + radius * Math.sin(radians)
    };
  }

  /** Path for an arc from startDeg to endDeg, clockwise from 12 o'clock. */
  function arcPath(radius, startDeg, endDeg) {
    const sweep = endDeg - startDeg;
    if (sweep <= 0) return '';
    // A full turn cannot be drawn as one arc, so it is split into two halves.
    if (sweep >= 359.999) {
      const a = polar(CENTER, CENTER, radius, 0);
      const b = polar(CENTER, CENTER, radius, 180);
      return `M ${a.x} ${a.y} A ${radius} ${radius} 0 1 1 ${b.x} ${b.y} A ${radius} ${radius} 0 1 1 ${a.x} ${a.y}`;
    }
    const start = polar(CENTER, CENTER, radius, startDeg);
    const end = polar(CENTER, CENTER, radius, endDeg);
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  function el(doc, name, attrs) {
    const node = doc.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function colorFor(index) {
    return CAT.SEGMENT_COLORS[index % CAT.SEGMENT_COLORS.length];
  }

  /**
   * Builds the dial once and returns an updater. The wedge geometry is rebuilt
   * only when the plan changes; every frame just moves the drain arcs.
   */
  function createDial(doc, options) {
    const opts = options || {};
    const svg = el(doc, 'svg', {
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      class: 'cat-dial',
      'aria-hidden': 'true',
      focusable: 'false'
    });

    const trackGroup = el(doc, 'g', { class: 'cat-dial-tracks' });
    const fillGroup = el(doc, 'g', { class: 'cat-dial-fills' });
    const tickGroup = el(doc, 'g', { class: 'cat-dial-ticks' });
    const playhead = el(doc, 'line', { class: 'cat-dial-playhead' });
    svg.append(trackGroup, fillGroup, tickGroup, playhead);

    let signature = '';
    let parts = [];

    function rebuild(session) {
      const total = CAT.session.totalSeconds(session);
      trackGroup.textContent = '';
      fillGroup.textContent = '';
      tickGroup.textContent = '';
      parts = [];
      if (!total) return;

      const bounds = CAT.session.boundaries(session);
      session.segments.forEach((segment, index) => {
        const startDeg = (bounds[index].start / total) * 360;
        const endDeg = (bounds[index].end / total) * 360;
        const span = endDeg - startDeg;
        // Tiny wedges lose their gap rather than disappear entirely.
        const gap = Math.min(GAP_DEGREES, span * 0.25);
        const from = startDeg + gap / 2;
        const to = endDeg - gap / 2;

        const track = el(doc, 'path', {
          class: 'cat-seg-track',
          d: arcPath(RADIUS, from, to),
          stroke: colorFor(index),
          'stroke-width': RING_WIDTH,
          fill: 'none'
        });
        const title = el(doc, 'title');
        title.textContent = `${segment.name} — ${CAT.duration.formatHuman(segment.seconds)}`;
        track.appendChild(title);

        const fill = el(doc, 'path', {
          class: 'cat-seg-fill',
          d: arcPath(RADIUS, from, to),
          stroke: colorFor(index),
          'stroke-width': RING_WIDTH,
          fill: 'none'
        });

        // Clicking a wedge jumps the timer to that subsection.
        const hit = el(doc, 'path', {
          class: 'cat-seg-hit',
          d: arcPath(RADIUS, from, to),
          stroke: 'transparent',
          'stroke-width': RING_WIDTH + 6,
          fill: 'none'
        });
        hit.dataset.index = String(index);

        trackGroup.appendChild(track);
        fillGroup.appendChild(fill);
        tickGroup.appendChild(hit);
        parts.push({ track, fill, hit, from, to, index });
      });
    }

    /** Redraws the drain arcs for the current instant. */
    function update(session, state) {
      const total = state.total;
      const nextSignature =
        session.segments.map((s) => `${s.id}:${s.seconds}`).join('|') + `#${session.id}`;
      if (nextSignature !== signature) {
        signature = nextSignature;
        rebuild(session);
      }
      if (!total || !parts.length) return;

      const elapsedDeg = (state.elapsed / total) * 360;

      parts.forEach((part) => {
        const { from, to, index } = part;
        const consumedTo = Math.min(Math.max(elapsedDeg, from), to);
        const remainingPath = arcPath(RADIUS, consumedTo, to);
        part.fill.setAttribute('d', remainingPath);
        part.fill.style.opacity = remainingPath ? '1' : '0';

        const isCurrent = index === state.index && !state.isFinished;
        const isDone = elapsedDeg >= to - 0.001;
        part.track.classList.toggle('is-current', isCurrent);
        part.track.classList.toggle('is-done', isDone);
        part.fill.classList.toggle('is-current', isCurrent);
      });

      const head = polar(CENTER, CENTER, RADIUS + RING_WIDTH / 2 + 1.5, elapsedDeg);
      const tail = polar(CENTER, CENTER, RADIUS - RING_WIDTH / 2 - 1.5, elapsedDeg);
      playhead.setAttribute('x1', tail.x);
      playhead.setAttribute('y1', tail.y);
      playhead.setAttribute('x2', head.x);
      playhead.setAttribute('y2', head.y);
      playhead.style.opacity = state.isFinished ? '0' : '1';
    }

    if (typeof opts.onSegmentClick === 'function') {
      svg.addEventListener('click', (event) => {
        const hit = event.target.closest('.cat-seg-hit');
        if (!hit) return;
        opts.onSegmentClick(Number(hit.dataset.index));
      });
    }

    return { el: svg, update };
  }

  CAT.dial = { createDial, arcPath, polar, colorFor, RADIUS, RING_WIDTH };
})(typeof globalThis !== 'undefined' ? globalThis : self);
