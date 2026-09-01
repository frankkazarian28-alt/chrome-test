/** Runs every suite in order and reports a single pass/fail. */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const suites = ['unit.test.cjs', 'scan.test.cjs', 'overlay.test.cjs', 'popup.test.cjs', 'background.test.cjs'];
const failed = [];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(suite);
}

console.log('\n' + '═'.repeat(62));
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`All ${suites.length} suites passed.`);
