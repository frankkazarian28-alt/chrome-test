/**
 * Popup: builds the plan before the timer runs, and mirrors it while it does.
 *
 * The scan comes from the content script in the active tab; everything the user
 * edits here stays in a draft keyed to the page URL so closing the popup does
 * not throw the plan away.
 */
(function () {
  const CAT = window.CAT;
  const { STATUS, MSG } = CAT;
  const { parseUserDuration, formatHuman, formatClock } = CAT.duration;

  const el = (id) => document.getElementById(id);
  const views = {
    running: el('running'),
    plan: el('plan'),
    unsupported: el('unsupported'),
    settings: el('settings-panel')
  };

  let tab = null;
  let settings = Object.assign({}, CAT.DEFAULT_SETTINGS);
  let session = null;
  let plan = { activity: '', segments: [], source: 'none' };
  let ticker = null;

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload: payload || {} }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response || null);
      });
    });
  }

  function show(name) {
    Object.entries(views).forEach(([key, node]) => {
      if (key === 'settings') return;
      node.classList.toggle('is-hidden', key !== name);
    });
  }

  /** Round minutes render bare ("12"); anything else keeps its seconds. */
  function formatEditable(seconds) {
    if (seconds % 60 === 0) return String(seconds / 60);
    if (seconds < 60) return `${seconds}s`;
    return formatClock(seconds);
  }

  /* ---------------- plan editing ---------------- */

  function totalSeconds() {
    return plan.segments.reduce((sum, s) => sum + s.seconds, 0);
  }

  function saveDraft() {
    if (!tab) return;
    send(MSG.DRAFT, {
      draft: {
        url: tab.url,
        activity: plan.activity,
        segments: plan.segments,
        savedAt: Date.now()
      }
    });
  }

  function renderTotal() {
    el('total').textContent = formatHuman(totalSeconds());
    el('start').disabled = plan.segments.length === 0;
  }

  function renderSegments() {
    const list = el('segments');
    list.textContent = '';

    plan.segments.forEach((segment, index) => {
      const row = document.createElement('li');
      row.className = 'segment';

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = CAT.SEGMENT_COLORS[index % CAT.SEGMENT_COLORS.length];

      const name = document.createElement('input');
      name.className = 'input';
      name.type = 'text';
      name.value = segment.name;
      name.setAttribute('aria-label', `Subsection ${index + 1} name`);
      name.addEventListener('input', () => {
        segment.name = name.value;
        saveDraft();
      });

      const time = document.createElement('input');
      time.className = 'input is-time';
      time.type = 'text';
      time.value = formatEditable(segment.seconds);
      time.setAttribute('aria-label', `Subsection ${index + 1} length in minutes`);
      time.title = 'Minutes, or "90s", "5:30", "1h 15m"';
      const commitTime = () => {
        const seconds = parseUserDuration(time.value);
        if (!seconds) {
          time.classList.add('is-invalid');
          time.value = formatEditable(segment.seconds);
          window.setTimeout(() => time.classList.remove('is-invalid'), 900);
          return;
        }
        time.classList.remove('is-invalid');
        segment.seconds = seconds;
        time.value = formatEditable(seconds);
        renderTotal();
        saveDraft();
      };
      time.addEventListener('change', commitTime);
      time.addEventListener('blur', commitTime);

      const remove = document.createElement('button');
      remove.className = 'btn is-quiet';
      remove.textContent = '✕';
      remove.title = `Remove “${segment.name}”`;
      remove.setAttribute('aria-label', `Remove subsection ${index + 1}`);
      remove.addEventListener('click', () => {
        plan.segments.splice(index, 1);
        renderSegments();
        renderTotal();
        saveDraft();
      });

      row.append(swatch, name, time, remove);
      list.appendChild(row);
    });

    renderTotal();
  }

  function addSegment() {
    const nameInput = el('add-name');
    const timeInput = el('add-time');
    const seconds = parseUserDuration(timeInput.value || '10');
    if (!seconds) {
      timeInput.classList.add('is-invalid');
      window.setTimeout(() => timeInput.classList.remove('is-invalid'), 900);
      return;
    }
    plan.segments.push(
      CAT.session.makeSegment(nameInput.value.trim() || `Subsection ${plan.segments.length + 1}`, seconds)
    );
    nameInput.value = '';
    timeInput.value = '';
    renderSegments();
    saveDraft();
    nameInput.focus();
  }

  /* ---------------- scanning ---------------- */

  function scanTab() {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: MSG.SCAN }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) resolve(null);
        else resolve(response.result);
      });
    });
  }

  function describeScan(result) {
    if (!result) return '';
    const count = result.segments.length;
    if (!count) return 'No timed subsections found on this page.';
    const where = {
      headings: 'headings',
      list: 'list items',
      table: 'the agenda table',
      paragraphs: 'paragraphs',
      'total-hint': 'the stated total time'
    }[result.source] || 'the page';
    return `Found ${count} subsection${count === 1 ? '' : 's'} in ${where}.`;
  }

  async function loadPlan(forceRescan) {
    const stored = await chrome.storage.local.get(CAT.DRAFT_KEY);
    const draft = stored[CAT.DRAFT_KEY];

    if (!forceRescan && draft && tab && draft.url === tab.url && draft.segments.length) {
      plan = { activity: draft.activity, segments: draft.segments, source: 'draft' };
      el('scan-note').textContent = 'Restored your edits for this page.';
    } else {
      const result = await scanTab();
      if (!result) {
        showUnsupported();
        return;
      }
      plan = {
        activity: result.activity,
        segments: result.segments.map((s) => CAT.session.makeSegment(s.name, s.seconds)),
        source: result.source
      };
      el('scan-note').textContent = describeScan(result);
      saveDraft();
    }

    el('activity').value = plan.activity;
    renderSegments();
    show('plan');
  }

  /* ---------------- unsupported pages ---------------- */

  function originPattern(url) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      return `${parsed.protocol}//${parsed.hostname}/*`;
    } catch (err) {
      return null;
    }
  }

  async function showUnsupported() {
    const pattern = tab ? originPattern(tab.url) : null;
    const note = el('unsupported-note');
    const enable = el('enable-site');

    if (!pattern) {
      note.textContent = 'Open a Canvas activity page, then reopen this popup.';
      enable.classList.add('is-hidden');
    } else {
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      if (granted) {
        note.textContent =
          'This page has not loaded the timer yet. Reload the tab and reopen this popup.';
        enable.classList.add('is-hidden');
      } else {
        note.textContent = `This looks like a self-hosted Canvas at ${new URL(tab.url).hostname}. Grant access to scan it.`;
        enable.classList.remove('is-hidden');
      }
    }
    show('unsupported');
  }

  el('enable-site').addEventListener('click', async () => {
    const pattern = originPattern(tab.url);
    if (!pattern) return;
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) return;
    await chrome.tabs.reload(tab.id);
    window.close();
  });

  el('manual-start').addEventListener('click', () => {
    plan = { activity: tab && tab.title ? tab.title.slice(0, 120) : 'Activity', segments: [], source: 'manual' };
    el('activity').value = plan.activity;
    el('scan-note').textContent = 'Add each subsection and its length.';
    renderSegments();
    show('plan');
  });

  /* ---------------- running view ---------------- */

  function renderRunning() {
    if (!session) return;
    const state = CAT.session.progress(session, Date.now());
    el('run-activity').textContent = session.activity;
    el('run-clock').textContent = formatClock(state.segmentRemaining);
    el('run-clock').classList.toggle('is-low', state.segmentRemaining <= 60 && !state.isFinished);
    el('run-sub').textContent = state.isFinished
      ? 'Time’s up'
      : state.segment
        ? `${state.segment.name} · ${Math.min(state.index + 1, session.segments.length)} of ${session.segments.length}`
        : '';
    el('run-bar-fill').style.width = `${Math.min(100, state.fraction * 100)}%`;
    el('run-toggle').textContent =
      session.status === STATUS.RUNNING ? 'Pause' : state.isFinished ? 'Restart' : 'Resume';
    el('run-note').textContent = `${formatClock(state.remaining)} left overall · ${formatHuman(
      state.total
    )} planned`;
  }

  function startTicker() {
    stopTicker();
    ticker = window.setInterval(renderRunning, 250);
  }

  function stopTicker() {
    if (ticker !== null) window.clearInterval(ticker);
    ticker = null;
  }

  async function command(type, payload) {
    const response = await send(type, payload);
    if (response && response.session !== undefined) session = response.session;
    await route();
  }

  el('run-toggle').addEventListener('click', () =>
    command(session && session.status === STATUS.RUNNING ? MSG.PAUSE : MSG.RESUME, {})
  );
  el('run-prev').addEventListener('click', () => command(MSG.JUMP, { relative: -1 }));
  el('run-next').addEventListener('click', () => command(MSG.JUMP, { relative: 1 }));
  el('run-reset').addEventListener('click', () => command(MSG.RESET, {}));
  el('run-stop').addEventListener('click', () => command(MSG.STOP, {}));

  /* ---------------- settings ---------------- */

  function renderSettings() {
    el('set-theme').value = settings.theme;
    el('set-size').value = CAT.SIZES[settings.size] ? settings.size : 'medium';
    el('set-flash').value = formatHuman(settings.flashSeconds);
    el('set-flash-on').checked = !!settings.flashEnabled;
    el('set-sound').checked = !!settings.soundEnabled;
    el('set-fullscreen').checked = !!settings.fullscreen;
  }

  async function patchSettings(patch) {
    const response = await send(MSG.SETTINGS, patch);
    if (response && response.settings) settings = response.settings;
  }

  el('settings-toggle').addEventListener('click', () => {
    const hidden = views.settings.classList.toggle('is-hidden');
    el('settings-toggle').setAttribute('aria-expanded', String(!hidden));
  });
  el('set-theme').addEventListener('change', (e) => patchSettings({ theme: e.target.value }));
  el('set-size').addEventListener('change', (e) =>
    patchSettings({ size: e.target.value, customWidth: null })
  );
  el('set-flash-on').addEventListener('change', (e) =>
    patchSettings({ flashEnabled: e.target.checked })
  );
  el('set-sound').addEventListener('change', (e) =>
    patchSettings({ soundEnabled: e.target.checked })
  );
  el('set-fullscreen').addEventListener('change', (e) =>
    patchSettings({ fullscreen: e.target.checked })
  );
  el('set-flash').addEventListener('change', (e) => {
    const seconds = parseUserDuration(e.target.value);
    if (!seconds) {
      e.target.classList.add('is-invalid');
      e.target.value = formatHuman(settings.flashSeconds);
      window.setTimeout(() => e.target.classList.remove('is-invalid'), 900);
      return;
    }
    settings.flashSeconds = seconds;
    e.target.value = formatHuman(seconds);
    patchSettings({ flashSeconds: seconds });
  });

  /* ---------------- wiring ---------------- */

  el('activity').addEventListener('input', (e) => {
    plan.activity = e.target.value;
    saveDraft();
  });
  el('rescan').addEventListener('click', () => loadPlan(true));
  el('add-btn').addEventListener('click', addSegment);
  el('add-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSegment();
  });
  el('add-time').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSegment();
  });

  el('start').addEventListener('click', async () => {
    const error = el('plan-error');
    if (!plan.segments.length) {
      error.textContent = 'Add at least one subsection first.';
      error.classList.remove('is-hidden');
      return;
    }
    error.classList.add('is-hidden');
    const response = await send(MSG.START, {
      activity: plan.activity || 'Activity',
      segments: plan.segments,
      url: tab ? tab.url : null,
      tabId: tab ? tab.id : null
    });
    if (!response || !response.ok) {
      error.textContent = (response && response.error) || 'Could not start the timer.';
      error.classList.remove('is-hidden');
      return;
    }
    session = response.session;
    await route();
  });

  async function route() {
    if (session && session.status !== STATUS.IDLE) {
      show('running');
      renderRunning();
      startTicker();
    } else {
      stopTicker();
      await loadPlan(false);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CAT.STORAGE_KEY]) {
      session = changes[CAT.STORAGE_KEY].newValue || null;
      route();
    }
    if (changes[CAT.SETTINGS_KEY]) {
      settings = Object.assign({}, CAT.DEFAULT_SETTINGS, changes[CAT.SETTINGS_KEY].newValue || {});
      renderSettings();
    }
  });

  (async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0] || null;
    const state = await send(MSG.GET_STATE, {});
    if (state) {
      session = state.session;
      settings = Object.assign({}, CAT.DEFAULT_SETTINGS, state.settings || {});
    }
    renderSettings();
    await route();
  })();
})();
