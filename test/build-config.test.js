const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const signingEnvironmentKeys = ['MAC_SIGN', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

function loadBuilderWithSigningEnvironment(overrides) {
  const previous = Object.fromEntries(signingEnvironmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of signingEnvironmentKeys) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    delete require.cache[require.resolve('../electron-builder.cjs')];
    return require('../electron-builder.cjs');
  } finally {
    delete require.cache[require.resolve('../electron-builder.cjs')];
    for (const key of signingEnvironmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// Regression test for the actual incident behind the "cue is damaged and
// can't be opened" bug reports: package.json used to carry its own legacy
// "build" field (mac.identity: null, no publish config). electron-builder
// picked that up INSTEAD OF electron-builder.cjs, so every release —
// including the "signed and notarized" v0.2.1/v0.2.2 tags — was actually
// built unsigned and auto-published over the real asset. Fixed in
// 1a86a6c ("remove stale package.json build field so dist uses
// electron-builder.cjs"). If a "build" field ever comes back, it silently
// reintroduces the exact same failure mode.
test('package.json has no "build" field shadowing electron-builder.cjs', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'build'), false);
});

test('dist/pack scripts do not pass an inline --config that could bypass electron-builder.cjs', () => {
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/electron-builder/.test(script)) continue;
    assert.ok(!/--config/.test(script), `${name} script unexpectedly overrides config: ${script}`);
  }
});

test('package exposes the macOS application verifier', () => {
  assert.equal(pkg.scripts['verify:mac-app'], 'node scripts/verify-macos-app.js');
  assert.match(pkg.devDependencies['@electron/asar'], /^\^3\.4\.1$/);
});

test('mac config never auto-publishes and only claims hardened runtime / notarization with a real cert', () => {
  const unsigned = loadBuilderWithSigningEnvironment({});

  // publish:null is what stops electron-builder auto-publishing an
  // ad-hoc build over a real release asset just because GH_TOKEN is set.
  assert.equal(unsigned.publish, null);
  // No cert -> must not claim hardened runtime or notarization (would
  // otherwise fail the build outright, or worse, silently no-op).
  assert.equal(unsigned.mac.identity, '-');
  assert.equal(unsigned.mac.hardenedRuntime, false);
  assert.equal(unsigned.mac.notarize, false);

  const signedWithoutNotarizationCredentials = loadBuilderWithSigningEnvironment({ MAC_SIGN: '1' });
  assert.equal(signedWithoutNotarizationCredentials.publish, null);
  assert.equal(signedWithoutNotarizationCredentials.mac.identity, undefined);
  assert.equal(signedWithoutNotarizationCredentials.mac.hardenedRuntime, true);
  assert.equal(signedWithoutNotarizationCredentials.mac.notarize, false);

  const signed = loadBuilderWithSigningEnvironment({
    MAC_SIGN: '1',
    APPLE_ID: 'dev@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'app-specific-password',
    APPLE_TEAM_ID: 'TEAMID1234',
  });
  assert.equal(signed.publish, null);
  assert.equal(signed.mac.identity, undefined); // let electron-builder discover the keychain identity
  assert.equal(signed.mac.hardenedRuntime, true);
  assert.equal(signed.mac.notarize, true);
});

test('mac config ships the zip target with entitlements files that exist on disk', () => {
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const builder = require('../electron-builder.cjs');
  assert.deepEqual(builder.mac.target, [{ target: 'zip', arch: ['x64', 'arm64'] }]);
  const root = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, builder.mac.entitlements)));
  assert.ok(fs.existsSync(path.join(root, builder.mac.entitlementsInherit)));
  // The hardened runtime withholds mic input without this entitlement —
  // silently, with no error, which is indistinguishable from a code bug.
  const entitlementsXml = fs.readFileSync(path.join(root, builder.mac.entitlements), 'utf8');
  assert.match(entitlementsXml, /com\.apple\.security\.device\.audio-input/);
});

test('packaging allowlist includes the renderer and source reliability modules', () => {
  delete require.cache[require.resolve('../electron-builder.cjs')];
  const builder = require('../electron-builder.cjs');
  assert.ok(builder.files.includes('renderer/**/*'));
  assert.ok(builder.files.includes('src/**/*'));
  assert.equal(builder.asar, false);
  for (const modulePath of [
    'renderer/capture-coordinator.js',
    'src/diagnostics.js',
    'src/provider-errors.js',
    'src/request-policy.js',
    'src/transcript-ledger.js',
  ]) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', modulePath)), `missing source module ${modulePath}`);
  }
});
