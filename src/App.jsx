import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateTower, sectionRange, FLOOR_HEIGHT } from './geometry/generateTower.js';
import Viewport3D from './views/Viewport3D.jsx';
import PlanView from './views/PlanView.jsx';
import SectionView from './views/SectionView.jsx';
import Controls from './ui/Controls.jsx';

const INITIAL_FORM = { floors: 84, width: 36, sway: 14, twist: 120, towers: 2, bridges: 4, mode: 'adjacent' };
const INITIAL_CUTS = { planLevel: 48, sectionPos: 0, axis: 'x', cut3D: false };

/**
 * Coalesce rapid slider updates to at most one every `ms` (leading + trailing),
 * so a continuous drag still updates live at ~60 Hz instead of stalling the way
 * a pure trailing debounce would.
 */
function useCoalesced(value, ms) {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  const timer = useRef(0);
  const latest = useRef(value);

  useEffect(() => {
    latest.current = value;
    const wait = ms - (performance.now() - last.current);
    if (wait <= 0) {
      last.current = performance.now();
      setOut(value);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = 0;
        last.current = performance.now();
        setOut(latest.current);
      }, wait);
    }
  }, [value, ms]);

  useEffect(() => () => clearTimeout(timer.current), []);
  return out;
}

const fmt = (v) => Math.round(v).toLocaleString('en-US');

export default function App() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [cuts, setCuts] = useState(INITIAL_CUTS);
  const formD = useCoalesced(form, 16);
  const cutsD = useCoalesced(cuts, 16);

  // Geometry is regenerated only when form/cluster params change.
  const model = useMemo(() => generateTower(formD), [formD]);

  const onForm = useCallback((k, v) => setForm((f) => ({ ...f, [k]: v })), []);
  const onCuts = useCallback((k, v) => setCuts((c) => ({ ...c, [k]: v })), []);

  // Plan framing: whole site, or zoomed onto one tower to read the fit-out.
  const [planFocus, setPlanFocus] = useState(0);
  const focus = planFocus === 'site' || planFocus < model.towers.length ? planFocus : 'site';

  const maxLevel = model.params.floors - 1;
  const planLevel = Math.min(cutsD.planLevel, maxLevel);
  const [lo, hi] = sectionRange(model.bounds, cutsD.axis);
  const sectionPos = (lo + hi) / 2 + (cutsD.sectionPos / 100) * ((hi - lo) / 2);
  const [uiLo, uiHi] = sectionRange(model.bounds, cuts.axis);
  const uiSectionPos = (uiLo + uiHi) / 2 + (cuts.sectionPos / 100) * ((uiHi - uiLo) / 2);

  const st = model.stats;
  const modeName = { adjacent: 'PAIRS', all: 'ALL-TO-ALL', chain: 'CHAIN' }[model.params.mode];

  return (
    <div className="app">
      <main className="stage">
        <Viewport3D
          model={model}
          planLevel={planLevel}
          sectionAxis={cutsD.axis}
          sectionPos={sectionPos}
          cut3D={cutsD.cut3D}
        />

        <header className="readout">
          <div className="title">TWISTED TWIN TOWERS</div>
          <div className="subtitle">SKY-BRIDGE ARCH TYPOLOGY · PARAMETRIC STUDY</div>
          <dl className="stats">
            <div>
              <dt>GFA</dt>
              <dd>
                {fmt(st.gfa)} m²
              </dd>
            </div>
            <div>
              <dt>Floors</dt>
              <dd>{st.totalFloors} total</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd>{st.height.toFixed(1)} m</dd>
            </div>
            <div>
              <dt>Towers</dt>
              <dd>{st.towers}</dd>
            </div>
            <div>
              <dt>Bridges</dt>
              <dd className="amber">{st.bridges}</dd>
            </div>
            <div>
              <dt>Sway</dt>
              <dd>{st.sway.toFixed(1)} m</dd>
            </div>
            <div>
              <dt>Twist</dt>
              <dd>{st.twist}°</dd>
            </div>
            <div>
              <dt>Fins</dt>
              <dd>{st.finCount} / twr</dd>
            </div>
          </dl>
        </header>

        <Controls
          form={form}
          onForm={onForm}
          cuts={cuts}
          onCuts={onCuts}
          maxLevel={form.floors - 1}
          sectionMetres={uiSectionPos}
        />

        <div className="hint">
          DRAG ORBIT · SCROLL ZOOM · {modeName} · {cutsD.cut3D ? 'CUT 3D ON' : 'CUT 3D OFF'}
        </div>
      </main>

      <aside className="drawings">
        <section className="panel">
          <div className="panel-head">
            <span>PLAN</span>
            <span className="focus">
              {['site', ...model.towers.map((T) => T.index)].map((f) => (
                <button
                  key={f}
                  type="button"
                  className={f === focus ? 'focus-btn is-on' : 'focus-btn'}
                  onClick={() => setPlanFocus(f)}
                >
                  {f === 'site' ? 'SITE' : model.towers[f].name}
                </button>
              ))}
            </span>
            <span className="cyan">+{(planLevel * FLOOR_HEIGHT).toFixed(1)} M</span>
          </div>
          <div className="panel-body">
            <PlanView model={model} level={planLevel} sectionAxis={cutsD.axis} sectionPos={sectionPos} focus={focus} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <span>SECTION</span>
            <span className="cyan">∥ {cutsD.axis.toUpperCase()}</span>
          </div>
          <div className="panel-body">
            <SectionView model={model} level={planLevel} sectionAxis={cutsD.axis} sectionPos={sectionPos} />
          </div>
        </section>
      </aside>
    </div>
  );
}
