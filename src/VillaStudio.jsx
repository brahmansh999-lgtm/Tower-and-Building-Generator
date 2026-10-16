import { useCallback, useMemo, useState } from 'react';
import { generateVilla, VILLA_OPTIONS, GFA_RANGE, PLOT } from './geometry/generateVilla.js';
import VillaViewport3D from './views/VillaViewport3D.jsx';
import VillaPlanView from './views/VillaPlanView.jsx';
import VillaSectionView from './views/VillaSectionView.jsx';
import VillaControls from './ui/VillaControls.jsx';

const fmt = (v) => Math.round(v).toLocaleString('en-US');

/**
 * Villa studio: seven Zaha-inspired options on one shared brief (plot, road,
 * context, programme, GFA). Every option is generated so the options board can
 * compare them side by side; the selected one drives the 3D view and drawings.
 */
export default function VillaStudio({ active }) {
  const [option, setOptionState] = useState(() => {
    const m = window.location.hash.match(/^#villas\/(\d)/);
    return m ? Math.min(VILLA_OPTIONS.length, Math.max(1, Number(m[1]))) : 1;
  });
  const setOption = (id) => {
    setOptionState(id);
    window.history.replaceState(null, '', `#villas/${id}`);
  };
  const [gfa, setGfa] = useState(GFA_RANGE.default);
  const [cuts, setCuts] = useState({ level: 0, frame: 'house', sectionPos: -10, axis: 'x', cut3D: false });
  const onCuts = useCallback((k, v) => setCuts((c) => ({ ...c, [k]: v })), []);

  const options = useMemo(() => VILLA_OPTIONS.map((o) => generateVilla({ option: o.id, gfa })), [gfa]);
  const villa = options.find((v) => v.option.id === option) || options[0];

  const half = (cuts.axis === 'x' ? PLOT.d : PLOT.w) / 2;
  const sectionPos = (cuts.sectionPos / 100) * half;
  const st = villa.stats;

  return (
    <div className={active ? 'app' : 'app is-hidden'}>
      <main className="stage">
        <VillaViewport3D
          villa={villa}
          planLevel={cuts.level}
          sectionAxis={cuts.axis}
          sectionPos={sectionPos}
          cut3D={cuts.cut3D}
          active={active}
        />
        <header className="readout">
          <div className="title">
            OPTION {villa.option.id} · {villa.option.name}
          </div>
          <div className="subtitle">{villa.option.tagline.toUpperCase()}</div>
          <dl className="stats">
            <div>
              <dt>GFA</dt>
              <dd>{fmt(st.gfa)} m²</dd>
            </div>
            <div>
              <dt>L0 / L1</dt>
              <dd>
                {fmt(st.levelAreas[0])} / {fmt(st.levelAreas[1])}
              </dd>
            </div>
            <div>
              <dt>Footprint</dt>
              <dd>{fmt(st.footprint)} m²</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>{(st.coverage * 100).toFixed(1)} %</dd>
            </div>
            <div>
              <dt>Plot</dt>
              <dd>
                {PLOT.w} × {PLOT.d} m
              </dd>
            </div>
            <div>
              <dt>Bedrooms</dt>
              <dd>{st.bedrooms}</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>{st.height.toFixed(1)} m</dd>
            </div>
            <div>
              <dt>Pool</dt>
              <dd className="amber">{fmt(st.poolArea)} m²</dd>
            </div>
          </dl>
        </header>
        <VillaControls
          options={options}
          option={option}
          onOption={setOption}
          gfa={gfa}
          onGfa={setGfa}
          cuts={cuts}
          onCuts={onCuts}
          sectionMetres={sectionPos}
        />
        <div className="hint">DRAG ORBIT · SCROLL ZOOM · {st.withinSetbacks ? 'WITHIN SETBACKS' : 'BREACHES SETBACK'}</div>
      </main>

      <aside className="drawings">
        <section className="panel">
          <div className="panel-head">
            <span>PLAN · L{cuts.level}</span>
            <span className="cyan">{cuts.level === 0 ? 'GROUND FLOOR' : 'FIRST FLOOR'}</span>
          </div>
          <div className="panel-body">
            <VillaPlanView villa={villa} level={cuts.level} frame={cuts.frame} sectionAxis={cuts.axis} sectionPos={sectionPos} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <span>SECTION</span>
            <span className="cyan">∥ {cuts.axis.toUpperCase()}</span>
          </div>
          <div className="panel-body">
            <VillaSectionView villa={villa} level={cuts.level} sectionAxis={cuts.axis} sectionPos={sectionPos} />
          </div>
        </section>
      </aside>
    </div>
  );
}
