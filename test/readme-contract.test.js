const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function includes(readme, pattern, message) {
  assert.equal(pattern.test(readme), true, message);
}

function excludes(readme, pattern, message) {
  assert.equal(pattern.test(readme), false, message);
}

test('README keeps high-risk listening, privacy, release, and recovery claims bounded', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  excludes(readme, /meeting audio is Windows-only/i, 'README must not describe meeting audio as Windows-only');
  includes(readme, /macOS 14\.4\+[\s\S]*ScreenCaptureKit loopback/i, 'README must document supported macOS loopback audio');
  excludes(readme, /Settings\s*→\s*Transcription/i, 'README must not name the internal Transcription tab');
  includes(readme, /Settings\s*→\s*Audio/i, 'README must use the visible Audio tab label');
  includes(readme, /Settings\s*→\s*Health/i, 'README must use the visible Health tab label');
  includes(readme, /Screen & System Audio Recording/, 'README must use the current macOS permission label');
  includes(readme, /best-effort capture exclusion; not every capture path/i, 'README must bound Windows capture exclusion');
  includes(readme, /not a guarantee that every capture tool will exclude cue/i, 'README must not guarantee capture exclusion');
  includes(readme, /excludes API keys, transcript content, captured audio, and screenshots/i, 'README must bound diagnostic contents');
  includes(readme, /ad-hoc.*not a distributable public release/i, 'README must distinguish a local ad-hoc build');
  includes(readme, /notarizes, and staples the app/i, 'README must distinguish notarized distribution');
  includes(readme, /Automatic answers and continuous screen-change awareness.*Phase 2/i, 'README must preserve the Phase 2 boundary');
  includes(readme, /Electron \*\*33\.2\.1\*\*.*high-severity.*not be represented as production-safe/is, 'README must retain the Electron audit limitation');
});

test('README distinguishes configuration health from runtime provider validation', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  excludes(readme, /AI-provider readiness/i, 'README must not call Health provider readiness');
  includes(readme, /AI-provider configuration/i, 'README must call Health provider configuration');
  includes(readme, /does not check credential validity, network reachability, or provider availability/i, 'README must bound Health checks to configuration');
  includes(readme, /actual request.*authentication, quota, model,.*network/is, 'README must reserve provider failures for runtime requests');
});

test('README documents Auto streaming preference and its Gemini batch fallback', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  includes(readme, /Auto.*Deepgram streaming.*OpenAI Realtime.*Gemini.*batch/i, 'README must identify Gemini as Auto batch fallback');
  excludes(readme, /then available batch providers/i, 'README must not claim an unspecified batch fallback');
  includes(readme, /### 2\. Grant Windows microphone permission/, 'README must separate Windows permission guidance');
});
