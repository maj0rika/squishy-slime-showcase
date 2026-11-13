import * as THREE from 'three';
import { CONFIG } from './config.js';
import { getShape } from './shapes/index.js';
import { SoftBody } from './physics/softBody.js';
import { getFeelPreset, resolvePhysics } from './physics/presets.js';
import { Surface } from './render/surface.js';
import { ImplicitSurface, chooseRenderMode } from './render/implicitSurface.js';
import { Stage } from './render/stage.js';
import {
  applyColor,
  createSlimeMaterial,
  createSquishyMaterial,
  getColor,
  getColorLinear,
  getMaterialProfile,
} from './render/materials.js';
import { CameraRig } from './input/camera.js';
import { PointerController } from './input/pointer.js';
import { Panel } from './ui/panel.js';
import { DebugLayer } from './ui/debug.js';

const isMobile = () =>
  window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;

export class App {
  constructor({ canvas, stageEl, panelEl, statusEl, statusTextEl }) {
    this.canvas = canvas;
    this.stageEl = stageEl;
    this.panelEl = panelEl;
    this.statusEl = statusEl;
    this.statusTextEl = statusTextEl;

    this.lastTime = 0;
    this.accumulator = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.lastAspect = 0;
    this.raf = 0;
    this.cameraDir = new THREE.Vector3();
    this.surface = null;
    this.implicit = null;
    this.material = null;
    this.slimeMaterial = null;
    this.renderMode = 'skinned';
    this.debug = null;
    this.pointer = null;
  }

  async init() {
    this.stage = new Stage(this.canvas, { mobile: isMobile() });

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.fov,
      1,
      CONFIG.camera.near,
      CONFIG.camera.far
    );
    this.rig = new CameraRig(this.camera, this.canvas);

    this.state = {
      color: CONFIG.defaults.color,
      material: CONFIG.defaults.material,
      feel: 'squishy',
      physics: { ...CONFIG.defaults.physics },
      paused: false,
      debug: false,
    };

    this.panel = new Panel({
      root: this.panelEl,
      onColor: (id) => this.setColor(id),
      onPaint: (id) => this.paint(id),
      onFeel: (id) => this.setFeel(id),
      onPhysics: (patch) => this.setPhysics(patch),
      onReset: () => this.reset(),
      onPause: () => this.togglePause(),
      onPoke: () => this.poke(),
      onDrop: () => this.drop(),
      onDebug: (open) => this.applyDebug(open),
    });

    this.mountShape(getShape('slime'), { frame: true });

    this.pointer = new PointerController({
      stageEl: this.stageEl,
      canvas: this.canvas,
      camera: this.camera,
      mesh: this.surface.mesh,
      body: this.body,
      controls: this.rig.controls,
      rig: this.rig,
      floorY: this.floorY,
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stageEl);

    this.onResize = () => this.resize();
    this.onDoubleClick = () => this.rig.reset(true);
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);

    this.resize();
    this.rig.frame(this.shapeDef.camera, this.camera.aspect);
    this.lastAspect = this.camera.aspect;

    this.body.reset({ drop: true });
    this.updateStats();

    // The studio HDR is loaded by the Stage; nothing renders until it is in
    // place. A failed load is reported in the status pill and rethrown — there
    // is no fallback environment.
    this.statusEl.dataset.loading = 'true';
    this.statusTextEl.textContent = '불러오는 중…';
    try {
      await this.stage.ready;
    } catch (error) {
      this.statusEl.dataset.loading = 'false';
      this.statusEl.dataset.error = 'true';
      this.statusTextEl.textContent = `조명 로드 실패 · ${error.message}`;
      throw error;
    }
    this.statusEl.dataset.loading = 'false';
    this.statusEl.dataset.error = 'false';
    this.statusTextEl.textContent = '실시간';

    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  mountShape(definition, { frame }) {
    if (this.surface) {
      this.stage.scene.remove(this.surface.mesh);
      this.surface.geometry.dispose();
      this.material.dispose();
    }
    if (this.implicit) {
      this.stage.scene.remove(this.implicit.mesh);
      this.implicit.dispose();
      this.slimeMaterial.dispose();
    }
    if (this.debug) this.debug.dispose();

    this.shapeDef = definition;

    const built = definition.build({});
    this.floorY = built.floorY;
    this.body = new SoftBody({
      rest: built.rest,
      index: built.index,
      floorY: built.floorY,
      spacing: built.spacing,
    });

    // Two skins, two materials: the smooth skinned surface wears the squishy
    // material, the implicit (slime) surface wears the wet slime material. The
    // Stage keeps both registered so it can push per-frame uniforms (the key
    // direction in view space) to each.
    this.material = createSquishyMaterial(definition.material, definition.color);
    this.slimeMaterial = createSlimeMaterial(definition.color);
    this.stage.registerMaterial(this.material);
    this.stage.registerMaterial(this.slimeMaterial);
    this.surface = new Surface(built.geometry, this.material, this.body);
    this.stage.scene.add(this.surface.mesh);

    const resolution = isMobile()
      ? CONFIG.render.implicitResolution.mobile
      : CONFIG.render.implicitResolution.desktop;
    this.implicit = new ImplicitSurface({
      material: this.slimeMaterial,
      body: this.body,
      resolution,
    });
    this.stage.scene.add(this.implicit.mesh);

    this.state.color = definition.color;
    this.state.material = definition.material;
    this.state.physics = { ...CONFIG.defaults.physics, ...definition.physics };
    this.applyPhysics();

    this.debug = new DebugLayer({
      scene: this.stage.scene,
      geometry: built.geometry,
      body: this.body,
    });

    if (frame) this.rig.frame(definition.camera, this.camera.aspect);

    this.panel.setColor(definition.color);
    this.panel.setPhysics(this.state.physics);
    this.panel.setFeel(this.state.feel);
    this.panel.setMeta(definition.name, getMaterialProfile(definition.material).label);

    this.applyDebug(this.state.debug);
    this.setColor(definition.color);
  }

  resize() {
    const rect = this.stageEl.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio);

    this.stage.resize(width, height, dpr);

    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    if (this.lastAspect > 0 && Math.abs(aspect - this.lastAspect) / this.lastAspect > 0.2) {
      this.rig.refit(aspect);
    }
    this.lastAspect = aspect;
  }

  setColor(id) {
    this.state.color = id;
    this.body.setBaseColor(getColorLinear(id));
    applyColor(this.material, id);
    applyColor(this.slimeMaterial, id);
    this.panel.setColor(id);

    const preset = getColor(id);
    document.documentElement.style.setProperty('--tint', preset.base);
    document.documentElement.style.setProperty('--tint-deep', preset.deep);
  }

  setFeel(id) {
    const preset = getFeelPreset(id);
    this.state.feel = id;
    this.state.physics = { ...preset.values };
    this.applyPhysics();
    this.panel.setPhysics(this.state.physics);
    this.panel.setFeel(id);
  }

  setPhysics(patch) {
    Object.assign(this.state.physics, patch);
    this.state.feel = null;
    this.applyPhysics();
    this.panel.setPhysics(this.state.physics);
    this.panel.setFeel(null);
  }

  /**
   * The solver always receives a complete parameter set. The hidden keys
   * (`tack`, `fuse`, `weldBreak`, the colour-mix rates, the weld lifetime,
   * `viscoRelease`) are never exposed as sliders, so they ride along with
   * whatever the current feel preset or shape default set them to while the
   * sliders move. The whole physics object is passed straight to
   * `resolvePhysics`, which validates every key it needs and throws on a missing
   * one. The resolved parameters also decide the render mode: a plastic
   * (slime-like) body is drawn as an implicit surface.
   */
  applyPhysics() {
    const resolved = resolvePhysics(this.state.physics);
    this.body.setParams(resolved);
    this.renderMode = chooseRenderMode(resolved);
    this.applyRenderMode();
  }

  applyRenderMode() {
    const implicit = this.renderMode === 'implicit';
    this.surface.mesh.visible = !implicit;
    this.implicit.mesh.visible = implicit;
  }

  reset() {
    this.pointer.cancel();
    this.body.reset({ drop: true });
    this.body.setBaseColor(getColorLinear(this.state.color));
    this.state.physics = { ...CONFIG.defaults.physics, ...this.shapeDef.physics };
    this.state.feel = 'squishy';
    this.applyPhysics();
    this.panel.setPhysics(this.state.physics);
    this.panel.setFeel('squishy');
    this.rig.reset(true);
  }

  drop() {
    if (this.state.paused) return;
    this.body.drop(CONFIG.simulation.dropHeight);
  }

  togglePause() {
    this.setPaused(!this.state.paused);
  }

  setPaused(paused) {
    this.state.paused = paused;
    this.pointer.setEnabled(!paused);
    this.panel.setPaused(paused);
    this.statusEl.dataset.paused = String(paused);
    this.statusTextEl.textContent = paused ? '일시정지' : '실시간';
  }

  applyDebug(open) {
    this.state.debug = open;
    const flags = this.panel.debugState();
    this.debug.setEnabled(open);
    this.debug.setWireframe(flags.wireframe);
    this.debug.setPoints(flags.points);
    this.debug.setContact(flags.contact);
    this.debug.setGrabField(flags.field);
  }

  updateStats() {
    const stats = this.body.stats();
    this.panel.setStats({
      nodes: stats.nodeCount,
      tets: stats.tetCount,
      surfaceVerts: this.body.count,
      volumeRatio: stats.volumeRatio,
      maxStretch: stats.maxStretch,
      contactRadius: stats.contactRadius,
      flipped: stats.flipped,
      welds: stats.welds,
      mode: this.renderMode,
      lastSyncMs: this.implicit.lastSyncMs,
      fps: this.fps,
    });
  }

  /**
   * A random camera-facing upper surface vertex, in CURRENT simulation space
   * (the point the dollop is dropped on, and the normal the poke is applied
   * along). The normal is the current outward direction `pos_i − centroid`
   * (rest normals go stale once the blob deforms/rotates). Throws if the
   * camera sees no suitable vertex — no silent no-op.
   */
  pickSurfacePoint() {
    this.camera.getWorldDirection(this.cameraDir);
    const camDir = this.cameraDir;
    const { pos, count, centroid } = this.body;

    const candidates = [];
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      if (pos[i3 + 1] <= centroid.y) continue;
      const nx = pos[i3] - centroid.x;
      const ny = pos[i3 + 1] - centroid.y;
      const nz = pos[i3 + 2] - centroid.z;
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      const facing = (nx * camDir.x + ny * camDir.y + nz * camDir.z) / len;
      if (facing < -0.35) candidates.push(i);
    }
    if (candidates.length === 0) {
      throw new Error('App.pickSurfacePoint: no camera-facing upper vertex');
    }

    const index = candidates[Math.floor(Math.random() * candidates.length)];
    const i3 = index * 3;
    const nx = pos[i3] - centroid.x;
    const ny = pos[i3 + 1] - centroid.y;
    const nz = pos[i3 + 2] - centroid.z;
    const len = Math.hypot(nx, ny, nz);
    return {
      point: new THREE.Vector3(pos[i3], pos[i3 + 1], pos[i3 + 2]),
      normal: new THREE.Vector3(nx / len, ny / len, nz / len),
    };
  }

  poke() {
    if (this.state.paused) return;
    const { point, normal } = this.pickSurfacePoint();
    this.body.pokeAt(point, normal, 3.2);
  }

  /** Drop a dollop of paint and nudge it in, so it starts marbling. */
  paint(id) {
    if (this.state.paused) return;
    const rgb = getColorLinear(id);
    const { point, normal } = this.pickSurfacePoint();
    this.body.paintColor(point, 0.55, rgb);
    this.body.pokeAt(point, normal, 1.6);
  }

  tick = (now) => {
    this.raf = requestAnimationFrame(this.tick);

    const dt = Math.min((now - this.lastTime) / 1000, CONFIG.simulation.maxFrameDt);
    this.lastTime = now;

    this.pointer.update(dt);

    if (!this.state.paused) {
      this.accumulator += dt;
      const { fixedDt, maxSubsteps } = CONFIG.simulation;
      let steps = 0;
      while (this.accumulator >= fixedDt && steps < maxSubsteps) {
        this.body.step(fixedDt);
        this.accumulator -= fixedDt;
        steps += 1;
      }
      if (steps === maxSubsteps) this.accumulator = 0;
    }

    this.body.updateDerived(dt);
    this.surface.sync();
    if (this.renderMode === 'implicit') this.implicit.sync();

    if (!this.pointer.active) this.rig.follow(this.body.centroid, dt);
    this.rig.update(dt);
    this.stage.update({ centroid: this.body.centroid, contact: this.body.contact, dt });
    this.debug.update();
    this.stage.render(this.camera);

    this.fpsAccum += dt;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      if (this.state.debug) this.updateStats();
    }
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.pointer.dispose();
    this.rig.dispose();
    this.surface.geometry.dispose();
    this.material.dispose();
    this.slimeMaterial.dispose();
    this.implicit.dispose();
    this.debug.dispose();
    this.stage.dispose();
  }
}
