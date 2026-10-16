import { useMemo, useRef } from 'react';
import { offsetFlat } from '../geometry/generateVilla.js';
import { useElementSize, niceScaleLength, furniturePath, personPath } from './PlanView.jsx';

const n1 = (v) => v.toFixed(1);

/** Points every `step` metres along a closed outline, with outward normals. */
function perimeterTicks(p, step) {
  const out = [];
  let carry = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j];
    const ay = p[j + 1];
    const bx = p[i];
    const by = p[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    let t = step - carry;
    while (t < L) {
      out.push([ax + ux * t, ay + uy * t, uy, -ux]);
      t += step;
    }
    carry = (carry + L) % step;
  }
  return out;
}

export default function VillaPlanView({ villa, level, frame, sectionAxis, sectionPos }) {
  const hostRef = useRef(null);
  const { w, h } = useElementSize(hostRef);

  const drawing = useMemo(() => {
    if (w < 40 || h < 40) return null;
    const L = villa.levels[level];
    const other = villa.levels[1 - level];
    const { plot, context } = villa;

    // Frame: the house (both levels + pool) or the whole plot with neighbours.
    let b;
    if (frame === 'site') {
      b = { minX: -plot.w / 2 - 14, maxX: plot.w / 2 + 14, minY: -plot.d / 2 - 14, maxY: plot.d / 2 + 10 };
    } else {
      b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const p of [villa.levels[0].outline, villa.levels[1].outline, villa.pool, villa.canopy?.outline]) {
        if (!p) continue;
        for (let i = 0; i < p.length; i += 2) {
          b.minX = Math.min(b.minX, p[i] - 3);
          b.maxX = Math.max(b.maxX, p[i] + 3);
          b.minY = Math.min(b.minY, p[i + 1] - 3);
          b.maxY = Math.max(b.maxY, p[i + 1] + 3);
        }
      }
    }
    const margin = 40;
    const s = Math.min((w - 2 * margin) / (b.maxX - b.minX), (h - 2 * margin) / (b.maxY - b.minY));
    const mx = (b.minX + b.maxX) / 2;
    const my = (b.minY + b.maxY) / 2;
    const X = (x) => w / 2 + (x - mx) * s;
    const Y = (y) => h / 2 - (y - my) * s;
    const pt = (x, y) => `${n1(X(x))},${n1(Y(y))}`;
    const poly = (p) => {
      if (!p) return '';
      let d = '';
      for (let i = 0; i < p.length; i += 2) d += (i ? 'L' : 'M') + pt(p[i], p[i + 1]);
      return d + 'Z';
    };
    const vx0 = mx - w / 2 / s;
    const vx1 = mx + w / 2 / s;
    const vy0 = my - h / 2 / s;
    const vy1 = my + h / 2 / s;
    const inView = (x, y, r = 0) => x + r > vx0 && x - r < vx1 && y + r > vy0 && y - r < vy1;

    // Context
    let streets = '';
    for (const st of context.streets) streets += `M${pt(st.x0, st.y0)}L${pt(st.x1, st.y1)}`;
    let blocks = '';
    for (const k of context.blocks) {
      if (!inView(k.x, k.y, Math.max(k.w, k.d))) continue;
      blocks += `M${pt(k.x - k.w / 2, k.y - k.d / 2)}L${pt(k.x + k.w / 2, k.y - k.d / 2)}L${pt(k.x + k.w / 2, k.y + k.d / 2)}L${pt(k.x - k.w / 2, k.y + k.d / 2)}Z`;
    }
    let trees = '';
    for (const t of context.trees) {
      if (!inView(t.x, t.y, t.r)) continue;
      const r = t.r * s;
      trees += `M${n1(X(t.x) - r)},${n1(Y(t.y))}a${n1(r)},${n1(r)} 0 1,0 ${n1(2 * r)},0a${n1(r)},${n1(r)} 0 1,0 ${n1(-2 * r)},0`;
    }
    let outsidePeople = '';
    if (level === 0) {
      for (const p of context.people) if (p.z === 0 && inView(p.x, p.y)) outsidePeople += personPath({ x: p.x, y: p.y, rot: p.x * 3.1 }, X, Y, s);
    }

    // Site elements
    let outdoor = '';
    if (level === 0) for (const f of villa.outdoor) outdoor += furniturePath(f, X, Y, s);

    // Building outline: exterior wall + inner glazing line + mullion ticks.
    const glassIn = poly(offsetFlat(L.outline, -0.3)) + (L.hole ? poly(offsetFlat(L.hole, -0.3)) : '');
    let mullions = '';
    for (const C of [L.outline, L.hole].filter(Boolean)) {
      for (const [x, y, nx, ny] of perimeterTicks(C, 1.8)) {
        mullions += `M${pt(x, y)}L${pt(x - nx * 0.3, y - ny * 0.3)}`;
      }
    }

    // Partitions + doors
    let walls = '';
    for (let k = 0; k < L.walls.length; k += 4) walls += `M${pt(L.walls[k], L.walls[k + 1])}L${pt(L.walls[k + 2], L.walls[k + 3])}`;
    let doors = '';
    for (const d of L.doors) {
      // leaf perpendicular to the wall at the hinge, quarter-circle swing
      const lx = d.x - Math.sin(d.angle) * d.w;
      const ly = d.y + Math.cos(d.angle) * d.w;
      const ex = d.x + Math.cos(d.angle) * d.w;
      const ey = d.y + Math.sin(d.angle) * d.w;
      const r = n1(d.w * s);
      doors += `M${pt(d.x, d.y)}L${pt(lx, ly)}M${pt(lx, ly)}A${r},${r} 0 0,1 ${pt(ex, ey)}`;
    }

    // Furniture, stair / void, people
    let furniture = '';
    for (const f of L.furniture) furniture += furniturePath(f, X, Y, s);
    const st = villa.stair;
    const stairD =
      level === 0
        ? furniturePath({ type: st.type === 'spiral' ? 'spiral' : 'stair', x: st.x, y: st.y, w: st.w, d: st.d, rot: st.rot }, X, Y, s)
        : furniturePath({ type: 'void', x: st.x, y: st.y, w: st.w, d: st.d, rot: st.rot }, X, Y, s);
    let people = '';
    for (const p of L.people) people += personPath(p, X, Y, s);

    // Room labels with areas
    // Labels run along each room's long direction (kept upright).
    const labels = L.rooms
      .filter((r) => r.area > 1)
      .map((r) => {
        let deg = (-r.angle * 180) / Math.PI;
        deg = ((((deg + 90) % 180) + 180) % 180) - 90;
        return { key: r.name, x: X(r.cx), y: Y(r.cy), deg, name: r.name, area: `${Math.round(r.area)} m²` };
      });

    // Overall dimensions of this level (axis-aligned)
    let ox0 = Infinity;
    let ox1 = -Infinity;
    let oy0 = Infinity;
    let oy1 = -Infinity;
    for (let i = 0; i < L.outline.length; i += 2) {
      ox0 = Math.min(ox0, L.outline[i]);
      ox1 = Math.max(ox1, L.outline[i]);
      oy0 = Math.min(oy0, L.outline[i + 1]);
      oy1 = Math.max(oy1, L.outline[i + 1]);
    }
    const dimY = Y(oy0) + 22;
    const dimX = X(ox0) - 22;

    // Section line
    const cut =
      sectionAxis === 'x'
        ? { x1: 10, y1: Y(sectionPos), x2: w - 10, y2: Y(sectionPos), l1: [12, Y(sectionPos) - 5], l2: [w - 22, Y(sectionPos) - 5] }
        : { x1: X(sectionPos), y1: 44, x2: X(sectionPos), y2: h - 10, l1: [X(sectionPos) + 5, 54], l2: [X(sectionPos) + 5, h - 14] };

    const Ls = niceScaleLength(s, 110);
    const sbx = 16;
    const sby = h - 18;

    return (
      <>
        <path d={streets} className="pl-ctx-street" strokeWidth={context.street * s} />
        <path d={blocks} className="pl-ctx-block" />
        <path d={poly(plot.outline2D)} className="vl-plot" />
        <path d={poly(plot.build2D)} className="vl-setback" />
        <path d={poly(villa.drive)} className="vl-drive" />
        {villa.deck && <path d={poly(villa.deck)} className="vl-deck" />}
        {villa.pool && (
          <>
            <path d={poly(offsetFlat(villa.pool, 0.5))} className="vl-coping" />
            <path d={poly(villa.pool)} className="vl-pool" />
          </>
        )}
        <path d={trees} className="pl-ctx-tree" />
        <path d={outdoor} className="pl-furn" />

        <path d={poly(other.outline) + poly(other.hole)} className="vl-other" />
        {villa.canopy && <path d={poly(villa.canopy.outline)} className="vl-canopy" />}

        <path d={poly(L.outline) + poly(L.hole)} className="vl-floor" fillRule="evenodd" />
        <path d={glassIn} className="vl-glass" />
        <path d={poly(L.outline) + poly(L.hole)} className="vl-ext" strokeWidth={Math.max(2, 0.3 * s)} />
        <path d={mullions} className="vl-mullion" />
        <path d={walls} className="pl-wall" strokeWidth={Math.max(1.4, 0.15 * s)} />
        <path d={doors} className="vl-door" />
        <path d={furniture} className="pl-furn" />
        <path d={stairD} className="vl-stair" />
        <path d={people + outsidePeople} className="pl-person" />

        {labels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} className="svg-label room" textAnchor="middle" transform={`rotate(${l.deg.toFixed(1)} ${l.x} ${l.y})`}>
            <tspan x={l.x}>{l.name}</tspan>
            <tspan x={l.x} dy={10} className="area">
              {l.area}
            </tspan>
          </text>
        ))}

        {frame === 'house' && (
          <g>
            <line x1={X(ox0)} y1={dimY} x2={X(ox1)} y2={dimY} className="svg-stroke" />
            <line x1={X(ox0)} y1={dimY - 4} x2={X(ox0)} y2={dimY + 4} className="svg-stroke" />
            <line x1={X(ox1)} y1={dimY - 4} x2={X(ox1)} y2={dimY + 4} className="svg-stroke" />
            <text x={(X(ox0) + X(ox1)) / 2} y={dimY - 4} className="svg-label" textAnchor="middle">
              {`${(ox1 - ox0).toFixed(1)} M`}
            </text>
            <line x1={dimX} y1={Y(oy0)} x2={dimX} y2={Y(oy1)} className="svg-stroke" />
            <line x1={dimX - 4} y1={Y(oy0)} x2={dimX + 4} y2={Y(oy0)} className="svg-stroke" />
            <line x1={dimX - 4} y1={Y(oy1)} x2={dimX + 4} y2={Y(oy1)} className="svg-stroke" />
            <text
              x={dimX - 4}
              y={(Y(oy0) + Y(oy1)) / 2}
              className="svg-label"
              textAnchor="middle"
              transform={`rotate(-90 ${dimX - 4} ${(Y(oy0) + Y(oy1)) / 2})`}
            >
              {`${(oy1 - oy0).toFixed(1)} M`}
            </text>
          </g>
        )}

        <line x1={cut.x1} y1={cut.y1} x2={cut.x2} y2={cut.y2} className="cut-line" />
        <text x={cut.l1[0]} y={cut.l1[1]} className="svg-label cyan">
          A
        </text>
        <text x={cut.l2[0]} y={cut.l2[1]} className="svg-label cyan">
          A′
        </text>

        <text x={14} y={20} className="svg-title">
          {`OPT ${villa.option.id} ${villa.option.name} · L${level} ${L.name}`}
        </text>
        <text x={14} y={33} className="svg-label">
          {`GIA ${Math.round(L.area)} m² · FFL +${L.z.toFixed(2)} · ${level === 0 ? 'FIRST FLOOR DASHED ABOVE' : 'GROUND FLOOR DASHED BELOW'}`}
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
          <line x1={sbx} y1={sby} x2={sbx + Ls * s} y2={sby} className="svg-stroke" />
          <line x1={sbx} y1={sby - 4} x2={sbx} y2={sby + 1} className="svg-stroke" />
          <line x1={sbx + Ls * s} y1={sby - 4} x2={sbx + Ls * s} y2={sby + 1} className="svg-stroke" />
          <text x={sbx} y={sby - 7} className="svg-label">
            0
          </text>
          <text x={sbx + Ls * s} y={sby - 7} className="svg-label" textAnchor="end">
            {`${Ls} M`}
          </text>
        </g>
      </>
    );
  }, [villa, level, frame, sectionAxis, sectionPos, w, h]);

  return (
    <div className="svg-host" ref={hostRef}>
      <svg width={w} height={h} shapeRendering="geometricPrecision">
        {drawing}
      </svg>
    </div>
  );
}
