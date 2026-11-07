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

test('fork notes open in the right rail on a wide screen; classic keeps them below', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser fork rail checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-fork-rail-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const render = (name, style) => {
    const file = path.join(scratch, `${name}.html`);
    const env = { ...process.env };
    delete env.ARCHIFY_FORK_STYLE;
    if (style) env.ARCHIFY_FORK_STYLE = style;
    execFileSync(process.execPath, [path.join(skillRoot, 'renderers/architecture/render-architecture.mjs'),
      path.join(skillRoot, 'examples/web-app.architecture.json'), file], { env });
    return file;
  };
  const fork = render('fork');
  const classic = render('classic', 'classic');

  const browser = desktopBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  // every page starts as a first-time reader with no stored rail choice
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { localStorage.clear(); } catch (_) {}' });
  const railState = () => run(`document.documentElement.getAttribute('data-reader-rail')`);
  async function load(file, width, height) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + '?theme=light' });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.readerLayout.whenStable()');
    return railState();
  }

  assert.equal(await load(fork, 1920, 961), 'true', 'a wide screen docks the notes open beside the diagram');
  assert.equal(await load(fork, 1200, 900), 'bottom', 'below the rail floor the notes stay under the diagram');
  assert.equal(await load(classic, 1920, 961), 'bottom', 'classic keeps the upstream default');
  await load(fork, 1920, 961);
  await run(`document.getElementById('rail-placement').click()`);
  await run('Archify.readerLayout.whenStable()');
  assert.equal(await railState(), 'bottom', 'the reader can still move them below');
});
