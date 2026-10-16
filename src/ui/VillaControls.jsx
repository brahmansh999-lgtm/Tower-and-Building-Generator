import { useState } from 'react';
import { GFA_RANGE } from '../geometry/generateVilla.js';

const flatPath = (p, X, Y) => {
  if (!p) return '';
  let d = '';
  for (let i = 0; i < p.length; i += 2) d += `${i ? 'L' : 'M'}${X(p[i]).toFixed(1)},${Y(p[i + 1]).toFixed(1)}`;
  return d + 'Z';
};

/** Mini plan of one option: plot, ground floor (filled), first floor (outline), pool. */
function OptionThumb({ villa }) {
  const W = 84;
  const H = 58;
  const s = Math.min(W / villa.plot.w, H / villa.plot.d);
  const X = (x) => W / 2 + x * s;
  const Y = (y) => H / 2 - y * s;
  const [L0, L1] = villa.levels;
  return (
    <svg width={W} height={H} className="opt-thumb">
      <rect x={X(-villa.plot.w / 2)} y={Y(villa.plot.d / 2)} width={villa.plot.w * s} height={villa.plot.d * s} className="opt-plot" />
      {villa.pool && <path d={flatPath(villa.pool, X, Y)} className="opt-pool" />}
      <path d={flatPath(L0.outline, X, Y) + flatPath(L0.hole, X, Y)} className="opt-l0" fillRule="evenodd" />
      <path d={flatPath(L1.outline, X, Y) + flatPath(L1.hole, X, Y)} className="opt-l1" />
      {villa.canopy && <path d={flatPath(villa.canopy.outline, X, Y)} className="opt-canopy" />}
    </svg>
  );
}

function Slider({ label, value, min, max, step, onChange, readout, accent }) {
  return (
    <label className="ctl">
      <span className="ctl-row">
        <span className="ctl-label">{label}</span>
        <span className={accent ? `ctl-value ${accent}` : 'ctl-value'}>{readout}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="ctl">
      <span className="ctl-row">
        <span className="ctl-label">{label}</span>
      </span>
      <div className="seg">
        {options.map((o) => (
          <button key={o.value} type="button" className={o.value === value ? 'seg-btn is-on' : 'seg-btn'} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function VillaControls({ options, option, onOption, gfa, onGfa, cuts, onCuts, sectionMetres }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={open ? 'controls' : 'controls is-closed'}>
      <button type="button" className="controls-head" onClick={() => setOpen(!open)}>
        <span>VILLA OPTIONS</span>
        <span className="dim">{open ? '—' : '+'}</span>
      </button>
      {open && (
        <div className="controls-body">
          <div className="micro">DESIGN OPTIONS · SAME PLOT · SAME GFA</div>
          <div className="opt-grid">
            {options.map((v) => (
              <button
                key={v.option.id}
                type="button"
                className={v.option.id === option ? 'opt-card is-on' : 'opt-card'}
                onClick={() => onOption(v.option.id)}
                title={v.option.tagline}
              >
                <OptionThumb villa={v} />
                <span className="opt-name">
                  {v.option.id} · {v.option.name}
                </span>
              </button>
            ))}
          </div>

          <div className="micro">BRIEF</div>
          <Slider
            label="Target GFA"
            min={GFA_RANGE.min}
            max={GFA_RANGE.max}
            step={GFA_RANGE.step}
            value={gfa}
            onChange={onGfa}
            readout={`${gfa} m²`}
          />

          <div className="micro">CUTS</div>
          <Segmented
            label="Plan level"
            value={cuts.level}
            onChange={(v) => onCuts('level', v)}
            options={[
              { value: 0, label: 'L0 Ground' },
              { value: 1, label: 'L1 First' },
            ]}
          />
          <Segmented
            label="Plan frame"
            value={cuts.frame}
            onChange={(v) => onCuts('frame', v)}
            options={[
              { value: 'house', label: 'House' },
              { value: 'site', label: 'Site' },
            ]}
          />
          <Slider
            label="Section"
            min={-100}
            max={100}
            step={0.5}
            value={cuts.sectionPos}
            onChange={(v) => onCuts('sectionPos', v)}
            readout={`${cuts.axis === 'x' ? 'Y' : 'X'} ${sectionMetres >= 0 ? '+' : ''}${sectionMetres.toFixed(1)} m`}
            accent="cyan"
          />
          <Segmented
            label="Section axis"
            value={cuts.axis}
            onChange={(v) => onCuts('axis', v)}
            options={[
              { value: 'x', label: '∥ X' },
              { value: 'y', label: '∥ Y' },
            ]}
          />
          <button type="button" className={cuts.cut3D ? 'toggle is-on' : 'toggle'} onClick={() => onCuts('cut3D', !cuts.cut3D)}>
            <span className="toggle-box" />
            <span className="ctl-label">Cut 3D model</span>
            <span className="ctl-value cyan">{cuts.cut3D ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
