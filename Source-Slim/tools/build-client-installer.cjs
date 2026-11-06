#!/usr/bin/env node
'use strict';

if (process.env.BUILD_MODE === 'dev') throw new Error('رفض بناء المثبّت: BUILD_MODE=dev مخصص للتطوير فقط.');
process.env.BUILD_MODE = 'client';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('electron-builder');
const JavaScriptObfuscator = require('javascript-obfuscator');

const sourceRoot = path.resolve(__dirname, '..');
const stagingRoot = path.join(os.tmpdir(), `system-pos-phase4-${process.pid}`);
const outputDir = path.join(sourceRoot, 'dist-phase4');
const criticalModules = ['server.js', 'accounting.js', 'wallet-service.js', 'sms-service.js', 'auth.js'];

function copySourceTree() {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.cpSync(sourceRoot, stagingRoot, {
    recursive: true,
    dereference: true,
    filter(candidate) {
      const relative = path.relative(sourceRoot, candidate);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      // Keep the installed dependency tree in staging. Electron-builder's
      // pnpm collector can otherwise omit nested CommonJS dependencies such
      // as depd/raw-body used by express/body-parser.
      return !['.git', 'backups', 'outputs', 'mock-output', 'work', 'dist', 'dist-phase4', 'dist-final', 'dist-new'].includes(first);
    }
  });
}

function protectCriticalModules() {
  const protectedFiles = [];
  for (const name of criticalModules) {
    const file = path.join(stagingRoot, name);
    if (!fs.existsSync(file)) continue;
    const result = JavaScriptObfuscator.obfuscate(fs.readFileSync(file, 'utf8'), {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      rotateStringArray: true,
      selfDefending: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      sourceMap: false
    });
    fs.writeFileSync(file, result.getObfuscatedCode(), 'utf8');
    protectedFiles.push(name);
  }
  return protectedFiles;
}

async function main() {
  copySourceTree();
  const protectedFiles = protectCriticalModules();
  fs.rmSync(outputDir, { recursive: true, force: true });
  const artifacts = await build({
    projectDir: stagingRoot,
    config: { directories: { output: outputDir }, npmRebuild: false, buildDependenciesFromSource: false }
  });
  console.log(JSON.stringify({ stagingRoot, protectedFiles, artifacts }, null, 2));
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.stack || String(error), stagingRoot }, null, 2));
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});
