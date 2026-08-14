const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('runFeature uses the shared stream policy instead of its inline watchdog', () => {
  assert.match(source, /require\('\.\/src\/request-policy'\)/);
  assert.match(source, /await runStreamWithPolicy\(\{/);
  assert.doesNotMatch(source, /streamSettled/);
  assert.doesNotMatch(source, /const stalled = new Promise/);
});

test('runFeature rejects an empty non-screen request before creating an AI response group', () => {
  const guard = source.indexOf("No conversation yet. Start listening and speak, or type a question.");
  const start = source.indexOf("send('llm:start'");
  assert.notEqual(guard, -1);
  assert.notEqual(start, -1);
  assert.ok(guard < start);
});
