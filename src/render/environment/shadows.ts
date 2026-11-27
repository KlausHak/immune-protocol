/**
 * [environment] Fits the sun's orthographic shadow camera to what the RTS camera actually sees:
 * the camera frustum's ground footprint (plus a height allowance) in light space → a tight box, sized in
 * coarse steps and texel-snapped so shadows don't shimmer while panning.
 */
import * as THREE from 'three';

const NDC: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, 1], [-1, 0], [1, 0]];

export class SunShadowFitter {
  /** max distance (world units) from the focus that the shadow box may cover */
  maxRadius = 64;
  /** how far toward the sun the light sits (casters up to this far are captured) */
  lightDistance = 160;
  private readonly x = new THREE.Vector3();
  private readonly y = new THREE.Vector3();
  private readonly z = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly pts: THREE.Vector3[] = Array.from({ length: NDC.length * 2 + 2 }, () => new THREE.Vector3());

  setSunDirection(dir: THREE.Vector3): void {
    this.z.copy(dir).normalize();
    const up = Math.abs(this.z.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    this.x.crossVectors(up, this.z).normalize();
    this.y.crossVectors(this.z, this.x).normalize();
  }

  fit(light: THREE.DirectionalLight, camera: THREE.PerspectiveCamera, focus: THREE.Vector3, casterHeight = 16): void {
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    camera.updateMatrixWorld();
    const groundY = focus.y;
    let n = 0;
    const add = (v: THREE.Vector3) => {
      const d = v.distanceTo(focus);
      if (d > this.maxRadius) v.sub(focus).multiplyScalar(this.maxRadius / d).add(focus);
      this.pts[n++]!.copy(v);
      this.pts[n++]!.set(v.x, v.y + casterHeight, v.z);
    };
    for (const [nx, ny] of NDC) {
      this.p.set(nx, ny, 0.5).unproject(camera);
      this.ray.origin.copy(camera.position);
      this.ray.direction.copy(this.p).sub(camera.position).normalize();
      const dy = this.ray.direction.y;
      let t = dy < -1e-4 ? (groundY - camera.position.y) / dy : Infinity;
      if (!Number.isFinite(t) || t < 0) t = this.maxRadius * 2;
      this.ray.at(t, this.c);
      this.c.y = groundY;
      add(this.c);
    }
    add(this.c.copy(focus));
    // light-space AABB
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = this.pts[i]!;
      const lx = v.dot(this.x), ly = v.dot(this.y);
      if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
    }
    // coarse size steps (stable while panning), then texel snap of the centre
    const step = 4;
    const halfW = Math.ceil(((maxX - minX) / 2 + 2) / step) * step;
    const halfH = Math.ceil(((maxY - minY) / 2 + 2) / step) * step;
    const size = light.shadow.mapSize;
    const texX = (2 * halfW) / size.x, texY = (2 * halfH) / size.y;
    const cx = Math.round(((minX + maxX) / 2) / texX) * texX;
    const cy = Math.round(((minY + maxY) / 2) / texY) * texY;
    const cz = focus.dot(this.z);
    this.c.copy(this.x).multiplyScalar(cx).addScaledVector(this.y, cy).addScaledVector(this.z, cz);
    light.target.position.copy(this.c);
    light.position.copy(this.c).addScaledVector(this.z, this.lightDistance);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    if (cam.left !== -halfW || cam.right !== halfW || cam.top !== halfH || cam.bottom !== -halfH || cam.far !== this.lightDistance + 120) {
      cam.left = -halfW; cam.right = halfW; cam.top = halfH; cam.bottom = -halfH;
      cam.near = 1; cam.far = this.lightDistance + 120;
      cam.updateProjectionMatrix();
    }
  }
}
