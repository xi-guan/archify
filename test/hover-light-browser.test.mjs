import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../archify/bin/visual-check.mjs';
import { desktopBrowser, desktopPointerCheck } from './helpers/desktop-browser.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'archify');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;

// a light is whatever differs from the same frozen frame with every hover light hidden, sampled along its line
const probe = `
  window.probeErrors=[];
  addEventListener('error',e=>probeErrors.push(e.message));
  addEventListener('unhandledrejection',e=>probeErrors.push(String(e.reason)));
  window.lightProbe={
    lights:'.intent-trace-flow, .relationship-flow-pulse, .semantic-lens-flow, .route-probe-flow',
    svg(){return document.querySelector('.diagram-container > svg');},
    edge(from,to){return this.svg().querySelector('path[data-edge-from="'+from+'"][data-edge-to="'+to+'"]');},
    main(edge){
      const d=edge.getAttribute('data-motion-path')||edge.getAttribute('d');
      return [...document.querySelectorAll(this.lights)].find(l=>!l.closest('[data-label-light]')&&l.getAttribute('d')===d);
    },
    show(visible){
      document.querySelectorAll(this.lights).forEach(l=>{l.style.visibility=visible?'':'hidden';});
      document.querySelectorAll('.relationship-flow-token').forEach(l=>{l.style.visibility='hidden';});
    },
    freeze(){document.getAnimations().forEach(a=>a.pause());},
    // panels and zoom are placed by script after the hover starts, so the frame must stop moving before the base shot
    async settle(edge){
      const pose=()=>{const m=edge.getScreenCTM();return [m.a,m.e,m.f,...[...document.querySelectorAll('body *')].filter(e=>getComputedStyle(e).position==='fixed'||getComputedStyle(e).position==='absolute').map(e=>{const r=e.getBoundingClientRect();return r.x+','+r.y;})].join('|');};
      let last='',same=0;
      for(let i=0;i<240&&same<10;i++){await new Promise(r=>requestAnimationFrame(r));const now=pose();same=now===last?same+1:0;last=now;}
      return same>=10;
    },
    center(light){const c=getComputedStyle(light);return -parseFloat(c.strokeDashoffset)+parseFloat(c.strokeDasharray)/2;},
    seek(light,target){
      // every hover light moves by the same time after its own delay, so label copies stay in step
      const own=light.getAnimations().find(a=>a.animationName),span=own.effect.getTiming().duration*0.78;
      const place=u=>{document.querySelectorAll(this.lights).forEach(l=>l.getAnimations().filter(a=>a.animationName).forEach(a=>{a.currentTime=a.effect.getTiming().delay+u;}));};
      let lo=0,hi=span;
      for(let i=0;i<32;i++){const mid=(lo+hi)/2;place(mid);if(this.center(light)<target)lo=mid;else hi=mid;}
      place((lo+hi)/2);return this.center(light);
    },
    labelSpan(edge){
      const label=[...this.svg().querySelectorAll('[data-edge-from][data-edge-to] > rect.c-mask')].map(m=>m.parentNode)
        .find(g=>['data-edge-from','data-edge-to','data-edge-key'].every(n=>g.getAttribute(n)===edge.getAttribute(n)));
      const m=label.querySelector(':scope > rect.c-mask'),[x,y,w,h]=['x','y','width','height'].map(n=>Number(m.getAttribute(n)));
      const length=edge.getTotalLength(),inside=[];
      for(let s=0;s<=length;s+=1){const p=edge.getPointAtLength(s);if(p.x>x&&p.x<x+w&&p.y>y&&p.y<y+h)inside.push(s/length);}
      return {label,start:inside[0],end:inside[inside.length-1]};
    },
    async decode(name,data){
      const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      this[name]=context.getImageData(0,0,canvas.width,canvas.height);
    },
    runs(edge){
      const base=this.base,lit=this.lit,length=edge.getTotalLength(),matrix=edge.getScreenCTM(),flags=[];
      const at=(img,x,y)=>{const i=(y*img.width+x)*4;return [img.data[i],img.data[i+1],img.data[i+2]];};
      for(let s=0;s<=length;s+=1.5){
        const p=edge.getPointAtLength(s).matrixTransform(matrix);let diff=0;
        if(!this.svg().contains(document.elementFromPoint(p.x,p.y)||this.svg()))continue;
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
          const x=Math.round(p.x)+dx,y=Math.round(p.y)+dy;if(x<0||y<0||x>=lit.width||y>=lit.height)continue;
          const a=at(base,x,y),b=at(lit,x,y);diff=Math.max(diff,Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+Math.abs(a[2]-b[2]));
        }
        flags.push({at:s/length,lit:diff>90});
      }
      const runs=[];let gap=99;
      for(const f of flags){
        if(f.lit){if(gap>4)runs.push({start:f.at,end:f.at});else runs[runs.length-1].end=f.at;gap=0;}else gap+=1;
      }
      return runs;
    },
  };
`;

test('hover lights stay one light on their own line and pass behind its label', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser hover light checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-hover-light-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'web-app.html');
  // fork style, so the lights follow the shortened data-motion-path the fork draws
  const env = { ...process.env };
  delete env.ARCHIFY_FORK_STYLE;
  execFileSync(process.execPath, [path.join(skillRoot, 'renderers/architecture/render-architecture.mjs'),
    path.join(skillRoot, 'examples/web-app.architecture.json'), file], { env });

  const browser = desktopBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const checkPointer = await desktopPointerCheck(browser, session);
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: probe });
  async function load(theme = 'dark') {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + `?theme=${theme}` });
    await loaded;
    await checkPointer();
    await run('document.fonts.ready'); await run('Archify.viewerChromeLayout.whenStable()');
    await run('Archify.motionGovernor.resume()');
  }
  async function capture(name) {
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await run(`lightProbe.decode(${JSON.stringify(name)}, ${JSON.stringify(shot.data)})`);
  }

  const features = {
    intent: [`Archify.intentTrace.show('auth')`, `Archify.intentTrace.clear()`],
    relationship: [`Archify.focus.inspectRelationship(lightProbe.edge('auth','api').getAttribute('data-edge-key'),{updateUrl:false})`, `Archify.focus.clear({updateUrl:false})`],
    lens: [`Archify.semanticLens.select(document.querySelector('[data-node-id="auth"]').getAttribute('data-node-kind'))`, `Archify.semanticLens.clear({updateUrl:false})`],
    route: [`(Archify.routeProbe.begin({source:'auth'}),Archify.routeProbe.choose('api'))`, `Archify.routeProbe.clear({updateUrl:false})`],
  };

  await t.test('the web-app fixture is drawn larger than its viewBox and its long line carries a label', async () => {
    await load();
    const fixture = await run(`(()=>{const e=lightProbe.edge('auth','api'),span=lightProbe.labelSpan(e);
      return {scale:e.getScreenCTM().a,length:e.getTotalLength(),start:span.start,end:span.end};})()`);
    assert.ok(Math.abs(fixture.scale - 1) > 0.1, 'a pathLength dash only misreads the line when the drawing is scaled: ' + JSON.stringify(fixture));
    assert.ok(fixture.length > 500 && fixture.start > 0.25 && fixture.end < 0.75, JSON.stringify(fixture));
  });

  for (const [name, [start, stop]] of Object.entries(features)) {
    await t.test(`${name}: one light runs the whole line, behind its label too`, async () => {
      await load();
      await run(start);
      await run('new Promise(resolve=>requestAnimationFrame(resolve))');
      await run('lightProbe.freeze()');
      assert.equal(await run(`lightProbe.settle(lightProbe.edge('auth','api'))`), true, `${name} stops moving the frame`);
      await run('lightProbe.freeze()');
      const ready = await run(`(()=>{const e=lightProbe.edge('auth','api'),l=lightProbe.main(e),span=lightProbe.labelSpan(e);
        window.probeEdge=e;window.probeLight=l;return {light:!!l,start:span.start,end:span.end,copies:span.label.querySelectorAll('[data-label-light]').length};})()`);
      assert.equal(ready.light, true, `${name} draws a light on auth -> api`);
      await run('lightProbe.show(false)'); await capture('base'); await run('lightProbe.show(true)');
      for (const target of [0.18, (ready.start + ready.end) / 2, 0.82]) {
        const center = await run(`lightProbe.seek(probeLight, ${target})`);
        assert.ok(Math.abs(center - target) < 0.01, `${name} seeks to ${target}: ${center}`);
        await capture('lit');
        const runs = await run('lightProbe.runs(probeEdge)');
        assert.equal(runs.length, 1, `${name} at ${target.toFixed(2)} shows exactly one light: ${JSON.stringify(runs)}`);
        assert.ok(runs[0].start <= target && runs[0].end >= target, `${name} lights the line where it says it is: ${target} in ${JSON.stringify(runs)}`);
      }
      assert.ok(ready.copies > 0, `${name} lets the light pass behind the "verify JWT" label`);
      await run(stop);
      assert.equal(await run('document.querySelectorAll("[data-label-light]").length'), 0, `${name} clears its label copies`);
      assert.deepEqual(await run('probeErrors'), []);
    });
  }

  await t.test('a still highlight never strikes through the label and exports stay clean', async () => {
    await load();
    await run(`Archify.intentTrace.show('auth')`);
    await run('Archify.motionGovernor.pause()');
    assert.deepEqual(await run(`[...document.querySelectorAll('[data-label-light]')].map(e=>getComputedStyle(e).display)`).then(list => [...new Set(list)]), ['none']);
    const exported = await run(`(async()=>{
      const original=URL.createObjectURL;let blob;
      URL.createObjectURL=function(v){if(v.type.startsWith('image/svg+xml'))blob=v;return original.call(URL,v);};
      try {await Archify.exportMenu.run('svg');}finally{URL.createObjectURL=original;}
      return (await blob.text()).includes('data-label-light');
    })()`);
    assert.equal(exported, false);
  });

  await t.test('a hover light never takes the colour of the line it runs on', async () => {
    for (const theme of ['dark', 'light']) {
      for (const [name, start, stop] of [
        ['intent', `Archify.intentTrace.show('s3')`, `Archify.intentTrace.clear()`],
        ['relationship', `Archify.focus.inspectRelationship(lightProbe.edge('users','cdn').getAttribute('data-edge-key'),{updateUrl:false})`, `Archify.focus.clear({updateUrl:false})`],
      ]) {
        await load(theme);
        await run(start);
        const pairs = await run(`[...document.querySelectorAll(lightProbe.lights)].filter(l=>!l.closest('[data-label-light]')).map(l=>{
          const e=[...lightProbe.svg().querySelectorAll('path[data-edge-from]')].find(p=>(p.getAttribute('data-motion-path')||p.getAttribute('d'))===l.getAttribute('d'));
          return {edge:e.getAttribute('data-edge-from')+'->'+e.getAttribute('data-edge-to'),light:getComputedStyle(l).stroke,line:getComputedStyle(e).stroke};
        })`);
        assert.ok(pairs.length > 0, `${theme}/${name} draws lights`);
        for (const pair of pairs) assert.notEqual(pair.light, pair.line, `${theme}/${name}: ${JSON.stringify(pair)}`);
        await run(stop);
      }
    }
  });
});
