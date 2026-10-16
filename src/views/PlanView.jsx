import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FLOOR_HEIGHT, PARAPET, floorFitout } from '../geometry/generateTower.js';

const TICK_PX = 4;
const SCALE_STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500];

export function useElementSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function niceScaleLength(pxPerMetre, targetPx) {
  let best = SCALE_STEPS[0];
  for (const s of SCALE_STEPS) if (s * pxPerMetre <= targetPx) best = s;
  return best;
}

const n1 = (v) => v.toFixed(1);

/*
 * Furniture symbols. Each item is drawn in its own frame: u along `rot`
 * (width w), v perpendicular (depth d), centred on (x, y). R() is a rectangle
 * and C() a circle in that frame; both return SVG path data in screen space.
 */
function furniturePath(it, X, Y, s) {
  const c = Math.cos(it.rot);
  const sn = Math.sin(it.rot);
  const P = (u, v) => `${n1(X(it.x + u * c - v * sn))},${n1(Y(it.y + u * sn + v * c))}`;
  const R = (u, v, w, d) =>
    `M${P(u - w / 2, v - d / 2)}L${P(u + w / 2, v - d / 2)}L${P(u + w / 2, v + d / 2)}L${P(u - w / 2, v + d / 2)}Z`;
  const C = (u, v, r) => {
    const x = X(it.x + u * c - v * sn);
    const y = Y(it.y + u * sn + v * c);
    const rp = Math.max(0.6, r * s);
    return `M${n1(x - rp)},${n1(y)}a${n1(rp)},${n1(rp)} 0 1,0 ${n1(2 * rp)},0a${n1(rp)},${n1(rp)} 0 1,0 ${n1(-2 * rp)},0`;
  };
  const L = (u0, v0, u1, v1) => `M${P(u0, v0)}L${P(u1, v1)}`;
  const { w, d } = it;
  switch (it.type) {
    case 'bed':
      return R(0, 0, w, d) + R(-w / 4, d / 2 - 0.3, w / 2 - 0.12, 0.34) + R(w / 4, d / 2 - 0.3, w / 2 - 0.12, 0.34) + L(-w / 2, d / 2 - 0.75, w / 2, d / 2 - 0.75);
    case 'sofa':
      return R(0, 0, w, d) + R(0, d / 2 - 0.12, w, 0.24) + R(-w / 2 + 0.12, 0, 0.24, d) + R(w / 2 - 0.12, 0, 0.24, d);
    case 'coffee':
    case 'reception':
      return R(0, 0, w, d) + (it.type === 'reception' ? R(0, 0, w - 0.4, d - 0.5) : '');
    case 'dining':
      return R(0, 0, w, d) + [-w / 4, w / 4].map((u) => R(u, d / 2 + 0.3, 0.44, 0.4) + R(u, -d / 2 - 0.3, 0.44, 0.4)).join('');
    case 'counter':
      return R(0, 0, w, d) + C(w / 4, 0, 0.2) + C(-w / 4, -0.12, 0.1) + C(-w / 4 + 0.3, 0.12, 0.1);
    case 'bathroom':
      return R(0, 0, w, d) + C(-w / 4, d / 2 - 0.5, 0.2) + R(-w / 4, d / 2 - 0.14, 0.42, 0.22) + R(w / 4, d / 2 - 0.28, 0.5, 0.36) + R(w / 4, -d / 4, w / 2 - 0.15, d / 2 - 0.15) + L(w / 4 - w / 4 + 0.08, -d / 2 + 0.08, w / 2 - 0.08, -0.08);
    case 'desks':
      return [-0.8, 0.8].map((u) => R(u, -0.4, 1.5, 0.75) + R(u, 0.4, 1.5, 0.75) + C(u, -1.15, 0.26) + C(u, 1.15, 0.26)).join('');
    case 'meeting': {
      let p = R(0, 0, w, d);
      const n = Math.max(2, Math.floor(w / 0.8));
      for (let k = 0; k < n; k++) {
        const u = -w / 2 + (w * (k + 0.5)) / n;
        p += C(u, d / 2 + 0.38, 0.24) + C(u, -d / 2 - 0.38, 0.24);
      }
      return p;
    }
    case 'lounge':
      return R(0, d / 2 - 0.45, w * 0.75, 0.85) + R(0, d / 2 - 0.15, w * 0.75, 0.24) + R(-w / 2 + 0.2, -0.2, 0.8, 0.8) + R(w / 2 - 0.2, -0.2, 0.8, 0.8) + R(0, -0.15, 1.1, 0.6);
    case 'plant':
      return C(0, 0, w / 2) + C(0, 0, w / 4);
    case 'ahu':
      return R(0, 0, w, d) + L(-w / 2, -d / 2, w / 2, d / 2) + L(-w / 2, d / 2, w / 2, -d / 2);
    default:
      return R(0, 0, w, d);
  }
}

/** Plan-view person: head + shoulders, ~0.55 m across. */
function personPath(p, X, Y, s) {
  const it = { x: p.x, y: p.y, rot: p.rot, w: 0.55, d: 0.3, type: 'person' };
  const r = Math.max(1, 0.2 * s);
  return furniturePath(it, X, Y, s) + `M${n1(X(p.x) - r)},${n1(Y(p.y))}a${n1(r)},${n1(r)} 0 1,0 ${n1(2 * r)},0a${n1(r)},${n1(r)} 0 1,0 ${n1(-2 * r)},0`;
}

export default function PlanView({ model, level, sectionAxis, sectionPos, focus = 'site' }) {
  const hostRef = useRef(null);
  const { w, h } = useElementSize(hostRef);

  const drawing = useMemo(() => {
    if (w < 40 || h < 40) return null;
    const { towers, bridges, podium, context } = model;

    // Frame: whole site, or one tower's plate at this level (± a margin).
    let bounds = model.bounds;
    const ft = typeof focus === 'number' ? towers[focus] : null;
    if (ft) {
      const F = ft.floors[Math.min(level, ft.floors.length - 1)];
      const p = F.points2D;
      bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (let j = 0; j < p.length; j += 2) {
        bounds.minX = Math.min(bounds.minX, p[j] - 6);
        bounds.maxX = Math.max(bounds.maxX, p[j] + 6);
        bounds.minY = Math.min(bounds.minY, p[j + 1] - 6);
        bounds.maxY = Math.max(bounds.maxY, p[j + 1] + 6);
      }
    }

    const margin = 38;
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const s = Math.min((w - margin * 2) / bw, (h - margin * 2) / bh);
    const mx = (bounds.minX + bounds.maxX) / 2;
    const my = (bounds.minY + bounds.maxY) / 2;
    const X = (x) => w / 2 + (x - mx) * s;
    const Y = (y) => h / 2 - (y - my) * s;
    const pt = (x, y) => `${n1(X(x))},${n1(Y(y))}`;
    const poly = (p) => {
      let d = '';
      for (let j = 0; j < p.length; j += 2) d += (j ? 'L' : 'M') + pt(p[j], p[j + 1]);
      return d + 'Z';
    };

    const z = level * FLOOR_HEIGHT;
    const podiumCut = z <= podium.height;

    // Towers at the cut level + ground ghosts.
    let ghosts = '';
    let ghostAxes = '';
    let plates = '';
    let ticks = '';
    let axes = '';
    let drift = '';
    const labels = [];
    let roofsBelow = '';
    towers.forEach((T) => {
      const G = T.floors[0];
      const F = T.floors[level];
      ghosts += poly(G.points2D);
      if (!F) {
        // Towers vary in height: above this tower's roof, show its roof outline.
        roofsBelow += poly(T.floors[T.floors.length - 1].points2D);
        labels.push({ x: X(G.cx), y: Y(G.cy) + G.r * 0.78 * s + 14, text: `${T.name} · ROOF`, cx: null, cy: null });
        return;
      }
      plates += poly(F.points2D);

      // Fin positions: every finStride-th vertex, ticked outward from the centre.
      const p = F.points2D;
      const stride = p.length / 2 / T.finCount;
      for (let k = 0; k < T.finCount; k++) {
        const j = k * stride;
        const px = p[2 * j];
        const py = p[2 * j + 1];
        const len = Math.hypot(px - F.cx, py - F.cy) || 1;
        const nx = (px - F.cx) / len;
        const ny = (py - F.cy) / len;
        const sx = X(px);
        const sy = Y(py);
        ticks += `M${n1(sx)},${n1(sy)}L${n1(sx + nx * TICK_PX)},${n1(sy - ny * TICK_PX)}`;
      }

      // Major-axis lines make twist readable as rotation; drift line shows sway.
      const ax = Math.cos(F.rot) * F.r;
      const ay = Math.sin(F.rot) * F.r;
      axes += `M${pt(F.cx - ax, F.cy - ay)}L${pt(F.cx + ax, F.cy + ay)}`;
      const gx = Math.cos(G.rot) * G.r;
      const gy = Math.sin(G.rot) * G.r;
      ghostAxes += `M${pt(G.cx - gx, G.cy - gy)}L${pt(G.cx + gx, G.cy + gy)}`;
      drift += `M${pt(G.cx, G.cy)}L${pt(F.cx, F.cy)}`;
      labels.push({ x: X(G.cx), y: Y(G.cy) + G.r * 0.78 * s + 14, text: `${T.name} · ${T.floors.length} FL`, cx: X(F.cx), cy: Y(F.cy) });
    });

    /*
     * Fit-out (rooms, furniture, people) from floorFitout() — shown once the
     * plan is large enough to read it (≥ 2 px per metre).
     */
    const fitout = s >= 2;
    let fitWalls = '';
    let furniture = '';
    let figures = '';
    const roomLabels = [];
    if (fitout) {
      towers.forEach((T) => {
        const fo = floorFitout(T, level, podium);
        if (!fo) return;
        for (let k = 0; k < fo.walls.length; k += 4) {
          fitWalls += `M${pt(fo.walls[k], fo.walls[k + 1])}L${pt(fo.walls[k + 2], fo.walls[k + 3])}`;
        }
        for (const it of fo.furniture) furniture += furniturePath(it, X, Y, s);
        for (const p of fo.people) figures += personPath(p, X, Y, s);
        fo.rooms.forEach((r, i) => roomLabels.push({ key: `${T.name}${i}`, x: X(r.x), y: Y(r.y), text: r.text }));
      });
    }

    /*
     * Urban context around the site (only what falls inside this view): streets,
     * ring road, plaza edge, clay blocks, trees; people on the ground plane only
     * when the plan cuts at ground level.
     */
    const vx0 = mx - w / 2 / s;
    const vx1 = mx + w / 2 / s;
    const vy0 = my - h / 2 / s;
    const vy1 = my + h / 2 / s;
    const inView = (x, y, r = 0) => x + r > vx0 && x - r < vx1 && y + r > vy0 && y - r < vy1;
    let ctxBlocks = '';
    let ctxTrees = '';
    let ctxPeople = '';
    let ctxStreets = '';
    for (const b of context.blocks) {
      if (!inView(b.x, b.y, Math.max(b.w, b.d))) continue;
      ctxBlocks += `M${pt(b.x - b.w / 2, b.y - b.d / 2)}L${pt(b.x + b.w / 2, b.y - b.d / 2)}L${pt(b.x + b.w / 2, b.y + b.d / 2)}L${pt(b.x - b.w / 2, b.y + b.d / 2)}Z`;
    }
    for (const st of context.streets) ctxStreets += `M${pt(st.x0, st.y0)}L${pt(st.x1, st.y1)}`;
    for (const t of context.trees) {
      if (!inView(t.x, t.y, t.r)) continue;
      const r = t.r * s;
      ctxTrees += `M${n1(X(t.x) - r)},${n1(Y(t.y))}a${n1(r)},${n1(r)} 0 1,0 ${n1(2 * r)},0a${n1(r)},${n1(r)} 0 1,0 ${n1(-2 * r)},0`;
    }
    if (fitout) {
      for (const p of context.people) {
        const onPlane = level === 0 ? p.z === 0 : Math.abs(p.z - z) < 1;
        if (onPlane && inView(p.x, p.y)) ctxPeople += personPath({ x: p.x, y: p.y, rot: p.x * 7.3 }, X, Y, s);
      }
    }

    /*
     * Floor detail per tower, all read from the floor data:
     *   structural axes through the core (dash-dot, grid bubbles)
     *   perimeter columns (core2D / columns2D are generated per floor)
     *   core poché with its rooms: lifts (crossed), scissor stairs (treads),
     *   lobby, risers (hatched)
     */
    const detail = s >= 1.6;
    let gridAxes = '';
    const bubbles = [];
    let columns = '';
    let corePoche = '';
    let voids = '';
    let liftX = '';
    let treads = '';
    let hatch = '';
    const tags = [];
    towers.forEach((T) => {
      const F = T.floors[level];
      if (!F) return;
      const cc = Math.cos(T.coreRot);
      const cs = Math.sin(T.coreRot);
      const L2W = (lx, ly) => [F.cx + lx * cc - ly * cs, F.cy + lx * cs + ly * cc];
      const lp = (lx, ly) => pt(...L2W(lx, ly));
      const rect = (x0, y0, x1, y1) => `M${lp(x0, y0)}L${lp(x1, y0)}L${lp(x1, y1)}L${lp(x0, y1)}Z`;

      // structural axes
      const ext = F.r * 1.3;
      [
        [1, 0, '1'],
        [0, 1, '2'],
      ].forEach(([ax, ay, tag]) => {
        gridAxes += `M${lp(-ax * ext, -ay * ext)}L${lp(ax * ext, ay * ext)}`;
        const [bx, by] = L2W(ax * (ext + 3 / s), ay * (ext + 3 / s));
        bubbles.push({ key: `${T.name}${tag}`, x: X(bx), y: Y(by), text: `${T.name}${tag}` });
      });

      // columns
      const cw = Math.max(2.4, 0.9 * s) / 2;
      const c = F.columns2D;
      for (let k = 0; k < c.length; k += 2) {
        const x = X(c[k]);
        const y = Y(c[k + 1]);
        columns += `M${n1(x - cw)},${n1(y - cw)}h${n1(2 * cw)}v${n1(2 * cw)}h${n1(-2 * cw)}Z`;
      }

      // core
      const zone = T.coreZones[F.zone];
      corePoche += poly(F.core2D);
      if (detail) {
        for (const r of zone.rooms) {
          voids += rect(r.x0, r.y0, r.x1, r.y1);
          if (r.type === 'lift') {
            liftX += `M${lp(r.x0, r.y0)}L${lp(r.x1, r.y1)}M${lp(r.x1, r.y0)}L${lp(r.x0, r.y1)}`;
          } else if (r.type === 'riser') {
            for (let q = 0; q <= 4; q++) {
              const t = q / 4;
              hatch += `M${lp(r.x0 + (r.x1 - r.x0) * t, r.y0)}L${lp(r.x0, r.y0 + (r.y1 - r.y0) * t)}`;
              hatch += `M${lp(r.x1, r.y0 + (r.y1 - r.y0) * t)}L${lp(r.x0 + (r.x1 - r.x0) * t, r.y1)}`;
            }
          } else if (r.type === 'stair') {
            // scissor stair: central divider, treads between landings
            const mx2 = (r.x0 + r.x1) / 2;
            const land = (r.y1 - r.y0) * 0.18;
            treads += `M${lp(mx2, r.y0 + land)}L${lp(mx2, r.y1 - land)}`;
            const n = Math.max(3, Math.round((r.y1 - r.y0 - 2 * land) / 0.9));
            for (let q = 0; q <= n; q++) {
              const y = r.y0 + land + ((r.y1 - r.y0 - 2 * land) * q) / n;
              treads += `M${lp(r.x0, y)}L${lp(r.x1, y)}`;
            }
          }
        }
      }

      const [hx, hy] = [zone.hx * 2, zone.hy * 2];
      const top = T.floors[T.floors.length - 1];
      tags.push({
        key: T.name,
        x: X(F.cx),
        y: Y(F.cy - F.r * 1.05) + 12,
        lines: [
          `${T.name} · L${level}/${T.floors.length - 1}${F.mep ? ' · MEP' : ''}`,
          `GFA ${Math.round(F.area).toLocaleString('en-US')} m² · NIA ${Math.round((F.nia / F.area) * 100)}%`,
          `CORE ${hx.toFixed(1)}×${hy.toFixed(1)} · ${zone.lifts} LIFTS · Z${F.zone + 1}`,
          `ROOF +${(top.z + PARAPET).toFixed(1)}`,
        ],
      });
    });

    // Bridges at this level: their flared plan footprint (cut), others faint.
    const bridgeEls = [];
    let bridgesBelow = '';
    bridges.forEach((b, n) => {
      const cut = z >= b.z && z < b.z + b.height;
      if (cut) bridgeEls.push(<path key={n} d={poly(b.outline2D)} className="pl-bridge-cut" />);
      else if (b.z + b.height <= z) bridgesBelow += poly(b.outline2D);
    });

    // Section line.
    const edge = 10;
    let cut;
    if (sectionAxis === 'x') {
      const y = Y(sectionPos);
      cut = { x1: edge, y1: y, x2: w - edge, y2: y, l1: [edge + 2, y - 5], l2: [w - edge - 12, y - 5] };
    } else {
      const x = X(sectionPos);
      cut = { x1: x, y1: edge + 34, x2: x, y2: h - edge, l1: [x + 5, edge + 44], l2: [x + 5, h - edge - 4] };
    }

    // Scale bar.
    const L = niceScaleLength(s, 110);
    const sbx = 16;
    const sby = h - 18;
    const sbw = L * s;

    return (
      <>
        <circle cx={X(0)} cy={Y(0)} r={context.ring.r * s} className="pl-ctx-ring" strokeWidth={context.ring.width * s} />
        <path d={ctxStreets} className="pl-ctx-street" strokeWidth={context.street * s} />
        <circle cx={X(0)} cy={Y(0)} r={context.plazaR * s} className="pl-ctx-plaza" />
        <path d={ctxBlocks} className="pl-ctx-block" />
        <path d={ctxTrees} className="pl-ctx-tree" />
        <path d={ctxPeople} className="pl-person ctx" />
        <path d={poly(podium.outline2D)} className={podiumCut ? 'pl-podium is-cut' : 'pl-podium'} />
        <path d={ghosts} className="pl-ghost" />
        <path d={ghostAxes} className="pl-ghost-axis" />
        <path d={bridgesBelow} className="pl-bridge-below" />
        {bridgeEls}
        <path d={gridAxes} className="pl-grid" />
        {bubbles.map((b) => (
          <g key={b.key}>
            <circle cx={b.x} cy={b.y} r={8} className="pl-bubble" />
            <text x={b.x} y={b.y + 3} className="svg-label bubble" textAnchor="middle">
              {b.text}
            </text>
          </g>
        ))}
        <path d={plates} className="pl-plate" />
        <path d={ticks} className="pl-tick" />
        <path d={axes} className="pl-axis" />
        <path d={drift} className="pl-drift" />
        <path d={columns} className="pl-column" />
        <path d={corePoche} className="pl-core" />
        <path d={voids} className="pl-core-void" />
        <path d={liftX} className="pl-core-line" />
        <path d={treads} className="pl-core-line" />
        <path d={hatch} className="pl-core-line faint" />
        <path d={fitWalls} className="pl-wall" />
        <path d={furniture} className="pl-furn" />
        <path d={figures} className="pl-person" />
        {roomLabels.map((r) => (
          <text key={r.key} x={r.x} y={r.y} className="svg-label room" textAnchor="middle">
            {r.text}
          </text>
        ))}
        {tags.map((t) => (
          <text key={t.key} x={t.x} y={t.y} className="svg-label tag" textAnchor="middle">
            {t.lines.map((line, i) => (
              <tspan key={i} x={t.x} dy={i ? 11 : 0}>
                {line}
              </tspan>
            ))}
          </text>
        ))}
        <path d={roofsBelow} className="pl-roof-below" />
        {labels.map((l) => (
          <g key={l.text}>
            {l.cx !== null && <rect x={l.cx - 1.5} y={l.cy - 1.5} width={3} height={3} className="pl-centre" />}
            {l.cx === null && (
              <text x={l.x} y={l.y} className="svg-label" textAnchor="middle">
                {l.text}
              </text>
            )}
          </g>
        ))}

        <line x1={cut.x1} y1={cut.y1} x2={cut.x2} y2={cut.y2} className="cut-line" />
        <text x={cut.l1[0]} y={cut.l1[1]} className="svg-label cyan">
          A
        </text>
        <text x={cut.l2[0]} y={cut.l2[1]} className="svg-label cyan">
          A′
        </text>

        <text x={14} y={20} className="svg-title">
          {`L${level} / +${z.toFixed(1)} m`}
        </text>
        <text x={14} y={33} className="svg-label">
          {level === towers[0].floors.length - 1 ? 'ROOF' : podiumCut ? 'PODIUM + SHAFT' : 'SHAFT'}
          {roofsBelow ? ' · ROOFS BELOW' : ''}
          {` · ${bridgeEls.length} BRIDGE${bridgeEls.length === 1 ? '' : 'S'} AT LEVEL`}
        </text>

        <g transform={`translate(${w - 24},${22})`}>
          <line x1={0} y1={14} x2={0} y2={-6} className="svg-stroke" />
          <path d="M0,-12 L4,-3 L0,-5 L-4,-3 Z" className="svg-fill" />
          <circle cx={0} cy={6} r={9} className="svg-stroke faint" />
          <text x={0} y={28} className="svg-label" textAnchor="middle">
            N
          </text>
        </g>

        <g>
          <line x1={sbx} y1={sby} x2={sbx + sbw} y2={sby} className="svg-stroke" />
          <line x1={sbx} y1={sby - 4} x2={sbx} y2={sby + 1} className="svg-stroke" />
          <line x1={sbx + sbw / 2} y1={sby - 2} x2={sbx + sbw / 2} y2={sby + 1} className="svg-stroke" />
          <line x1={sbx + sbw} y1={sby - 4} x2={sbx + sbw} y2={sby + 1} className="svg-stroke" />
          <text x={sbx} y={sby - 7} className="svg-label">
            0
          </text>
          <text x={sbx + sbw} y={sby - 7} className="svg-label" textAnchor="end">
            {`${L} M`}
          </text>
        </g>
      </>
    );
  }, [model, level, sectionAxis, sectionPos, focus, w, h]);

  return (
    <div className="svg-host" ref={hostRef}>
      <svg width={w} height={h} shapeRendering="geometricPrecision">
        {drawing}
      </svg>
    </div>
  );
}
