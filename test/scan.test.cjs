/**
 * Runs the scanner against Canvas-shaped fixtures in a real browser, because
 * it leans on layout and computed styles to skip hidden and off-content text.
 */
const path = require('node:path');
const { requirePlaywright, createReporter, ROOT } = require('./helpers.cjs');

const EXPECTED = {
  'assignment.html': {
    activity: 'Cell Respiration Lab',
    source: 'headings',
    names: ['Warm-up discussion', 'Set up the apparatus', 'Run the experiment', 'Clean up and data entry', 'Exit ticket'],
    seconds: [300, 600, 1200, 600, 300]
  },
  'page-list.html': {
    activity: 'Module 4 Studio Rotation',
    source: 'list',
    names: ['Station 1: Sketching', 'Station 2: Clay forms', 'Station 3: Peer critique', 'Station 4: Reflection journal'],
    seconds: [720, 900, 480, 600]
  },
  'table.html': {
    activity: 'Socratic Seminar Agenda',
    source: 'table',
    names: ['Opening question', 'Inner circle discussion', 'Outer circle feedback', 'Whole-group synthesis'],
    seconds: [300, 1200, 600, 900]
  },
  'discussion.html': {
    activity: 'Weekly Debate: Renewable Policy',
    source: 'paragraphs',
    names: ['Prep', 'Draft your opening claim', 'Post one reply to a peer'],
    seconds: [600, 900, 300]
  },
  'quiz-none.html': {
    activity: 'Unit 2 Quiz',
    source: 'none',
    names: [],
    seconds: []
  }
};

(async () => {
  const { chromium } = requirePlaywright();
  const r = createReporter('scan: Canvas page shapes');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();

  for (const [file, want] of Object.entries(EXPECTED)) {
    await page.goto('file://' + path.join(__dirname, 'fixtures', file));
    for (const script of ['src/common/constants.js', 'src/common/duration.js', 'src/content/scanner.js']) {
      await page.addScriptTag({ path: path.join(ROOT, script) });
    }
    const got = await page.evaluate(() => window.CAT.scanner.scan(document));
    r.check(`${file} activity`, got.activity, want.activity);
    r.check(`${file} source`, got.source, want.source);
    r.check(`${file} names`, got.segments.map((s) => s.name), want.names);
    r.check(`${file} seconds`, got.segments.map((s) => s.seconds), want.seconds);
  }

  // Breadcrumbs and the right-hand rail carry times that are not the plan.
  await page.goto('file://' + path.join(__dirname, 'fixtures', 'assignment.html'));
  for (const script of ['src/common/constants.js', 'src/common/duration.js', 'src/content/scanner.js']) {
    await page.addScriptTag({ path: path.join(ROOT, script) });
  }
  const scan = await page.evaluate(() => window.CAT.scanner.scan(document));
  r.ok('ignores the breadcrumb time', !scan.segments.some((s) => s.seconds === 3000), scan.segments.map((s) => s.seconds));
  r.ok('ignores the sidebar heading', !scan.segments.some((s) => s.name.includes('Related items')), scan.segments.map((s) => s.name));
  r.check('reads the stated total as a hint', scan.totalHint, 3000);

  await browser.close();
  process.exit(r.done() ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
