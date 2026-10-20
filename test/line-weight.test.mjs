import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderDefinitions } from '../archify/renderers/shared/utils.mjs';

const cli = fileURLToPath(new URL('../archify/bin/archify.mjs', import.meta.url));

function render(t, type, diagram) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-line-weight-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const input = path.join(cwd, 'source.json');
  const output = path.join(cwd, 'diagram.html');
  fs.writeFileSync(input, JSON.stringify(diagram));
  const result = spawnSync(process.execPath, [cli, 'render', type, input, output], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return fs.readFileSync(output, 'utf8');
}

function edgeWidths(html) {
  const widths = {};
  for (const tag of html.match(/<path [^>]*marker-end="[^"]*"[^>]*>/g) || []) {
    const cls = tag.match(/class="(a-[a-z]+)"/)[1];
    (widths[cls] ||= new Set()).add(tag.match(/stroke-width="([\d.]+)"/)[1]);
  }
  return Object.fromEntries(Object.entries(widths).map(([cls, set]) => [cls, [...set]]));
}

// the first two rects of a node group are its mask and its card; later rects belong to icons
function nodeRadii(html) {
  const radii = new Set();
  for (const [, body] of html.matchAll(/<g [^>]*data-node-id="[^"]*"[^>]*>([\s\S]*?)<\/g>/g)) {
    for (const rect of (body.match(/<rect [^>]*>/g) || []).slice(0, 2)) radii.add(rect.match(/rx="([\d.]+)"/)[1]);
  }
  return [...radii];
}

function frameRadii(html) {
  return [...new Set((html.match(/<rect [^>]*data-graph-role="structural-frame"[^>]*>/g) || []).map(tag => tag.match(/rx="([\d.]+)"/)[1]))];
}

function largestBendRadius(html) {
  const radii = [...html.matchAll(/L (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+)/g)]
    .map(([, x, y, cx, cy]) => Math.round(Math.hypot(cx - x, cy - y) * 100) / 100);
  assert.ok(radii.length, 'expected at least one rounded bend');
  return Math.max(...radii);
}

function assertLineHierarchy(html) {
  assert.ok(html.includes('svg[data-node-ui] [data-node-id] > rect:not(.c-mask) { stroke-width: 0.8px; }'), 'node card border');
  // the live-motion entrance pulse must not thicken or glow every card on load
  assert.ok(html.includes('svg[data-node-ui][data-animation][data-preset] { --node-pulse-stroke: 0.8px; --node-glow-name: none; }'), 'entrance pulse override');
  assert.match(html, /@keyframes archify-node-pulse \{\s*0%, 72%, 100% \{ filter: none; stroke-width: var\(--node-pulse-stroke, 1\.5\); \}/);
  assert.equal((html.match(/<marker id="arrowhead[^"]*" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">/g) || []).length, 4);
  const widths = edgeWidths(html);
  assert.deepEqual(widths['a-emphasis'], ['1.3']);
  assert.deepEqual(widths['a-default'], ['1']);
  assert.deepEqual(nodeRadii(html), ['5']);
  assert.deepEqual(frameRadii(html), ['8']);
  assert.ok(html.includes('svg[data-node-ui] .c-lane[data-composition-frame-kind="lane"] { rx: 3px; stroke: none;'), 'lanes are borderless and square');
  assert.ok(html.includes('svg[data-node-ui] [data-composition-frame-kind="exception-lane"] { fill: none; stroke: none; }'), 'exception lane has no inner frame');
  assert.equal(largestBendRadius(html), 5);
}

test('other diagram types keep arrowheads that scale with their stroke', () => {
  assert.ok(!renderDefinitions().includes('markerUnits'));
});

test('sequence arrowheads keep their size instead of growing with the message stroke', t => {
  const diagram = JSON.parse(fs.readFileSync(new URL('../archify/examples/cache-miss-request.sequence.json', import.meta.url), 'utf8'));
  diagram.meta.output = 'diagram.html';
  const html = render(t, 'sequence', diagram);
  assert.equal((html.match(/<marker id="arrowhead[^"]*" [^>]*markerUnits="userSpaceOnUse">/g) || []).length, 4);
});

test('workflow connectors outweigh card borders, with tighter corners', t => {
  assertLineHierarchy(render(t, 'workflow', {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Line weight', output: 'diagram.html' },
    lanes: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }],
    nodes: [
      { id: 'a', lane: 'top', col: 0, type: 'backend', label: 'A' },
      { id: 'b', lane: 'top', col: 1, type: 'backend', label: 'B' },
      { id: 'c', lane: 'bottom', col: 1, type: 'backend', label: 'C' },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ac', from: 'a', to: 'c', variant: 'emphasis', fromSide: 'bottom', toSide: 'left' },
    ],
  }));
});

test('meta.centered_lanes sits workflow nodes in the vertical middle of their lane', t => {
  const diagram = (centered) => ({
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Lane centering', output: 'diagram.html', ...(centered ? { centered_lanes: true } : {}) },
    lanes: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom', variant: 'exception' }],
    nodes: [
      { id: 'a', lane: 'top', col: 0, type: 'backend', label: 'A', tag: 'tall' },
      { id: 'b', lane: 'bottom', col: 1, type: 'backend', label: 'B' },
    ],
    edges: [{ id: 'ab', from: 'a', to: 'b' }],
  });
  const laneHeights = (markup) => [...markup.matchAll(/<rect [^>]*data-composition-frame-kind="lane"[^>]*height="([\d.]+)"/g)].map(([, h]) => Number(h));
  // off by default: lanes keep their historical height
  assert.deepEqual(laneHeights(render(t, 'workflow', diagram(false))), [106, 106]);
  const html = render(t, 'workflow', diagram(true));
  assert.deepEqual(laneHeights(html), [136, 136]);
  const lanes = [...html.matchAll(/<rect [^>]*data-composition-frame-kind="lane"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)]
    .map(([, y, h]) => Number(y) + Number(h) / 2);
  const nodes = ['a', 'b'].map(id => {
    const [, y, h] = html.match(new RegExp(`data-node-id="${id}"[^>]*>\\s*<rect [^>]*y="([\\d.]+)"[^>]*height="([\\d.]+)"`));
    return Number(y) + Number(h) / 2;
  });
  assert.deepEqual(nodes, lanes);
});

test('architecture connectors outweigh card borders, with tighter corners', t => {
  assertLineHierarchy(render(t, 'architecture', {
    schema_version: 1, diagram_type: 'architecture',
    meta: { title: 'Line weight', output: 'diagram.html', viewBox: [600, 420] },
    components: [
      { id: 'a', type: 'backend', label: 'A', pos: [80, 100], size: [120, 60] },
      { id: 'b', type: 'backend', label: 'B', pos: [340, 100], size: [120, 60] },
      { id: 'c', type: 'backend', label: 'C', pos: [340, 260], size: [120, 60] },
    ],
    connections: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c', variant: 'emphasis', fromSide: 'bottom', toSide: 'left' },
    ],
    boundaries: [{ kind: 'region', label: 'Backend', wraps: ['a', 'b', 'c'] }],
  }));
});
