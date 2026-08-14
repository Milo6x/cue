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
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function requireDirectory(directoryPath, label) {
  if (isSymlink(directoryPath)) fail(`${label} must not be a symlink: ${directoryPath}`);
  if (!isDirectory(directoryPath)) fail(`missing directory for ${label}: ${directoryPath}`);
}

function requireRegularFile(filePath, label) {
  if (isSymlink(filePath)) fail(`${label} must not be a symlink: ${filePath}`);
  if (!isRegularFile(filePath)) fail(`missing or malformed ${label}: ${filePath}`);
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

  if (isSymlink(appPath)) fail(`resources app directory must not be a symlink: ${appPath}`);
  if (isSymlink(archivePath)) fail(`app.asar must not be a symlink: ${archivePath}`);
  if (isSymlink(`${archivePath}.unpacked`)) {
    fail(`app.asar.unpacked directory must not be a symlink: ${archivePath}.unpacked`);
  }

  if (isRegularFile(archivePath)) {
    try {
      const { listPackage } = require('@electron/asar');
      archiveEntries = new Set(listPackage(archivePath, { isPack: false }).map((entry) => entry.replace(/^\/+/, '')));
    } catch (error) {
      fail(`could not inspect app.asar for reliability modules: ${error.message}`);
    }
  }

  return requiredModules.filter((modulePath) => {
    const looseModule = path.join(appPath, modulePath);
    const unpackedModule = path.join(`${archivePath}.unpacked`, modulePath);
    if (isSymlink(looseModule) || isSymlink(unpackedModule)) {
      fail(`reliability module must not be a symlink: ${modulePath}`);
    }
    return !isRegularFile(looseModule) &&
      !isRegularFile(unpackedModule) &&
      !archiveEntries.has(modulePath);
  });
}

function verifyMacApp(appPath) {
  if (process.platform !== 'darwin') fail('macOS app verification requires macOS');
  const resolvedApp = path.resolve(appPath);
  if (!fs.existsSync(resolvedApp)) fail(`app bundle does not exist: ${resolvedApp}`);
  if (isSymlink(resolvedApp)) fail(`app bundle must not be a symlink: ${resolvedApp}`);
  if (!isDirectory(resolvedApp) || path.extname(resolvedApp) !== '.app') {
    fail(`expected a .app bundle directory: ${resolvedApp}`);
  }

  const contentsPath = path.join(resolvedApp, 'Contents');
  const infoPlist = path.join(contentsPath, 'Info.plist');
  requireDirectory(contentsPath, 'Contents');
  requireRegularFile(infoPlist, 'Info.plist');

  const bundleIdentifier = readPlistValue(infoPlist, 'CFBundleIdentifier');
  if (bundleIdentifier !== expectedBundleIdentifier) {
    fail(`unexpected bundle identifier ${JSON.stringify(bundleIdentifier)} (expected ${expectedBundleIdentifier})`);
  }

  const executableName = readPlistValue(infoPlist, 'CFBundleExecutable');
  if (path.basename(executableName) !== executableName) {
    fail(`malformed CFBundleExecutable in Info.plist: ${JSON.stringify(executableName)}`);
  }
  const macOSPath = path.join(contentsPath, 'MacOS');
  requireDirectory(macOSPath, 'Contents/MacOS');
  const executable = path.join(macOSPath, executableName);
  if (isSymlink(executable)) fail(`bundle binary must not be a symlink: ${executable}`);
  if (!isExecutableFile(executable)) {
    fail(`missing or non-executable bundle binary: ${executable}`);
  }

  const architectures = run('lipo', ['-archs', executable]).split(/\s+/).filter(Boolean);
  if (!architectures.includes('arm64')) {
    fail(`bundle binary must include arm64, found: ${architectures.join(' ') || 'none'}`);
  }

  const resourcesPath = path.join(contentsPath, 'Resources');
  requireDirectory(resourcesPath, 'Contents/Resources');
  const missingModules = findMissingModules(resourcesPath);
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
