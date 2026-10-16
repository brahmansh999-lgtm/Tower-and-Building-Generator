import { useMemo, useRef } from 'react';
import { FLOOR_HEIGHT, BRIDGE_STATION_STRIDE, cutPolygonAtLine } from '../geometry/generateTower.js';
import { useElementSize, niceScaleLength } from './PlanView.jsx';

const n1 = (v) => v.toFixed(1);

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
    const mr = 16;
    const mt = 40;
    const mb = 24;
    const uSpan = Math.max(1, uMax - uMin);
    const zSpan = Math.max(1, bounds.maxZ);
    const s = Math.min((w - ml - mr) / uSpan, (h - mt - mb) / zSpan);
    const uc = (uMin + uMax) / 2;
    const U = (u) => ml + (w - ml - mr) / 2 + (u - uc) * s;
    const Z = (z) => h - mb - z * s;
    const pt = (u, z) => `${n1(U(u))},${n1(Z(z))}`;

    /*
     * Per tower:
     *  - elevation beyond: closed outline of the plate extents along u (soft fill)
     *  - cut poché: plates are convex, so each floor cuts to at most one
     *    interval; contiguous runs of cut floors become one filled outline
     *  - floor lines inside the poché, with a stronger datum every 10th floor
     */
    let elevation = '';
    let poche = '';
    let floorLines = '';
    let datumLines = '';
    towers.forEach((T) => {
      const lo = [];
      const hi = [];
      let runL = [];
      let runR = [];
      const flush = () => {
        if (runL.length > 1) {
          poche += 'M' + runL.map(([u, z]) => pt(u, z)).join('L');
          poche += 'L' + runR.reverse().map(([u, z]) => pt(u, z)).join('L') + 'Z';
        }
        runL = [];
        runR = [];
      };
      T.floors.forEach((F) => {
        const p = F.points2D;
        let a = Infinity;
        let b = -Infinity;
        for (let j = uIdx; j < p.length; j += 2) {
          if (p[j] < a) a = p[j];
          if (p[j] > b) b = p[j];
        }
        lo.push([a, F.z]);
        hi.push([b, F.z]);

        const segs = cutPolygonAtLine(p, sectionAxis, sectionPos);
        if (segs.length) {
          const [u0, u1] = segs[0];
          runL.push([u0, F.z]);
          runR.push([u1, F.z]);
          const line = `M${pt(u0, F.z)}L${pt(u1, F.z)}`;
          if (F.index % 10 === 0) datumLines += line;
          else floorLines += line;
        } else {
          flush();
        }
      });
      flush();
      elevation += 'M' + lo.map(([u, z]) => pt(u, z)).join('L');
      elevation += 'L' + hi.reverse().map(([u, z]) => pt(u, z)).join('L') + 'Z';
    });

    // Podium cut.
    const podiumRects = cutPolygonAtLine(podium.outline2D, sectionAxis, sectionPos).map(([a, b], i) => (
      <rect key={i} x={U(a)} y={Z(podium.height)} width={(b - a) * s} height={podium.height * s} className="sc-podium" />
    ));
    let pLo = Infinity;
    let pHi = -Infinity;
    for (let j = uIdx; j < podium.outline2D.length; j += 2) {
      pLo = Math.min(pLo, podium.outline2D[j]);
      pHi = Math.max(pHi, podium.outline2D[j]);
    }

    /*
     * Bridges: elevation profile from the bridge stations (top edge out, bottom
     * edge back). Where the bridge crosses the cut line, its rounded section is
     * drawn as poché: width along u = 2·hw / |dir_k| (oblique cut stretches it).
     */
    const K = BRIDGE_STATION_STRIDE;
    const bridgeEls = bridges.map((b, n) => {
      const st = b.stations;
      const S = st.length / K;
      let top = '';
      let bottom = '';
      let cut = null;
      for (let i = 0; i < S; i++) {
        const o = K * i;
        top += (i ? 'L' : 'M') + pt(st[o + uIdx], st[o + 2] + st[o + 4]);
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
          <path d={top + bottom + 'Z'} className={cut ? 'sc-bridge is-cut' : 'sc-bridge'} />
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

    // Level markers every 10 floors.
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

    const planY = Z(level * FLOOR_HEIGHT);
    const L = niceScaleLength(s, 90);
    const axisName = sectionAxis === 'x' ? 'Y' : 'X';

    return (
      <>
        <path d={elevation} className="sc-beyond" />
        {bridgeEls}
        {podiumRects}
        <path d={poche} className="sc-poche" />
        <path d={floorLines} className="sc-floor" />
        <path d={datumLines} className="sc-datum" />

        <line x1={ml - 2} y1={Z(0)} x2={w - mr} y2={Z(0)} className="svg-stroke" />
        <line x1={U(pLo)} y1={Z(0) + 4} x2={U(pHi)} y2={Z(0) + 4} className="svg-stroke faint" />
        <line x1={ml - 2} y1={Z(0)} x2={ml - 2} y2={Z(params.floors * FLOOR_HEIGHT)} className="svg-stroke faint" />
        {markers}

        <line x1={ml - 2} y1={planY} x2={w - mr} y2={planY} className="plan-line" />
        <text x={w - mr} y={planY - 4} className="svg-label cyan" textAnchor="end">
          {`PLAN L${level}`}
        </text>

        <text x={14} y={20} className="svg-title">
          {`A–A′ · ${axisName} = ${sectionPos >= 0 ? '+' : ''}${sectionPos.toFixed(1)} m`}
        </text>
        <text x={14} y={33} className="svg-label">
          {`LOOKING ${sectionAxis === 'x' ? 'NORTH' : 'EAST'} · H ${(params.floors * FLOOR_HEIGHT).toFixed(1)} M`}
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
