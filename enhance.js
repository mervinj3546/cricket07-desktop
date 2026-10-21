// Graphics enhancements, added on top of the port by the Mac app. Loaded before c07.js; it adjusts the
// game's WebGPU calls instead of changing the engine:
// - Sharper textures: 16x anisotropic filtering on the game's (linear) samplers, so the pitch and outfield
//   stay crisp at an angle. Applies when the game creates its samplers, so it needs a restart to change.
// - Smooth edges: the game draws each frame into one image and copies it to the screen. That copy is
//   replaced by a pass that applies FXAA anti-aliasing on the way. Can be switched on and off live.
// - Less shimmer: most of the game's textures have no mipmaps (smaller pre-shrunk copies), so distant crowds,
//   boards and buildings flicker as the camera moves. Each such texture gets an uncompressed copy with a full
//   set of mipmaps, which the game is given to draw with. Cut-out textures (crowd, trees) keep their shape in
//   the smaller copies instead of thinning out. Applies to textures loaded after it is on (restart to change).
// - Sharpen and Vivid Colours: contrast-adaptive sharpening and a gentle saturation/contrast boost on the final
//   picture, after FXAA. Both can be switched live.
// - Widescreen: the game's frame image is made as wide as the screen and the 3D scene is drawn with a wider
//   view instead of being stretched; 2D (menus, scoreboard) fills the screen as before. Needs a restart.
// Settings come from the page URL (?aniso=0, ?fxaa=0, ?mips=0, ?sharpen=0, ?vivid=1, ?wide=1) and window.c07Enhance (changed live by the app).
(() => {
  'use strict';
  if (!window.GPUDevice) return;
  const q = new URLSearchParams(location.search);
  const cfg = (window.c07Enhance = { fxaa: q.get('fxaa') !== '0', aniso: q.get('aniso') !== '0', mips: q.get('mips') !== '0',
    sharpen: q.get('sharpen') === '0' ? 0 : 0.5, vivid: q.get('vivid') === '1', wide: q.get('wide') === '1' });

  // ---- sharper textures
  const createSampler = GPUDevice.prototype.createSampler;
  GPUDevice.prototype.createSampler = function (d = {}) {
    if (cfg.aniso && d.minFilter === 'linear' && d.magFilter === 'linear' && d.mipmapFilter === 'linear' && !d.compare)
      d = { ...d, maxAnisotropy: 16 };
    return createSampler.call(this, d);
  };

  // ---- smooth edges
  const RENDER_ATTACHMENT = 16, TEXTURE_BINDING = 4;
  let device = null;
  const canvasTextures = new WeakSet();

  // widescreen: the screen's shape, and the 4:3 frame image -> wide frame image mapping
  // the shape is taken from the game's canvas when first needed (the window is full screen by then) and then kept
  let aspect = 0;
  const ASPECT = () => {
    if (!aspect) {
      const c = document.getElementById('canvas');
      aspect = Math.max(4 / 3, c && c.width && c.height ? c.width / c.height : screen.width / screen.height);
    }
    return aspect;
  };
  const wideScale = new WeakMap();   // widened texture -> width scale
  function wideSize(d) {
    const sz = d.size, w = sz.width ?? sz[0], h = sz.height ?? sz[1];
    if (!h || h < 300 || Math.abs(w / h - 4 / 3) > 0.01) return null;
    const w1 = Math.round(h * ASPECT());
    return w1 > w + 1 ? { w, h, w1 } : null;
  }

  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    device = this;
    // the frame image must be readable by the FXAA pass
    if ((d.usage & RENDER_ATTACHMENT) && d.format === 'bgra8unorm' && !(d.usage & TEXTURE_BINDING))
      d = { ...d, usage: d.usage | TEXTURE_BINDING };
    let ws = null;
    if (cfg.wide && (d.usage & RENDER_ATTACHMENT) && (ws = wideSize(d)))
      d = { ...d, size: { width: ws.w1, height: ws.h, depthOrArrayLayers: 1 } };
    const t = createTexture.call(this, d);
    if (ws) wideScale.set(t, ws.w1 / ws.w);
    if (cfg.mips) addMipCopy(t, d);
    return t;
  };
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const t = getCurrentTexture.call(this);
    canvasTextures.add(t);
    return t;
  };

  const WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb; }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(src));
  let uv = in.uv;
  let m = tap(uv);
  let lNW = luma(tap(uv + vec2f(-1.0, -1.0) * px));
  let lNE = luma(tap(uv + vec2f(1.0, -1.0) * px));
  let lSW = luma(tap(uv + vec2f(-1.0, 1.0) * px));
  let lSE = luma(tap(uv + vec2f(1.0, 1.0) * px));
  let lM = luma(m);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) { return vec4f(m, 1.0); }   // no edge here
  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2f(-8.0), vec2f(8.0)) * px;
  let a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let b = a * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  let lB = luma(b);
  if (lB < lMin || lB > lMax) { return vec4f(a, 1.0); }
  return vec4f(b, 1.0);
}`;

  // The post-processing chain on the way to the screen: [FXAA] -> [sharpen + colour]
  const POST_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
struct P { sharp: f32, sat: f32, con: f32, pad: f32 };
@group(0) @binding(1) var<uniform> prm: P;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn ld(p: vec2i) -> vec3f { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).rgb; }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  var c = ld(p);
  if (prm.sharp > 0.0) {
    // contrast-adaptive sharpening (after AMD's CAS): sharpens detail, holds back on edges that are already strong
    let n = ld(p + vec2i(0, -1)); let s = ld(p + vec2i(0, 1)); let e = ld(p + vec2i(1, 0)); let w = ld(p + vec2i(-1, 0));
    let mn = min(c, min(min(n, s), min(e, w)));
    let mx = max(c, max(max(n, s), max(e, w)));
    let amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3f(0.0001)), vec3f(0.0), vec3f(1.0)));
    let wgt = -amp * mix(0.125, 0.2, prm.sharp);
    c = clamp((c + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), vec3f(0.0), vec3f(1.0));
  }
  let l = dot(c, vec3f(0.299, 0.587, 0.114));
  c = mix(vec3f(l), c, prm.sat);                                  // saturation
  c = clamp((c - 0.5) * prm.con + 0.5, vec3f(0.0), vec3f(1.0));   // contrast
  return vec4f(c, 1.0);
}`;

  let failed = false, linear = null, ubuf = null, tmp = null;
  const pipes = {};
  const bindCache = new WeakMap();   // texture -> { fxaa, post }
  function pipe(kind, format) {
    const key = kind + ':' + format;
    if (!pipes[key]) {
      const module = device.createShaderModule({ code: kind === 'fxaa' ? WGSL : POST_WGSL });
      pipes[key] = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    }
    return pipes[key];
  }
  function bindings(kind, p, tex) {
    let g = bindCache.get(tex);
    if (!g) bindCache.set(tex, (g = {}));
    if (!g[kind] || g[kind].p !== p) {
      const second = kind === 'fxaa' ? { binding: 1, resource: linear } : { binding: 1, resource: { buffer: ubuf } };
      g[kind] = { p, bg: device.createBindGroup({ layout: p.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: tex.createView() }, second] }) };
    }
    return g[kind].bg;
  }
  function draw(enc, kind, srcTex, target, w, h) {
    const p = pipe(kind, target.format);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear',
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(p);
    pass.setBindGroup(0, bindings(kind, p, srcTex));
    pass.draw(3);
    pass.end();
  }

  const copyTextureToTexture = GPUCommandEncoder.prototype.copyTextureToTexture;
  GPUCommandEncoder.prototype.copyTextureToTexture = function (source, destination, size) {
    const s = source.texture, d = destination.texture;
    let w = size.width ?? size[0], h = size.height ?? size[1] ?? 1;
    // the whole frame image, copied to the top-left of the (same size or slightly larger) screen
    const atZero = (o) => !o || ((o.x ?? o[0] ?? 0) === 0 && (o.y ?? o[1] ?? 0) === 0 && (o.z ?? o[2] ?? 0) === 0);
    const wideSrc = wideScale.has(s);
    const whole = wideSrc || (atZero(source.origin) && atZero(destination.origin) && !source.mipLevel && !destination.mipLevel &&
      w === s.width && h === s.height && d.width >= w && d.height >= h);
    const post = cfg.sharpen > 0 || cfg.vivid || wideSrc;
    if (wideSrc) { w = Math.min(s.width, d.width); h = Math.min(s.height, d.height); }
    if ((cfg.fxaa || post) && !failed && device && canvasTextures.has(d) && whole && (s.usage & TEXTURE_BINDING)) {
      try {
        if (!linear) linear = createSampler.call(device, { minFilter: 'linear', magFilter: 'linear' });
        if (!ubuf) ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(ubuf, 0, new Float32Array([cfg.sharpen, cfg.vivid ? 1.18 : 1, cfg.vivid ? 1.07 : 1, 0]));
        if (cfg.fxaa && post) {
          if (!tmp || tmp.width !== w || tmp.height !== h || tmp.format !== d.format) {
            if (tmp) tmp.destroy();
            tmp = createTexture.call(device, { size: [w, h], format: d.format, usage: RENDER_ATTACHMENT | TEXTURE_BINDING, label: 'c07-post' });
          }
          draw(this, 'fxaa', s, tmp, w, h);
          draw(this, 'post', tmp, d, w, h);
        } else {
          draw(this, cfg.fxaa ? 'fxaa' : 'post', s, d, w, h);
        }
        return;
      } catch (err) {
        failed = true;   // fall back to the plain copy for the rest of the session
        console.warn('[enhance] post-processing off:', err);
      }
    }
    return copyTextureToTexture.call(this, source, destination, size);
  };

  // ---- less shimmer: mipmapped copies of textures that have none
  const MIP_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'bc1-rgba-unorm', 'bc2-rgba-unorm', 'bc3-rgba-unorm']);
  const copies = new WeakMap();   // game texture -> { tex, levels, w, h }
  const dirty = new Set();
  let mipFailed = false;

  function addMipCopy(t, d) {
    if (mipFailed || (d.usage & RENDER_ATTACHMENT) || (d.mipLevelCount || 1) !== 1 || !MIP_FORMATS.has(d.format)) return;
    if ((d.dimension && d.dimension !== '2d') || (d.sampleCount || 1) !== 1) return;
    const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, layers = s.depthOrArrayLayers ?? s[2] ?? 1;
    if (layers !== 1 || Math.max(w, h) < 64) return;
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    try {
      const tex = createTexture.call(device, { size: [w, h], format: 'rgba8unorm', mipLevelCount: levels,
        usage: TEXTURE_BINDING | RENDER_ATTACHMENT, label: 'c07-mips' });
      copies.set(t, { tex, levels, w, h });
    } catch (err) { mipFailed = true; console.warn('[enhance] mipmaps off:', err); }
  }

  // the game draws with the copy (its views never pick a format or mip range, see below)
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (d) {
    const c = copies.get(this);
    if (c && !mipFailed && (!d || (!d.baseMipLevel && !d.baseArrayLayer && (!d.dimension || d.dimension === '2d'))))
      return createView.call(c.tex);
    return createView.call(this, d);
  };
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function (dst, ...rest) {
    const r = writeTexture.call(this, dst, ...rest);
    if (copies.has(dst.texture)) dirty.add(dst.texture);
    return r;
  };
  const destroy = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function () {
    const c = copies.get(this);
    if (c) { c.tex.destroy(); copies.delete(this); dirty.delete(this); }
    return destroy.call(this);
  };

  const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
// level 0: the game's texture as it is (decompressed)
@fragment fn copy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
// smaller levels: average 2x2 texels; colours weighted by alpha so cut-out edges don't go dark, and alpha
// leaning towards the strongest texel so crowd and leaf cut-outs keep their shape at a distance
@fragment fn down(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let last = vec2i(textureDimensions(src)) - 1;
  let p = vec2i(pos.xy) * 2;
  let a = textureLoad(src, min(p, last), 0);
  let b = textureLoad(src, min(p + vec2i(1, 0), last), 0);
  let c = textureLoad(src, min(p + vec2i(0, 1), last), 0);
  let d = textureLoad(src, min(p + vec2i(1, 1), last), 0);
  let wsum = a.a + b.a + c.a + d.a;
  var rgb = (a.rgb + b.rgb + c.rgb + d.rgb) * 0.25;
  if (wsum > 0.001) { rgb = (a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) / wsum; }
  let avg = wsum * 0.25;
  let mx = max(max(a.a, b.a), max(c.a, d.a));
  return vec4f(rgb, mix(avg, mx, 0.6));
}`;
  let mipPipes = null;
  function buildMips(enc, game, c) {
    if (!mipPipes) {
      const module = device.createShaderModule({ code: MIP_WGSL });
      const mk = (entryPoint) => device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint, targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
      mipPipes = { copy: mk('copy'), down: mk('down') };
    }
    const level = (i) => createView.call(c.tex, { baseMipLevel: i, mipLevelCount: 1 });
    const run = (pipe, srcView, i) => {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: level(i), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] }));
      pass.draw(3);
      pass.end();
    };
    run(mipPipes.copy, createView.call(game), 0);
    for (let i = 1; i < c.levels; i++) run(mipPipes.down, level(i - 1), i);
  }

  // the copies are refreshed just before the game's next drawing reaches the GPU
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    if (dirty.size && device && !mipFailed) {
      try {
        const enc = device.createCommandEncoder({ label: 'c07-mips' });
        for (const t of dirty) { const c = copies.get(t); if (c) buildMips(enc, t, c); }
        dirty.clear();
        return submit.call(this, [enc.finish(), ...buffers]);
      } catch (err) {
        mipFailed = true;
        console.warn('[enhance] mipmaps off:', err);
      }
    }
    return submit.call(this, buffers);
  };

  // ---- widescreen: render passes into the widened frame image get their viewport widened to match, and the
  // game's shader draws the 3D scene with a wider view (2D, which is placed by the viewport, stretches as before)
  if (cfg.wide) {
    const createShaderModule = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (d) {
      const marker = 'p.x = p.x + p.w / u.vp.z;';
      if (d && typeof d.code === 'string' && d.code.includes(marker))
        // only perspective drawing (the stadium, players) gets the wider view; flat overlays drawn through the 3D
        // path (radar, inset frame) have no perspective and stretch with the rest of the 2D layer
        d = { ...d, code: d.code.replace(marker, `if (u.flags.x == 2u || u.mvp[0][3] != 0.0 || u.mvp[1][3] != 0.0 || u.mvp[2][3] != 0.0) { p.x = p.x * ${((4 / 3) / ASPECT()).toFixed(6)}; }\n    ${marker}`) };
      return createShaderModule.call(this, d);
    };
    const viewScale = new WeakMap(), wideWidth = new WeakMap(), passScale = new WeakMap();
    const createView2 = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (d) {
      const v = createView2.call(this, d);
      const sc = wideScale.get(this);
      if (sc) { viewScale.set(v, sc); wideWidth.set(v, this.width); }
      return v;
    };
    const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (d) {
      const pass = beginRenderPass.call(this, d);
      const v = d.colorAttachments?.[0]?.view || d.depthStencilAttachment?.view;
      const sc = v && viewScale.get(v);
      if (sc) passScale.set(pass, { sc, width: wideWidth.get(v) });
      return pass;
    };
    const setViewport = GPURenderPassEncoder.prototype.setViewport;
    GPURenderPassEncoder.prototype.setViewport = function (x, y, w, h, a, b) {
      const p = passScale.get(this);
      if (p) { x *= p.sc; w *= p.sc; }   // viewports stretch with the image; the shader keeps 3D in proportion
      return setViewport.call(this, x, y, w, h, a, b);
    };
  }
})();
