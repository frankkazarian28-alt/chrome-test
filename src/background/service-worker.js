/**
 * Service worker: the single writer of timer state.
 *
 * Every surface (page overlay, popup) sends commands here; this file mutates
 * the session, writes it to chrome.storage.local and lets the storage change
 * event fan out. That keeps two Canvas tabs and the popup from racing each
 * other into different ideas of what the clock says.
 */
importScripts(
  '../common/constants.js',
  '../common/duration.js',
  '../common/session.js'
);

const CAT = self.CAT;
const { STATUS, MSG, STORAGE_KEY, SETTINGS_KEY, DRAFT_KEY } = CAT;
const S = CAT.session;

const STATIC_MATCHES = [
  '*://*.instructure.com/*',
  '*://*.instructure.com.au/*',
  '*://*.canvas.net/*'
];

const CONTENT_FILES = [
  'src/common/constants.js',
  'src/common/duration.js',
  'src/common/session.js',
  'src/content/scanner.js',
  'src/content/dial.js',
  'src/content/overlay.js',
  'src/content/content.js'
];

const END_ALARM = 'cat-end';
const BADGE_ALARM = 'cat-badge';

/* ---------------- storage ---------------- */

async function readSession() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

async function writeSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
  await afterSessionChange(session);
  return session;
}

async function clearSession() {
  await chrome.storage.local.remove(STORAGE_KEY);
  await afterSessionChange(null);
}

async function readSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, CAT.DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
}

async function writeSettings(patch) {
  const next = Object.assign(await readSettings(), patch || {});
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/* ---------------- badge & alarms ---------------- */

function badgeFor(session) {
  if (!session || session.status === STATUS.IDLE) return { text: '', color: '#2f6fed' };
  const state = S.progress(session, Date.now());
  if (state.isFinished) return { text: '0', color: '#d93b3b' };

  const seconds = Math.ceil(state.segmentRemaining);
  const text = seconds >= 3600
    ? `${Math.ceil(seconds / 3600)}h`
    : seconds >= 60
      ? `${Math.ceil(seconds / 60)}m`
      : `${seconds}s`;
  const paused = session.status === STATUS.PAUSED;
  return { text, color: paused ? '#8a94a8' : seconds <= 60 ? '#d93b3b' : '#2f6fed' };
}

async function refreshBadge(session) {
  const { text, color } = badgeFor(session);
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (err) {
    /* The action may be unavailable while the browser is shutting down. */
  }
}

async function scheduleAlarms(session) {
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(BADGE_ALARM);
  if (!session || session.status !== STATUS.RUNNING) return;

  const endsAt = S.endsAt(session, Date.now());
  if (endsAt) {
    // Chrome clamps short alarms, so the overlay handles anything imminent and
    // this is the backstop for a tab that is closed or asleep.
    await chrome.alarms.create(END_ALARM, { when: Math.max(endsAt, Date.now() + 1000) });
  }
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
}

async function afterSessionChange(session) {
  await Promise.all([refreshBadge(session), scheduleAlarms(session)]);
}

async function notifyFinished(session) {
  try {
    await chrome.notifications.create(`cat-done-${session.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Time’s up',
      message: `${session.activity} — all ${session.segments.length} subsection${
        session.segments.length === 1 ? '' : 's'
      } complete.`,
      priority: 2
    });
  } catch (err) {
    /* Notifications can be blocked at the OS level; the overlay still flashes. */
  }
}

/* ---------------- command handling ---------------- */

async function handleCommand(type, payload, sender) {
  const now = Date.now();

  if (type === MSG.GET_STATE) {
    return {
      session: await readSession(),
      settings: await readSettings(),
      tabId: sender && sender.tab ? sender.tab.id : null
    };
  }

  if (type === MSG.SETTINGS) {
    return { settings: await writeSettings(payload) };
  }

  if (type === MSG.DRAFT) {
    if (payload && payload.draft) await chrome.storage.local.set({ [DRAFT_KEY]: payload.draft });
    else await chrome.storage.local.remove(DRAFT_KEY);
    return { ok: true };
  }

  if (type === MSG.START) {
    const session = S.createSession(payload.activity, payload.segments, {
      url: payload.url || null,
      tabId: typeof payload.tabId === 'number' ? payload.tabId : sender && sender.tab ? sender.tab.id : null
    });
    if (!session.segments.length) return { ok: false, error: 'No subsections to run.' };
    S.start(session, now);
    await writeSession(session);
    return { ok: true, session };
  }

  const session = await readSession();
  if (!session) return { ok: false, error: 'No active timer.' };

  switch (type) {
    case MSG.PAUSE:
      S.pause(session, now);
      break;
    case MSG.RESUME:
      S.resume(session, now);
      break;
    case MSG.RESET:
      S.reset(session);
      S.start(session, now);
      break;
    case MSG.STOP:
      await clearSession();
      return { ok: true, session: null };
    case MSG.NUDGE:
      S.nudge(session, Number(payload.delta) || 0, now);
      break;
    case MSG.SET_SEGMENT: {
      // "Time left on this step": the elapsed part of the subsection is kept,
      // and the playhead is snapped up to a whole second so the clock lands on
      // exactly the number the user asked for rather than a fraction above it.
      S.settle(session, now);
      const state = S.progress(session, now);
      const segment = session.segments[state.index];
      if (segment) {
        const consumed = Math.ceil(state.segmentElapsed);
        const bounds = S.boundaries(session);
        segment.seconds = Math.max(1, consumed + Math.round(payload.seconds));
        session.elapsed = bounds[state.index].start + consumed;
        if (session.status === STATUS.RUNNING) session.startedAt = now;
        if (session.status === STATUS.FINISHED) {
          session.status = STATUS.PAUSED;
          session.finishedAt = null;
        }
      }
      break;
    }
    case MSG.JUMP: {
      if (typeof payload.index === 'number') {
        S.jumpTo(session, payload.index, now);
      } else if (payload.relative === 1) {
        S.skip(session, now);
      } else if (payload.relative === -1) {
        S.previous(session, now);
      }
      break;
    }
    case MSG.FINISHED:
      if (session.status !== STATUS.FINISHED) {
        S.finish(session, now);
        await notifyFinished(session);
      }
      break;
    default:
      return { ok: false, error: `Unknown command: ${type}` };
  }

  await writeSession(session);
  return { ok: true, session };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;
  handleCommand(message.type, message.payload || {}, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
  return true; // response is async
});

/* ---------------- alarms ---------------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const session = await readSession();
  if (!session) return;

  if (alarm.name === END_ALARM) {
    const state = S.progress(session, Date.now());
    if (state.isFinished && session.status !== STATUS.FINISHED) {
      S.finish(session, Date.now());
      await writeSession(session);
      await notifyFinished(session);
    } else {
      await afterSessionChange(session);
    }
    return;
  }

  if (alarm.name === BADGE_ALARM) {
    const state = S.progress(session, Date.now());
    if (state.isFinished && session.status !== STATUS.FINISHED) {
      S.finish(session, Date.now());
      await writeSession(session);
      await notifyFinished(session);
      return;
    }
    await refreshBadge(session);
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('cat-done-')) chrome.notifications.clear(id);
});

/* ---------------- opt-in Canvas hosts ---------------- */

/**
 * Canvas is self-hosted under school domains, so the user can grant this
 * extension one extra origin at a time from the popup. Registering the scripts
 * dynamically keeps that grant working after a browser restart.
 */
async function syncDynamicScripts() {
  let origins = [];
  try {
    const permissions = await chrome.permissions.getAll();
    origins = (permissions.origins || []).filter((origin) => !STATIC_MATCHES.includes(origin));
  } catch (err) {
    return;
  }

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['cat-dynamic'] });
  } catch (err) {
    existing = [];
  }

  if (!origins.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['cat-dynamic'] });
    return;
  }

  const script = {
    id: 'cat-dynamic',
    matches: origins,
    js: CONTENT_FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true
  };
  try {
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (err) {
    /* An origin can become invalid if the grant was revoked mid-flight. */
  }
}

chrome.permissions.onAdded.addListener(syncDynamicScripts);
chrome.permissions.onRemoved.addListener(syncDynamicScripts);
chrome.runtime.onInstalled.addListener(async () => {
  await syncDynamicScripts();
  await refreshBadge(await readSession());
});
chrome.runtime.onStartup.addListener(async () => {
  await syncDynamicScripts();
  const session = await readSession();
  await afterSessionChange(session);
});
