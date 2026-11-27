/**
 * [render-core] Batched screen-space bars drawn in an overlay pass after post-processing (exact UI colours,
 * no tone mapping/bloom): segmented health bars with a damage trail, construction/production progress bars,
 * resource amount bars and the shield-shaped cargo pip for carrying workers. One draw call; quads are
 * pixel-snapped on the CPU and shaded by an SDF/pixel shader.
 */
import * as THREE from 'three';

export const BarKind = { Health: 0, Progress: 1, Cargo: 2 } as const;
/** item sizes of [position, aUv, aSize, aData, aColor] */
const ATTR_SIZES = [3, 2, 2, 4, 4] as const;

const VERT = /* glsl */`
attribute vec2 aUv;
attribute vec2 aSize;
attribute vec4 aData;
attribute vec4 aColor;
uniform vec2 uResolution;
varying vec2 vUv;
varying vec2 vSize;
varying vec4 vData;
varying vec4 vColor;
void main() {
  vUv = aUv; vSize = aSize; vData = aData; vColor = aColor;
  vec2 ndc = vec2(position.x / uResolution.x * 2.0 - 1.0, 1.0 - position.y / uResolution.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec2 vSize;
varying vec4 vData;   // x: fill 0..1, y: segments, z: kind, w: trail (health) / shimmer (progress)
varying vec4 vColor;  // rgb fill, a = opacity
void main() {
  float kind = vData.z;
  vec2 px = vUv * vSize;
  vec3 col;
  float alpha = vColor.a;
  if (kind < 1.5) {
    bool edge = px.x < 1.0 || px.y < 1.0 || px.x > vSize.x - 1.0 || px.y > vSize.y - 1.0;
    vec2 inner = vec2(max(vSize.x - 2.0, 1.0), max(vSize.y - 2.0, 1.0));
    vec2 ip = (px - 1.0) / inner;
    vec3 bg = vec3(0.018, 0.026, 0.03);
    if (edge) {
      col = vec3(0.0);
    } else if (ip.x <= vData.x) {
      col = vColor.rgb * mix(1.22, 0.72, ip.y);
      if (ip.y < 0.34) col = mix(col, vec3(1.0), 0.16);
      if (kind < 0.5) {
        float segs = vData.y;
        if (segs > 1.0) {
          float segW = inner.x / segs;
          if (mod(px.x - 1.0, segW) < 1.0 && px.x > 1.5) col *= 0.3;
        }
      } else if (vData.w > 0.5) {
        float s = fract(ip.x * 1.5 - uTime * 0.6);
        col += vec3(0.22) * smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.12, 0.3, s));
      }
    } else if (kind < 0.5 && ip.x <= vData.w) {
      col = vec3(0.95, 0.88, 0.8) * mix(1.0, 0.75, ip.y);
    } else {
      col = bg;
    }
  } else {
    // cargo pip: shield with a dark outline, y grows downward
    vec2 p = vUv * 2.0 - 1.0;
    float hw = p.y < -0.1 ? 0.8 : 0.8 * sqrt(max(0.0, 1.0 - (p.y + 0.1) / 1.05));
    float d = max(abs(p.x) - hw, abs(p.y + 0.02) - 0.94);
    float aa = max(fwidth(d), 1e-3);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float edgeB = smoothstep(-0.3 - aa, -0.3 + aa, d);
    col = mix(vColor.rgb * mix(1.25, 0.75, vUv.y), vec3(0.02, 0.02, 0.02), edgeB);
    if (p.y < -0.35 && p.x < 0.0 && d < -0.3) col = mix(col, vec3(1.0), 0.35);
    alpha *= inside;
  }
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}`;

export class HealthBars {
  readonly scene = new THREE.Scene();
  /** unused by the shader (positions are already in pixels) but required by renderer.render */
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private geo!: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private capacity = 0;
  private count = 0;
  private pos!: Float32Array;
  private uv!: Float32Array;
  private size!: Float32Array;
  private data!: Float32Array;
  private color!: Float32Array;
  private attrs: THREE.BufferAttribute[] = [];
  private pr = 1;

  constructor(initialCapacity = 256) {
    this.mat = new THREE.ShaderMaterial({
      name: 'HealthBars', vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uResolution: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 } },
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.allocate(initialCapacity);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }

  private allocate(capacity: number): void {
    const old = this.geo;
    const n = capacity * 4;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), size = new Float32Array(n * 2);
    const data = new Float32Array(n * 4), color = new Float32Array(n * 4);
    if (old) { pos.set(this.pos); uv.set(this.uv); size.set(this.size); data.set(this.data); color.set(this.color); }
    this.pos = pos; this.uv = uv; this.size = size; this.data = data; this.color = color;
    const idx = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4, i = q * 6;
      // pixel space has y down, so this winding is counter-clockwise in NDC
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1; idx[i + 3] = v; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
    }
    const geo = new THREE.BufferGeometry();
    const mk = (arr: Float32Array, s: number) => { const a = new THREE.BufferAttribute(arr, s); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.attrs = [mk(pos, 3), mk(uv, 2), mk(size, 2), mk(data, 4), mk(color, 4)];
    geo.setAttribute('position', this.attrs[0]!);
    geo.setAttribute('aUv', this.attrs[1]!);
    geo.setAttribute('aSize', this.attrs[2]!);
    geo.setAttribute('aData', this.attrs[3]!);
    geo.setAttribute('aColor', this.attrs[4]!);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.capacity = capacity;
    if (old) { this.mesh.geometry = geo; old.dispose(); }
  }

  /** Start a frame. width/height in CSS px. */
  begin(width: number, height: number, pixelRatio: number): void {
    this.count = 0;
    this.pr = pixelRatio;
    (this.mat.uniforms.uResolution!.value as THREE.Vector2).set(Math.max(1, width), Math.max(1, height));
  }

  private snap(v: number): number { return Math.round(v * this.pr) / this.pr; }

  /**
   * Push one bar/pip. (x, y) = top-left in CSS px, w/h in CSS px. fill 0..1; segments (health only);
   * extra = trail fraction (health) or shimmer flag (progress). col = linear colour.
   */
  push(kind: number, x: number, y: number, w: number, h: number, fill: number, segments: number, extra: number, col: THREE.Color, alpha = 1): void {
    if (this.count >= this.capacity) {
      let c = this.capacity; while (c <= this.count) c *= 2;
      this.allocate(c);
    }
    const q = this.count++;
    const x0 = this.snap(x), y0 = this.snap(y), x1 = this.snap(x + w), y1 = this.snap(y + h);
    const sw = x1 - x0, sh = y1 - y0;
    for (let k = 0; k < 4; k++) {
      const v = q * 4 + k;
      const right = k === 1 || k === 2, bottom = k >= 2;
      this.pos[v * 3] = right ? x1 : x0; this.pos[v * 3 + 1] = bottom ? y1 : y0; this.pos[v * 3 + 2] = 0;
      this.uv[v * 2] = right ? 1 : 0; this.uv[v * 2 + 1] = bottom ? 1 : 0;
      this.size[v * 2] = sw; this.size[v * 2 + 1] = sh;
      this.data[v * 4] = fill; this.data[v * 4 + 1] = segments; this.data[v * 4 + 2] = kind; this.data[v * 4 + 3] = extra;
      this.color[v * 4] = col.r; this.color[v * 4 + 1] = col.g; this.color[v * 4 + 2] = col.b; this.color[v * 4 + 3] = alpha;
    }
  }

  end(time: number): void {
    this.mat.uniforms.uTime!.value = time;
    const n = this.count * 4;
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i]!;
      a.clearUpdateRanges();
      if (n > 0) { a.addUpdateRange(0, n * ATTR_SIZES[i]!); a.needsUpdate = true; }
    }
    this.geo.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
  }

  get barCount(): number { return this.count; }

  /** Draw the overlay on top of whatever is in the canvas. */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.count === 0) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
