import { useMemo, useRef } from 'react';
import { cutPolygonAtLine } from '../geometry/generateTower.js';
import { VILLA_SLAB, VILLA_POOL_DEPTH, waveAt } from '../geometry/generateVilla.js';
import { useElementSize, niceScaleLength } from './PlanView.jsx';

const n1 = (v) => v.toFixed(1);

/** Intervals of an outline minus its hole along the section line. */
function cutWithHole(outline, hole, axis, pos) {
  let iv = cutPolygonAtLine(outline, axis, pos);
  if (hole) {
    for (const [h0, h1] of cutPolygonAtLine(hole, axis, pos)) {
      const next = [];
      for (const [a, b] of iv) {
        if (h1 <= a || h0 >= b) next.push([a, b]);
        else {
          if (h0 > a) next.push([a, h0]);
          if (h1 < b) next.push([h1, b]);
        }
      }
      iv = next;
    }
  }
  return iv;
}

/** Scale-figure silhouette 1 unit tall at (sx, sy) in screen space. */
function figure(sx, sy, hpx) {
  const k = hpx;
  const head = 0.07 * k;
  return (
    `M${n1(sx - head)},${n1(sy - 0.9 * k)}a${n1(head)},${n1(head)} 0 1,0 ${n1(2 * head)},0a${n1(head)},${n1(head)} 0 1,0 ${n1(-2 * head)},0` +
    `M${n1(sx - 0.13 * k)},${n1(sy - 0.8 * k)}L${n1(sx + 0.13 * k)},${n1(sy - 0.8 * k)}L${n1(sx + 0.09 * k)},${n1(sy - 0.47 * k)}` +
    `L${n1(sx + 0.06 * k)},${n1(sy)}L${n1(sx + 0.01 * k)},${n1(sy)}L${n1(sx)},${n1(sy - 0.42 * k)}L${n1(sx - 0.01 * k)},${n1(sy)}` +
    `L${n1(sx - 0.06 * k)},${n1(sy)}L${n1(sx - 0.09 * k)},${n1(sy - 0.47 * k)}Z`
  );
}

export default function VillaSectionView({ villa, level, sectionAxis, sectionPos }) {
  const hostRef = useRef(null);
  const { w, h } = useElementSize(hostRef);

  const drawing = useMemo(() => {
    if (w < 40 || h < 40) return null;
    const { plot, levels, context } = villa;
    const uIdx = sectionAxis === 'x' ? 0 : 1;
    const kIdx = 1 - uIdx;
    // Frame the house (both levels, pool, canopy) ± 6 m rather than the whole plot.
    let uMin = Infinity;
    let uMax = -Infinity;
    for (const p of [levels[0].outline, levels[1].outline, villa.pool, villa.canopy?.outline]) {
      if (!p) continue;
      for (let i = uIdx; i < p.length; i += 2) {
        uMin = Math.min(uMin, p[i] - 6);
        uMax = Math.max(uMax, p[i] + 6);
      }
    }
    const uc = (uMin + uMax) / 2;
    const zMin = -VILLA_POOL_DEPTH - 1.2;
    const zMax = villa.stats.height + 6;
    const ml = 58;
    const mr = 40;
    const mt = 44;
    const mb = 22;
    const s = Math.min((w - ml - mr) / (uMax - uMin), (h - mt - mb) / (zMax - zMin));
    const U = (u) => ml + (w - ml - mr) / 2 + (u - uc) * s;
    // centre the drawing vertically when the width limits the scale
    const zPad = Math.max(0, (h - mt - mb - (zMax - zMin) * s) / 2);
    const Z = (z) => h - mb - zPad - (z - zMin) * s;
    const pt = (u, z) => `${n1(U(u))},${n1(Z(z))}`;
    const rect = (u0, z0, u1, z1) => `M${pt(u0, z0)}L${pt(u1, z0)}L${pt(u1, z1)}L${pt(u0, z1)}Z`;
    const XY = (u) => (uIdx === 0 ? [u, sectionPos] : [sectionPos, u]);
    const ext = (p) => {
      let a = Infinity;
      let b = -Infinity;
      for (let i = uIdx; i < p.length; i += 2) {
        a = Math.min(a, p[i]);
        b = Math.max(b, p[i]);
      }
      return [a, b];
    };

    // Beyond: neighbour houses on the viewing side, trees, then this villa's elevation.
    const beyondSide = (k) => k > sectionPos;
    let houses = '';
    for (const blk of context.blocks) {
      const kc = kIdx === 1 ? blk.y : blk.x;
      if (!beyondSide(kc)) continue;
      const uc = uIdx === 0 ? blk.x : blk.y;
      const hw = (uIdx === 0 ? blk.w : blk.d) / 2;
      if (uc + hw < uMin || uc - hw > uMax) continue;
      houses += rect(Math.max(uMin, uc - hw), 0, Math.min(uMax, uc + hw), blk.h);
    }
    let treesD = '';
    for (const t of context.trees) {
      const kc = kIdx === 1 ? t.y : t.x;
      const uc = uIdx === 0 ? t.x : t.y;
      if (!beyondSide(kc) || kc - sectionPos > 60 || uc < uMin || uc > uMax) continue;
      const r = t.r * s;
      treesD += `M${pt(uc, 0)}L${pt(uc, t.h * 0.45)}`;
      treesD += `M${n1(U(uc) - r)},${n1(Z(t.h * 0.62))}a${n1(r)},${n1(r * 0.75)} 0 1,0 ${n1(2 * r)},0a${n1(r)},${n1(r * 0.75)} 0 1,0 ${n1(-2 * r)},0`;
    }
    let elevation = '';
    levels.forEach((L) => {
      const [a, b] = ext(L.outline);
      elevation += rect(a, L.z, b, L.z + L.height);
    });

    // Cut: slabs, soffits, glazing, partitions.
    let slabs = '';
    let glazing = '';
    let partitions = '';
    levels.forEach((L, i) => {
      const z0 = L.z;
      const z1 = L.z + L.height;
      const isTop = i === levels.length - 1;
      const wv = (u) => (isTop ? waveAt(villa.roof?.wave, ...XY(u)) : 0);
      for (const [u0, u1] of cutWithHole(L.outline, L.hole, sectionAxis, sectionPos)) {
        // top ribbon / roof slab (follows the roof wave on the top level)
        const N = 24;
        let top = '';
        let bot = '';
        for (let q = 0; q <= N; q++) {
          const u = u0 + ((u1 - u0) * q) / N;
          top += (q ? 'L' : 'M') + pt(u, z1 + wv(u));
          bot = 'L' + pt(u, z1 - VILLA_SLAB + wv(u)) + bot;
        }
        slabs += top + bot + 'Z';
        if (i === 0) slabs += rect(u0 - 0.2, -0.4, u1 + 0.2, 0.02);
        else slabs += rect(u0, z0 - 0.45, u1, z0 + 0.3);
        // glazing: double line, recessed 0.35 m
        const gz0 = i === 0 ? z0 + 0.02 : z0 + 0.3;
        for (const ug of [u0 + 0.35, u1 - 0.35]) {
          const zt = z1 - VILLA_SLAB + wv(ug);
          glazing += `M${pt(ug - 0.04, gz0)}L${pt(ug - 0.04, zt)}M${pt(ug + 0.04, gz0)}L${pt(ug + 0.04, zt)}`;
        }
      }
      // partitions crossing the cut
      for (let k = 0; k < L.walls.length; k += 4) {
        const a = L.walls[k + kIdx] - sectionPos;
        const c = L.walls[k + 2 + kIdx] - sectionPos;
        if (a < 0 === c < 0) continue;
        const t = a / (a - c);
        const u = L.walls[k + uIdx] + t * (L.walls[k + 2 + uIdx] - L.walls[k + uIdx]);
        partitions += rect(u - 0.07, z0 + (i ? 0.3 : 0.02), u + 0.07, z1 - VILLA_SLAB + wv(u));
      }
    });

    // Canopy
    let canopy = '';
    if (villa.canopy) {
      const c = villa.canopy;
      for (const [u0, u1] of cutPolygonAtLine(c.outline, sectionAxis, sectionPos)) {
        let top = '';
        let bot = '';
        for (let q = 0; q <= 30; q++) {
          const u = u0 + ((u1 - u0) * q) / 30;
          const zb = c.z + waveAt(c.wave, ...XY(u));
          top += (q ? 'L' : 'M') + pt(u, zb + c.thickness);
          bot = 'L' + pt(u, zb) + bot;
        }
        canopy += top + bot + 'Z';
      }
      for (const [x, y] of c.columns) {
        const kc = kIdx === 1 ? y : x;
        if (Math.abs(kc - sectionPos) > 12) continue;
        const uc = uIdx === 0 ? x : y;
        const zt = c.z + waveAt(c.wave, x, y);
        canopy += `M${pt(uc - 0.25, 0)}L${pt(uc - 0.3, zt * 0.6)}L${pt(uc - 0.9, zt)}L${pt(uc + 0.9, zt)}L${pt(uc + 0.3, zt * 0.6)}L${pt(uc + 0.25, 0)}Z`;
      }
    }

    // Pool
    let water = '';
    let poolWalls = '';
    if (villa.pool) {
      for (const [u0, u1] of cutPolygonAtLine(villa.pool, sectionAxis, sectionPos)) {
        water += rect(u0, -VILLA_POOL_DEPTH, u1, -0.14);
        poolWalls += rect(u0 - 0.3, -VILLA_POOL_DEPTH - 0.3, u0, 0.06) + rect(u1, -VILLA_POOL_DEPTH - 0.3, u1 + 0.3, 0.06) + rect(u0, -VILLA_POOL_DEPTH - 0.3, u1, -VILLA_POOL_DEPTH);
      }
    }

    // Boundary walls at the plot edges.
    const pe = (uIdx === 0 ? plot.w : plot.d) / 2;
    const boundary =
      (-pe > uMin ? rect(-pe - 0.25, 0, -pe, 1.2) : '') + (pe < uMax ? rect(pe, 0, pe + 0.25, 1.2) : '');

    // People within 3 m of the cut (garden, street, every floor).
    const near = [];
    for (const p of context.people) near.push({ x: p.x, y: p.y, z: p.z, h: p.h });
    levels.forEach((L, i) => L.people.forEach((p) => near.push({ x: p.x, y: p.y, z: L.z + (i ? 0.31 : 0.02), h: 1.72 })));
    let figures = '';
    for (const p of near) {
      const kc = kIdx === 1 ? p.y : p.x;
      if (Math.abs(kc - sectionPos) > 3) continue;
      const uc = uIdx === 0 ? p.x : p.y;
      if (uc < uMin || uc > uMax) continue;
      figures += figure(U(uc), Z(p.z), p.h * s);
    }

    // Levels + dims
    const markers = [
      ['L0 FFL', 0],
      ['L1 FFL', levels[1].z],
      ['ROOF', levels[1].z + levels[1].height],
    ];
    const H = villa.stats.height;
    const dx = w - mr + 14;
    const Ls = niceScaleLength(s, 90);
    const axisName = sectionAxis === 'x' ? 'Y' : 'X';

    return (
      <>
        <defs>
          <pattern id="vl-earth" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
          </pattern>
        </defs>
        <path d={houses} className="vs-house" />
        <path d={treesD} className="vs-tree" />
        <path d={elevation} className="sc-beyond" />
        <rect x={U(uMin)} y={Z(0)} width={(uMax - uMin) * s} height={(-zMin) * s - 2} fill="url(#vl-earth)" />
        <path d={water} className="vs-water" />
        <path d={poolWalls} className="sc-poche" />
        <path d={canopy} className="sc-poche" />
        <path d={slabs} className="sc-poche" />
        <path d={partitions} className="vs-partition" />
        <path d={glazing} className="vs-glass" />
        <path d={boundary} className="sc-roof" />
        <path d={figures} className="vs-figure" />
        <line x1={U(uMin)} y1={Z(0)} x2={U(uMax)} y2={Z(0)} className="sc-ground" />

        {markers.map(([name, z]) => (
          <g key={name}>
            <line x1={ml - 8} y1={Z(z)} x2={ml - 2} y2={Z(z)} className="svg-stroke" />
            <text x={ml - 10} y={Z(z) + 3} className="svg-label" textAnchor="end">
              {name}
            </text>
            <text x={ml - 10} y={Z(z) + 12} className="svg-label" textAnchor="end">
              {`+${z.toFixed(2)}`}
            </text>
          </g>
        ))}
        <line x1={ml - 2} y1={Z(levels[level].z + 1.2)} x2={w - mr} y2={Z(levels[level].z + 1.2)} className="plan-line" />
        <text x={w - mr} y={Z(levels[level].z + 1.2) - 4} className="svg-label cyan" textAnchor="end">
          {`PLAN L${level}`}
        </text>
        <g>
          <line x1={dx} y1={Z(0)} x2={dx} y2={Z(H)} className="svg-stroke" />
          <line x1={dx - 4} y1={Z(0) + 4} x2={dx + 4} y2={Z(0) - 4} className="svg-stroke" />
          <line x1={dx - 4} y1={Z(H) + 4} x2={dx + 4} y2={Z(H) - 4} className="svg-stroke" />
          <text x={dx + 10} y={(Z(0) + Z(H)) / 2} className="svg-label" textAnchor="middle" transform={`rotate(-90 ${dx + 10} ${(Z(0) + Z(H)) / 2})`}>
            {`${H.toFixed(2)} M`}
          </text>
        </g>
        <text x={14} y={20} className="svg-title">
          {`A–A′ · ${axisName} = ${sectionPos >= 0 ? '+' : ''}${sectionPos.toFixed(1)} m`}
        </text>
        <text x={14} y={33} className="svg-label">
          {`OPT ${villa.option.id} ${villa.option.name} · LOOKING ${sectionAxis === 'x' ? 'NORTH' : 'EAST'} · POOL −${VILLA_POOL_DEPTH.toFixed(1)}`}
        </text>
        <g>
          <line x1={w - mr - Ls * s} y1={h - 8} x2={w - mr} y2={h - 8} className="svg-stroke" />
          <text x={w - mr - Ls * s - 6} y={h - 5} className="svg-label" textAnchor="end">
            {`${Ls} M`}
          </text>
        </g>
      </>
    );
  }, [villa, level, sectionAxis, sectionPos, w, h]);

  return (
    <div className="svg-host" ref={hostRef}>
      <svg width={w} height={h} shapeRendering="geometricPrecision">
        {drawing}
      </svg>
    </div>
  );
}
