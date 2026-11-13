import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * A visible index fingertip for mouse and pen input. A touch user's own finger
 * is already on the glass, so those pointers report `visible: false` and the
 * proxy eases out. The finger's shadow on the toy is the main contact cue.
 *
 * Finger local frame: the origin is the centre of the tip dome, +Y runs along
 * the finger from the tip toward the knuckle, +Z is dorsal (the nail side) and
 * -Z is the pad that touches the toy. 1 unit = 3.6 cm.
 */

const TIP_RADIUS = 0.22;
const FINGER_LENGTH = 3.6;
const PAD_FLATTEN = 0.14;
const THICKNESS_RATIO = 0.85;
const TAPER_PER_UNIT = 0.05;
const AROUND_SEGMENTS = 36;
const DOME_RINGS = 16;
const BODY_RINGS = 110;

const CREASE_Y = 0.72;
const CREASE_DEPTH = 0.05;
const CREASE_WIDTH = 0.05;
const KNUCKLE_Y = 0.98;
const KNUCKLE_SWELL = 0.03;
const KNUCKLE_WIDTH = 0.2;

const NAIL_Y_FREE = -0.1;
const NAIL_Y_CUTICLE = 0.3;
const NAIL_HALF_ANGLE = 0.78;
const NAIL_LIFT = 0.007;
const NAIL_ACROSS = 14;
const NAIL_ALONG = 16;

/** Appear / disappear durations, position smoothing and orientation smoothing. */
const APPEAR_SECONDS = 0.09;
const DISAPPEAR_SECONDS = 0.12;
const SMOOTH_TIME = 0.025;
const ORIENT_SECONDS = 0.04;

/** Finger axis angle from the surface normal, and the sideways lean toward the viewer's right. */
const AXIS_ANGLE = (42 * Math.PI) / 180;
const RIGHT_LEAN = 0.4;
/** Distance from the tip-dome centre to the surface at the pad contact. */
const CONTACT_OFFSET = 0.17;
/** Roll about the finger axis that turns the nail toward the camera. */
const NAIL_ROLL = (75 * Math.PI) / 180;

const SKIN_COLOR = 0xf1c6aa;
const NAIL_COLOR = 0xf4bdb4;

const AXES = ['x', 'y', 'z'];

/**
 * Unity-style critically damped smoothing of `current` toward `target`, with
 * `velocity` carried across frames. `smoothTime` is the 25 ms time constant.
 */
function smoothDamp(current, target, velocity, smoothTime, dt) {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const axis of AXES) {
    const change = current[axis] - target[axis];
    const temp = (velocity[axis] + omega * change) * dt;
    velocity[axis] = (velocity[axis] - omega * temp) * exp;
    current[axis] = target[axis] + (change + temp) * exp;
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Point on the finger skin at height `y` along the axis and angle `phi` around it (0 = dorsal). */
function fingerPoint(y, phi, out) {
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  let radius;
  if (y < 0) {
    radius = Math.sqrt(Math.max(0, TIP_RADIUS * TIP_RADIUS - y * y));
  } else {
    const crease = (y - CREASE_Y) / CREASE_WIDTH;
    const knuckle = (y - KNUCKLE_Y) / KNUCKLE_WIDTH;
    const padSide = 0.5 - 0.5 * cosPhi;
    radius =
      TIP_RADIUS *
      (1 +
        TAPER_PER_UNIT * y -
        CREASE_DEPTH * (0.5 + 0.5 * padSide) * Math.exp(-crease * crease) +
        KNUCKLE_SWELL * Math.exp(-knuckle * knuckle));
  }
  const padAmount = Math.max(0, -cosPhi);
  const thickness = THICKNESS_RATIO * (1 - PAD_FLATTEN * padAmount);
  return out.set(radius * sinPhi, y, radius * cosPhi * thickness);
}

function buildFingerGeometry() {
  const ys = [];
  for (let i = 0; i <= DOME_RINGS; i++) {
    ys.push(TIP_RADIUS * Math.sin(-Math.PI / 2 + (i / DOME_RINGS) * (Math.PI / 2)));
  }
  for (let i = 1; i <= BODY_RINGS; i++) {
    ys.push(FINGER_LENGTH * Math.pow(i / BODY_RINGS, 1.6));
  }
  // Closing ring: same height as the last one but collapsed onto the axis.
  const ringCount = ys.length + 1;
  const stride = AROUND_SEGMENTS;
  const positions = new Float32Array(ringCount * stride * 3);
  const colors = new Float32Array(ringCount * stride * 3);
  const point = new THREE.Vector3();

  for (let i = 0; i < ringCount; i++) {
    const closing = i === ringCount - 1;
    const y = closing ? ys[ys.length - 1] : ys[i];
    for (let j = 0; j < stride; j++) {
      const phi = (j / stride) * Math.PI * 2;
      fingerPoint(y, phi, point);
      if (i === 0 || closing) {
        point.x = 0;
        point.z = 0;
      }
      const index = (i * stride + j) * 3;
      positions[index] = point.x;
      positions[index + 1] = point.y;
      positions[index + 2] = point.z;

      // Redder toward the tip, at the distal crease, and on the pad side.
      const padSide = 0.5 - 0.5 * Math.cos(phi);
      const tip = smoothstep(0.55, -0.15, y);
      const crease = (y - CREASE_Y) / (CREASE_WIDTH * 1.6);
      const flush = Math.min(1, 0.55 * tip + 0.5 * Math.exp(-crease * crease) + 0.18 * padSide * tip);
      colors[index] = 1;
      colors[index + 1] = 1 - 0.2 * flush;
      colors[index + 2] = 1 - 0.27 * flush;
    }
  }

  const indices = [];
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < stride; j++) {
      const a = i * stride + j;
      const b = i * stride + ((j + 1) % stride);
      const c = (i + 1) * stride + j;
      const d = (i + 1) * stride + ((j + 1) % stride);
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildNailGeometry() {
  const columns = NAIL_ACROSS + 1;
  const rows = NAIL_ALONG + 1;
  const positions = new Float32Array(rows * columns * 3);
  const colors = new Float32Array(rows * columns * 3);
  const point = new THREE.Vector3();
  const outward = new THREE.Vector3();

  for (let row = 0; row < rows; row++) {
    const v = row / NAIL_ALONG;
    const y = NAIL_Y_FREE + (NAIL_Y_CUTICLE - NAIL_Y_FREE) * v;
    // Square free edge, rounded cuticle end.
    const rounding = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, v - 0.8) / 0.2, 2)));
    const width = (0.93 + 0.07 * (1 - v)) * rounding;
    const free = smoothstep(0.22, 0.0, v);
    for (let column = 0; column < columns; column++) {
      const u = (column / NAIL_ACROSS) * 2 - 1;
      const phi = u * NAIL_HALF_ANGLE * width;
      fingerPoint(y, phi, point);
      outward.set(point.x, point.y - Math.max(y, 0), point.z).normalize();
      point.addScaledVector(outward, NAIL_LIFT);
      const index = (row * columns + column) * 3;
      positions[index] = point.x;
      positions[index + 1] = point.y;
      positions[index + 2] = point.z;
      colors[index] = 1;
      colors[index + 1] = 1 - 0.07 * (1 - free) + 0.0;
      colors[index + 2] = 1 - 0.1 * (1 - free);
    }
  }

  const indices = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = (row + 1) * columns + column;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildSkinMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    color: SKIN_COLOR,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0,
    sheen: 0.7,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(0xffd6c2),
    specularIntensity: 0.3,
    envMapIntensity: 0.85,
  });
  // Subsurface-like warmth: a soft red glow at grazing angles, where light
  // scatters through thin skin at the silhouette.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float skinRim = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 2.2);
      outgoingLight += vec3(0.2, 0.045, 0.03) * skinRim * diffuseColor.rgb;
      #include <opaque_fragment>`
    );
  };
  material.customProgramCacheKey = () => 'fingerSkinRim';
  return material;
}

export class FingerProxy {
  constructor({ scene }) {
    this.scene = scene;

    this.geometry = buildFingerGeometry();
    this.nailGeometry = buildNailGeometry();
    this.material = buildSkinMaterial();
    this.nailMaterial = new THREE.MeshPhysicalMaterial({
      color: NAIL_COLOR,
      vertexColors: true,
      roughness: 0.22,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      specularIntensity: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.slots = [];
    for (let i = 0; i < CONFIG.grab.maxHands; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.visible = false;
      const nail = new THREE.Mesh(this.nailGeometry, this.nailMaterial);
      nail.castShadow = false;
      nail.receiveShadow = false;
      mesh.add(nail);
      scene.add(mesh);
      this.slots.push({
        mesh,
        id: null,
        scale: 0,
        targetScale: 0,
        hasPose: false,
        center: new THREE.Vector3(),
        targetCenter: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        quaternion: new THREE.Quaternion(),
        targetQuaternion: new THREE.Quaternion(),
      });
    }

    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._toCamera = new THREE.Vector3();
    this._lean = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._dorsal = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._apex = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
  }

  /**
   * `fingers` is one entry per active hand:
   * `{ id, visible, center:{x,y,z}, normal:{x,y,z} }` in world space.
   */
  update({ fingers, camera, dt }) {
    camera.updateMatrixWorld();
    const elements = camera.matrixWorld.elements;
    this._camRight.set(elements[0], elements[1], elements[2]);
    this._camUp.set(elements[4], elements[5], elements[6]);

    const present = new Set();
    for (const finger of fingers) present.add(finger.id);

    // Fingers that are gone this frame start easing out.
    for (const slot of this.slots) {
      if (slot.id !== null && !present.has(slot.id)) slot.targetScale = 0;
    }

    for (const finger of fingers) {
      let slot = null;
      for (const candidate of this.slots) {
        if (candidate.id === finger.id) {
          slot = candidate;
          break;
        }
      }
      if (!slot) {
        for (const candidate of this.slots) {
          if (candidate.id === null) {
            slot = candidate;
            break;
          }
        }
      }
      if (!slot) {
        for (const candidate of this.slots) {
          if (!present.has(candidate.id)) {
            slot = candidate;
            break;
          }
        }
      }
      if (!slot) {
        throw new Error('FingerProxy: more active fingers than CONFIG.grab.maxHands');
      }
      if (slot.id !== finger.id) {
        slot.id = finger.id;
        slot.hasPose = false;
        slot.scale = 0;
        slot.mesh.visible = false;
      }

      slot.targetCenter.set(finger.center.x, finger.center.y, finger.center.z);
      slot.normal.set(finger.normal.x, finger.normal.y, finger.normal.z).normalize();
      this._solveOrientation(slot, camera, slot.targetQuaternion);

      if (!slot.hasPose) {
        slot.center.copy(slot.targetCenter);
        slot.velocity.set(0, 0, 0);
        slot.quaternion.copy(slot.targetQuaternion);
        slot.hasPose = true;
      }
      slot.targetScale = finger.visible ? 1 : 0;
    }

    for (const slot of this.slots) {
      if (slot.id === null) continue;

      const speed = slot.targetScale > slot.scale ? 1 / APPEAR_SECONDS : 1 / DISAPPEAR_SECONDS;
      const step = speed * dt;
      slot.scale =
        slot.targetScale > slot.scale
          ? Math.min(slot.targetScale, slot.scale + step)
          : Math.max(slot.targetScale, slot.scale - step);

      if (slot.scale <= 0) {
        slot.mesh.visible = false;
        if (!present.has(slot.id)) {
          slot.id = null;
          slot.hasPose = false;
        }
        continue;
      }

      smoothDamp(slot.center, slot.targetCenter, slot.velocity, SMOOTH_TIME, dt);
      slot.quaternion.slerp(slot.targetQuaternion, 1 - Math.exp(-dt / ORIENT_SECONDS));
      this._place(slot);
    }
  }

  /**
   * Finger axis: tilted AXIS_ANGLE away from the surface normal toward the
   * viewer (and slightly to their right). With n the surface normal, v the
   * unit vector from the contact to the camera and r the camera right:
   *   l = v + RIGHT_LEAN * r, t = normalize(l - (l . n) n)
   *   axis = n cos(a) + t sin(a)
   * If l is parallel to n (looking straight down the normal) t falls back to
   * the camera right, then the camera up, projected into the surface plane.
   * The dorsal side is n made perpendicular to the axis, so the pad faces the
   * toy and the nail faces the viewer.
   */
  _solveOrientation(slot, camera, outQuaternion) {
    const normal = slot.normal;
    this._toCamera.copy(camera.position).sub(slot.targetCenter).normalize();
    this._lean.copy(this._toCamera).addScaledVector(this._camRight, RIGHT_LEAN);
    this._lean.addScaledVector(normal, -this._lean.dot(normal));
    if (this._lean.lengthSq() < 1e-4) {
      this._lean.copy(this._camRight);
      this._lean.addScaledVector(normal, -this._lean.dot(normal));
      if (this._lean.lengthSq() < 1e-4) {
        this._lean.copy(this._camUp);
        this._lean.addScaledVector(normal, -this._lean.dot(normal));
      }
    }
    this._lean.normalize();

    this._axis
      .copy(normal)
      .multiplyScalar(Math.cos(AXIS_ANGLE))
      .addScaledVector(this._lean, Math.sin(AXIS_ANGLE));

    this._dorsal.copy(normal).addScaledVector(this._axis, -normal.dot(this._axis)).normalize();
    this._side.crossVectors(this._axis, this._dorsal);
    if (this._side.dot(this._toCamera) < 0) this._side.negate();
    this._dorsal.multiplyScalar(Math.cos(NAIL_ROLL)).addScaledVector(this._side, Math.sin(NAIL_ROLL));
    this._side.crossVectors(this._axis, this._dorsal);
    this._basis.makeBasis(this._side, this._axis, this._dorsal);
    outQuaternion.setFromRotationMatrix(this._basis);
  }

  /** Put the tip-dome centre one contact offset above `center`, scaling about the fingertip. */
  _place(slot) {
    const eased = slot.scale * slot.scale * (3 - 2 * slot.scale);

    // Dome centre when fully grown; the apex is TIP_RADIUS back along -axis.
    this._axis.set(0, 1, 0).applyQuaternion(slot.quaternion);
    this._apex
      .copy(slot.center)
      .addScaledVector(slot.normal, CONTACT_OFFSET)
      .addScaledVector(this._axis, -TIP_RADIUS);

    slot.mesh.quaternion.copy(slot.quaternion);
    slot.mesh.scale.setScalar(eased);
    slot.mesh.position.copy(this._apex).addScaledVector(this._axis, TIP_RADIUS * eased);
    slot.mesh.visible = true;
  }

  dispose() {
    for (const slot of this.slots) {
      this.scene.remove(slot.mesh);
    }
    this.slots.length = 0;
    this.geometry.dispose();
    this.nailGeometry.dispose();
    this.material.dispose();
    this.nailMaterial.dispose();
  }
}
