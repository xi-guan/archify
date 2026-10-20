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
// the dock is fork style only; the test runners pin classic for upstream tests
const env = { ...process.env };
delete env.ARCHIFY_FORK_STYLE;

function render(dir, name, edit = () => {}, renderEnv = env) {
  const spec = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples/agent-tool-call.workflow.json'), 'utf8'));
  edit(spec);
  const input = path.join(dir, `${name}.json`);
  const output = path.join(dir, `${name}.html`);
  fs.writeFileSync(input, JSON.stringify(spec));
  execFileSync(process.execPath, [path.join(skillRoot, 'bin/archify.mjs'), 'render', 'workflow', input, output], { env: renderEnv });
  return output;
}

const placement = `(() => {
  const html = document.documentElement, row = document.querySelector('.header-row'), nav = document.querySelector('.diagram-nav');
  const container = document.querySelector('.diagram-container'), title = row.querySelector('h1');
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  return {
    inRow: nav.parentNode === row, inStage: nav.parentNode === container,
    attribute: html.getAttribute('data-nav-placement'),
    reserve: parseFloat(getComputedStyle(container).getPropertyValue('--archify-nav-reserve')) || 0,
    nav: box(nav), toolbar: box(document.querySelector('.toolbar')), container: box(container),
    rowOverflow: row.scrollWidth - row.clientWidth,
    titleLines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
    errors: window.dockErrors,
  };
})()`;

test('the reader dock joins a roomy title row and falls back to the stage rail', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run the real browser regression.',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-header-dock-'));
  const plain = render(dir, 'plain');
  const longTitle = render(dir, 'long', (spec) => {
    spec.meta.title = 'Agent tool call with retries, approvals, sandboxed execution and audit trail';
  });
  const classic = render(dir, 'classic', undefined, { ...env, ARCHIFY_FORK_STYLE: 'classic' });
  const browser = desktopBrowser(chrome);
  try {
    const session = await browser.sessionPromise;
    const send = (method, params = {}) => browser.cdp.send(method, params, session);
    const run = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
      return result.result?.value;
    };
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.dockErrors = [];
      addEventListener('error', e => dockErrors.push(e.message));
      addEventListener('unhandledrejection', e => dockErrors.push(String(e.reason)));
    ` });
    const settle = () => run('document.fonts.ready.then(() => Archify.layoutStability.whenStable())');
    const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    async function load(file, width, height, query = '') {
      await viewport(width, height);
      const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
      await send('Page.navigate', { url: `${pathToFileURL(file).href}?theme=light${query}` });
      await loaded;
      await settle();
      return run(placement);
    }
    function assertHeader(state, label) {
      const message = `${label}: ${JSON.stringify(state)}`;
      assert.deepEqual(state.errors, [], message);
      assert.ok(state.inRow && state.attribute === 'header', message);
      assert.equal(state.reserve, 0, `${message}: a title-row dock reserves no stage rail`);
      assert.ok(state.nav.right <= state.toolbar.left - 8, `${message}: dock clears the toolbar`);
      assert.ok(state.nav.bottom <= state.container.top, `${message}: dock stays above the stage`);
      assert.ok(state.rowOverflow <= 1 && state.titleLines === 1, `${message}: title keeps one line`);
    }
    function assertStage(state, label) {
      const message = `${label}: ${JSON.stringify(state)}`;
      assert.deepEqual(state.errors, [], message);
      assert.ok(state.inStage && state.attribute === null, message);
    }

    // fork style draws this workflow taller, so 900-high windows narrow the page and the dock falls back there
    for (const [width, height] of [[1333, 1000], [1440, 1000]]) {
      assertHeader(await load(plain, width, height), `${width}x${height}`);
    }

    // zooming in reveals Map; the row was measured with it, so nothing moves or wraps
    await run('Archify.view.zoomIn(), Archify.view.zoomIn()');
    await settle();
    const zoomed = await run(placement);
    assertHeader(zoomed, 'zoomed');
    assert.equal(await run(`getComputedStyle(document.getElementById('btn-overview-map')).display === 'none'`), false, 'Map shows once the stage pans');
    await run('Archify.view.reset()');
    await settle();

    // panels the title-row dock opens stay inside the stage
    for (const [button, panel] of [['btn-semantic-lens', 'semantic-lens'], ['btn-route-probe', 'route-probe']]) {
      await run(`document.getElementById('${button}').click()`);
      await settle();
      const inside = await run(`(() => {
        const p = document.getElementById('${panel}').getBoundingClientRect(), c = document.querySelector('.diagram-container').getBoundingClientRect();
        return { visible: p.width > 0 && p.height > 0, inside: p.top >= c.top && p.bottom <= c.bottom && p.left >= c.left && p.right <= c.right };
      })()`);
      assert.deepEqual(inside, { visible: true, inside: true }, panel);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await settle();
    }

    // narrowing past the row's room returns the dock to the stage with its rail, and widening brings it back
    await viewport(1000, 700);
    await settle();
    const narrow = await run(placement);
    assertStage(narrow, '1000x700 after resize');
    assert.ok(narrow.reserve > 0, 'the stage dock keeps its rail');
    await viewport(1440, 1000);
    await settle();
    assertHeader(await run(placement), '1440x1000 after resize');
    // a short window keeps innerWidth, but the reader then narrows the page and the row loses its room
    await viewport(1440, 360);
    await settle();
    const short = await run(placement);
    assertStage(short, '1440x360 after resize');
    assert.ok(short.reserve > 0, 'the narrowed page keeps the stage rail');
    await viewport(1440, 1000);
    await settle();
    assertHeader(await run(placement), '1440x1000 after the short window');

    const crowded = await load(longTitle, 1333, 920);
    assertStage(crowded, 'long title');
    assert.ok(crowded.reserve > 0, 'long title keeps the stage rail');
    assertStage(await load(plain, 1440, 900, '&dock=stage'), 'dock=stage');
    assertStage(await load(plain, 1440, 900, '&present=1'), 'presentation');
    assertStage(await load(classic, 1440, 900), 'classic style keeps the stage dock');
  } finally {
    browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
