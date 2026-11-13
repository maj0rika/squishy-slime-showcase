import * as THREE from 'three';
import { CONFIG } from '../config.js';

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _cameraDir = new THREE.Vector3();
const _planePoint = new THREE.Vector3();
const _drag = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _target = new THREE.Vector3();

const PULL = CONFIG.grab.pull;
const PUSH = PULL.push;
const PRESS = CONFIG.grab.press;

/** Pointer movement (in CSS px) below which a held pointer counts as "still". */
const HOLD_STILL_PX = 6;
/** Once a pointer has moved past this, its hold force stops growing for good. */
const HOLD_MOVE_PX = 12;
/** World units of drag per haptic tick while a hand is being dragged. */
const HAPTIC_DRAG_STEP = 0.25;

/**
 * Gesture input — no tool switching.
 *
 *   Left mouse / one finger on the blob  → grab. A touch is a FORCE along the
 *     surface normal, not a scripted offset: the finger pushes the patch in and
 *     the material decides how deep it goes. Holding still deepens the push;
 *     dragging out fades the push so the pin takes over and the patch stretches.
 *     Every pointer on the blob starts its own hand until
 *     `CONFIG.grab.maxHands` are active: five or more fingers can stretch,
 *     fold and knead at once. Further pointers are ignored.
 *   Right mouse drag / Shift + left      → palm press (volume spreads).
 *   Empty space (no hand active)         → OrbitControls: one finger orbits,
 *     two fingers pinch-zoom. Empty space while a hand is active is ignored.
 *
 * OrbitControls is switched off entirely while any hand is active and back on
 * once every hand is released, so a hand never fights the camera.
 *
 * On hardware that exposes `navigator.vibrate` (Android; iOS does not) each
 * grab start, palm press start and each 0.25 world units of drag fires a short
 * haptic tick. The capability is checked once; when absent it is never called.
 */
export class PointerController {
  constructor({ stageEl, canvas, camera, mesh, body, controls, rig, floorY, onGrabStart, onGrabEnd }) {
    this.stageEl = stageEl;
    this.canvas = canvas;
    this.camera = camera;
    this.mesh = mesh;
    this.body = body;
    this.controls = controls;
    this.rig = rig;
    this.floorY = floorY;
    this.onGrabStart = onGrabStart;
    this.onGrabEnd = onGrabEnd;

    this.enabled = true;
    this.shift = false;
    this.pointers = new Map();
    this.lastHoverAt = 0;
    this.dragTravel = 0;
    this.haptics = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onCancel = this.onCancel.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);

    stageEl.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /** True while at least one hand (grab or press) is active. */
  get active() {
    return this.pointers.size > 0;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.cancel();
    this.canvas.style.cursor = 'default';
  }

  /** OrbitControls owns the camera only when no hand is holding the blob. */
  syncControls() {
    this.controls.enabled = this.pointers.size === 0;
  }

  /** Number of grab hands currently active (palm presses excluded). */
  grabCount() {
    let n = 0;
    for (const hand of this.pointers.values()) {
      if (hand.kind === 'grab') n += 1;
    }
    return n;
  }

  /**
   * One entry per active grab hand for the finger proxy: the pointer id,
   * whether the finger should be drawn (a real touch finger is already there),
   * and the solver's current contact centre and outward normal.
   */
  fingers() {
    const fingers = [];
    for (const hand of this.pointers.values()) {
      if (hand.kind !== 'grab') continue;
      const state = this.body.hands[hand.handle];
      fingers.push({
        id: hand.pointerId,
        visible: hand.pointerType !== 'touch',
        center: state.center,
        normal: state.normal,
      });
    }
    return fingers;
  }

  /** World distance every grab hand's drag vector moved since the last call. */
  consumeDragTravel() {
    const travel = this.dragTravel;
    this.dragTravel = 0;
    return travel;
  }

  /** Fire a haptic pattern only where the capability exists. */
  vibrate(pattern) {
    if (this.haptics) navigator.vibrate(pattern);
  }

  toNdc(event) {
    const rect = this.canvas.getBoundingClientRect();
    _ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    return _ndc;
  }

  hitTest(event) {
    _raycaster.setFromCamera(this.toNdc(event), this.camera);
    this.mesh.updateMatrixWorld();
    return _raycaster.intersectObject(this.mesh, false);
  }

  onDown(event) {
    if (!this.enabled) return;

    const type = event.pointerType;
    if (type === 'mouse') {
      if (event.button !== 0 && event.button !== 2) return;
    } else if (type !== 'touch' && type !== 'pen') {
      return;
    }

    // One hand per pointer: a mouse holding two buttons must not overwrite its
    // own hand (touch fingers have distinct pointer ids, so both can grab).
    if (this.pointers.has(event.pointerId)) return;

    const hits = this.hitTest(event);
    if (hits.length === 0) return;

    const pressRequested = type === 'mouse' && (event.button === 2 || this.shift);
    if (pressRequested) {
      if (this.pressActive()) return;
      this.beginPress(event, hits[0]);
      return;
    }

    if (this.grabCount() >= CONFIG.grab.maxHands) return;
    this.beginGrab(event, hits[0]);
  }

  beginGrab(event, hit) {
    _normal.copy(hit.face.normal).transformDirection(this.mesh.matrixWorld).normalize();
    this.camera.getWorldDirection(_cameraDir);

    // Contact area drives the area term of the push. Only touch reports a real
    // contact size; a mouse/pen reports a constant size, so areaF stays 0.
    const area0 = event.pointerType === 'touch' ? event.width * event.height : 0;

    const hand = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      kind: 'grab',
      handle: this.body.beginGrab(hit.point, PULL.radius, _normal.clone()),
      hitPoint: hit.point.clone(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(_cameraDir, hit.point),
      drag: new THREE.Vector3(),
      prevDrag: new THREE.Vector3(),
      hold: 0,
      holdF: 0,
      holdLatched: false,
      area: area0,
      area0,
      startX: event.clientX,
      startY: event.clientY,
      moved: 0,
      dragTicks: 0,
    };

    this.vibrate(8);
    this.rig.cancelTween();
    this.pointers.set(event.pointerId, hand);
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.syncControls();
    this.onGrabStart();
  }

  beginPress(event, hit) {
    const top = this.body.topHeightAt(hit.point.x, hit.point.z, PRESS.radius);
    const hand = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      kind: 'press',
      pressX: hit.point.x,
      pressZ: hit.point.z,
      pressTop: top,
      pressMaxDepth: Math.max(0, top - this.floorY - this.body.pressMinThickness),
      clientY: event.clientY,
      startClientY: event.clientY,
      hold: 0,
    };

    this.vibrate([0, 12]);
    this.rig.cancelTween();
    this.body.beginPress(hit.point.x, hit.point.z, top, PRESS.radius);
    this.pointers.set(event.pointerId, hand);
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.syncControls();
  }

  pressActive() {
    for (const hand of this.pointers.values()) {
      if (hand.kind === 'press') return true;
    }
    return false;
  }

  onMove(event) {
    const hand = this.pointers.get(event.pointerId);
    if (!hand) {
      if (event.pointerType === 'mouse') this.updateHover(event);
      return;
    }

    if (hand.kind === 'grab') {
      _raycaster.setFromCamera(this.toNdc(event), this.camera);
      if (_raycaster.ray.intersectPlane(hand.plane, _planePoint)) {
        _drag.subVectors(_planePoint, hand.hitPoint);
        const max = PULL.maxDrag;
        if (_drag.lengthSq() > max * max) _drag.setLength(max);
        hand.drag.copy(_drag);
      }
      if (hand.pointerType === 'touch') hand.area = event.width * event.height;
      const ticks = Math.floor(hand.drag.length() / HAPTIC_DRAG_STEP);
      if (ticks > hand.dragTicks) {
        hand.dragTicks = ticks;
        this.vibrate(4);
      }
      hand.moved = Math.max(
        hand.moved,
        Math.hypot(event.clientX - hand.startX, event.clientY - hand.startY)
      );
    } else {
      hand.clientY = event.clientY;
    }
  }

  updateHover(event) {
    if (this.pointers.size > 0) return;
    const now = performance.now();
    if (now - this.lastHoverAt < 90) return;
    this.lastHoverAt = now;
    const hits = this.hitTest(event);
    this.canvas.style.cursor = hits.length === 0 ? 'default' : 'grab';
  }

  onUp(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.endHand(event.pointerId);
  }

  onCancel(event) {
    if (this.pointers.has(event.pointerId)) this.endHand(event.pointerId);
  }

  onBlur() {
    this.cancel();
  }

  onVisibility() {
    if (document.hidden) this.cancel();
  }

  onKey(event) {
    if (event.key === 'Shift') this.shift = event.type === 'keydown';
  }

  onContextMenu(event) {
    event.preventDefault();
  }

  endHand(pointerId) {
    const hand = this.pointers.get(pointerId);
    if (!hand) {
      throw new Error(`PointerController.endHand: no hand for pointer ${pointerId}`);
    }
    this.pointers.delete(pointerId);

    if (hand.kind === 'grab') {
      // Read the pressed depth before the solver clears the hand: the audio
      // layer uses it to decide whether the release pops.
      const depth = this.body.hands[hand.handle].depth;
      this.body.endGrab(hand.handle);
      this.onGrabEnd(depth);
    } else {
      this.body.endPress();
    }

    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
    this.syncControls();
    this.canvas.style.cursor = this.pointers.size > 0 ? 'grabbing' : 'default';
  }

  cancel() {
    for (const pointerId of [...this.pointers.keys()]) this.endHand(pointerId);
    this.syncControls();
  }

  /** Called every frame: drives each hand's force and target from the pointer. */
  update(dt) {
    if (this.pointers.size === 0) return;
    for (const hand of this.pointers.values()) {
      hand.hold += dt;
      if (hand.kind === 'grab') {
        this.updateGrab(hand, dt);
        this.dragTravel += hand.drag.distanceTo(hand.prevDrag);
        hand.prevDrag.copy(hand.drag);
      } else {
        this.updatePress(hand);
      }
    }
  }

  updateGrab(hand, dt) {
    // Hold force: a still finger sinks deeper. Once the finger has been dragged
    // past HOLD_MOVE_PX the hold stops growing for good, so stretching the patch
    // cannot keep deepening the press.
    if (!hand.holdLatched) {
      if (hand.moved < HOLD_STILL_PX && hand.hold > PUSH.holdStartSeconds) {
        hand.holdF = Math.min(hand.holdF + PUSH.holdPerSecond * dt, PUSH.holdMax);
      }
      if (hand.moved > HOLD_MOVE_PX) hand.holdLatched = true;
    }

    const touchF = PUSH.touch * (1 - Math.exp(-hand.hold / PUSH.touchEaseSeconds));
    const areaF = hand.area0 > 0
      ? PUSH.areaGain * Math.min(Math.max(hand.area / hand.area0 - 1, 0), 1)
      : 0;
    const dragLength = hand.drag.length();
    const force =
      Math.min(PUSH.max, touchF + hand.holdF + areaF) * Math.exp(-dragLength / PUSH.pullDecay);

    this.body.setGrabPush(hand.handle, force);
    _target.copy(hand.hitPoint).add(hand.drag);
    this.body.setGrabTarget(hand.handle, _target.x, _target.y, _target.z);
  }

  updatePress(hand) {
    const rect = this.stageEl.getBoundingClientRect();
    const dragDown = ((hand.clientY - hand.startClientY) / rect.height) * PRESS.dragGain;
    const holdDepth = Math.min(
      hand.hold * PRESS.depthPerSecond,
      PRESS.holdMaxFraction * hand.pressMaxDepth
    );
    const depth = Math.min(Math.max(holdDepth + dragDown, 0), hand.pressMaxDepth);
    this.body.setPress(hand.pressX, hand.pressZ, hand.pressTop - depth);
  }

  dispose() {
    this.stageEl.removeEventListener('pointerdown', this.onDown, { capture: true });
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
