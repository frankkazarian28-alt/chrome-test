/** Shared test plumbing: assertions, module loading and browser launch. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

/**
 * Playwright is a dev dependency, but this repo is often checked out beside a
 * global install; try both before giving up with an actionable message.
 */
function requirePlaywright() {
  const candidates = [
    'playwright',
    path.join(ROOT, 'node_modules', 'playwright'),
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright'
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      /* try the next one */
    }
  }
  throw new Error('Playwright not found. Run: npm install');
}

/** Loads the extension's shared modules into this process's global scope. */
function loadCommon() {
  for (const file of ['src/common/constants.js', 'src/common/duration.js', 'src/common/session.js']) {
    require(path.join(ROOT, file));
  }
  return globalThis.CAT;
}

function createReporter(name) {
  let failures = 0;
  let checks = 0;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
  return {
    check(label, got, want) {
      checks++;
      const ok = JSON.stringify(got) === JSON.stringify(want);
      if (!ok) failures++;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}` +
          (ok ? '' : ` (want ${JSON.stringify(want)})`)
      );
    },
    ok(label, condition, detail) {
      checks++;
      if (!condition) failures++;
      console.log(
        `${condition ? 'ok  ' : 'FAIL'}  ${label}` +
          (detail !== undefined ? `: ${JSON.stringify(detail)}` : '')
      );
    },
    done() {
      console.log(
        failures ? `${failures} of ${checks} checks FAILED` : `${checks} checks passed`
      );
      return failures;
    }
  };
}

/**
 * Chromium loads unpacked extensions only under the new headless mode, which
 * Playwright selects for the "chromium" channel.
 */
async function launchWithExtension() {
  const { chromium } = requirePlaywright();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { context, worker, extensionId: new URL(worker.url()).host, userDataDir };
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

const SHOTS = process.env.CAT_SHOTS || path.join(os.tmpdir(), 'cat-shots');

function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  return path.join(SHOTS, name);
}

module.exports = { ROOT, requirePlaywright, loadCommon, createReporter, launchWithExtension, fixture, shot, SHOTS };
