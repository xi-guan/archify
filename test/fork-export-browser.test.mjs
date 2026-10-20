import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../archify/bin/visual-check.mjs';
import { desktopBrowser } from './helpers/desktop-browser.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'archify');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;
// fork.css only reaches fork-style pages; the test runners pin classic for upstream tests
const env = { ...process.env };
delete env.ARCHIFY_FORK_STYLE;

const INK = 'rgb(30, 41, 59)';
const INK_DARK = 'rgb(226, 232, 240)';
const UPSTREAM_EMPHASIS = 'rgb(5, 150, 105)';

function render(dir, name, renderEnv) {
  const output = path.join(dir, `${name}.html`);
  execFileSync(process.execPath, [path.join(skillRoot, 'bin/archify.mjs'), 'render', 'architecture',
    path.join(skillRoot, 'examples/web-app.architecture.json'), output], { env: renderEnv });
  return output;
}

const paint = `(() => {
  const style = (selector) => getComputedStyle(document.querySelector(selector));
  return { emphasis: style('path.a-emphasis').stroke, defaultWidth: style('path.a-default').strokeWidth,
    backendFill: style('[data-node-id] rect.c-backend').fill };
})()`;

test('svg and png exports of a fork-style page keep the fork colours; classic exports carry no fork rules', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser export checks.',
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-fork-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = { fork: render(dir, 'fork', env), classic: render(dir, 'classic', { ...env, ARCHIFY_FORK_STYLE: 'classic' }) };
  const browser = desktopBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  };
  const open = async (url) => {
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url });
    await loaded;
  };
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  // every svg blob is kept, so the raster path's intermediate svg is checked too
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.svgBlobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { if (blob.type.startsWith('image/svg')) svgBlobs.push(blob); return create(blob); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) return; return click.call(this); };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  async function exported(page, format) {
    await open(`${pathToFileURL(page).href}?theme=light`);
    await run('document.fonts.ready');
    const text = await run(`(async () => { svgBlobs.length = 0; await Archify.exportMenu.run(${JSON.stringify(format)}); return svgBlobs[0].text(); })()`);
    const file = path.join(dir, `${path.basename(page, '.html')}-${format}.svg`);
    fs.writeFileSync(file, text);
    return { text, file };
  }
  async function standalone(file, scheme) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await open(pathToFileURL(file).href);
    return run(paint);
  }

  await open(`${pathToFileURL(pages.fork).href}?theme=light`);
  const page = await run(paint);
  assert.equal(page.emphasis, INK, 'the fork page itself draws the ink emphasis line');

  const light = await exported(pages.fork, 'svg-light');
  assert.match(light.text, /<svg[^>]* data-fork-style=""/, 'the exported root keeps the fork marker');
  assert.deepEqual(await standalone(light.file, 'dark'), page, 'light svg matches the light page');
  const dark = await exported(pages.fork, 'svg-dark');
  assert.equal((await standalone(dark.file, 'light')).emphasis, INK_DARK, 'dark svg uses the fork dark tokens');
  const auto = await exported(pages.fork, 'svg');
  assert.equal((await standalone(auto.file, 'light')).emphasis, INK, 'auto svg follows the fork light tokens');
  assert.equal((await standalone(auto.file, 'dark')).emphasis, INK_DARK, 'auto svg follows the fork dark tokens');
  const raster = await exported(pages.fork, 'png');
  assert.deepEqual(await standalone(raster.file, 'light'), page, 'the png is drawn from an svg that matches the page');

  for (const format of ['svg-light', 'svg', 'png']) {
    const classic = await exported(pages.classic, format);
    assert.doesNotMatch(classic.text, /data-fork-style/, `classic ${format} export carries no fork rules`);
    assert.equal((await standalone(classic.file, 'light')).emphasis, UPSTREAM_EMPHASIS, `classic ${format} keeps the upstream colour`);
  }
});
