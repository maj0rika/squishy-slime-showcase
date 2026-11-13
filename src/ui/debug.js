import * as THREE from 'three';

/**
 * Debug overlays are wired to the real simulation: the wireframe and the
 * control points share the exact BufferGeometry the solver drives, the grab
 * fields are drawn at each active hand's real influence radius, the contact
 * points are the actual vertices resting on the floor, and the weld overlay
 * draws the live fusion constraints between node pairs.
 */

// Fixed capacity of the weld overlay; matches CONFIG.knead.maxWelds.
const WELD_CAPACITY = 6000;

export class DebugLayer {
  constructor({ scene, geometry, body }) {
    this.body = body;
    this.group = new THREE.Group();
    this.group.name = 'debug';
    this.group.visible = false;
    scene.add(this.group);

    this.wireframe = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x2b2521,
        wireframe: true,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      })
    );
    this.wireframe.frustumCulled = false;
    this.group.add(this.wireframe);

    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute('position', geometry.getAttribute('position'));
    this.points = new THREE.Points(
      pointsGeometry,
      new THREE.PointsMaterial({
        color: 0x1c1815,
        size: 0.018,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    this.points.frustumCulled = false;
    this.group.add(this.points);

    this.contactAttr = new THREE.BufferAttribute(new Float32Array(body.count * 3), 3);
    this.contactAttr.setUsage(THREE.DynamicDrawUsage);
    this.contactArray = this.contactAttr.array;
    const contactGeometry = new THREE.BufferGeometry();
    contactGeometry.setAttribute('position', this.contactAttr);
    contactGeometry.setDrawRange(0, 0);
    this.contactPoints = new THREE.Points(
      contactGeometry,
      new THREE.PointsMaterial({
        color: 0xc0392b,
        size: 0.022,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this.contactPoints.frustumCulled = false;
    this.contactPoints.renderOrder = 5;
    this.group.add(this.contactPoints);

    const fieldGeometry = new THREE.SphereGeometry(1, 22, 16);
    const fieldMaterial = new THREE.MeshBasicMaterial({
      color: 0x2f6ea8,
      wireframe: true,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    });
    this.handFields = body.hands.map(() => {
      const field = new THREE.Mesh(fieldGeometry, fieldMaterial);
      field.renderOrder = 5;
      field.visible = false;
      this.group.add(field);
      return field;
    });
    this.fieldGeometry = fieldGeometry;
    this.fieldMaterial = fieldMaterial;

    this.pressDisk = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: 0x8a5a2f,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.pressDisk.rotation.x = -Math.PI / 2;
    this.pressDisk.renderOrder = 5;
    this.group.add(this.pressDisk);

    this.weldAttr = new THREE.BufferAttribute(new Float32Array(WELD_CAPACITY * 2 * 3), 3);
    this.weldAttr.setUsage(THREE.DynamicDrawUsage);
    this.weldArray = this.weldAttr.array;
    const weldGeometry = new THREE.BufferGeometry();
    weldGeometry.setAttribute('position', this.weldAttr);
    weldGeometry.setDrawRange(0, 0);
    this.welds = new THREE.LineSegments(
      weldGeometry,
      new THREE.LineBasicMaterial({
        color: 0x27ae60,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      })
    );
    this.welds.frustumCulled = false;
    this.welds.renderOrder = 6;
    this.group.add(this.welds);

    this.contactEnabled = false;
    this.grabFieldEnabled = false;
    this.weldEnabled = false;

    this.pressDisk.visible = false;
    this.contactPoints.visible = false;
    this.welds.visible = false;
  }

  setEnabled(enabled) {
    this.group.visible = enabled;
  }

  setWireframe(visible) {
    this.wireframe.visible = visible;
  }

  setPoints(visible) {
    this.points.visible = visible;
  }

  setContact(visible) {
    this.contactEnabled = visible;
    this.contactPoints.visible = visible;
  }

  setGrabField(visible) {
    this.grabFieldEnabled = visible;
    if (!visible) {
      for (const field of this.handFields) field.visible = false;
    }
  }

  setWelds(visible) {
    this.weldEnabled = visible;
    if (!visible) this.welds.visible = false;
  }

  update() {
    if (!this.group.visible) return;

    const body = this.body;

    for (let h = 0; h < this.handFields.length; h++) {
      const hand = body.hands[h];
      const field = this.handFields[h];
      if (this.grabFieldEnabled && hand.active) {
        field.visible = true;
        field.position.set(hand.target.x, hand.target.y, hand.target.z);
        field.scale.setScalar(hand.radius);
      } else {
        field.visible = false;
      }
    }

    if (body.press.active) {
      this.pressDisk.visible = true;
      this.pressDisk.position.set(body.press.x, body.press.y, body.press.z);
      this.pressDisk.scale.set(body.press.radius, body.press.radius, 1);
    } else {
      this.pressDisk.visible = false;
    }

    if (this.contactEnabled) {
      const pos = body.pos;
      const floorY = body.floorY;
      const arr = this.contactArray;
      let n = 0;
      for (let i = 0; i < body.count; i++) {
        const i3 = i * 3;
        if (pos[i3 + 1] <= floorY + 0.01) {
          arr[n * 3] = pos[i3];
          arr[n * 3 + 1] = pos[i3 + 1];
          arr[n * 3 + 2] = pos[i3 + 2];
          n += 1;
        }
      }
      this.contactAttr.needsUpdate = true;
      this.contactPoints.geometry.setDrawRange(0, n);
    }

    if (this.weldEnabled) {
      const welds = body.welds;
      const pos = body.nodePos;
      const arr = this.weldArray;
      const count = Math.min(welds.length, WELD_CAPACITY);
      for (let k = 0; k < count; k++) {
        const i = welds[k].i * 3;
        const j = welds[k].j * 3;
        const o = k * 6;
        arr[o] = pos[i];
        arr[o + 1] = pos[i + 1];
        arr[o + 2] = pos[i + 2];
        arr[o + 3] = pos[j];
        arr[o + 4] = pos[j + 1];
        arr[o + 5] = pos[j + 2];
      }
      this.weldAttr.needsUpdate = true;
      this.welds.geometry.setDrawRange(0, count * 2);
    }
  }

  dispose() {
    this.wireframe.material.dispose();
    this.points.material.dispose();
    this.points.geometry.dispose();
    this.contactPoints.geometry.dispose();
    this.contactPoints.material.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    this.pressDisk.geometry.dispose();
    this.pressDisk.material.dispose();
    this.welds.geometry.dispose();
    this.welds.material.dispose();
    this.group.removeFromParent();
  }
}
