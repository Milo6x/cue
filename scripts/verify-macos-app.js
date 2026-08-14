#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const expectedBundleIdentifier = 'com.cue.overlay';
const requiredModules = [
  'renderer/capture-coordinator.js',
  'src/diagnostics.js',
  'src/provider-errors.js',
  'src/request-policy.js',
  'src/transcript-ledger.js',
];

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

function readPlistValue(infoPlist, key) {
  const value = run('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]).trim();
  if (!value) fail(`Info.plist is missing a non-empty ${key}`);
  return value;
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(filePath) {
  if (!isRegularFile(filePath)) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findMissingModules(resourcesPath) {
  const appPath = path.join(resourcesPath, 'app');
  const archivePath = path.join(resourcesPath, 'app.asar');
  let archiveEntries = new Set();

  if (isRegularFile(archivePath)) {
    try {
      const { listPackage } = require('@electron/asar');
      archiveEntries = new Set(listPackage(archivePath, { isPack: false }).map((entry) => entry.replace(/^\/+/, '')));
    } catch (error) {
      fail(`could not inspect app.asar for reliability modules: ${error.message}`);
    }
  }

  return requiredModules.filter((modulePath) => {
    return !isRegularFile(path.join(appPath, modulePath)) &&
      !isRegularFile(path.join(`${archivePath}.unpacked`, modulePath)) &&
      !archiveEntries.has(modulePath);
  });
}

function verifyMacApp(appPath) {
  if (process.platform !== 'darwin') fail('macOS app verification requires macOS');
  const resolvedApp = path.resolve(appPath);
  if (!fs.existsSync(resolvedApp)) fail(`app bundle does not exist: ${resolvedApp}`);
  if (!fs.statSync(resolvedApp).isDirectory() || path.extname(resolvedApp) !== '.app') {
    fail(`expected a .app bundle directory: ${resolvedApp}`);
  }

  const contentsPath = path.join(resolvedApp, 'Contents');
  const infoPlist = path.join(contentsPath, 'Info.plist');
  if (!isRegularFile(infoPlist)) fail(`missing Info.plist: ${infoPlist}`);

  const bundleIdentifier = readPlistValue(infoPlist, 'CFBundleIdentifier');
  if (bundleIdentifier !== expectedBundleIdentifier) {
    fail(`unexpected bundle identifier ${JSON.stringify(bundleIdentifier)} (expected ${expectedBundleIdentifier})`);
  }

  const executableName = readPlistValue(infoPlist, 'CFBundleExecutable');
  if (path.basename(executableName) !== executableName) {
    fail(`malformed CFBundleExecutable in Info.plist: ${JSON.stringify(executableName)}`);
  }
  const executable = path.join(contentsPath, 'MacOS', executableName);
  if (!isExecutableFile(executable)) {
    fail(`missing or non-executable bundle binary: ${executable}`);
  }

  const architectures = run('lipo', ['-archs', executable]).split(/\s+/).filter(Boolean);
  if (!architectures.includes('arm64')) {
    fail(`bundle binary must include arm64, found: ${architectures.join(' ') || 'none'}`);
  }

  const missingModules = findMissingModules(path.join(contentsPath, 'Resources'));
  if (missingModules.length) {
    fail(`missing required reliability module(s): ${missingModules.join(', ')}`);
  }

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', resolvedApp]);
  const signature = run('codesign', ['--display', '--verbose=4', resolvedApp]);
  if (!/(?:^|\n)(?:Signature=adhoc|Authority=|TeamIdentifier=)/m.test(signature)) {
    fail('code signature has no recognizable signing identity or ad-hoc signature');
  }

  return { appPath: resolvedApp, architectures };
}

function main() {
  const target = process.argv[2] || 'dist/mac-arm64/cue.app';
  try {
    const result = verifyMacApp(target);
    console.log(`Verified macOS app: ${result.appPath} (architectures: ${result.architectures.join(', ')})`);
  } catch (error) {
    console.error(`macOS app verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { verifyMacApp, requiredModules };
