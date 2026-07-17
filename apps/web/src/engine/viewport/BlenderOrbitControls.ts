import * as THREE from 'three';

type SupportedCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type PointerAction = 'orbit' | 'pan' | 'dolly';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MIN_ORTHOGRAPHIC_ZOOM = 0.01;
const MAX_ORTHOGRAPHIC_ZOOM = 10_000;

/**
 * Blender-style turntable navigation without OrbitControls' 180-degree polar
 * clamp. Rotation is composed around world-up and the camera's local right
 * axis, so the view can pass through both poles without introducing trackball
 * roll.
 */
export class BlenderOrbitControls {
  enabled = true;
  readonly target = new THREE.Vector3();
  minDistance = 0.3;
  maxDistance = 40;
  rotateSpeed = 0.005;
  zoomSpeed = 0.0015;
  panSpeed = 1;

  private activePointerId?: number;
  private pointerAction?: PointerAction;
  private pointerX = 0;
  private pointerY = 0;
  private readonly offset = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly panOffset = new THREE.Vector3();
  private readonly yawRotation = new THREE.Quaternion();
  private readonly pitchRotation = new THREE.Quaternion();

  constructor(
    readonly camera: SupportedCamera,
    readonly domElement: HTMLElement,
  ) {
    domElement.addEventListener('contextmenu', this.handleContextMenu);
    domElement.addEventListener('pointerdown', this.handlePointerDown);
    domElement.addEventListener('pointermove', this.handlePointerMove);
    domElement.addEventListener('pointerup', this.handlePointerUp);
    domElement.addEventListener('pointercancel', this.handlePointerUp);
    domElement.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  update = () => {
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  };

  dispose() {
    this.domElement.removeEventListener('contextmenu', this.handleContextMenu);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('pointercancel', this.handlePointerUp);
    this.domElement.removeEventListener('wheel', this.handleWheel);
  }

  private handleContextMenu = (event: MouseEvent) => {
    if (this.enabled) event.preventDefault();
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (!this.enabled || this.activePointerId !== undefined) return;

    const action = this.getPointerAction(event);
    if (!action) return;

    this.activePointerId = event.pointerId;
    this.pointerAction = action;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.domElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.enabled || event.pointerId !== this.activePointerId || !this.pointerAction) return;

    const deltaX = event.clientX - this.pointerX;
    const deltaY = event.clientY - this.pointerY;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;

    if (this.pointerAction === 'orbit') this.orbit(deltaX, deltaY);
    else if (this.pointerAction === 'pan') this.pan(deltaX, deltaY);
    else this.dolly(deltaY);
    event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return;
    if (this.domElement.hasPointerCapture(event.pointerId)) this.domElement.releasePointerCapture(event.pointerId);
    this.activePointerId = undefined;
    this.pointerAction = undefined;
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    this.zoomByFactor(Math.exp(event.deltaY * this.zoomSpeed));
    event.preventDefault();
  };

  private getPointerAction(event: PointerEvent): PointerAction | undefined {
    // Keep the existing left-drag orbit interaction. Plain MMB pans the view
    // directly as requested; Ctrl/Cmd+MMB remains available for dolly.
    if (event.button === 0) return 'orbit';
    if (event.button === 1 && (event.ctrlKey || event.metaKey)) return 'dolly';
    if (event.button === 1) return 'pan';
    if (event.button === 2) return 'pan';
    return undefined;
  }

  private orbit(deltaX: number, deltaY: number) {
    this.offset.copy(this.camera.position).sub(this.target);
    if (this.offset.lengthSq() < Number.EPSILON) return;

    const yaw = -deltaX * this.rotateSpeed;
    const pitch = -deltaY * this.rotateSpeed;

    // Apply yaw first, then pitch around the yawed camera-right axis. Updating
    // camera.up with the same rotations keeps the horizon stable and preserves
    // orientation while crossing the top and bottom poles.
    this.yawRotation.setFromAxisAngle(WORLD_UP, yaw);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(this.yawRotation).normalize();
    this.pitchRotation.setFromAxisAngle(this.right, pitch);

    this.offset.applyQuaternion(this.yawRotation).applyQuaternion(this.pitchRotation);
    this.camera.up.applyQuaternion(this.yawRotation).applyQuaternion(this.pitchRotation).normalize();
    this.camera.position.copy(this.target).add(this.offset);
    this.update();
  }

  private pan(deltaX: number, deltaY: number) {
    const elementHeight = Math.max(this.domElement.clientHeight, 1);
    const elementWidth = Math.max(this.domElement.clientWidth, 1);
    let horizontalScale: number;
    let verticalScale: number;

    if (this.camera instanceof THREE.PerspectiveCamera) {
      const distance = this.camera.position.distanceTo(this.target);
      verticalScale = (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / elementHeight;
      horizontalScale = verticalScale;
    } else {
      horizontalScale = (this.camera.right - this.camera.left) / this.camera.zoom / elementWidth;
      verticalScale = (this.camera.top - this.camera.bottom) / this.camera.zoom / elementHeight;
    }

    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.up.copy(this.camera.up).normalize();
    this.panOffset
      .copy(this.right)
      .multiplyScalar(-deltaX * horizontalScale * this.panSpeed)
      .addScaledVector(this.up, deltaY * verticalScale * this.panSpeed);
    this.camera.position.add(this.panOffset);
    this.target.add(this.panOffset);
    this.update();
  }

  private dolly(deltaY: number) {
    this.zoomByFactor(Math.exp(deltaY * 0.01));
  }

  private zoomByFactor(factor: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;

    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.zoom = THREE.MathUtils.clamp(
        this.camera.zoom / factor,
        MIN_ORTHOGRAPHIC_ZOOM,
        MAX_ORTHOGRAPHIC_ZOOM,
      );
      this.camera.updateProjectionMatrix();
      return;
    }

    this.offset.copy(this.camera.position).sub(this.target);
    const distance = THREE.MathUtils.clamp(this.offset.length() * factor, this.minDistance, this.maxDistance);
    if (this.offset.lengthSq() < Number.EPSILON) this.offset.set(0, 0, distance);
    else this.offset.setLength(distance);
    this.camera.position.copy(this.target).add(this.offset);
    this.update();
  }
}
