import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderDefinitions } from '../archify/renderers/shared/utils.mjs';
import { createScratchDirectory } from './helpers/scratch-directory.mjs';

// the test runners pin the classic look for upstream tests; this file checks the fork's default one
delete process.env.ARCHIFY_FORK_STYLE;
const { compileWorkflow } = await import('../archify/renderers/workflow/workflow-compiler.mjs');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repoRoot, 'archify/bin/archify.mjs');
const classic = { ...process.env, ARCHIFY_FORK_STYLE: 'classic' };
const example = (name) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'archify/examples', name), 'utf8'));
// the fixed chevron tip reaches 0.85 past the line end and fork.css draws card borders 1.25 wide
const TIP_TRIM = 0.85 + 1.25 / 2;
const lineEnd = (tag, attr) => tag.match(new RegExp(` ${attr}="[^"]* L ([\\d.]+) ([\\d.]+)"`)).slice(1).map(Number);
const near = (point, expected) => point.every((value, index) => Math.abs(value - expected[index]) < 0.01);

function render(diagram, env = process.env, type = 'workflow') {
  const cwd = createScratchDirectory(path.join(os.tmpdir(), 'archify-fork-style-'));
  const input = path.join(cwd, 'source.json');
  const output = path.join(cwd, 'diagram.html');
  fs.writeFileSync(input, JSON.stringify(diagram));
  const result = spawnSync(process.execPath, [cli, 'render', type, input, output], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return fs.readFileSync(output, 'utf8');
}

const diagram = (meta = {}, extra = {}) => ({
  schema_version: 2, diagram_type: 'workflow',
  meta: { title: 'Fork style', output: 'diagram.html', ...meta },
  lanes: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }],
  nodes: [
    { id: 'a', lane: 'top', col: 0, type: 'backend', label: 'A', tag: 'tall tag' },
    { id: 'b', lane: 'top', col: 1, type: 'backend', label: 'B' },
    { id: 'c', lane: 'top', col: 3, type: 'backend', label: 'C' },
    { id: 'd', lane: 'bottom', col: 1, type: 'backend', label: 'D' },
  ],
  edges: [
    { id: 'ab', from: 'a', to: 'b' },
    { id: 'bc', from: 'b', to: 'c' },
    { id: 'ca', from: 'c', to: 'a', label: 'again', fromSide: 'bottom', toSide: 'bottom', route: 'bottom-channel' },
    { id: 'bd', from: 'b', to: 'd' },
  ],
  ...extra,
});

const lanes = (html) => [...html.matchAll(/<rect [^>]*data-composition-frame-kind="lane"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)]
  .map(([, y, height]) => ({ y: Number(y), height: Number(height) }));
const laneTitles = (html) => [...html.matchAll(/<text x="([\d.]+)" y="([\d.]+)" class="t-muted" font-size="([\d.]+)"[^>]*>\d\d \//g)]
  .map(([, x, y, size]) => ({ x: Number(x), y: Number(y), size: Number(size) }));
const nodeBox = (html, id) => {
  const [, y, height] = html.match(new RegExp(`data-node-id="${id}"[^>]*>\\s*<rect [^>]*y="([\\d.]+)"[^>]*height="([\\d.]+)"`));
  return { y: Number(y), height: Number(height) };
};

test('default workflow style centers nodes, keeps lane names small and leaves tags out of the card', () => {
  const html = render(diagram());
  const [top, bottom] = lanes(html);
  // no phases, so the first lane starts at a margin instead of under an empty phase band
  assert.equal(top.y, 28);
  assert.deepEqual([top.height, bottom.height], [118, 118]);
  for (const [id, lane] of [['a', top], ['d', bottom]]) {
    const node = nodeBox(html, id);
    assert.equal(node.y + node.height / 2, lane.y + lane.height / 2, `node ${id} sits mid-lane`);
  }
  assert.deepEqual(laneTitles(html), [{ x: 50, y: top.y + 15, size: 8 }, { x: 50, y: bottom.y + 15, size: 8 }]);
  assert.equal(nodeBox(html, 'a').height, 52, 'a tag no longer makes its node taller');
  assert.match(html, /data-node-tag="tall tag"/, 'Passport and finder still read the tag');
  assert.doesNotMatch(html, /<text[^>]*>tall tag</, 'the card does not draw the tag');
});

test('a loop-back channel runs mid-way under the nodes with its label on the line, and lines stop short of the card', () => {
  const html = render(diagram());
  const tag = html.match(/<path [^>]*data-edge-id="ca"[^>]*>/)[0];
  const points = tag.match(/data-composition-points="([^"]+)"/)[1].split(';').map((pair) => pair.split(',').map(Number));
  const nodeBottom = nodeBox(html, 'a').y + nodeBox(html, 'a').height;
  const channelY = points[1][1];
  assert.equal(channelY, nodeBottom + 17);
  // labels draw from y - 10 to y + 4, so a label centered on the line has its baseline 3 below it
  const [, labelY] = html.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>again</);
  assert.equal(Number(labelY) - 3, channelY);
  const [endX, endY] = points.at(-1);
  assert.ok(near(lineEnd(tag, 'd'), [endX, endY + TIP_TRIM]), 'the drawn line ends where the arrowhead tip meets the border');
  assert.ok(near(lineEnd(tag, 'data-motion-path'), [endX, endY + TIP_TRIM + 3.42]), 'the comet lands where the arrowhead begins');
});

test('a group frame keeps the same room around its nodes on every side', () => {
  const groups = [{ id: 'g', label: 'Group', lane: 'top', fromCol: 0, toCol: 1 }];
  const html = render(diagram({}, { groups }));
  const [, x, y, width, height] = html.match(/<rect [^>]*data-composition-frame-kind="group"[^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/).map(Number);
  const box = (id) => {
    const [, nx, ny, nw, nh] = html.match(new RegExp(`data-node-id="${id}"[^>]*>\\s*<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`)).map(Number);
    return { x: nx, y: ny, right: nx + nw, bottom: ny + nh };
  };
  const [a, b] = [box('a'), box('b')];
  const gaps = [a.x - x, x + width - b.right, a.y - y, y + height - a.bottom].map((gap) => Math.round(gap * 100) / 100);
  assert.deepEqual(gaps, [10, 10, 10, 10]);
});

test('centered_lanes false and authored phases bring back the old bands', () => {
  assert.deepEqual(lanes(render(diagram({ centered_lanes: false }))).map(({ height }) => height), [96, 96]);
  const phases = [{ id: 'p', label: 'Phase', fromCol: 0, toCol: 3 }];
  assert.equal(lanes(render(diagram({}, { phases })))[0].y, 52);
});

test('ARCHIFY_FORK_STYLE=classic draws upstream readable-v2 and arrowheads', () => {
  const html = render(diagram(), classic);
  const [top] = lanes(html);
  assert.equal(top.y, 52);
  assert.equal(nodeBox(html, 'a').height, 68);
  assert.match(html, /<text[^>]*>tall tag</);
  assert.match(html, /<text x="54" y="74" class="t-muted" font-size="10"[^>]*>01 \/ Top/);
  assert.match(html, /<polygon points="0 0, 10 3.5, 0 7" class="m-default"/);
});

test('cards put every title on one row beside the icon at fixed sizes and wrap a long sublabel', () => {
  const nodes = [
    { id: 'a', lane: 'top', col: 0, type: 'security', label: 'Task fails' },
    { id: 'b', lane: 'top', col: 1, type: 'backend', label: 'Read the page as text', sublabel: 'numbered elements + visible text' },
    { id: 'c', lane: 'top', col: 3, type: 'frontend', label: 'C', sublabel: 'short' },
    { id: 'd', lane: 'bottom', col: 1, type: 'backend', label: 'D' },
  ];
  const html = render(diagram({}, { nodes }));
  const card = (id) => {
    const [, x, y, rest] = html.match(new RegExp(`data-node-id="${id}"[^>]*>\\s*<rect x="([\\d.]+)" y="([\\d.]+)"([\\s\\S]*?)</g>\\s*(?=<g |</g>)`));
    const [, tx, ty, size] = rest.match(/<text data-node-label="" x="([\d.]+)" y="([\d.]+)" class="t-primary" font-size="([\d.]+)"/);
    return { dx: Number(tx) - Number(x), dy: Number(ty) - Number(y), size: Number(size), rest };
  };
  for (const id of ['a', 'b', 'c']) {
    const { dx, dy, size } = card(id);
    assert.deepEqual({ dx, dy, size }, { dx: 28, dy: 19, size: 12 }, `node ${id} title sits on the shared row`);
  }
  const sub = card('b').rest.match(/<text data-detail="context"[^>]*font-size="([\d.]+)">([\s\S]*?)<\/text>/);
  assert.equal(sub[1], '9');
  assert.deepEqual([...sub[2].matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(([, line]) => line.trim()).length, 2, 'the long sublabel wraps to two lines');
  assert.doesNotMatch(html, /<text [^>]*data-detail-anchor/, 'titles no longer shift when the sublabel hides');
});

test('pages carry data-fork-style for the viewer and the template inlines fork.css; classic pages do not', () => {
  const htmlTag = (page) => page.match(/<html [^>]*>/)[0];
  const forkPage = render(diagram());
  const classicPage = render(diagram(), classic);
  assert.match(htmlTag(forkPage), /data-fork-style=""/);
  assert.doesNotMatch(htmlTag(classicPage), /data-fork-style/);
  // classic pages drop fork.css whole, so upstream tests that search the page text never see its selectors
  assert.ok(forkPage.includes('/* fork style end */'));
  assert.ok(!classicPage.includes('[data-fork-style][data-preset="classic"][data-theme="light"] {') && !classicPage.includes('fork style end'));
  // the FORK_CSS marker is optional in generate-viewer, so this is what notices a lost marker
  const template = fs.readFileSync(path.join(repoRoot, 'archify/assets/template.html'), 'utf8');
  assert.ok(template.includes('[data-fork-style][data-preset="classic"][data-theme="light"] {'), 'template carries fork.css');
  // clearArrowTips (shared/utils.mjs) ends lines against this card border width
  assert.match(template, /\[data-node-id\] > rect:is\([^)]*\):not\(\.tree-root\) \{ stroke-width: 1\.25; \}/);
});

test('other diagram types end lines where the arrowhead tip meets the card border, and the comet stops before the arrowhead', () => {
  const source = example('web-app.architecture.json');
  const edge = (env) => render(source, env, 'architecture').match(/<path [^>]*data-edge-id="users-to-cdn"[^>]*>/)[0];
  // the cdn card's left border sits at x 250
  const fork = edge();
  assert.ok(near(lineEnd(fork, 'd'), [250 - TIP_TRIM, 330]), fork);
  assert.ok(near(lineEnd(fork, 'data-motion-path'), [250 - TIP_TRIM - 3.42, 330]), fork);
  const upstream = edge(classic);
  assert.match(upstream, / d="M 160 330 L 250 330"/);
  assert.doesNotMatch(upstream, /data-motion-path/);
});

test('sequence message labels sit clear of the arrowhead wing under them', () => {
  const source = example('async-job-roundtrip.sequence.json');
  const gaps = (env) => [...render(source, env, 'sequence').matchAll(/ d="M [\d.]+ ([\d.]+) L [\d.]+ \1"[^>]*\/>\s*<g data-detail="context">\s*<rect [^>]*y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)]
    .map(([, line, top, height]) => Number(line) - Number(top) - Number(height));
  // the chevron wing reaches 3.42 above the line
  const fork = gaps();
  assert.ok(fork.length >= 8, `found ${fork.length} labelled messages`);
  assert.ok(fork.every((gap) => gap >= 3.92), fork.join(','));
  assert.ok(gaps(classic).every((gap) => gap === 2));
});

test('arrowheads are open chevrons of one fixed size inside the shared 10x7 marker box', () => {
  const definitions = renderDefinitions();
  const polygons = [...definitions.matchAll(/<polygon points="([^"]+)"/g)].map(([, points]) => points.split(',').map((pair) => pair.trim().split(' ').map(Number)));
  assert.equal(polygons.length, 4);
  for (const polygon of polygons) {
    assert.equal(polygon.length, 6);
    assert.ok(polygon.every(([x, y]) => x >= 0 && x <= 10 && y >= 0 && y <= 7));
  }
  // every diagram type gets the same arrowhead size, whatever the line width
  assert.equal(definitions.match(/<marker [^>]*markerUnits="userSpaceOnUse"/g).length, 4);
});

test('the viewer template keeps the frameless mode, safe back link, relay hold and comet wrap', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'archify/assets/template.html'), 'utf8');
  // ?frameless=1 drops the frame and load zoom, and only then honours a safe back link
  assert.match(html, /get\('frameless'\) === '1'\) \{\s*document\.documentElement\.setAttribute\('data-frameless', 'true'\)/);
  assert.match(html, /html\[data-frameless="true"\] \.diagram-container \{ border: 0; border-radius: 0; box-shadow: none; \}/);
  assert.match(html, /html\[data-frameless="true"\] \.diagram-container svg \{ transition: none; \}/);
  assert.match(html, /setAttribute\('data-frameless', 'true'\);\s*document\.addEventListener\('DOMContentLoaded'/);
  assert.match(html, /if \(!relative && \(!\/\^https\?:\$\/\.test\(url\.protocol\) \|\| url\.origin !== window\.location\.origin\)\) return;/);
  assert.match(html, /link\.textContent = /);
  // a relay hop holds on the lit node ~500ms (0.34 x tempo 1.5) before the next light leaves
  assert.match(html, /handoff: 0\.34,/);
  assert.match(html, /tempo: 1\.5/);
  // a comet gap shorter than the path wraps a second copy in at the source on arrival
  assert.doesNotMatch(html, /calc\(var\(--flow-len, 0px\) - var\(--flow-dash/);
  assert.match(html, /stroke-dasharray: var\(--flow-dash, 6px\) calc\(var\(--flow-len, 0px\) \* 2\);/);
});

test('every checked-in v2 workflow still compiles in the default style', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) files.push(full);
    }
  };
  for (const dir of ['archify/examples', 'docs/gallery/sources', 'test/fixtures']) walk(path.join(repoRoot, dir));
  // a first draft that upstream keeps failing on purpose
  const expectedFailures = new Set(['test/fixtures/workflow-first-draft/release-luna.workflow.json']);
  let compiled = 0;
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    let document;
    try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (document?.diagram_type !== 'workflow' || document.schema_version !== 2 || expectedFailures.has(relative)) continue;
    const result = compileWorkflow({ workflow: document });
    assert.equal(result.ok, true, `${relative}: ${result.error}`);
    compiled += 1;
  }
  assert.ok(compiled >= 20, `compiled ${compiled} v2 workflows`);
});
