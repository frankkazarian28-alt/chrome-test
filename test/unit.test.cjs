/** Duration parsing and the timer model — pure logic, no browser needed. */
const { loadCommon, createReporter } = require('./helpers.cjs');

const CAT = loadCommon();
const { parseDuration, parseUserDuration, parseCellDuration, formatClock, formatHuman } = CAT.duration;
const S = CAT.session;
const r = createReporter('unit: duration + session model');

/* ---- durations found in page text ---- */
const scanCases = [
  ['Warm-up (10 min)', 600],
  ['Discussion 5-10 minutes', 600],
  ['Reading — 5 to 10 mins', 600],
  ['Lab: 1 hr 30 min', 5400],
  ['Quick check 90 seconds', 90],
  ['Sprint (1:30)', 90],
  ['Recording [1:02:30]', 3750],
  ['Group work 1.5 hours', 5400],
  ['Silent read 45s', 45],
  ['Watch video (12 minutes)', 720],
  ['Exit ticket - 3 min', 180],
  ['Whole-group synthesis 1/4 hour', 900],
  ['Break 1/2 hour', 1800],
  ['Review ¾ hour', 2700],
  ['Lunch half an hour', 1800],
  ['Approximately 2:00 for the essay', 120],
  // Text with no duration must stay null rather than guess.
  ['Step 3: Build the model', null],
  ['Chapter 5', null],
  ['Read pages 1/2 of the text', null],
  // A bare clock time is a due date, not a length.
  ['Due Friday 3:30', null]
];
for (const [input, want] of scanCases) r.check(`scan ${JSON.stringify(input)}`, parseDuration(input), want);

/* ---- durations typed into a field ---- */
for (const [input, want] of [
  ['20', 1200], ['5:30', 330], ['1h30', 5400], ['5m30', 330],
  ['45s', 45], ['90', 5400], ['2.5', 150], ['1 hour 30 min', 5400],
  ['', null], ['banana', null]
]) {
  r.check(`typed ${JSON.stringify(input)}`, parseUserDuration(input), want);
}

/* ---- whole-cell values in an agenda table ---- */
for (const [input, want] of [['0:20', 1200], ['0:05', 300], ['5:30', 330], ['1:05:00', 3900]]) {
  r.check(`cell ${JSON.stringify(input)}`, parseCellDuration(input), want);
}

/* ---- formatting ---- */
r.check('clock 65', formatClock(65), '1:05');
r.check('clock 3725', formatClock(3725), '1:02:05');
r.check('clock 0', formatClock(0), '0:00');
r.check('clock rounds up so a second lasts a second', formatClock(299.4), '5:00');
r.check('human 3150', formatHuman(3150), '52m 30s');
r.check('human 5400', formatHuman(5400), '1h 30m');
r.check('human 45', formatHuman(45), '45s');

/* ---- the session model ---- */
const t0 = 1_000_000;
const session = S.createSession('Photosynthesis Lab', [
  { name: 'Warm-up', seconds: 600 },
  { name: 'Lab', seconds: 1800 },
  { name: 'Debrief', seconds: 300 }
]);
r.check('total', S.totalSeconds(session), 2700);

S.start(session, t0);
r.check('elapsed after 5s', S.progress(session, t0 + 5_000).elapsed, 5);
r.check('still in the first subsection', S.progress(session, t0 + 5_000).index, 0);
r.check('crosses into the second', S.progress(session, t0 + 700_000).index, 1);
r.check('subsection elapsed carries over', S.progress(session, t0 + 700_000).segmentElapsed, 100);

S.pause(session, t0 + 700_000);
r.check('pause freezes elapsed', Math.round(S.progress(session, t0 + 9_999_000).elapsed), 700);
S.resume(session, t0 + 800_000);
r.check('resume picks up where it stopped', Math.round(S.progress(session, t0 + 810_000).elapsed), 710);

r.check('nudge reports what it applied', S.nudge(session, 300, t0 + 810_000).applied, 300);
r.check('nudge changes the total', S.totalSeconds(session), 3000);
S.nudge(session, -100_000, t0 + 810_000);
r.ok(
  'a subsection can never shrink below what it has already used',
  S.progress(session, t0 + 810_000).segment.seconds >= 110,
  S.progress(session, t0 + 810_000).segment.seconds
);

S.jumpTo(session, 2, t0 + 810_000);
r.check('jump lands on the requested subsection', S.progress(session, t0 + 810_000).index, 2);
S.skip(session, t0 + 810_000);
r.check('skipping the last subsection finishes the run', session.status, 'finished');
r.check('a finished run has nothing left', S.progress(session, t0 + 9_000_000).remaining, 0);

const empty = S.createSession('Empty', []);
r.check('an empty plan has no total', S.totalSeconds(empty), 0);
r.check('an empty plan still reports progress', S.progress(empty, t0).index, 0);

process.exit(r.done() ? 1 : 0);
