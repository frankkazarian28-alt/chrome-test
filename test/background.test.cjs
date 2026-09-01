/**
 * The service worker's side effects: the toolbar badge, the finish alarm, the
 * notification at zero, and recovery when the tab that started the timer is
 * closed and the page is reopened.
 */
const { launchWithExtension, createReporter, fixture } = require('./helpers.cjs');

const PAGE_URL = 'https://demo.instructure.com/courses/1/assignments/2';

(async () => {
  const r = createReporter('background: badge, alarms, notifications');
  const { context, worker } = await launchWithExtension();
  const workerErrors = [];
  worker.on('console', (m) => {
    if (m.type() === 'error') workerErrors.push(m.text());
  });

  // Record every notification the worker raises instead of showing it.
  await worker.evaluate(() => {
    self.__notified = [];
    const real = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (id, options, cb) => {
      self.__notified.push({ id, title: options.title, message: options.message });
      return real(id, options, cb);
    };
  });

  const page = await context.newPage();
  await page.route('**/*.instructure.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture('assignment.html') })
  );
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url && t.url.includes('instructure.com')).id;
  });

  /* ---- badge ---- */
  r.check('the badge is empty with no timer', await worker.evaluate(() => chrome.action.getBadgeText({})), '');

  await worker.evaluate(
    (id) => handleCommand('cat:start', {
      activity: 'Badge check',
      segments: [{ name: 'First', seconds: 300 }, { name: 'Second', seconds: 120 }],
      url: 'https://demo.instructure.com/courses/1/assignments/2',
      tabId: id
    }, {}),
    tabId
  );
  await page.waitForTimeout(400);
  r.check('the badge counts down in minutes', await worker.evaluate(() => chrome.action.getBadgeText({})), '5m');

  await worker.evaluate(() => handleCommand('cat:nudge', { delta: -240 }, {}));
  await page.waitForTimeout(300);
  r.check('the badge follows a time change', await worker.evaluate(() => chrome.action.getBadgeText({})), '1m');

  await worker.evaluate(() => handleCommand('cat:pause', {}, {}));
  await page.waitForTimeout(250);
  r.check('a paused badge greys out', await worker.evaluate(() => chrome.action.getBadgeBackgroundColor({})), [138, 148, 168, 255]);

  /* ---- alarms ---- */
  await worker.evaluate(() => handleCommand('cat:resume', {}, {}));
  await page.waitForTimeout(250);
  const alarms = await worker.evaluate(() => chrome.alarms.getAll().then((a) => a.map((x) => x.name).sort()));
  r.check('a finish alarm and a badge alarm are set', alarms, ['cat-badge', 'cat-end']);

  await worker.evaluate(() => handleCommand('cat:pause', {}, {}));
  await page.waitForTimeout(250);
  r.check('pausing clears the alarms', await worker.evaluate(() => chrome.alarms.getAll().then((a) => a.length)), 0);

  /* ---- the panel comes back when the page is reopened ---- */
  await worker.evaluate(() => handleCommand('cat:resume', {}, {}));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  r.check('the panel is restored after a reload', await page.locator('#canvas-activity-timer-root').count(), 1);
  r.check('and keeps its place in the plan', await page.textContent('#canvas-activity-timer-root .cat-title'), 'Badge check');

  /* ---- reaching zero ---- */
  await worker.evaluate(() => handleCommand('cat:jump', { index: 1 }, {}));
  await worker.evaluate(() => handleCommand('cat:set-segment', { seconds: 2 }, {}));
  await page.waitForTimeout(3500);
  const session = await worker.evaluate(async () => (await chrome.storage.local.get('session')).session);
  r.check('the session is marked finished', session.status, 'finished');
  const notified = await worker.evaluate(() => self.__notified);
  r.ok('a notification is raised once', notified.length === 1, notified);
  r.ok('naming the activity', notified.length > 0 && notified[0].message.includes('Badge check'), notified[0]);
  r.check('the badge shows zero', await worker.evaluate(() => chrome.action.getBadgeText({})), '0');

  const finishedClasses = await page.getAttribute('#canvas-activity-timer-root .cat-root', 'class');
  r.ok('the panel shows a finished state', finishedClasses.includes('is-finished'), finishedClasses);
  r.check('and says so', await page.textContent('#canvas-activity-timer-root .cat-segment-name'), 'Time’s up');

  /* ---- stopping tidies up ---- */
  await worker.evaluate(() => handleCommand('cat:stop', {}, {}));
  await page.waitForTimeout(300);
  r.check('the badge clears', await worker.evaluate(() => chrome.action.getBadgeText({})), '');
  r.check('no alarms are left behind', await worker.evaluate(() => chrome.alarms.getAll().then((a) => a.length)), 0);

  r.ok('the service worker logged no errors', workerErrors.length === 0, workerErrors);
  await context.close();
  process.exit(r.done() ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
