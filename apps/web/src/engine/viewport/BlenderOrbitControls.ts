import * as THREE from 'three';

type SupportedCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type PointerAction = 'orbit' | 'pan';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const MIN_ORTHOGRAPHIC_ZOOM = 0.01;
const MAX_ORTHOGRAPHIC_ZOOM = 10_000;
// The critically-damped frequency keeps the exact accumulated target while
// making high-frequency wheel input read as one continuous camera move. At
// 60 Hz this consumes 1.24% of the target on the first frame and peaks at
// 6.11% per frame (formerly 2.33% / 8.56%), without overshoot or a fixed FPS.
const WHEEL_ZOOM_SPRING = 10;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

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
  // Preserve every physical wheel delta but reduce the logarithmic sensitivity
  // by 25%; four 100px packets now target 27.1% instead of 37.7% distance.
  zoomSpeed = 0.0006;
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
  private pendingWheelDelta = 0;
  private targetPerspectiveDistance?: number;
  private targetOrthographicZoom?: number;
  private wheelZoomLogVelocity = 0;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    readonly camera: SupportedCamera,
    readonly domElement: HTMLElement,
    private readonly onWheelActivity?: () => void,
  ) {
    domElement.addEventListener('contextmenu', this.handleContextMenu);
    domElement.addEventListener('pointerdown', this.handlePointerDown);
    domElement.addEventListener('pointermove', this.handlePointerMove);
    domElement.addEventListener('pointerup', this.handlePointerUp);
    domElement.addEventListener('pointercancel', this.handlePointerUp);
    // The editor viewport is non-scrollable. Keeping this listener passive lets
    // Chromium route precision-wheel input without waiting on a scroll-blocking
    // main-thread acknowledgement for every raw device event.
    domElement.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  private syncCameraTransform() {
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  update = () => {
    this.cancelWheelTransition();
    this.syncCameraTransform();
    this.changeListeners.forEach((listener) => listener());
  };

  updateWheelTransition(deltaSeconds: number) {
    if (this.pendingWheelDelta !== 0) {
      const delta = this.pendingWheelDelta;
      this.pendingWheelDelta = 0;
      this.queueWheelZoom(Math.exp(THREE.MathUtils.clamp(delta * this.zoomSpeed, -4, 4)));
    }

    const frameDelta = THREE.MathUtils.clamp(deltaSeconds, 0, 0.05);
    if (frameDelta <= 0) return;

    if (this.camera instanceof THREE.OrthographicCamera) {
      const targetZoom = this.targetOrthographicZoom;
      if (targetZoom === undefined) return;
      this.onWheelActivity?.();
      const currentZoom = this.camera.zoom;
      const nextZoom = this.stepWheelZoomSpring(currentZoom, targetZoom, frameDelta);
      const settled = Math.abs(nextZoom - targetZoom) <= Math.max(targetZoom * 0.0005, 1e-6);
      this.camera.zoom = settled ? targetZoom : nextZoom;
      this.camera.updateProjectionMatrix();
      if (settled) {
        this.targetOrthographicZoom = undefined;
        this.wheelZoomLogVelocity = 0;
      }
      return;
    }

    const targetDistance = this.targetPerspectiveDistance;
    if (targetDistance === undefined) return;
    // Keep background texture uploads and heavy jobs paused for the complete
    // visible transition, not merely for the raw wheel-event burst.
    this.onWheelActivity?.();
    this.offset.copy(this.camera.position).sub(this.target);
    const currentDistance = this.offset.length();
    const safeCurrentDistance = Math.max(currentDistance, Number.EPSILON);
    const nextDistance = this.stepWheelZoomSpring(
      safeCurrentDistance,
      targetDistance,
      frameDelta,
    );
    const settled =
      Math.abs(nextDistance - targetDistance) <= Math.max(targetDistance * 0.0005, 1e-6);
    if (this.offset.lengthSq() < Number.EPSILON) this.offset.set(0, 0, targetDistance);
    else this.offset.setLength(settled ? targetDistance : nextDistance);
    this.camera.position.copy(this.target).add(this.offset);
    // Dolly keeps the existing viewing direction. Avoid rebuilding the
    // quaternion on every transition frame; only refresh the camera matrix.
    this.camera.updateMatrixWorld();
    if (settled) {
      this.targetPerspectiveDistance = undefined;
      this.wheelZoomLogVelocity = 0;
    }
  }

  subscribeChange(listener: () => void) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  dispose() {
    this.domElement.removeEventListener('contextmenu', this.handleContextMenu);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('pointercancel', this.handlePointerUp);
    this.domElement.removeEventListener('wheel', this.handleWheel);
    this.cancelWheelTransition();
    this.changeListeners.clear();
  }

  private handleContextMenu = (event: MouseEvent) => {
    if (this.enabled) event.preventDefault();
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (!this.enabled || this.activePointerId !== undefined) return;

    const action = this.getPointerAction(event);
    if (!action) return;

    this.cancelWheelTransition();

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
    else this.pan(deltaX, deltaY);
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
    // Claim the interaction budget synchronously. Waiting for the next R3F
    // frame left a 0-16.7ms race in which a ready 4K texture stripe could be
    // submitted before camera animation marked the viewport busy.
    this.onWheelActivity?.();
    // Precision wheels and trackpads can dispatch several events in one display
    // interval. Applying lookAt/updateMatrixWorld for every raw event creates an
    // input-rate CPU spike, especially while the local-repaint shader is active.
    // Preserve the complete physical delta but apply it once per native display
    // frame. This is refresh-rate adaptive (60/120/144Hz), not an FPS cap.
    const deltaScale =
      event.deltaMode === WHEEL_DELTA_LINE
        ? 16
        : event.deltaMode === WHEEL_DELTA_PAGE
          ? Math.max(this.domElement.clientHeight, 1)
          : 1;
    this.pendingWheelDelta += event.deltaY * deltaScale;
  };

  private cancelWheelTransition() {
    this.pendingWheelDelta = 0;
    this.targetPerspectiveDistance = undefined;
    this.targetOrthographicZoom = undefined;
    this.wheelZoomLogVelocity = 0;
  }

  private stepWheelZoomSpring(current: number, target: number, deltaSeconds: number) {
    const currentLog = Math.log(current);
    const targetLog = Math.log(target);
    const displacement = currentLog - targetLog;
    const springStep =
      (this.wheelZoomLogVelocity + WHEEL_ZOOM_SPRING * displacement) * deltaSeconds;
    const decay = Math.exp(-WHEEL_ZOOM_SPRING * deltaSeconds);
    this.wheelZoomLogVelocity =
      (this.wheelZoomLogVelocity - WHEEL_ZOOM_SPRING * springStep) * decay;
    return Math.exp(targetLog + (displacement + springStep) * decay);
  }

  private queueWheelZoom(factor: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;

    if (this.camera instanceof THREE.OrthographicCamera) {
      const currentTarget = this.targetOrthographicZoom ?? this.camera.zoom;
      this.targetOrthographicZoom = THREE.MathUtils.clamp(
        currentTarget / factor,
        MIN_ORTHOGRAPHIC_ZOOM,
        MAX_ORTHOGRAPHIC_ZOOM,
      );
      return;
    }

    const currentDistance = this.camera.position.distanceTo(this.target);
    const currentTarget = this.targetPerspectiveDistance ?? currentDistance;
    this.targetPerspectiveDistance = THREE.MathUtils.clamp(
      currentTarget * factor,
      this.minDistance,
      this.maxDistance,
    );
  }

  private getPointerAction(event: PointerEvent): PointerAction | undefined {
    // Primary input is reserved for the active paint/eraser tool. Navigation
    // follows the editor contract regardless of modifier keys: MMB pans and
    // RMB orbits. Wheel input remains the exclusive dolly gesture.
    if (event.button === 1) return 'pan';
    if (event.button === 2) return 'orbit';
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
    // Perspective dolly changes only the camera distance. View-cube listeners
    // care about orientation, and notifying them on every coalesced wheel frame
    // performs redundant model/camera math during the hottest zoom path.
    this.syncCameraTransform();
  }
}
