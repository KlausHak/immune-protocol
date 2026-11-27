/**
 * [ui] Animated 2D title-screen backdrop: Nordic-dusk sky over the sea bay, a stylised silhouette of the
 * hospital campus (tower with the teal "+", wings, skybridge, Biomedicum, old laundry chimney leaking a
 * faint magenta plume, water tower, birches), drifting translucent microbes, light snow and a monitor-style
 * ECG sweep. The static scene is pre-rendered on resize; each frame is one drawImage + a few dozen sprites.
 */

interface Microbe { sprite: number; x: number; y: number; z: number; vx: number; vy: number; rot: number; vr: number; phase: number }
interface Flake { x: number; y: number; r: number; v: number; drift: number }

/** Small seeded PRNG (visual only — this is UI, not the sim). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ECG waveform: one heartbeat over phase 0..1 → vertical offset (-1 = up). */
function beat(p: number): number {
  if (p < 0.1) return 0;
  if (p < 0.18) return -0.09 * Math.sin(((p - 0.1) / 0.08) * Math.PI);
  if (p < 0.24) return 0;
  if (p < 0.26) return ((p - 0.24) / 0.02) * 0.12;
  if (p < 0.29) return 0.12 - ((p - 0.26) / 0.03) * 1.12;
  if (p < 0.32) return -1 + ((p - 0.29) / 0.03) * 1.38;
  if (p < 0.35) return 0.38 - ((p - 0.32) / 0.03) * 0.38;
  if (p < 0.46) return 0;
  if (p < 0.6) return -0.22 * Math.sin(((p - 0.46) / 0.14) * Math.PI);
  return 0;
}

export class MenuBackground {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: HTMLCanvasElement | null = null;
  private sprites: HTMLCanvasElement[] = [];
  private microbes: Microbe[] = [];
  private flakes: Flake[] = [];
  private raf = 0;
  private running = false;
  private last = 0;
  private t = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private ecgHead = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ip-menu-bg';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.buildSprites();
    const rnd = mulberry(77);
    for (let i = 0; i < 26; i++) {
      this.microbes.push({
        sprite: i % this.sprites.length, x: rnd(), y: rnd(), z: 0.35 + rnd() * 1.25,
        vx: 0.004 + rnd() * 0.01, vy: -0.002 - rnd() * 0.006, rot: rnd() * Math.PI * 2, vr: (rnd() - 0.5) * 0.4, phase: rnd() * 10,
      });
    }
    this.microbes.sort((a, b) => a.z - b.z);
    for (let i = 0; i < 70; i++) this.flakes.push({ x: rnd(), y: rnd(), r: 0.6 + rnd() * 1.4, v: 0.012 + rnd() * 0.025, drift: rnd() * 6 });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this.resize);
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
  }

  dispose(): void { this.stop(); this.canvas.remove(); this.scene = null; }

  private resize = (): void => {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.round(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(240, Math.round(this.canvas.clientHeight || window.innerHeight));
    if (w === this.w && h === this.h && dpr === this.dpr && this.scene) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scene = this.renderScene(Math.round(w * dpr), Math.round(h * dpr));
  };

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.t += dt;
    this.draw(dt);
  };

  // ───────────────────────── static scene ─────────────────────────
  private renderScene(W: number, H: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const horizon = H * 0.74;
    // sky
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#03070f');
    sky.addColorStop(0.42, '#0a1730');
    sky.addColorStop(0.72, '#28213f');
    sky.addColorStop(0.9, '#6b3646');
    sky.addColorStop(1, '#c4673a');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon + 2);
    // low sun glow behind the campus
    const sx = W * 0.7, sy = horizon + H * 0.02;
    const sun = g.createRadialGradient(sx, sy, 0, sx, sy, H * 0.55);
    sun.addColorStop(0, 'rgba(255,170,90,0.55)');
    sun.addColorStop(0.25, 'rgba(230,110,80,0.22)');
    sun.addColorStop(1, 'rgba(120,40,90,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, horizon + 2);
    // stars
    const rnd = mulberry(5);
    for (let i = 0; i < 140; i++) {
      const x = rnd() * W, y = rnd() * horizon * 0.55, r = (rnd() * 0.9 + 0.3) * (H / 900);
      g.fillStyle = `rgba(220,235,255,${0.15 + rnd() * 0.5})`;
      g.fillRect(x, y, r * 1.6, r * 1.6);
    }
    // thin aurora-like teal veil
    const veil = g.createLinearGradient(0, H * 0.12, 0, H * 0.4);
    veil.addColorStop(0, 'rgba(53,226,208,0)');
    veil.addColorStop(0.5, 'rgba(53,226,208,0.06)');
    veil.addColorStop(1, 'rgba(53,226,208,0)');
    g.fillStyle = veil;
    g.beginPath();
    g.moveTo(0, H * 0.3);
    g.bezierCurveTo(W * 0.3, H * 0.12, W * 0.6, H * 0.36, W, H * 0.18);
    g.lineTo(W, H * 0.3); g.bezierCurveTo(W * 0.6, H * 0.46, W * 0.3, H * 0.22, 0, H * 0.4);
    g.fill();
    // sea (west bay) with sun reflection
    const sea = g.createLinearGradient(0, horizon, 0, H);
    sea.addColorStop(0, '#1b2236');
    sea.addColorStop(1, '#03060b');
    g.fillStyle = sea;
    g.fillRect(0, horizon, W, H - horizon);
    for (let i = 0; i < 90; i++) {
      const y = horizon + Math.pow(rnd(), 1.6) * (H - horizon);
      const len = (20 + rnd() * 120) * (H / 900);
      const x = sx + (rnd() - 0.5) * W * 0.5 * (1 - (y - horizon) / (H - horizon) * 0.3);
      g.fillStyle = `rgba(255,170,110,${0.05 + rnd() * 0.12})`;
      g.fillRect(x, y, len, Math.max(1, H / 900));
    }
    // far shore + forest band
    const far = (x: number) => horizon - H * (0.018 + 0.012 * Math.sin(x / W * 9) + 0.006 * Math.sin(x / W * 31));
    g.fillStyle = '#151b2e';
    g.beginPath(); g.moveTo(0, horizon);
    for (let x = 0; x <= W; x += 6) g.lineTo(x, far(x));
    g.lineTo(W, horizon); g.closePath(); g.fill();

    // campus silhouette (right 62%)
    const S = H / 900;                      // scene scale
    const base = horizon + H * 0.035;       // ground line of the campus
    const ink = '#060a12';
    const ground = g.createLinearGradient(0, base - H * 0.02, 0, H);
    ground.addColorStop(0, '#070b13');
    ground.addColorStop(1, '#020407');
    g.fillStyle = ground;
    g.beginPath();
    g.moveTo(W * 0.36, H);
    g.bezierCurveTo(W * 0.4, base + H * 0.01, W * 0.44, base, W * 0.5, base);
    g.lineTo(W, base); g.lineTo(W, H); g.closePath(); g.fill();

    const windows = (x: number, y: number, w: number, h: number, cols: number, rows: number, warm = 0.5) => {
      const cw = w / cols, rh = h / rows;
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
        const v = rnd();
        if (v > 0.62) continue;
        g.fillStyle = v < 0.08 ? 'rgba(127,245,230,0.75)' : v < warm ? `rgba(255,206,122,${0.45 + rnd() * 0.45})` : 'rgba(255,214,150,0.18)';
        g.fillRect(x + k * cw + cw * 0.25, y + r * rh + rh * 0.3, cw * 0.5, rh * 0.42);
      }
    };
    const block = (x: number, w: number, h: number, cols: number, rows: number, warm = 0.45) => {
      g.fillStyle = ink;
      g.fillRect(x, base - h, w, h);
      windows(x + w * 0.04, base - h + h * 0.06, w * 0.92, h * 0.86, cols, rows, warm);
      g.fillStyle = 'rgba(160,190,220,0.08)';
      g.fillRect(x, base - h, w, Math.max(1, 2 * S));
    };
    // Biomedicum (research lab) with curved roof
    g.fillStyle = ink;
    const bx = W * 0.47, bw = W * 0.12, bh = H * 0.11;
    g.beginPath(); g.moveTo(bx, base); g.lineTo(bx, base - bh); g.quadraticCurveTo(bx + bw / 2, base - bh - H * 0.05, bx + bw, base - bh); g.lineTo(bx + bw, base); g.fill();
    windows(bx + bw * 0.05, base - bh + H * 0.01, bw * 0.9, bh * 0.85, 9, 5, 0.5);
    // main tower with the teal plus
    const tx = W * 0.62, tw = W * 0.085, th = H * 0.3;
    block(tx, tw, th, 7, 14, 0.5);
    block(tx - W * 0.075, W * 0.075, H * 0.14, 6, 6);
    block(tx + tw, W * 0.1, H * 0.12, 8, 5);
    // skybridge to the east wing
    g.fillStyle = ink;
    g.fillRect(tx + tw + W * 0.1, base - H * 0.095, W * 0.05, H * 0.022);
    windows(tx + tw + W * 0.1, base - H * 0.094, W * 0.05, H * 0.02, 6, 1, 0.7);
    block(tx + tw + W * 0.15, W * 0.075, H * 0.16, 6, 7);
    // rooftop plus sign (hospital logo: white plus on teal)
    const px = tx + tw / 2, py = base - th - H * 0.045, ps = H * 0.034;
    g.save();
    g.shadowColor = 'rgba(53,226,208,0.9)'; g.shadowBlur = 24 * S;
    g.fillStyle = '#20c9b8';
    g.beginPath(); g.roundRect(px - ps / 2, py - ps / 2, ps, ps, ps * 0.22); g.fill();
    g.restore();
    g.fillStyle = '#f2fffd';
    g.fillRect(px - ps * 0.32, py - ps * 0.09, ps * 0.64, ps * 0.18);
    g.fillRect(px - ps * 0.09, py - ps * 0.32, ps * 0.18, ps * 0.64);
    g.fillStyle = ink;
    g.fillRect(px - 1.5 * S, py + ps / 2, 3 * S, base - th - (py + ps / 2));
    // old laundry + chimney with a faint infected plume (north, far right)
    const lx = W * 0.86;
    block(lx, W * 0.09, H * 0.085, 7, 3, 0.25);
    g.fillStyle = ink;
    g.fillRect(lx + W * 0.06, base - H * 0.2, W * 0.012, H * 0.12);
    const plume = g.createRadialGradient(lx + W * 0.066, base - H * 0.24, 0, lx + W * 0.07, base - H * 0.28, H * 0.12);
    plume.addColorStop(0, 'rgba(214,75,255,0.32)');
    plume.addColorStop(0.5, 'rgba(157,255,74,0.08)');
    plume.addColorStop(1, 'rgba(214,75,255,0)');
    g.fillStyle = plume;
    g.beginPath(); g.ellipse(lx + W * 0.075, base - H * 0.28, W * 0.05, H * 0.09, -0.4, 0, Math.PI * 2); g.fill();
    // water tower
    const wx = W * 0.965;
    g.fillStyle = ink;
    g.fillRect(wx - 1.5 * S, base - H * 0.12, 3 * S, H * 0.12);
    g.fillRect(wx - W * 0.012, base - H * 0.12, 2 * S, H * 0.12);
    g.fillRect(wx + W * 0.01, base - H * 0.12, 2 * S, H * 0.12);
    g.beginPath(); g.roundRect(wx - W * 0.018, base - H * 0.165, W * 0.036, H * 0.05, 6 * S); g.fill();
    // birches & pines along the park
    const tree = (x: number, h: number, pine: boolean) => {
      g.fillStyle = ink;
      if (pine) {
        g.beginPath(); g.moveTo(x, base - h); g.lineTo(x - h * 0.22, base - h * 0.05); g.lineTo(x + h * 0.22, base - h * 0.05); g.fill();
      } else {
        g.fillRect(x - 1 * S, base - h * 0.55, 2 * S, h * 0.55);
        g.beginPath(); g.ellipse(x, base - h * 0.62, h * 0.16, h * 0.36, 0, 0, Math.PI * 2); g.fill();
      }
    };
    for (let i = 0; i < 26; i++) {
      const x = W * (0.42 + rnd() * 0.58), hh = H * (0.035 + rnd() * 0.05);
      tree(x, hh, rnd() < 0.35);
    }
    // street lamps (warm glows)
    for (let i = 0; i < 9; i++) {
      const x = W * (0.5 + i * 0.055 + rnd() * 0.01), y = base - H * 0.04;
      g.fillStyle = ink;
      g.fillRect(x - 0.8 * S, y, 1.6 * S, H * 0.04);
      const lg = g.createRadialGradient(x, y, 0, x, y, H * 0.03);
      lg.addColorStop(0, 'rgba(255,200,120,0.85)');
      lg.addColorStop(1, 'rgba(255,170,90,0)');
      g.fillStyle = lg;
      g.fillRect(x - H * 0.03, y - H * 0.03, H * 0.06, H * 0.06);
    }
    // low mist over the ground
    const mist = g.createLinearGradient(0, base - H * 0.05, 0, base + H * 0.06);
    mist.addColorStop(0, 'rgba(120,140,190,0)');
    mist.addColorStop(0.5, 'rgba(120,140,190,0.10)');
    mist.addColorStop(1, 'rgba(120,140,190,0)');
    g.fillStyle = mist;
    g.fillRect(0, base - H * 0.05, W, H * 0.11);
    return c;
  }

  // ───────────────────────── sprites ─────────────────────────
  private buildSprites(): void {
    const mk = (size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d')!;
      g.translate(size / 2, size / 2);
      draw(g, size);
      this.sprites.push(c);
    };
    const glow = (g: CanvasRenderingContext2D, col: string, blur: number) => { g.shadowColor = col; g.shadowBlur = blur; };
    // virus (magenta, spiked)
    mk(128, (g) => {
      glow(g, 'rgba(214,75,255,0.9)', 16);
      g.strokeStyle = 'rgba(240,150,255,0.85)'; g.lineWidth = 3;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        g.beginPath(); g.moveTo(Math.cos(a) * 26, Math.sin(a) * 26); g.lineTo(Math.cos(a) * 40, Math.sin(a) * 40); g.stroke();
        g.fillStyle = 'rgba(168,255,79,0.9)'; g.beginPath(); g.arc(Math.cos(a) * 41, Math.sin(a) * 41, 3.6, 0, Math.PI * 2); g.fill();
      }
      const body = g.createRadialGradient(-8, -8, 2, 0, 0, 28);
      body.addColorStop(0, 'rgba(255,170,240,0.75)'); body.addColorStop(1, 'rgba(140,30,170,0.35)');
      g.fillStyle = body; g.beginPath(); g.arc(0, 0, 27, 0, Math.PI * 2); g.fill();
    });
    // bacillus (acid green rod)
    mk(128, (g) => {
      glow(g, 'rgba(157,255,74,0.8)', 14);
      g.rotate(-0.5);
      const grd = g.createLinearGradient(0, -14, 0, 14);
      grd.addColorStop(0, 'rgba(200,255,140,0.6)'); grd.addColorStop(1, 'rgba(80,170,30,0.3)');
      g.fillStyle = grd; g.strokeStyle = 'rgba(190,255,120,0.8)'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(-42, -14, 84, 28, 14); g.fill(); g.stroke();
      g.fillStyle = 'rgba(220,255,170,0.7)';
      for (const [x, y, r] of [[-20, -2, 4], [2, 4, 3], [22, -3, 3.5]] as const) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    });
    // spirochete (corkscrew)
    mk(128, (g) => {
      glow(g, 'rgba(214,75,255,0.8)', 12);
      g.strokeStyle = 'rgba(230,140,255,0.8)'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath();
      for (let x = -50; x <= 50; x += 2) { const y = Math.sin(x / 8) * 9; if (x === -50) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    });
    // spore (soft round with dots)
    mk(96, (g) => {
      glow(g, 'rgba(157,255,74,0.7)', 14);
      const grd = g.createRadialGradient(-6, -6, 2, 0, 0, 24);
      grd.addColorStop(0, 'rgba(210,255,160,0.6)'); grd.addColorStop(1, 'rgba(90,170,40,0.2)');
      g.fillStyle = grd; g.beginPath(); g.arc(0, 0, 22, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(200,255,150,0.6)'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = 'rgba(230,255,200,0.75)';
      for (const [x, y, r] of [[-7, -4, 3], [6, 5, 2.4], [5, -8, 1.8]] as const) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    });
    // phage (hex head + legs)
    mk(112, (g) => {
      glow(g, 'rgba(240,120,255,0.8)', 12);
      g.strokeStyle = 'rgba(245,200,255,0.85)'; g.lineWidth = 2.5; g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI * 2; const x = Math.cos(a) * 16, y = -18 + Math.sin(a) * 16; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.fillStyle = 'rgba(214,75,255,0.35)'; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(0, -2); g.lineTo(0, 20); g.stroke();
      g.strokeStyle = 'rgba(168,255,79,0.8)';
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(0, 20); g.lineTo(s * 16, 30); g.lineTo(s * 20, 42); g.stroke(); g.beginPath(); g.moveTo(0, 20); g.lineTo(s * 7, 32); g.lineTo(s * 8, 44); g.stroke(); }
    });
  }

  // ───────────────────────── per frame ─────────────────────────
  private draw(dt: number): void {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    if (!this.scene) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.scene, 0, 0);

    // microbes (depth-sorted, back ones smaller & fainter)
    const S = H / 900;
    for (const m of this.microbes) {
      m.x += m.vx * dt * m.z; m.y += m.vy * dt * m.z; m.rot += m.vr * dt;
      if (m.x > 1.08) m.x = -0.08;
      if (m.y < -0.1) { m.y = 1.05; m.x = Math.random(); }
      const sp = this.sprites[m.sprite]!;
      const sc = 0.42 * m.z * S;
      const x = m.x * W + Math.sin(this.t * 0.6 + m.phase) * 12 * S, y = m.y * H + Math.cos(this.t * 0.45 + m.phase) * 8 * S;
      ctx.globalAlpha = Math.min(0.75, 0.12 + m.z * 0.32);
      ctx.setTransform(sc, 0, 0, sc, x, y);
      ctx.rotate(m.rot);
      ctx.drawImage(sp, -sp.width / 2, -sp.height / 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // snow
    ctx.fillStyle = 'rgba(230,240,255,0.55)';
    for (const f of this.flakes) {
      f.y += f.v * dt; if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
      const x = (f.x + Math.sin(this.t * 0.5 + f.drift) * 0.004) * W, y = f.y * H;
      ctx.globalAlpha = 0.35 + 0.3 * Math.sin(this.t + f.drift);
      ctx.fillRect(x, y, f.r * S * 1.4, f.r * S * 1.4);
    }
    ctx.globalAlpha = 1;

    // ECG sweep across the sky
    const period = 230 * S;
    const speed = W / 3.4;
    this.ecgHead = (this.ecgHead + speed * dt) % (W + W * 0.5);
    const head = this.ecgHead, tail = W * 0.5;
    const y0 = H * 0.565, amp = H * 0.075;
    const drawSeg = (from: number, to: number) => {
      if (to <= from) return;
      const grad = ctx.createLinearGradient(head - tail, 0, head, 0);
      grad.addColorStop(0, 'rgba(53,226,208,0)');
      grad.addColorStop(0.85, 'rgba(53,226,208,0.55)');
      grad.addColorStop(1, 'rgba(200,255,250,0.95)');
      ctx.beginPath();
      for (let x = from; x <= to; x += 2) {
        const y = y0 + beat(((x / period) % 1 + 1) % 1) * amp;
        if (x === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5 * S;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.lineWidth = 1.8 * S;
      ctx.globalAlpha = 1;
      ctx.stroke();
    };
    drawSeg(Math.max(0, Math.floor(head - tail)), Math.min(W, Math.floor(head)));
    if (head <= W) {
      const hy = y0 + beat(((head / period) % 1 + 1) % 1) * amp;
      const dot = ctx.createRadialGradient(head, hy, 0, head, hy, 14 * S);
      dot.addColorStop(0, 'rgba(230,255,252,1)');
      dot.addColorStop(1, 'rgba(53,226,208,0)');
      ctx.fillStyle = dot;
      ctx.fillRect(head - 14 * S, hy - 14 * S, 28 * S, 28 * S);
    }
  }
}
