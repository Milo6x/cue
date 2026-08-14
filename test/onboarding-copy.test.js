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

test('macOS permission copy uses Screen & System Audio Recording while Windows onboarding asks only for microphone', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const permissionsPage = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'permissions.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(main, /grant Screen & System Audio Recording to cue in System Settings/i);
  assert.match(renderer, /Screen & System Audio Recording/);
  assert.match(permissionsPage, /Screen & System Audio Recording/);
  assert.doesNotMatch(renderer, /Open Screen recording settings/i);
  assert.doesNotMatch(renderer, /ms-settings:privacy-screenrecorder/i);
  assert.doesNotMatch(renderer, /Screen recording/i);
  assert.match(renderer, /const permissionRequirements = isWindows/);
  assert.match(renderer, /cue needs microphone permission to hear you/i);
});
