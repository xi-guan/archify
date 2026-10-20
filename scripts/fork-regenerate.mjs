#!/usr/bin/env node
// usage: ARCHIFY_CHROME=<chromium> node scripts/fork-regenerate.mjs
// rebuilds every derived file the fork commits, so upstream syncs drop that commit instead of merging it
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.ARCHIFY_CHROME) throw new Error('set ARCHIFY_CHROME to a Chromium binary for the README showcase');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

run('npm', ['--prefix', 'archify', 'run', 'generate:viewer']);

// examples/web-app.html has no renderer input, so it takes the template's viewer blocks in place
const template = fs.readFileSync(path.join(root, 'archify/assets/template.html'), 'utf8');
const webAppFile = path.join(root, 'examples/web-app.html');
let webApp = fs.readFileSync(webAppFile, 'utf8');
const owned = (block) => !block.includes('type="application/json"');
for (const tag of ['style', 'script']) {
  const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');
  const fresh = (template.match(pattern) || []).filter((b) => !b.includes('[PROJECT NAME]') && owned(b));
  const scope = tag === 'style' ? webApp.slice(0, webApp.indexOf('</head>')) : webApp;
  const stale = (scope.match(pattern) || []).filter((b) => !b.includes('Sample Web App') && owned(b));
  if (fresh.length !== stale.length) throw new Error(`web-app.html has ${stale.length} ${tag} blocks, template has ${fresh.length}`);
  let from = 0;
  stale.forEach((block, index) => {
    const at = webApp.indexOf(block, from);
    webApp = webApp.slice(0, at) + fresh[index] + webApp.slice(at + block.length);
    from = at + fresh[index].length;
  });
}
fs.writeFileSync(webAppFile, webApp);

run('npm', ['--prefix', 'archify', 'run', 'render:examples']);
run(process.execPath, ['archify/scripts/render-examples.mjs']);
run(process.execPath, ['scripts/build-gallery.mjs']);
run(process.execPath, ['scripts/build-readme-showcase.mjs']);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-delta-'));
try {
  const html = path.join(scratch, 'delta.html'), receipt = path.join(scratch, 'delta.receipt.json');
  execFileSync(process.execPath, ['archify/bin/archify.mjs', 'compare', 'architecture',
    path.join(root, 'archify/examples/checkout-platform.base.architecture.json'),
    path.join(root, 'archify/examples/checkout-platform.head.architecture.json'),
    html, '--receipt', receipt, '--quality', 'showcase', '--json'], { cwd: root, stdio: 'ignore' });
  fs.copyFileSync(html, path.join(root, 'examples/checkout-platform-delta.html'));
  fs.copyFileSync(receipt, path.join(root, 'examples/checkout-platform-delta.receipt.json'));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
