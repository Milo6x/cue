const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const verifier = path.join(root, 'scripts', 'verify-macos-app.js');
const requiredModules = [
  'renderer/capture-coordinator.js',
  'src/diagnostics.js',
  'src/provider-errors.js',
  'src/request-policy.js',
  'src/transcript-ledger.js',
];

function writeInfoPlist(appPath, bundleIdentifier = 'com.cue.overlay') {
  fs.writeFileSync(
    path.join(appPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleExecutable</key><string>cue</string></dict></plist>\n`,
  );
}

function makeSignedApp({ bundleIdentifier = 'com.cue.overlay', useAsar = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-mac-package-'));
  const appPath = path.join(directory, 'cue.app');
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  writeInfoPlist(appPath, bundleIdentifier);
  fs.copyFileSync(
    path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(contents, 'MacOS', 'cue'),
    fs.constants.COPYFILE_FICLONE,
  );
  const moduleRoot = path.join(directory, 'reliability-modules');
  for (const modulePath of requiredModules) {
    const target = path.join(moduleRoot, modulePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// packaged reliability module\n');
  }
  if (useAsar) {
    execFileSync(process.execPath, [
      require.resolve('@electron/asar/bin/asar.js'),
      'pack',
      moduleRoot,
      path.join(contents, 'Resources', 'app.asar'),
    ]);
  } else {
    fs.cpSync(moduleRoot, path.join(contents, 'Resources', 'app'), { recursive: true });
  }
  execFileSync('codesign', ['--force', '--sign', '-', '--deep', appPath]);
  return { directory, appPath };
}

function verify(appPath) {
  return spawnSync(process.execPath, [verifier, appPath], { encoding: 'utf8' });
}

test('macOS package verifier accepts a signed arm64 Cue app with all reliability modules', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const result = verify(fixture.appPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified macOS app:/);
  assert.match(result.stdout, /signature: ad-hoc/);
  assert.match(result.stdout, /does not prove notarization or Gatekeeper distribution/);
});

test('macOS package verifier names a missing reliability module', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.rmSync(path.join(fixture.appPath, 'Contents', 'Resources', 'app', 'src', 'request-policy.js'));

  const result = verify(fixture.appPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src\/request-policy\.js/);
});

test('macOS package verifier rejects an unexpected bundle identifier', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp({ bundleIdentifier: 'example.invalid' });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const result = verify(fixture.appPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /com\.cue\.overlay/);
});

test('macOS package verifier proves reliability modules inside app.asar', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp({ useAsar: true });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const result = verify(fixture.appPath);
  assert.equal(result.status, 0, result.stderr);
});

test('macOS package verifier rejects a symlinked reliability module', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const modulePath = path.join(fixture.appPath, 'Contents', 'Resources', 'app', 'src', 'request-policy.js');
  const outsidePath = path.join(fixture.directory, 'request-policy.js');
  fs.renameSync(modulePath, outsidePath);
  fs.symlinkSync(outsidePath, modulePath);

  const result = verify(fixture.appPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reliability module must not be a symlink: src\/request-policy\.js/);
});

test('macOS package verifier does not let app.asar mask a symlinked loose module', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp({ useAsar: true });
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const looseModule = path.join(fixture.appPath, 'Contents', 'Resources', 'app', 'src', 'request-policy.js');
  const outsidePath = path.join(fixture.directory, 'request-policy.js');
  fs.mkdirSync(path.dirname(looseModule), { recursive: true });
  fs.writeFileSync(outsidePath, '// outside package\n');
  fs.symlinkSync(outsidePath, looseModule);

  const result = verify(fixture.appPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reliability module must not be a symlink: src\/request-policy\.js/);
});

test('macOS package verifier rejects a symlinked app bundle path', (t) => {
  if (process.platform !== 'darwin') t.skip('requires macOS packaging tools');
  const fixture = makeSignedApp();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const symlinkPath = path.join(fixture.directory, 'linked-cue.app');
  fs.symlinkSync(fixture.appPath, symlinkPath);

  const result = verify(symlinkPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symlink/);
});
