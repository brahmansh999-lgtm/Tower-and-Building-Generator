import { useMemo, useRef } from 'react';
import {
  FLOOR_HEIGHT,
  BRIDGE_STATION_STRIDE,
  CORE_OVERRUN,
  PARAPET,
  cutPolygonAtLine,
} from '../geometry/generateTower.js';
import { useElementSize, niceScaleLength } from './PlanView.jsx';

const n1 = (v) => v.toFixed(1);
const PLANT_H = 3.2;

/** Min / max of the u-coordinate (stride 2, offset uIdx) of a flat 2D array. */
function extentU(p, uIdx, scale = 1, cu = 0) {
  let a = Infinity;
  let b = -Infinity;
  for (let j = uIdx; j < p.length; j += 2) {
    const v = cu + (p[j] - cu) * scale;
    if (v < a) a = v;
    if (v > b) b = v;
  }
  return [a, b];
}

export default function SectionView({ model, level, sectionAxis, sectionPos }) {
  const hostRef = useRef(null);
  const { w, h } = useElementSize(hostRef);

  const drawing = useMemo(() => {
    if (w < 40 || h < 40) return null;
    const { bounds, towers, bridges, podium, params } = model;

    // u = horizontal drawing axis (x for an X-parallel cut, y for a Y-parallel cut)
    const uIdx = sectionAxis === 'x' ? 0 : 1;
    const kIdx = 1 - uIdx;
    const uMin = uIdx === 0 ? bounds.minX : bounds.minY;
    const uMax = uIdx === 0 ? bounds.maxX : bounds.maxY;
    const ml = 64;
    const mr = 44; // room for the height dimension
    const mt = 46;
    const mb = 24;
    const zBottom = -podium.basementDepth;
    const zTop = bounds.maxZ + PARAPET + CORE_OVERRUN + 2;
    const uSpan = Math.max(1, uMax - uMin);
    const zSpan = zTop - zBottom;
    const s = Math.min((w - ml - mr) / uSpan, (h - mt - mb) / zSpan);
    const uc = (uMin + uMax) / 2;
    const U = (u) => ml + (w - ml - mr) / 2 + (u - uc) * s;
    const Z = (z) => h - mb - (z - zBottom) * s;
    const pt = (u, z) => `${n1(U(u))},${n1(Z(z))}`;
    const rect = (u0, z0, u1, z1) => `M${pt(u0, z0)}L${pt(u1, z0)}L${pt(u1, z1)}L${pt(u0, z1)}Z`;

    /*
     * Per tower, all from the floor data:
     *  - elevation beyond: outline of plate extents along u, with faint floor
     *    lines, MEP louvre bands, parapet, roof plant screen and lift overrun
     *  - cut poché: contiguous runs of cut floors (plates are convex → one
     *    interval per floor) become filled outlines; floor lines inside, datum
     *    every 10th floor
     *  - core poché: the core rectangle cut per floor, hatched, from the
     *    basement up through the overrun
     */
    let elevation = '';
    let beyondFloors = '';
    let mepBands = '';
    let roofParts = '';
    let poche = '';
    let floorLines = '';
    let datumLines = '';
    let corePoche = '';
    const mepLabels = [];
    const roofLabels = [];

    towers.forEach((T) => {
      const lo = [];
      const hi = [];
      const runs = { L: [], R: [] };
      const coreRuns = { L: [], R: [] };
      const flush = (r, target) => {
        let d = '';
        if (r.L.length > 1) {
          d += 'M' + r.L.map(([u, z]) => pt(u, z)).join('L');
          d += 'L' + r.R.slice().reverse().map(([u, z]) => pt(u, z)).join('L') + 'Z';
        }
        r.L = [];
        r.R = [];
        return target + d;
      };

      T.floors.forEach((F, f) => {
        const [a, b] = extentU(F.points2D, uIdx);
        lo.push([a, F.z]);
        hi.push([b, F.z]);
        if (f % 2 === 0) beyondFloors += `M${pt(a, F.z)}L${pt(b, F.z)}`;
        if (F.mep) {
          mepBands += rect(a, F.z, b, F.z + FLOOR_HEIGHT);
          mepLabels.push({ key: `${T.name}${f}`, x: U(b) + 4, y: Z(F.z + FLOOR_HEIGHT / 2) + 3, text: `MEP L${f}` });
        }

        const segs = cutPolygonAtLine(F.points2D, sectionAxis, sectionPos);
        if (segs.length) {
          const [u0, u1] = segs[0];
          runs.L.push([u0, F.z]);
          runs.R.push([u1, F.z]);
          const line = `M${pt(u0, F.z)}L${pt(u1, F.z)}`;
          if (F.index % 10 === 0) datumLines += line;
          else floorLines += line;
        } else {
          poche = flush(runs, poche);
        }

        const cseg = cutPolygonAtLine(F.core2D, sectionAxis, sectionPos);
        if (cseg.length) {
          coreRuns.L.push([cseg[0][0], F.z]);
          coreRuns.R.push([cseg[0][1], F.z]);
        } else {
          corePoche = flush(coreRuns, corePoche);
        }
      });

      // Roof: parapet, plant screen, lift overrun (continuing the core).
      const top = T.floors[T.floors.length - 1];
      const zRoof = top.z + PARAPET;
      const [ra, rb] = extentU(top.points2D, uIdx);
      roofParts += rect(ra, top.z, rb, zRoof);
      const cu = uIdx === 0 ? top.cx : top.cy;
      const [pa, pb] = extentU(top.points2D, uIdx, 0.55, cu);
      roofParts += rect(pa, zRoof - 0.3, pb, zRoof - 0.3 + PLANT_H);
      const [oa, ob] = extentU(top.core2D, uIdx);
      roofParts += rect(oa, zRoof, ob, zRoof + CORE_OVERRUN);
      const cTop = cutPolygonAtLine(top.core2D, sectionAxis, sectionPos);
      if (cTop.length) {
        coreRuns.L.push([cTop[0][0], zRoof + CORE_OVERRUN]);
        coreRuns.R.push([cTop[0][1], zRoof + CORE_OVERRUN]);
      }
      // Core continues into the basement.
      if (coreRuns.L.length && coreRuns.L[0][1] === 0) {
        coreRuns.L.unshift([coreRuns.L[0][0], zBottom]);
        coreRuns.R.unshift([coreRuns.R[0][0], zBottom]);
      }
      poche = flush(runs, poche);
      corePoche = flush(coreRuns, corePoche);
      roofLabels.push({ key: T.name, x: U((ra + rb) / 2), y: Z(zRoof + CORE_OVERRUN) - 6, text: `${T.name} +${zRoof.toFixed(1)}` });

      elevation += 'M' + lo.map(([u, z]) => pt(u, z)).join('L');
      elevation += 'L' + hi.reverse().map(([u, z]) => pt(u, z)).join('L') + 'Z';
    });

    // Podium cut + basement.
    const [pLo, pHi] = extentU(podium.outline2D, uIdx);
    const podiumRects = cutPolygonAtLine(podium.outline2D, sectionAxis, sectionPos).map(([a, b], i) => (
      <rect key={i} x={U(a)} y={Z(podium.height)} width={(b - a) * s} height={podium.height * s} className="sc-podium" />
    ));
    let podiumFloors = '';
    for (let k = 1; k < podium.floors; k++) {
      const z = (k * podium.height) / podium.floors;
      podiumFloors += `M${pt(pLo, z)}L${pt(pHi, z)}`;
    }
    let basement = rect(pLo, zBottom, pHi, 0);
    const levelH = podium.basementDepth / podium.basementLevels;
    for (let k = 1; k < podium.basementLevels; k++) basement += `M${pt(pLo, -k * levelH)}L${pt(pHi, -k * levelH)}`;

    /*
     * Bridges: elevation profile from the bridge stations (top edge out, bottom
     * edge back). Where the bridge crosses the cut line, its section is drawn
     * as poché: width along u = 2·hw / |dir_k| (oblique cut stretches it).
     */
    const K = BRIDGE_STATION_STRIDE;
    const bridgeEls = bridges.map((b, n) => {
      const st = b.stations;
      const S = st.length / K;
      let topEdge = '';
      let bottom = '';
      let cut = null;
      for (let i = 0; i < S; i++) {
        const o = K * i;
        topEdge += (i ? 'L' : 'M') + pt(st[o + uIdx], st[o + 2] + st[o + 4]);
        bottom = 'L' + pt(st[o + uIdx], st[o + 2] - st[o + 5]) + bottom;
        if (!cut && i > 0) {
          const a = st[o - K + kIdx] - sectionPos;
          const c = st[o + kIdx] - sectionPos;
          if (a < 0 !== c < 0) {
            const t = a / (a - c);
            const lerp = (k) => st[o - K + k] + t * (st[o + k] - st[o - K + k]);
            const dirK = Math.abs(kIdx === 0 ? b.ux : b.uy);
            const halfU = Math.min(lerp(3) / Math.max(dirK, 0.25), lerp(3) * 4);
            cut = { u: lerp(uIdx), top: lerp(2) + lerp(4), bottom: lerp(2) - lerp(5), hu: halfU };
          }
        }
      }
      return (
        <g key={n}>
          <path d={topEdge + bottom + 'Z'} className={cut ? 'sc-bridge is-cut' : 'sc-bridge'} />
          {cut && (
            <rect
              x={U(cut.u - cut.hu)}
              y={Z(cut.top)}
              width={2 * cut.hu * s}
              height={(cut.top - cut.bottom) * s}
              rx={Math.min(cut.hu, (cut.top - cut.bottom) / 2) * 0.5 * s}
              className="sc-bridge-cut"
            />
          )}
        </g>
      );
    });

    // Level markers every 10 floors + basement levels.
    const markers = [];
    for (let f = 0; f < params.floors; f += 10) {
      const y = Z(f * FLOOR_HEIGHT);
      markers.push(
        <g key={f}>
          <line x1={ml - 8} y1={y} x2={ml - 2} y2={y} className="svg-stroke" />
          <text x={ml - 12} y={y + 3} className="svg-label" textAnchor="end">
            {`L${f} +${(f * FLOOR_HEIGHT).toFixed(0)}`}
          </text>
        </g>
      );
    }
    markers.push(
      <text key="b" x={U(pHi) + 4} y={Z(zBottom / 2) + 3} className="svg-label">
        {`B${podium.basementLevels} −${podium.basementDepth.toFixed(0)}`}
      </text>
    );

    // Overall height dimension (tallest roof).
    const tallest = towers.reduce((m, T) => Math.max(m, T.floors[T.floors.length - 1].z + PARAPET), 0);
    const dx = w - mr + 16;

    const planY = Z(level * FLOOR_HEIGHT);
    const L = niceScaleLength(s, 90);
    const axisName = sectionAxis === 'x' ? 'Y' : 'X';

    return (
      <>
        <defs>
          <pattern id="sc-hatch-core" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="rgba(255,255,255,0.32)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,255,255,0.85)" strokeWidth="1.4" />
          </pattern>
          <pattern id="sc-hatch-mep" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
          </pattern>
        </defs>

        <path d={basement} className="sc-basement" />
        <path d={elevation} className="sc-beyond" />
        <path d={beyondFloors} className="sc-beyond-floor" />
        <path d={mepBands} className="sc-mep" />
        <path d={roofParts} className="sc-roof" />
        {bridgeEls}
        {podiumRects}
        <path d={podiumFloors} className="sc-beyond-floor" />
        <path d={poche} className="sc-poche" />
        <path d={floorLines} className="sc-floor" />
        <path d={datumLines} className="sc-datum" />
        <path d={corePoche} className="sc-core" />

        <line x1={ml - 2} y1={Z(0)} x2={w - mr} y2={Z(0)} className="sc-ground" />
        <line x1={ml - 2} y1={Z(0)} x2={ml - 2} y2={Z(params.floors * FLOOR_HEIGHT)} className="svg-stroke faint" />
        {markers}

        {mepLabels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} className="svg-label mep">
            {l.text}
          </text>
        ))}
        {roofLabels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} className="svg-label" textAnchor="middle">
            {l.text}
          </text>
        ))}

        <g>
          <line x1={dx} y1={Z(0)} x2={dx} y2={Z(tallest)} className="svg-stroke" />
          <line x1={dx - 4} y1={Z(0) + 4} x2={dx + 4} y2={Z(0) - 4} className="svg-stroke" />
          <line x1={dx - 4} y1={Z(tallest) + 4} x2={dx + 4} y2={Z(tallest) - 4} className="svg-stroke" />
          <text
            x={dx + 11}
            y={(Z(0) + Z(tallest)) / 2}
            className="svg-label"
            textAnchor="middle"
            transform={`rotate(-90 ${dx + 11} ${(Z(0) + Z(tallest)) / 2})`}
          >
            {`${tallest.toFixed(1)} M TO ROOF`}
          </text>
        </g>

        <line x1={ml - 2} y1={planY} x2={w - mr} y2={planY} className="plan-line" />
        <text x={w - mr} y={planY - 4} className="svg-label cyan" textAnchor="end">
          {`PLAN L${level}`}
        </text>

        <text x={14} y={20} className="svg-title">
          {`A–A′ · ${axisName} = ${sectionPos >= 0 ? '+' : ''}${sectionPos.toFixed(1)} m`}
        </text>
        <text x={14} y={33} className="svg-label">
          {`LOOKING ${sectionAxis === 'x' ? 'NORTH' : 'EAST'} · CORE HATCHED · MEP FLOORS LOUVRED`}
        </text>

        <g>
          <line x1={w - mr - L * s} y1={h - 8} x2={w - mr} y2={h - 8} className="svg-stroke" />
          <line x1={w - mr - L * s} y1={h - 11} x2={w - mr - L * s} y2={h - 7} className="svg-stroke" />
          <line x1={w - mr} y1={h - 11} x2={w - mr} y2={h - 7} className="svg-stroke" />
          <text x={w - mr - L * s - 6} y={h - 5} className="svg-label" textAnchor="end">
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
