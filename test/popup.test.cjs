/**
 * Drives the popup: the scan it shows, the plan the user edits, the settings it
 * writes, and the hand-off to the panel on the page.
 *
 * A real popup reads the active tab; opened as an ordinary page it would read
 * itself, so chrome.tabs.query is pointed at the Canvas tab before popup.js runs.
 */
const { launchWithExtension, createReporter, fixture, shot } = require('./helpers.cjs');

const PAGE_URL = 'https://demo.instructure.com/courses/1/assignments/2';
const OTHER_URL = 'https://canvas.someschool.edu/courses/9';

async function openPopup(context, extensionId, tab, size) {
  const popup = await context.newPage();
  await popup.addInitScript((fake) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info, callback) => {
      if (info && info.active) {
        const tabs = [fake];
        return callback ? callback(tabs) : Promise.resolve(tabs);
      }
      return real(info, callback);
    };
  }, tab);
  await popup.setViewportSize(size || { width: 400, height: 660 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForTimeout(800);
  return popup;
}

(async () => {
  const r = createReporter('popup: planning and hand-off');
  const { context, worker, extensionId } = await launchWithExtension();
  const errors = [];

  const canvas = await context.newPage();
  await canvas.route('**/*.instructure.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture('assignment.html') })
  );
  await canvas.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await canvas.waitForTimeout(600);
  const canvasTabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url && t.url.includes('instructure.com')).id;
  });

  const popup = await openPopup(context, extensionId, {
    id: canvasTabId,
    url: PAGE_URL,
    title: 'Cell Respiration Lab: BIO 101'
  });
  popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
  popup.on('console', (m) => {
    if (m.type() === 'error') errors.push('popup console: ' + m.text());
  });

  /* ---- the scan arrives already filled in ---- */
  r.ok('the plan view is shown', await popup.locator('#plan').isVisible());
  r.check('the activity name is prefilled', await popup.inputValue('#activity'), 'Cell Respiration Lab');
  r.check('it says where the times came from', await popup.textContent('#scan-note'), 'Found 5 subsections in headings.');
  r.check('a row per subsection', await popup.locator('#segments .segment').count(), 5);
  r.check('times read as plain minutes', await popup.locator('#segments .is-time').evaluateAll((n) => n.map((i) => i.value)), ['5', '10', '20', '10', '5']);
  r.check('the total is summed', await popup.textContent('#total'), '50m');
  await popup.screenshot({ path: shot('06-popup-plan.png') });

  /* ---- editing ---- */
  await popup.locator('#segments .is-time').first().fill('7:30');
  await popup.locator('#segments .is-time').first().dispatchEvent('change');
  await popup.waitForTimeout(200);
  r.check('a mm:ss entry is accepted', await popup.locator('#segments .is-time').first().inputValue(), '7:30');
  r.check('and the total keeps its seconds', await popup.textContent('#total'), '52m 30s');

  await popup.locator('#segments .is-time').nth(1).fill('banana');
  await popup.locator('#segments .is-time').nth(1).dispatchEvent('change');
  await popup.waitForTimeout(200);
  r.check('an unreadable entry reverts', await popup.locator('#segments .is-time').nth(1).inputValue(), '10');

  await popup.fill('#add-name', 'Pack up');
  await popup.fill('#add-time', '90s');
  await popup.click('#add-btn');
  await popup.waitForTimeout(200);
  r.check('a custom subsection can be added', await popup.locator('#segments .segment').count(), 6);
  r.check('the total includes it', await popup.textContent('#total'), '54m');
  await popup.locator('#segments .segment').nth(5).locator('button').click();
  await popup.waitForTimeout(200);
  r.check('and removed again', await popup.locator('#segments .segment').count(), 5);

  /* ---- settings ---- */
  await popup.click('#settings-toggle');
  await popup.waitForTimeout(150);
  await popup.selectOption('#set-theme', 'dark');
  await popup.fill('#set-flash', '2m');
  await popup.locator('#set-flash').dispatchEvent('change');
  await popup.check('#set-sound');
  await popup.waitForTimeout(350);
  const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  r.check('the theme is stored', settings.theme, 'dark');
  r.check('the flash threshold is stored in seconds', settings.flashSeconds, 120);
  r.check('the chime is stored', settings.soundEnabled, true);
  r.check('the popup follows its own theme setting', await popup.getAttribute('html', 'data-theme'), 'dark');
  await popup.screenshot({ path: shot('07-popup-settings.png') });
  await popup.click('#settings-toggle');

  /* ---- the draft survives a reopen ---- */
  await popup.reload();
  await popup.waitForTimeout(700);
  r.check('edits are restored', await popup.textContent('#scan-note'), 'Restored your edits for this page.');
  r.check('including the edited time', await popup.locator('#segments .is-time').first().inputValue(), '7:30');
  await popup.click('#rescan');
  await popup.waitForTimeout(500);
  r.check('rescanning goes back to the page values', await popup.locator('#segments .is-time').first().inputValue(), '5');

  /* ---- start, and hand off to the page ---- */
  await popup.click('#start');
  await popup.waitForTimeout(600);
  r.ok('the popup switches to the running view', await popup.locator('#running').isVisible());
  r.check('it names the activity', await popup.textContent('#run-activity'), 'Cell Respiration Lab');
  r.check('and the current subsection', await popup.textContent('#run-sub'), 'Warm-up discussion · 1 of 5');
  await popup.screenshot({ path: shot('08-popup-running.png') });

  await canvas.waitForTimeout(500);
  r.check('the panel appears on the canvas page', await canvas.locator('#canvas-activity-timer-root').count(), 1);
  r.check('using the theme chosen in the popup', await canvas.getAttribute('#canvas-activity-timer-root .cat-root', 'data-theme'), 'dark');

  await popup.click('#run-next');
  await popup.waitForTimeout(350);
  r.check('skipping from the popup advances it', await popup.textContent('#run-sub'), 'Set up the apparatus · 2 of 5');
  r.check('and the panel on the page agrees', await canvas.textContent('#canvas-activity-timer-root .cat-counter'), '2 of 5');

  await popup.click('#run-toggle');
  await popup.waitForTimeout(250);
  r.check('pausing flips the button', await popup.textContent('#run-toggle'), 'Resume');
  r.check('and is written to storage', (await worker.evaluate(async () => (await chrome.storage.local.get('session')).session)).status, 'paused');

  await popup.click('#run-stop');
  await popup.waitForTimeout(400);
  r.ok('stopping returns to the plan', await popup.locator('#plan').isVisible());
  r.check('and removes the panel', await canvas.locator('#canvas-activity-timer-root').count(), 0);

  /* ---- a Canvas the extension has no permission for ---- */
  const idsBefore = await worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const other = await context.newPage();
  await other.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Elsewhere</h1>' }));
  await other.goto(OTHER_URL);
  const idsAfter = await worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const otherTabId = idsAfter.find((id) => !idsBefore.includes(id));

  const popup2 = await openPopup(context, extensionId, { id: otherTabId, url: OTHER_URL, title: 'Elsewhere' }, { width: 400, height: 400 });
  popup2.on('pageerror', (e) => errors.push('popup2: ' + e.message));
  r.ok('an unknown host offers to be enabled', await popup2.locator('#enable-site').isVisible());
  r.ok('and is named in the prompt', (await popup2.textContent('#unsupported-note')).includes('canvas.someschool.edu'), await popup2.textContent('#unsupported-note'));
  await popup2.screenshot({ path: shot('09-popup-optin.png') });

  /* ---- building a plan by hand ---- */
  await popup2.click('#manual-start');
  await popup2.waitForTimeout(250);
  r.check('a hand-built plan starts empty', await popup2.locator('#segments .segment').count(), 0);
  r.ok('with start disabled', await popup2.locator('#start').isDisabled());
  await popup2.fill('#add-name', 'Reading');
  await popup2.fill('#add-time', '15');
  await popup2.click('#add-btn');
  await popup2.waitForTimeout(200);
  r.ok('start enables once there is something to run', await popup2.locator('#start').isEnabled());
  r.check('and the total reflects it', await popup2.textContent('#total'), '15m');

  r.ok('no page errors were logged', errors.length === 0, errors);
  await context.close();
  process.exit(r.done() ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
