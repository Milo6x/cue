const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('shipped copy describes screen-share protection as best effort without platform assurances', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.doesNotMatch(renderer, /hidden from most screen shares automatically/i);
  assert.doesNotMatch(renderer, /Google Meet, Teams, QuickTime/i);
  assert.match(renderer, /excludes itself from ordinary macOS screen capture where supported/i);
  assert.match(renderer, /hiding is not guaranteed across apps and capture methods/i);
  assert.match(renderer, /verify before sharing sensitive content/i);
  assert.doesNotMatch(packageMetadata.description, /invisible AI overlay/i);
  assert.match(packageMetadata.description, /best-effort capture exclusion/i);
  assert.doesNotMatch(main, /enable invisibility in screen shares/i);
  assert.match(main, /best-effort screen-capture exclusion\/content protection/i);
  assert.match(main, /Verify before sharing sensitive content/i);
});
