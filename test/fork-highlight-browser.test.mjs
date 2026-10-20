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

test('fork highlight states use the signal light, the ink ring and four opacity steps', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser fork highlight checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-fork-highlight-'));
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
  async function load(file, { theme = 'light', live = false } = {}) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + `?theme=${theme}` });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.viewerChromeLayout.whenStable()');
    await run(live ? 'Archify.motionGovernor.resume()' : 'Archify.motionGovernor.pause()');
  }
  const style = (selector, property) => run(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(property)})`);
  const token = (name) => run(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  const rgb = (hex) => `rgb(${hex.match(/\w\w/g).map((pair) => parseInt(pair, 16)).join(', ')})`;
  const node = (id) => `.diagram-container svg [data-node-id="${id}"]`;
  const card = (id) => `${node(id)} > rect[data-animate]`;
  const edge = (from, to) => `.diagram-container svg path[data-edge-from="${from}"][data-edge-to="${to}"]`;

  await t.test('route hops carry numbered discs that follow the journey, beside their labels', async () => {
    await load(fork);
    await run(`Archify.routeProbe.begin({ source: 'users', focusNode: false }); Archify.routeProbe.choose('db')`);
    const chips = await run(`[...document.querySelectorAll('.fork-route-step')].map(chip => {
      const disc = chip.querySelector('circle').getBBox();
      const masks = [...document.querySelectorAll('[data-edge-from][data-edge-to] > rect.c-mask')].map(m => m.getBBox());
      const clear = masks.every(m => disc.x + disc.width <= m.x || disc.x >= m.x + m.width || disc.y + disc.height <= m.y || disc.y >= m.y + m.height);
      return { number: chip.textContent, clear };
    })`);
    assert.deepEqual(chips.map((chip) => chip.number), ['1', '2', '3', '4']);
    assert.ok(chips.every((chip) => chip.clear), `no disc sits on a label: ${JSON.stringify(chips)}`);
    assert.equal(await style('.fork-route-step circle', 'fill'), rgb(await token('--focus-ring')));
    assert.equal(await style(card('users'), 'outline-style'), 'solid', 'the start card carries the ink ring');
    assert.equal(await style(card('db'), 'outline-style'), 'solid', 'the end card carries the ink ring');
    assert.equal(await style(node('auth'), 'opacity'), '0.2');
    await run('Archify.routeProbe.selectJourneyIndex(2)');
    assert.deepEqual(await run(`[...document.querySelectorAll('.fork-route-step')].map(c => [c.getAttribute('data-route-journey-state'), getComputedStyle(c).opacity])`),
      [['past', '0.6'], ['current', '1'], ['future', '0.35'], ['future', '0.35']]);
    await run('Archify.routeProbe.showOverview()');
    assert.equal(await run(`document.querySelectorAll('.fork-route-step[data-route-journey-state]').length`), 0);
    await run('Archify.routeProbe.clear({ updateUrl: false })');
    assert.equal(await run(`document.querySelectorAll('.fork-route-step').length`), 0);
  });

  await t.test('reach tags its origin with the direction and count, rings it, and leaves exports clean', async () => {
    await load(fork);
    await run(`Archify.focus.set('lb'); Archify.focus.reach('downstream')`);
    const tag = await run(`(() => { const tag = document.querySelector('.fork-reach-tag'); const box = tag.getBBox(); const card = document.querySelector(${JSON.stringify(card('lb'))}).getBBox();
      return { text: tag.textContent, above: box.y + box.height <= card.y, centered: Math.abs((box.x + box.width / 2) - (card.x + card.width / 2)) < 0.5 }; })()`);
    assert.deepEqual(tag, { text: 'Downstream · 5', above: true, centered: true });
    assert.equal(await style(card('lb'), 'outline-style'), 'solid');
    assert.equal(await style(node('auth'), 'opacity'), '0.2', 'a click neighbour outside the reach still fades');
    assert.equal(await style(edge('lb', 'api'), 'stroke-width'), '2.25px', 'a reached line gains 1');
    const exported = await run(`(async () => {
      const original = URL.createObjectURL; let blob;
      URL.createObjectURL = function (value) { if (value.type.startsWith('image/svg+xml')) blob = value; return original.call(URL, value); };
      try { await Archify.exportMenu.run('svg'); } finally { URL.createObjectURL = original; }
      return !!new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').querySelector('.fork-reach-tag');
    })()`);
    assert.equal(exported, false);
    await run('Archify.focus.clearReach()');
    assert.equal(await run(`document.querySelectorAll('.fork-reach-tag').length`), 0);
  });

  await t.test('comparing two kinds fades the way back to 0.6 instead of colouring it', async () => {
    await load(fork);
    await run(`Archify.semanticLens.select('backend'); Archify.semanticLens.select('messagebus')`);
    assert.equal(await style(edge('queue', 'worker'), 'opacity'), '0.6');
    assert.equal(await style(edge('api', 'queue'), 'opacity'), '1');
    await run('Archify.semanticLens.clear({ updateUrl: false })');
    assert.equal(await run(`document.querySelectorAll('[data-lens-reverse]').length`), 0);
  });

  await t.test('hover and click use one signal light, widened lines and an ink ring', async () => {
    await load(fork, { live: true });
    await run(`Archify.intentTrace.show('api')`);
    const lights = await run(`[...new Set([...document.querySelectorAll('.intent-trace-flow')].map(l => getComputedStyle(l).stroke))]`);
    assert.deepEqual(lights, [rgb(await token('--signal-head'))], 'in, out and loop lights share the signal colour');
    assert.match(await style(node('api'), 'filter'), /drop-shadow/, 'the traced node glows');
    assert.equal(await style(edge('lb', 'api'), 'stroke-width'), '2.25px');
    await run(`Archify.intentTrace.clear(); Archify.focus.set('api')`);
    assert.equal(await style(card('api'), 'outline-style'), 'solid');
    assert.equal(await style(node('api'), 'filter'), 'none', 'a selected node is ringed, not lit');
    assert.equal(await style(node('users'), 'opacity'), '0.2');
    await run(`Archify.focus.inspectRelationship(document.querySelector(${JSON.stringify(edge('lb', 'api'))}).getAttribute('data-edge-key'), { updateUrl: false })`);
    assert.equal(await run(`[...document.querySelectorAll('.semantic-flow-token')].filter(t => getComputedStyle(t).display !== 'none').length`), 0, 'no semantic token rides the line');
  });

  await t.test('still parks every light and keeps the widened line', async () => {
    await load(fork);
    await run(`Archify.intentTrace.show('api')`);
    assert.deepEqual(await run(`[...new Set([...document.querySelectorAll('.intent-trace-flow')].map(l => getComputedStyle(l).display))]`), ['none']);
    assert.equal(await style(edge('lb', 'api'), 'stroke-width'), '2.25px');
  });

  await t.test('classic keeps upstream highlights: no discs, tags, rings or reverse marks', async () => {
    await load(classic);
    await run(`Archify.routeProbe.begin({ source: 'users', focusNode: false }); Archify.routeProbe.choose('db')`);
    assert.equal(await run(`document.querySelectorAll('.fork-route-step').length`), 0);
    assert.equal(await style(card('users'), 'outline-style'), 'none');
    await run(`Archify.routeProbe.clear({ updateUrl: false }); Archify.focus.set('lb'); Archify.focus.reach('downstream')`);
    assert.equal(await run(`document.querySelectorAll('.fork-reach-tag').length`), 0);
    await run(`Archify.focus.clear({ updateUrl: false }); Archify.semanticLens.select('backend'); Archify.semanticLens.select('messagebus')`);
    assert.equal(await run(`document.querySelectorAll('[data-lens-reverse]').length`), 0);
  });
});
