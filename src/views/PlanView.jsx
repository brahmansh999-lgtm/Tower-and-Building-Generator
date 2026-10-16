import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FLOOR_HEIGHT } from '../geometry/generateTower.js';

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

export default function PlanView({ model, level, sectionAxis, sectionPos }) {
  const hostRef = useRef(null);
  const { w, h } = useElementSize(hostRef);

  const drawing = useMemo(() => {
    if (w < 40 || h < 40) return null;
    const { bounds, towers, bridges, podium } = model;

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
        <path d={poly(podium.outline2D)} className={podiumCut ? 'pl-podium is-cut' : 'pl-podium'} />
        <path d={ghosts} className="pl-ghost" />
        <path d={ghostAxes} className="pl-ghost-axis" />
        <path d={bridgesBelow} className="pl-bridge-below" />
        {bridgeEls}
        <path d={plates} className="pl-plate" />
        <path d={ticks} className="pl-tick" />
        <path d={axes} className="pl-axis" />
        <path d={drift} className="pl-drift" />
        <path d={roofsBelow} className="pl-roof-below" />
        {labels.map((l) => (
          <g key={l.text}>
            {l.cx !== null && <rect x={l.cx - 1.5} y={l.cy - 1.5} width={3} height={3} className="pl-centre" />}
            <text x={l.x} y={l.y} className="svg-label" textAnchor="middle">
              {l.text}
            </text>
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
  }, [model, level, sectionAxis, sectionPos, w, h]);

  return (
    <div className="svg-host" ref={hostRef}>
      <svg width={w} height={h} shapeRendering="geometricPrecision">
        {drawing}
      </svg>
    </div>
  );
}
