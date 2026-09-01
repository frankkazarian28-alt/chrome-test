/**
 * Shared constants and defaults.
 *
 * Every file in this extension is a classic script that hangs its exports off
 * the single `CAT` global, so the same source works in content scripts, the
 * popup and the (non-module) service worker.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});

  CAT.STORAGE_KEY = 'session';
  CAT.SETTINGS_KEY = 'settings';
  CAT.DRAFT_KEY = 'draft';

  CAT.STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    FINISHED: 'finished'
  };

  CAT.SIZES = {
    small: 260,
    medium: 340,
    large: 460
  };

  CAT.DEFAULT_SETTINGS = {
    theme: 'auto', // 'auto' | 'light' | 'dark'
    size: 'medium', // key of CAT.SIZES, or 'custom'
    customWidth: null, // px, set by the resize handle
    position: null, // {left, top} in px, set by dragging
    fullscreen: false,
    flashEnabled: true,
    flashSeconds: 60, // start flashing when this much of the total is left
    soundEnabled: false,
    showTotal: true,
    autoAdvance: true // roll into the next subsection without waiting for input
  };

  /** Buttons offered by the +/- time control, in seconds. */
  CAT.NUDGE_STEPS = [-300, -60, 60, 300];

  /** Colors cycled through by the pie segments (index % length). */
  CAT.SEGMENT_COLORS = [
    '#4f8ef7',
    '#22b8a6',
    '#f2a63b',
    '#e8618c',
    '#9b6cf2',
    '#5cb85c',
    '#e2574c',
    '#3fb0d8'
  ];

  CAT.MSG = {
    GET_STATE: 'cat:get-state',
    START: 'cat:start',
    PAUSE: 'cat:pause',
    RESUME: 'cat:resume',
    RESET: 'cat:reset',
    STOP: 'cat:stop',
    NUDGE: 'cat:nudge',
    SET_SEGMENT: 'cat:set-segment',
    JUMP: 'cat:jump',
    SETTINGS: 'cat:settings',
    SCAN: 'cat:scan',
    DRAFT: 'cat:draft',
    FINISHED: 'cat:finished'
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
