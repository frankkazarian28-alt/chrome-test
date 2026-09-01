/**
 * Drives the real extension in Chromium: scan a Canvas page, start a timer and
 * exercise every control on the floating panel.
 */
const { launchWithExtension, createReporter, fixture, shot } = require('./helpers.cjs');

const PAGE_URL = 'https://demo.instructure.com/courses/1/assignments/2';
const ROOT_SELECTOR = '#canvas-activity-timer-root';
const sel = (suffix) => `${ROOT_SELECTOR} ${suffix}`;

/** Reads the session straight out of extension storage. */
const readSession = (worker) =>
  worker.evaluate(async () => (await chrome.storage.local.get('session')).session);

(async () => {
  const r = createReporter('overlay: the floating timer');
  const { context, worker } = await launchWithExtension();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.route('**/*.instructure.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture('assignment.html') })
  );
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  r.check('nothing is injected before a timer starts', await page.locator(ROOT_SELECTOR).count(), 0);

  /* ---- scan through the content script, exactly as the popup does ---- */
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((t) => t.url && t.url.includes('instructure.com'));
    return match ? match.id : null;
  });
  r.ok('the canvas tab is reachable', tabId !== null, tabId);

  const scan = await worker.evaluate(
    (id) => new Promise((res) => chrome.tabs.sendMessage(id, { type: 'cat:scan' }, res)),
    tabId
  );
  r.ok('the content script answers a scan', scan && scan.ok === true);
  r.check('scanned activity', scan.result.activity, 'Cell Respiration Lab');
  r.check('scanned durations', scan.result.segments.map((s) => s.seconds), [300, 600, 1200, 600, 300]);

  /* ---- start ---- */
  const started = await worker.evaluate(
    (a) => handleCommand('cat:start', { activity: a.activity, segments: a.segments, url: a.url, tabId: a.tabId }, {}),
    { activity: scan.result.activity, segments: scan.result.segments, url: PAGE_URL, tabId }
  );
  r.ok('the service worker starts the session', started.ok === true);

  await page.locator(ROOT_SELECTOR).waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForTimeout(400);

  const clock = page.locator(sel('.cat-clock'));
  const counter = page.locator(sel('.cat-counter'));
  const segmentName = page.locator(sel('.cat-segment-name'));

  r.check('the panel shows the activity', await page.textContent(sel('.cat-title')), 'Cell Respiration Lab');
  r.check('it opens on the first subsection', await segmentName.textContent(), 'Warm-up discussion');
  r.check('the counter reads 1 of 5', await counter.textContent(), '1 of 5');
  r.ok('the clock starts at the first subsection length', /^(5:00|4:5\d)$/.test(await clock.textContent()), await clock.textContent());
  r.ok('the total is shown alongside', (await page.textContent(sel('.cat-total'))).includes('left overall'));
  r.check('one wedge per subsection', await page.locator(sel('.cat-seg-track')).count(), 5);
  r.check('one list row per subsection', await page.locator(sel('.cat-list-item')).count(), 5);

  // A 20-minute subsection must own four times the arc of a 5-minute one.
  const arcs = await page.evaluate((selector) => {
    const shadow = document.querySelector(selector).shadowRoot;
    return [...shadow.querySelectorAll('.cat-seg-track')].map((p) => p.getTotalLength());
  }, ROOT_SELECTOR);
  r.ok('wedges are proportional to their durations', Math.abs(arcs[2] / arcs[0] - 4) < 0.35, arcs.map(Math.round));
  await page.screenshot({ path: shot('01-running-light.png') });

  /* ---- theme ---- */
  await page.click(sel('[data-role="theme"]'));
  await page.waitForTimeout(200);
  const themeOne = await page.getAttribute(sel('.cat-root'), 'data-theme');
  await page.click(sel('[data-role="theme"]'));
  await page.waitForTimeout(200);
  const themeTwo = await page.getAttribute(sel('.cat-root'), 'data-theme');
  r.check('theme cycles system, light, dark', [themeOne, themeTwo], ['light', 'dark']);
  await page.screenshot({ path: shot('02-running-dark.png') });

  /* ---- +/- time ---- */
  const total = async () => (await readSession(worker)).segments.reduce((a, s) => a + s.seconds, 0);
  const before = await total();
  await page.locator(sel('.cat-nudge'), { hasText: '+5m' }).click();
  await page.waitForTimeout(250);
  const afterPlus = await total();
  r.check('+5m adds five minutes', afterPlus - before, 300);
  await page.locator(sel('.cat-nudge'), { hasText: '−1m' }).click();
  await page.waitForTimeout(250);
  r.check('−1m takes one back off', afterPlus - (await total()), 60);

  /* ---- custom time ---- */
  await page.fill(sel('[data-role="custom-input"]'), '2:30');
  await page.click(sel('[data-role="custom-apply"]'));
  await page.waitForTimeout(300);
  r.ok('a custom time lands exactly on the clock', /^2:(29|30)$/.test(await clock.textContent()), await clock.textContent());

  await page.fill(sel('[data-role="custom-input"]'), 'not a time');
  await page.click(sel('[data-role="custom-apply"]'));
  await page.waitForTimeout(200);
  r.ok('nonsense is refused with a hint', (await page.textContent(sel('[data-role="hint"]'))).includes('Try'), await page.textContent(sel('[data-role="hint"]')));

  /* ---- jumping ---- */
  await page.locator(sel('.cat-list-item')).nth(2).click();
  await page.waitForTimeout(300);
  r.check('clicking a row jumps to it', await counter.textContent(), '3 of 5');
  r.check('and the name follows', await segmentName.textContent(), 'Run the experiment');

  /* ---- pause and resume ---- */
  await page.click(sel('[data-role="toggle"]'));
  await page.waitForTimeout(250);
  const frozen = await clock.textContent();
  await page.waitForTimeout(1200);
  r.check('a paused clock does not move', await clock.textContent(), frozen);
  await page.click(sel('[data-role="toggle"]'));
  await page.waitForTimeout(1300);
  r.ok('a resumed clock moves again', (await clock.textContent()) !== frozen, await clock.textContent());

  /* ---- dragging ---- */
  const box = () => page.locator(sel('.cat-root')).boundingBox();
  const start = await box();
  const header = await page.locator(sel('[data-role="header"]')).boundingBox();
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + header.width / 2 - 220, header.y + header.height / 2 + 130, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const dragged = await box();
  r.ok('the panel follows the pointer', start.x - dragged.x > 180 && dragged.y > start.y + 40, [start.x, dragged.x, start.y, dragged.y]);
  r.ok('and stays fully on screen', dragged.y + dragged.height <= page.viewportSize().height + 1);
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.position);
  r.ok('the position is remembered', saved && Math.abs(saved.left - dragged.x) < 3, saved);

  /* ---- resizing ---- */
  const widthBefore = (await box()).width;
  const handle = await page.locator(sel('[data-role="resize"]')).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  r.ok('the corner handle resizes the panel', (await box()).width - widthBefore > 70, [widthBefore, (await box()).width]);
  await page.screenshot({ path: shot('03-moved-resized.png') });

  await page.click(sel('[data-role="size"]'));
  await page.waitForTimeout(200);
  r.ok('the size button snaps back to a preset', [260, 340, 460].includes(Math.round((await box()).width)), (await box()).width);

  /* ---- full screen ---- */
  await page.click(sel('[data-role="fullscreen"]'));
  await page.waitForTimeout(350);
  const viewport = page.viewportSize();
  const full = await box();
  r.ok('full screen fills the window', Math.abs(full.width - viewport.width) < 2 && Math.abs(full.height - viewport.height) < 2, full);
  r.ok('full screen drops the list', (await page.locator(sel('.cat-list')).isVisible()) === false);
  await page.screenshot({ path: shot('04-fullscreen-dark.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  r.ok('escape leaves full screen', (await box()).width < viewport.width - 50);

  /* ---- flashing near the end ---- */
  await page.fill(sel('[data-role="custom-input"]'), '8s');
  await page.click(sel('[data-role="custom-apply"]'));
  await page.waitForTimeout(400);
  const classes = await page.getAttribute(sel('.cat-root'), 'class');
  r.ok('the panel flashes near the end', classes.includes('is-flashing'), classes);
  r.ok('and flashes faster in the last ten seconds', classes.includes('is-critical'), classes);
  await page.screenshot({ path: shot('05-flashing.png') });

  /* ---- rolling into the next subsection ---- */
  await page.waitForTimeout(9000);
  const status = (await readSession(worker)).status;
  r.ok('it rolls into the next subsection on its own', (await counter.textContent()) === '4 of 5' || status === 'finished', [await counter.textContent(), status]);

  /* ---- closing ---- */
  await page.click(sel('[data-role="close"]'));
  await page.waitForTimeout(350);
  r.check('closing removes the panel', await page.locator(ROOT_SELECTOR).count(), 0);
  r.check('closing clears the session', await readSession(worker), undefined);

  r.ok('no page errors were logged', errors.length === 0, errors);
  await context.close();
  process.exit(r.done() ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
