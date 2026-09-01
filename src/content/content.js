/**
 * Content-script entry point.
 *
 * Owns nothing but the view: it mirrors the stored session onto the overlay and
 * forwards every control back to the service worker. Storage change events are
 * the broadcast channel, so the popup and any other Canvas tab stay in step
 * without a port to manage.
 */
(function (root) {
  const CAT = root.CAT;
  if (!CAT || root.__catContentLoaded) return;
  root.__catContentLoaded = true;

  let overlay = null;
  let myTabId = null;
  let settings = Object.assign({}, CAT.DEFAULT_SETTINGS);

  /** True once the extension has been reloaded out from under this page. */
  function contextGone() {
    return !chrome.runtime || !chrome.runtime.id;
  }

  function send(type, payload) {
    if (contextGone()) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload: payload || {} }, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = CAT.overlay.createOverlay({
      onCommand: (type, payload) => send(type, payload),
      onSettings: (patch) => send(CAT.MSG.SETTINGS, patch)
    });
    overlay.setSettings(settings);
    return overlay;
  }

  /** The timer shows in the tab that started it, and on the same page reopened. */
  function belongsHere(session) {
    if (!session) return false;
    if (myTabId !== null && session.tabId === myTabId) return true;
    return !!session.url && session.url === location.href;
  }

  function applyState(session) {
    if (!session || session.status === CAT.STATUS.IDLE || !belongsHere(session)) {
      if (overlay && overlay.isMounted()) overlay.unmount();
      overlay = null;
      return;
    }
    const view = ensureOverlay();
    view.setSession(session);
    view.mount();
  }

  async function refresh() {
    const state = await send(CAT.MSG.GET_STATE, {});
    if (!state) return;
    if (typeof state.tabId === 'number') myTabId = state.tabId;
    settings = Object.assign({}, CAT.DEFAULT_SETTINGS, state.settings || {});
    if (overlay) overlay.setSettings(settings);
    applyState(state.session);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CAT.SETTINGS_KEY]) {
      settings = Object.assign({}, CAT.DEFAULT_SETTINGS, changes[CAT.SETTINGS_KEY].newValue || {});
      if (overlay) overlay.setSettings(settings);
    }
    if (changes[CAT.STORAGE_KEY]) {
      applyState(changes[CAT.STORAGE_KEY].newValue || null);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== CAT.MSG.SCAN) return undefined;
    try {
      sendResponse({ ok: true, result: CAT.scanner.scan(document) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message) });
    }
    return true;
  });

  // Canvas is a single-page app in places, so a re-scan target can appear late.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  refresh();
})(typeof globalThis !== 'undefined' ? globalThis : self);
