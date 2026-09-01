/**
 * The floating countdown panel injected into the Canvas page.
 *
 * It renders inside a shadow root so Canvas cannot restyle it and it cannot
 * restyle Canvas. It owns no timer state: every control sends a command to the
 * service worker, which writes the session back to storage, and the panel
 * re-renders from that.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});
  const { STATUS, SIZES } = CAT;
  const { formatClock, formatHuman, parseUserDuration } = CAT.duration;

  const ICONS = {
    play: '<path d="M5 3.5 13 8l-8 4.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    next: '<path d="M4 3.5 10 8l-6 4.5z" fill="currentColor" stroke="none"/><path d="M12 3.5v9"/>',
    prev: '<path d="M12 3.5 6 8l6 4.5z" fill="currentColor" stroke="none"/><path d="M4 3.5v9"/>',
    reset: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1"/>',
    moon: '<path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7z"/>',
    expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    shrink: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    size: '<path d="M2.5 2.5h11v11h-11z"/><path d="M6 6h4v4H6z"/>',
    chevron: '<path d="M4 6.5 8 10l4-3.5"/>'
  };

  function icon(name) {
    return `<svg class="cat-icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  /** Seconds left at which the flash doubles its rate. */
  const CRITICAL_SECONDS = 10;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * A short two-tone chime. Built on demand because an AudioContext created
   * before a user gesture starts suspended.
   */
  function createChime() {
    let ctx = null;
    return function play(kind) {
      try {
        if (!ctx) ctx = new (root.AudioContext || root.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const notes = kind === 'finish' ? [880, 660, 523] : [660, 880];
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const at = now + i * 0.16;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.14, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
          osc.connect(gain).connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.18);
        });
      } catch (err) {
        /* Audio is a nicety; never let it break the timer. */
      }
    };
  }

  function createOverlay(options) {
    const doc = document;
    const host = doc.createElement('div');
    host.id = 'canvas-activity-timer-root';
    host.style.cssText = 'all:initial;position:static;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('src/content/overlay.css');
    shadow.appendChild(style);

    const panel = doc.createElement('div');
    panel.className = 'cat-root';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Canvas activity timer');
    panel.innerHTML = `
      <div class="cat-header" data-role="header" part="header">
        <div class="cat-title" data-role="title">Activity</div>
        <div class="cat-header-actions">
          <button class="cat-btn is-icon" data-role="collapse" title="Collapse" aria-label="Collapse">${icon('chevron')}</button>
          <button class="cat-btn is-icon" data-role="theme" title="Light / dark" aria-label="Toggle light or dark">${icon('moon')}</button>
          <button class="cat-btn is-icon" data-role="size" title="Panel size" aria-label="Cycle panel size">${icon('size')}</button>
          <button class="cat-btn is-icon" data-role="fullscreen" title="Full screen (F)" aria-label="Toggle full screen">${icon('expand')}</button>
          <button class="cat-btn is-icon" data-role="close" title="Close timer" aria-label="Close timer">${icon('close')}</button>
        </div>
      </div>
      <div class="cat-body">
        <div class="cat-dial-wrap" data-role="dial-wrap">
          <div class="cat-readout">
            <div class="cat-clock" data-role="clock" title="Click to swap subsection and total time">0:00</div>
            <div class="cat-segment-name" data-role="segment-name"></div>
            <div class="cat-counter" data-role="counter"></div>
            <div class="cat-total" data-role="total"></div>
          </div>
        </div>
        <div class="cat-controls">
          <button class="cat-btn is-outline" data-role="prev" title="Previous subsection" aria-label="Previous subsection">${icon('prev')}</button>
          <button class="cat-btn is-primary" data-role="toggle">${icon('pause')}<span data-role="toggle-label">Pause</span></button>
          <button class="cat-btn is-outline" data-role="next" title="Next subsection" aria-label="Next subsection">${icon('next')}</button>
          <button class="cat-btn is-outline" data-role="reset" title="Restart from the beginning" aria-label="Restart">${icon('reset')}</button>
        </div>
        <div class="cat-nudges" data-role="nudges"></div>
        <div class="cat-custom">
          <input class="cat-input" data-role="custom-input" type="text" inputmode="text"
                 placeholder="Time left on this step… 12, 90s, 5:30" aria-label="Set the time left on the current subsection">
          <button class="cat-btn is-outline" data-role="custom-apply">Set</button>
        </div>
        <div class="cat-hint" data-role="hint"></div>
        <ul class="cat-list" data-role="list"></ul>
      </div>
      <div class="cat-resize" data-role="resize" title="Drag to resize"></div>
    `;
    shadow.appendChild(panel);

    const refs = {};
    panel.querySelectorAll('[data-role]').forEach((el) => {
      refs[el.dataset.role] = el;
    });

    const dial = CAT.dial.createDial(doc, {
      onSegmentClick: (index) => options.onCommand(CAT.MSG.JUMP, { index })
    });
    refs['dial-wrap'].insertBefore(dial.el, refs['dial-wrap'].firstChild);

    const chime = createChime();

    const darkQuery = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;

    let session = null;
    let settings = Object.assign({}, CAT.DEFAULT_SETTINGS);
    let rafId = null;
    let lastRenderKey = '';
    let lastSegmentIndex = -1;
    let lastFinished = false;
    let listSignature = '';

    /* ---------------- geometry ---------------- */

    function currentWidth() {
      if (settings.size === 'custom' && settings.customWidth) return settings.customWidth;
      return SIZES[settings.size] || SIZES.medium;
    }

    function applyGeometry() {
      const width = clamp(currentWidth(), 220, Math.max(240, root.innerWidth - 24));
      panel.style.setProperty('--cat-width', `${width}px`);

      if (settings.fullscreen) {
        panel.classList.add('is-fullscreen');
        return;
      }
      panel.classList.remove('is-fullscreen');

      const height = panel.offsetHeight || 320;
      const maxLeft = Math.max(8, root.innerWidth - width - 8);
      const maxTop = Math.max(8, root.innerHeight - height - 8);
      const pos = settings.position || {
        left: Math.max(8, root.innerWidth - width - 24),
        top: 96
      };
      panel.style.left = `${clamp(pos.left, 8, maxLeft)}px`;
      panel.style.top = `${clamp(pos.top, 8, maxTop)}px`;
    }

    function applySettings(next) {
      settings = Object.assign({}, CAT.DEFAULT_SETTINGS, next || {});
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'auto' && !!darkQuery && darkQuery.matches);
      panel.dataset.theme = dark ? 'dark' : 'light';
      refs.theme.innerHTML = icon(dark ? 'sun' : 'moon');
      refs.theme.title =
        settings.theme === 'auto' ? 'Theme: match system' : `Theme: ${settings.theme}`;
      refs.fullscreen.innerHTML = icon(settings.fullscreen ? 'shrink' : 'expand');
      panel.classList.toggle('is-collapsed', !!settings.collapsed);
      refs.collapse.style.transform = settings.collapsed ? 'rotate(-90deg)' : '';
      applyGeometry();
    }

    /* ---------------- rendering ---------------- */

    function renderNudges() {
      if (refs.nudges.childElementCount) return;
      CAT.NUDGE_STEPS.forEach((step) => {
        const button = doc.createElement('button');
        button.className = 'cat-btn cat-nudge';
        const sign = step > 0 ? '+' : '−';
        const magnitude = Math.abs(step);
        button.textContent = `${sign}${magnitude >= 60 ? `${magnitude / 60}m` : `${magnitude}s`}`;
        button.title = `${step > 0 ? 'Add' : 'Remove'} ${formatHuman(magnitude)} on this subsection`;
        button.addEventListener('click', () => options.onCommand(CAT.MSG.NUDGE, { delta: step }));
        refs.nudges.appendChild(button);
      });
    }

    function renderList(state) {
      const signature =
        session.segments.map((s) => `${s.id}:${s.seconds}`).join('|') + `#${state.index}`;
      if (signature === listSignature) return;
      listSignature = signature;

      refs.list.textContent = '';
      session.segments.forEach((segment, index) => {
        const item = doc.createElement('li');
        item.className = 'cat-list-item';
        if (index === state.index && !state.isFinished) item.classList.add('is-current');
        if (index < state.index || state.isFinished) item.classList.add('is-done');
        item.title = `Jump to “${segment.name}”`;

        const swatch = doc.createElement('span');
        swatch.className = 'cat-swatch';
        swatch.style.background = CAT.dial.colorFor(index);

        const name = doc.createElement('span');
        name.className = 'cat-list-name';
        name.textContent = segment.name;

        const time = doc.createElement('span');
        time.className = 'cat-list-time';
        time.textContent = formatHuman(segment.seconds);

        item.append(swatch, name, time);
        item.addEventListener('click', () => options.onCommand(CAT.MSG.JUMP, { index }));
        refs.list.appendChild(item);
      });
    }

    /**
     * Flashing kicks in for the last stretch of the current subsection, and is
     * capped at half its length so a short subsection is not flashing from the
     * moment it starts.
     */
    function flashState(state) {
      if (!settings.flashEnabled) return { flashing: false, critical: false };
      if (state.isFinished || !state.isRunning) return { flashing: false, critical: false };

      // Capped at half the subsection so a short one is not flashing from the
      // moment it starts, but the last few seconds always flash regardless.
      const threshold = Math.min(
        settings.flashSeconds,
        state.segment ? Math.max(CRITICAL_SECONDS, state.segment.seconds / 2) : settings.flashSeconds
      );
      const watched = Math.min(state.segmentRemaining, state.remaining);
      const critical = watched <= CRITICAL_SECONDS;
      return { flashing: critical || watched <= threshold, critical };
    }

    function render(now) {
      if (!session) return;
      const state = CAT.session.progress(session, now);

      const primaryIsTotal = settings.primary === 'total';
      const primarySeconds = primaryIsTotal ? state.remaining : state.segmentRemaining;
      const secondarySeconds = primaryIsTotal ? state.segmentRemaining : state.remaining;

      const flash = flashState(state);
      const key = [
        Math.ceil(primarySeconds),
        Math.ceil(secondarySeconds),
        state.index,
        session.status,
        flash.flashing,
        flash.critical
      ].join('|');

      // The dial moves every frame; the text only when a displayed value changes.
      dial.update(session, state);

      if (key !== lastRenderKey) {
        lastRenderKey = key;
        refs.clock.textContent = formatClock(primarySeconds);
        refs.title.textContent = session.activity;
        refs.title.title = session.activity;
        refs['segment-name'].textContent = state.isFinished
          ? 'Time’s up'
          : state.segment
            ? state.segment.name
            : '';
        refs.counter.textContent = session.segments.length
          ? `${Math.min(state.index + 1, session.segments.length)} of ${session.segments.length}`
          : '';
        refs.total.textContent = primaryIsTotal
          ? `${formatClock(secondarySeconds)} in this subsection`
          : `${formatClock(secondarySeconds)} left overall`;

        const running = session.status === STATUS.RUNNING;
        refs.toggle.innerHTML =
          icon(running ? 'pause' : 'play') +
          `<span data-role="toggle-label">${running ? 'Pause' : state.isFinished ? 'Restart' : 'Start'}</span>`;

        panel.classList.toggle('is-flashing', flash.flashing);
        panel.classList.toggle('is-critical', flash.critical);
        panel.classList.toggle('is-finished', state.isFinished);
        renderList(state);
      }

      // Boundary crossings and the final zero are announced once each.
      if (state.index !== lastSegmentIndex) {
        if (lastSegmentIndex !== -1 && state.isRunning && settings.soundEnabled) chime('segment');
        lastSegmentIndex = state.index;
      }
      if (state.isFinished && !lastFinished) {
        lastFinished = true;
        if (settings.soundEnabled) chime('finish');
        if (session.status !== STATUS.FINISHED) options.onCommand(CAT.MSG.FINISHED, {});
      } else if (!state.isFinished) {
        lastFinished = false;
      }
    }

    function loop() {
      render(Date.now());
      rafId = root.requestAnimationFrame(loop);
    }

    function startLoop() {
      if (rafId === null) rafId = root.requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId !== null) root.cancelAnimationFrame(rafId);
      rafId = null;
    }

    /* ---------------- dragging & resizing ---------------- */

    function beginDrag(event) {
      if (settings.fullscreen) return;
      if (event.target.closest('.cat-btn')) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      panel.classList.add('is-dragging');

      const move = (ev) => {
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const left = clamp(ev.clientX - offsetX, 8, Math.max(8, root.innerWidth - width - 8));
        const top = clamp(ev.clientY - offsetY, 8, Math.max(8, root.innerHeight - height - 8));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      };
      const end = () => {
        panel.classList.remove('is-dragging');
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', end);
        options.onSettings({
          position: { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) }
        });
      };
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', end);
    }

    function beginResize(event) {
      if (settings.fullscreen) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = panel.offsetWidth;
      const left = panel.getBoundingClientRect().left;

      const move = (ev) => {
        const width = clamp(
          startWidth + (ev.clientX - startX),
          220,
          Math.max(240, root.innerWidth - left - 8)
        );
        panel.style.setProperty('--cat-width', `${width}px`);
      };
      const end = () => {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', end);
        options.onSettings({ size: 'custom', customWidth: panel.offsetWidth });
      };
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', end);
    }

    /* ---------------- controls ---------------- */

    function applyCustomTime() {
      const seconds = parseUserDuration(refs['custom-input'].value);
      if (!seconds) {
        refs.hint.textContent = 'Try “12”, “90s”, “5:30” or “1h 15m”.';
        refs.hint.classList.add('is-error');
        return;
      }
      refs.hint.textContent = '';
      refs.hint.classList.remove('is-error');
      refs['custom-input'].value = '';
      options.onCommand(CAT.MSG.SET_SEGMENT, { seconds });
    }

    refs.collapse.addEventListener('click', () =>
      options.onSettings({ collapsed: !settings.collapsed })
    );
    refs.theme.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(settings.theme) + 1) % order.length];
      options.onSettings({ theme: next });
    });
    refs.size.addEventListener('click', () => {
      const order = ['small', 'medium', 'large'];
      const index = order.indexOf(settings.size);
      const next = order[(index + 1) % order.length];
      options.onSettings({ size: next, customWidth: null });
    });
    refs.fullscreen.addEventListener('click', () =>
      options.onSettings({ fullscreen: !settings.fullscreen })
    );
    refs.close.addEventListener('click', () => options.onCommand(CAT.MSG.STOP, {}));
    refs.toggle.addEventListener('click', () => {
      if (!session) return;
      if (session.status === STATUS.RUNNING) options.onCommand(CAT.MSG.PAUSE, {});
      else options.onCommand(CAT.MSG.RESUME, {});
    });
    refs.prev.addEventListener('click', () => options.onCommand(CAT.MSG.JUMP, { relative: -1 }));
    refs.next.addEventListener('click', () => options.onCommand(CAT.MSG.JUMP, { relative: 1 }));
    refs.reset.addEventListener('click', () => options.onCommand(CAT.MSG.RESET, {}));
    refs.clock.addEventListener('click', () =>
      options.onSettings({ primary: settings.primary === 'total' ? 'segment' : 'total' })
    );
    refs['custom-apply'].addEventListener('click', applyCustomTime);
    refs['custom-input'].addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') applyCustomTime();
    });
    refs.header.addEventListener('pointerdown', beginDrag);
    refs.resize.addEventListener('pointerdown', beginResize);

    const onResizeWindow = () => applyGeometry();
    root.addEventListener('resize', onResizeWindow);

    // "Match system" has to keep matching if the system changes mid-run.
    const onSchemeChange = () => {
      if (settings.theme === 'auto') applySettings(settings);
    };
    if (darkQuery) darkQuery.addEventListener('change', onSchemeChange);

    // Keyboard shortcuts, ignored while typing into a page field.
    const onKeyDown = (event) => {
      if (!session) return;
      const target = event.composedPath()[0];
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f') options.onSettings({ fullscreen: !settings.fullscreen });
      else if (key === 'escape' && settings.fullscreen) options.onSettings({ fullscreen: false });
      else return;
      event.preventDefault();
    };
    doc.addEventListener('keydown', onKeyDown, true);

    renderNudges();

    return {
      host,
      mount() {
        if (!host.isConnected) (doc.body || doc.documentElement).appendChild(host);
        startLoop();
      },
      unmount() {
        stopLoop();
        root.removeEventListener('resize', onResizeWindow);
        if (darkQuery) darkQuery.removeEventListener('change', onSchemeChange);
        doc.removeEventListener('keydown', onKeyDown, true);
        host.remove();
      },
      setSession(next) {
        const changedSession = !session || next.id !== session.id;
        session = next;
        if (changedSession) {
          lastSegmentIndex = -1;
          lastFinished = false;
        }
        lastRenderKey = '';
        listSignature = '';
        render(Date.now());
        applyGeometry();
      },
      setSettings(next) {
        applySettings(next);
        lastRenderKey = '';
        if (session) render(Date.now());
      },
      isMounted: () => host.isConnected
    };
  }

  CAT.overlay = { createOverlay };
})(typeof globalThis !== 'undefined' ? globalThis : self);
