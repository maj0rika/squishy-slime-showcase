import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from '../config.js';

const { camera: CAM } = CONFIG;

/**
 * Portrait stages (aspect below this) frame the blob with extra horizontal
 * room so multi-finger stretching still fits: the fitted radius is scaled by
 * `PORTRAIT_RADIUS_SCALE`. Landscape/desktop uses the shape's own radius.
 */
const PORTRAIT_ASPECT = 0.8;
const PORTRAIT_RADIUS_SCALE = 1.35;

function framingRadius(shapeCamera, aspect) {
  return aspect < PORTRAIT_ASPECT
    ? shapeCamera.radius * PORTRAIT_RADIUS_SCALE
    : shapeCamera.radius;
}

function fitDistance(camera, radius, aspect, margin) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const vertical = radius / Math.sin(vFov / 2);
  const horizontal = radius / Math.sin(hFov / 2);
  return Math.max(vertical, horizontal) * margin;
}

function poseFor(camera, shapeCamera, aspect, azimuth, polar) {
  const target = new THREE.Vector3().fromArray(shapeCamera.target);
  const distance = fitDistance(camera, framingRadius(shapeCamera, aspect), aspect, shapeCamera.margin);
  const sinPolar = Math.sin(polar);
  const position = new THREE.Vector3(
    target.x + distance * sinPolar * Math.sin(azimuth),
    target.y + distance * Math.cos(polar),
    target.z + distance * sinPolar * Math.cos(azimuth)
  );
  return { target, position };
}

export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = CAM.damping;
    this.controls.enablePan = false;
    this.controls.minDistance = CAM.minDistance;
    this.controls.maxDistance = CAM.maxDistance;
    this.controls.minPolarAngle = CAM.minPolar;
    this.controls.maxPolarAngle = CAM.maxPolar;
    this.controls.rotateSpeed = CAM.rotateSpeed;
    this.controls.zoomSpeed = CAM.zoomSpeed;
    this.controls.target.set(0, 0.78, 0);

    this.defaultPosition = new THREE.Vector3();
    this.defaultTarget = new THREE.Vector3();
    this.shapeCamera = null;
    this.tween = null;
  }

  /** Canonical framing for a shape. Applied immediately. */
  frame(shapeCamera, aspect) {
    this.shapeCamera = shapeCamera;
    const pose = poseFor(this.camera, shapeCamera, aspect, shapeCamera.azimuth, shapeCamera.polar);
    this.defaultPosition.copy(pose.position);
    this.defaultTarget.copy(pose.target);
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.tween = null;
  }

  /**
   * Keep the current viewing angle but re-fit the distance for a new aspect.
   * Used on large viewport changes (rotation, desktop ↔ mobile).
   */
  refit(aspect) {
    if (!this.shapeCamera) return;
    const shapeCamera = this.shapeCamera;
    const target = new THREE.Vector3().fromArray(shapeCamera.target);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.radius = fitDistance(this.camera, framingRadius(shapeCamera, aspect), aspect, shapeCamera.margin);
    spherical.makeSafe();

    const position = new THREE.Vector3().setFromSpherical(spherical).add(target);
    this.camera.position.copy(position);
    this.controls.target.copy(target);

    const canonical = poseFor(
      this.camera,
      shapeCamera,
      aspect,
      shapeCamera.azimuth,
      shapeCamera.polar
    );
    this.defaultPosition.copy(canonical.position);
    this.defaultTarget.copy(canonical.target);

    this.controls.update();
    this.tween = null;
  }

  reset(animate) {
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(this.defaultPosition);
      this.controls.target.copy(this.defaultTarget);
      this.controls.update();
      this.tween = null;
      return;
    }

    this.tween = {
      elapsed: 0,
      duration: CAM.resetTweenSeconds,
      fromPosition: this.camera.position.clone(),
      toPosition: this.defaultPosition.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: this.defaultTarget.clone(),
    };
  }

  cancelTween() {
    this.tween = null;
  }

  /**
   * Ease the orbit target's x/z toward the body centroid (y unchanged) and
   * move the camera by the same delta, so the view tracks the blob as it
   * slides across the floor. Call only while no tool is active.
   */
  follow(centroid, dt) {
    const k = 1 - Math.exp(-CAM.followRate * dt);
    const dx = (centroid.x - this.controls.target.x) * k;
    const dz = (centroid.z - this.controls.target.z) * k;
    this.controls.target.x += dx;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  update(dt) {
    if (this.tween) {
      this.tween.elapsed += dt;
      const t = Math.min(this.tween.elapsed / this.tween.duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, eased);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, eased);
      if (t >= 1) this.tween = null;
    }
    this.controls.update();
  }

  dispose() {
    this.controls.dispose();
  }
}
