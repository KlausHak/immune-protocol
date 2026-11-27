/**
 * [map] Top-down 2D debug view of any registered map: /sandbox/map.html?map=meilahti
 * Params: map=<id> · px=<pixels per tile> · layers=terrain,shade,blocked,build,ramps,doodads,decals,caches,regions,points,slots,lanes
 *         (default: all except build) · build=1 adds the buildable overlay.
 */
import { Terrain, type Doodad, type DoodadKind, type MapData, type Vec2 } from '../src/core/types';
import { listMaps } from '../src/map';
import { DOODAD_SPECS } from '../src/map/builder';
import { cacheRect, formatReport, obstacleGrid, placePath, slotHqRect, validateMap, type ValidationReport } from '../src/map/validate';

const q = new URLSearchParams(location.search);
const maps = listMaps();
const info = maps.find((m) => m.id === (q.get('map') ?? 'meilahti')) ?? maps[0]!;
const t0 = performance.now();
const builder = info.builder?.();
const map: MapData = builder ? builder.finalize() : info.build();
const tBuild = performance.now() - t0;
const report: ValidationReport = builder ? builder.validate(map) : validateMap(map);
const tAll = performance.now() - t0;

const defaultLayers = ['terrain', 'shade', 'blocked', 'ramps', 'doodads', 'decals', 'caches', 'regions', 'points', 'slots', 'lanes'];
const layers = new Set((q.get('layers') ?? defaultLayers.join(',')).split(','));
if (q.get('build') === '1') layers.add('build');

const W = map.width, H = map.height;
const px = Number(q.get('px')) || Math.max(3, Math.floor((window.innerHeight - 8) / H));
const canvas = document.getElementById('map') as HTMLCanvasElement;
canvas.width = W * px; canvas.height = H * px;
const ctx = canvas.getContext('2d')!;

const TERRAIN_RGB: Record<number, [number, number, number]> = {
  [Terrain.Grass]: [79, 122, 58], [Terrain.Asphalt]: [58, 61, 66], [Terrain.Concrete]: [141, 144, 150],
  [Terrain.Plaza]: [165, 157, 143], [Terrain.Sand]: [201, 185, 138], [Terrain.Water]: [29, 79, 110],
  [Terrain.Dirt]: [107, 82, 54], [Terrain.Snow]: [232, 238, 242], [Terrain.Contaminated]: [93, 42, 107], [Terrain.Rock]: [119, 116, 111],
};

const hv = (vx: number, vy: number) => map.heights[vy * (W + 1) + vx]!;
const tileFlat = (tx: number, ty: number) => {
  const a = hv(tx, ty);
  return Math.abs(a - hv(tx + 1, ty)) < 0.3 && Math.abs(a - hv(tx, ty + 1)) < 0.3 && Math.abs(a - hv(tx + 1, ty + 1)) < 0.3;
};

// ── terrain + hillshade + level tint ──
const img = ctx.createImageData(W * px, H * px);
for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
  const i = ty * W + tx;
  const t = map.terrain[i]!;
  let [r, g, b] = layers.has('terrain') ? TERRAIN_RGB[t] ?? [90, 90, 90] : [70, 80, 70];
  let k = 1 + 0.13 * map.levels[i]!;
  if (layers.has('shade')) {
    const dx = (hv(tx + 1, ty) + hv(tx + 1, ty + 1) - hv(tx, ty) - hv(tx, ty + 1)) / 2;
    const dy = (hv(tx, ty + 1) + hv(tx + 1, ty + 1) - hv(tx, ty) - hv(tx + 1, ty)) / 2;
    k *= Math.min(1.5, Math.max(0.45, 1 - (dx + dy) * 0.55));
    if (t === Terrain.Water) k *= 0.75 + Math.max(0, Math.min(0.45, (map.heights[ty * (W + 1) + tx]! + 2.4) * 0.2));
  }
  r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k);
  for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) {
    const o = ((ty * px + yy) * W * px + tx * px + xx) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
}
ctx.putImageData(img, 0, 0);

const rect = (x: number, y: number, w: number, h: number, fill: string) => { ctx.fillStyle = fill; ctx.fillRect(x * px, y * px, w * px, h * px); };

// ── cliffs / blocked / buildable / ramps ──
for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
  const i = ty * W + tx;
  const water = map.terrain[i] === Terrain.Water;
  if (map.blocked[i] && !water && !map.ramps[i] && !tileFlat(tx, ty)) {
    rect(tx, ty, 1, 1, 'rgba(25,18,10,0.55)');
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(tx * px, ty * px + px / 2 - 0.5, px, 1);
  } else if (layers.has('blocked') && map.blocked[i] && !water) {
    rect(tx, ty, 1, 1, 'rgba(255,40,40,0.28)');
  }
  if (layers.has('build') && map.buildable[i]) rect(tx + 0.3, ty + 0.3, 0.4, 0.4, 'rgba(120,255,140,0.75)');
  if (layers.has('ramps') && map.ramps[i]) {
    rect(tx, ty, 1, 1, 'rgba(255,196,40,0.55)');
  }
}
if (layers.has('ramps')) {
  // uphill arrows at ramp centres (one per 2×2 block)
  ctx.strokeStyle = '#3a2a00'; ctx.lineWidth = 1.2;
  for (let ty = 0; ty < H; ty += 2) for (let tx = 0; tx < W; tx += 2) {
    if (!map.ramps[ty * W + tx]) continue;
    const gx = hv(tx + 1, ty) + hv(tx + 1, ty + 1) - hv(tx, ty) - hv(tx, ty + 1);
    const gy = hv(tx, ty + 1) + hv(tx + 1, ty + 1) - hv(tx, ty) - hv(tx + 1, ty);
    const l = Math.hypot(gx, gy); if (l < 1e-3) continue;
    const cx = (tx + 0.5) * px, cy = (ty + 0.5) * px, ux = (gx / l) * px * 0.7, uy = (gy / l) * px * 0.7;
    ctx.beginPath(); ctx.moveTo(cx - ux, cy - uy); ctx.lineTo(cx + ux, cy + uy);
    ctx.lineTo(cx + ux * 0.4 - uy * 0.5, cy + uy * 0.4 + ux * 0.5); ctx.moveTo(cx + ux, cy + uy); ctx.lineTo(cx + ux * 0.4 + uy * 0.5, cy + uy * 0.4 - ux * 0.5);
    ctx.stroke();
  }
}

// ── decals ──
if (layers.has('decals')) {
  for (const d of map.decals) {
    ctx.save();
    ctx.translate(d.pos.x * px, d.pos.y * px); ctx.rotate(d.rot);
    const w = d.size.x * px, h = d.size.y * px;
    switch (d.kind) {
      case 'road_line': ctx.fillStyle = 'rgba(255,255,230,0.85)'; ctx.fillRect(-w / 2, -Math.max(1, h) / 2, w, Math.max(1, h)); break;
      case 'crosswalk': {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (let s = -w / 2; s < w / 2; s += px * 0.6) ctx.fillRect(s, -h / 2, px * 0.3, h);
        break;
      }
      case 'parking_lines': {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
        for (let s = -w / 2; s <= w / 2 + 0.1; s += 1.5 * px) { ctx.beginPath(); ctx.moveTo(s, -h / 2); ctx.lineTo(s, h / 2); ctx.stroke(); }
        break;
      }
      case 'helipad_h': ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = `bold ${Math.round(h * 0.8)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', 0, 0); break;
      case 'medical_cross': ctx.fillStyle = 'rgba(47,214,198,0.9)'; ctx.fillRect(-w / 2, -h / 6, w, h / 3); ctx.fillRect(-w / 6, -h / 2, w / 3, h); break;
      case 'arrow': ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.fill(); break;
      case 'manhole': ctx.fillStyle = 'rgba(20,20,20,0.8)'; ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill(); break;
      case 'stain': ctx.fillStyle = 'rgba(160,40,200,0.3)'; ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); break;
    }
    ctx.restore();
  }
}

// ── doodads ──
const BUILDING_KINDS: DoodadKind[] = ['hospital_tower', 'hospital_wing', 'childrens_hospital', 'research_lab', 'parking_garage', 'old_laundry', 'water_tower', 'skybridge'];
const DOODAD_COLOR: Partial<Record<DoodadKind, string>> = {
  hospital_tower: '#efeae0', hospital_wing: '#e2ddd2', childrens_hospital: '#f3d9a6', research_lab: '#cfe3ea', parking_garage: '#b0b4ba',
  old_laundry: '#9a8270', water_tower: '#8fa3b0', skybridge: '#c8e8f0', ambulance: '#f4f4f4', bus: '#e0b020', helicopter_pad: '#45535e',
  street_lamp: '#ffe08a', bench: '#8b5a2b', bus_stop: '#5aa0d0', traffic_cone: '#ff7000', barrier: '#ff9040', fence: '#cfcfcf', sign_er: '#e04040',
  dumpster: '#3e6b4a', flag_pole: '#ffffff', tree_birch: '#d6e6a8', tree_pine: '#1f5a30', bush: '#3d8a3d', rock_granite: '#9a9790',
  snow_pile: '#ffffff', reeds: '#b5b56a', pier: '#8b6b4a', biohazard_barrel: '#f0d020', goo_puddle: '#80ff50', sewer_grate: '#222222',
  infected_growth: '#c040e0', spore_vent: '#9dff4a', waste_container: '#5a7a5a',
};
const drawDoodad = (d: Doodad) => {
  const spec = DOODAD_SPECS[d.kind];
  const w = spec.w * d.scale, h = spec.h * d.scale;
  ctx.save();
  ctx.translate(d.pos.x * px, d.pos.y * px);
  ctx.rotate(d.rot);
  let fill = DOODAD_COLOR[d.kind] ?? '#888';
  if (d.kind === 'car') fill = ['#c94b4b', '#4b7bc9', '#d8d8d8', '#2b2b2b', '#6a9a5a'][d.seed % 5]!;
  ctx.fillStyle = fill;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
  if (d.kind === 'tree_birch' || d.kind === 'tree_pine' || d.kind === 'bush' || d.kind === 'snow_pile' || d.kind === 'goo_puddle' || d.kind === 'reeds') {
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, w * px * 0.42), 0, Math.PI * 2); ctx.fill();
    if (d.kind.startsWith('tree')) ctx.stroke();
  } else if (d.kind === 'street_lamp' || d.kind === 'flag_pole') {
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, px * 0.28), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    ctx.fillRect((-w / 2) * px, (-h / 2) * px, w * px, h * px);
    ctx.strokeRect((-w / 2) * px, (-h / 2) * px, w * px, h * px);
    if (d.kind === 'ambulance') { ctx.fillStyle = '#2fd6c6'; ctx.fillRect((-w / 2) * px, -1, w * px, 2); }
    if (d.kind === 'helicopter_pad') { ctx.fillStyle = '#fff'; ctx.font = `bold ${px * 2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', 0, 1); }
  }
  ctx.restore();
};
if (layers.has('doodads')) {
  for (const d of map.doodads) if (!BUILDING_KINDS.includes(d.kind)) drawDoodad(d);
  for (const d of map.doodads) if (BUILDING_KINDS.includes(d.kind)) drawDoodad(d);
  ctx.font = `bold ${Math.max(9, px + 3)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const d of map.doodads) {
    if (!BUILDING_KINDS.includes(d.kind) || d.kind === 'skybridge') continue;
    ctx.fillStyle = '#111';
    ctx.fillText(d.kind === 'research_lab' ? 'Biomedicum' : d.kind.replace(/_/g, ' '), d.pos.x * px, d.pos.y * px);
  }
}

// ── caches ──
if (layers.has('caches')) {
  for (const r of map.resources) {
    const c = cacheRect(r.pos);
    rect(c.x + 0.1, c.y + 0.1, 1.8, 1.8, '#f2c14e');
    ctx.strokeStyle = '#5a3d00'; ctx.lineWidth = 1.5; ctx.strokeRect((c.x + 0.1) * px, (c.y + 0.1) * px, 1.8 * px, 1.8 * px);
  }
}

// ── regions, points, slots ──
const REGION_COLORS = ['#7fe3d6', '#ff9df0', '#ffd36e', '#9fc2ff', '#b6ff8a', '#ffab7a', '#e0b0ff', '#8affd8', '#ffef9a', '#ff8a8a', '#a8f0ff'];
const label = (text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') => {
  ctx.font = `bold ${Math.max(10, px + 4)}px sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
};
if (layers.has('regions')) {
  Object.entries(map.regions).forEach(([name, g], k) => {
    const col = REGION_COLORS[k % REGION_COLORS.length]!;
    ctx.setLineDash([6, 4]); ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.strokeRect(g.x * px, g.y * px, g.w * px, g.h * px);
    ctx.setLineDash([]);
    label(name, g.x * px + 3, g.y * px + 2, col);
  });
}
if (layers.has('lanes') && builder) {
  const obst = obstacleGrid(map);
  const colors = ['#ff5b5b', '#5bd0ff', '#ffe05b', '#c08bff'];
  builder.lanes().forEach((lane, k) => {
    const stops = [lane.from ?? 'slot1', ...lane.via, lane.to ?? 'slot2'];
    ctx.strokeStyle = colors[k % colors.length]!; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let s = 0; s + 1 < stops.length; s++) {
      const path = placePath(map, obst, stops[s]!, stops[s + 1]!);
      path?.forEach((p: Vec2, i: number) => (i === 0 && s === 0 ? ctx.moveTo(p.x * px, p.y * px) : ctx.lineTo(p.x * px, p.y * px)));
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  });
}
if (layers.has('points')) {
  for (const [name, p] of Object.entries(map.points)) {
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x * px, p.y * px, Math.max(3, px * 0.55), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    label(name, p.x * px + 6, p.y * px + 3, '#ffffff');
  }
}
if (layers.has('slots')) {
  for (const s of map.slots) {
    const r = slotHqRect(s);
    const col = s.faction === 'hospital' ? '#2fd6c6' : '#d64bff';
    if (r) { ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.strokeRect(r.x * px, r.y * px, r.w * px, r.h * px); }
    label(`P${s.id} ${s.faction}`, s.start.x * px, (s.start.y + 3) * px, col, 'center');
  }
}

// ── side panel ──
document.getElementById('title')!.textContent = `${map.name} (${map.id}) — ${W}×${H}, lighting ${map.lighting}, waterLevel ${map.waterLevel}`;
const legend: Array<[string, string]> = [
  ['#4f7a3a', 'grass'], ['#3a3d42', 'asphalt'], ['#8d9096', 'concrete'], ['#a59d8f', 'plaza'], ['#e8eef2', 'snow'], ['#5d2a6b', 'contaminated'],
  ['#77746f', 'rock'], ['#1d4f6e', 'water'], ['rgba(255,196,40,0.9)', 'ramp'], ['rgba(25,18,10,0.9)', 'cliff'], ['rgba(255,40,40,0.5)', 'blocked'],
  ['#78ff8c', 'buildable (build=1)'], ['#f2c14e', 'supply cache'],
];
document.getElementById('legend')!.innerHTML = legend.map(([c, n]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
const pre = document.getElementById('report')!;
pre.className = report.ok ? 'ok' : 'err';
pre.textContent = `${formatReport(report)}\n\nbuild ${tBuild.toFixed(0)} ms · build+validate ${tAll.toFixed(0)} ms\n` +
  `regions: ${Object.keys(map.regions).join(', ')}\npoints: ${Object.keys(map.points).join(', ')}\n` +
  `maps: ${maps.map((m) => m.id).join(', ')}`;
(window as unknown as { __mapReport: ValidationReport; __mapReady: boolean }).__mapReport = report;
(window as unknown as { __mapReady: boolean }).__mapReady = true;
