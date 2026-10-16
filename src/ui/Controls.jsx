import { useState } from 'react';
import { PARAM_RANGES, FLOOR_HEIGHT } from '../geometry/generateTower.js';

function Slider({ label, value, min, max, step, onChange, readout, accent }) {
  return (
    <label className="ctl">
      <span className="ctl-row">
        <span className="ctl-label">{label}</span>
        <span className={accent ? `ctl-value ${accent}` : 'ctl-value'}>{readout}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
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
          <button
            key={o.value}
            type="button"
            className={o.value === value ? 'seg-btn is-on' : 'seg-btn'}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <button type="button" className={value ? 'toggle is-on' : 'toggle'} onClick={() => onChange(!value)}>
      <span className="toggle-box" />
      <span className="ctl-label">{label}</span>
      <span className="ctl-value cyan">{value ? 'ON' : 'OFF'}</span>
    </button>
  );
}

const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} m`;

export default function Controls({ form, onForm, cuts, onCuts, maxLevel, sectionMetres }) {
  const [open, setOpen] = useState(true);
  const R = PARAM_RANGES;
  const level = Math.min(cuts.planLevel, maxLevel);

  return (
    <div className={open ? 'controls' : 'controls is-closed'}>
      <button type="button" className="controls-head" onClick={() => setOpen(!open)}>
        <span>PARAMETERS</span>
        <span className="dim">{open ? '—' : '+'}</span>
      </button>

      {open && (
        <div className="controls-body">
          <div className="micro">FORM</div>
          <Slider
            label="Height"
            {...R.floors}
            value={form.floors}
            onChange={(v) => onForm('floors', v)}
            readout={`${form.floors} FL · ${(form.floors * FLOOR_HEIGHT).toFixed(1)} m`}
          />
          <Slider
            label="Width"
            {...R.width}
            value={form.width}
            onChange={(v) => onForm('width', v)}
            readout={`${form.width} m`}
          />
          <Slider
            label="Sway"
            {...R.sway}
            value={form.sway}
            onChange={(v) => onForm('sway', v)}
            readout={`${form.sway.toFixed(1)} m`}
          />
          <Slider
            label="Twist"
            {...R.twist}
            value={form.twist}
            onChange={(v) => onForm('twist', v)}
            readout={`${form.twist}°`}
          />

          <div className="micro">CLUSTER</div>
          <Slider
            label="Towers"
            {...R.towers}
            value={form.towers}
            onChange={(v) => onForm('towers', v)}
            readout={`${form.towers}`}
          />
          <Slider
            label="Bridges"
            {...R.bridges}
            value={form.bridges}
            onChange={(v) => onForm('bridges', v)}
            readout={`${form.bridges} / link`}
            accent="amber"
          />
          <Segmented
            label="Connection"
            value={form.mode}
            onChange={(v) => onForm('mode', v)}
            options={[
              { value: 'adjacent', label: 'Pairs' },
              { value: 'all', label: 'All' },
              { value: 'chain', label: 'Chain' },
            ]}
          />

          <div className="micro">CUTS</div>
          <Slider
            label="Plan level"
            min={0}
            max={maxLevel}
            step={1}
            value={level}
            onChange={(v) => onCuts('planLevel', v)}
            readout={`L${level} · +${(level * FLOOR_HEIGHT).toFixed(1)} m`}
            accent="cyan"
          />
          <Slider
            label="Section"
            min={-100}
            max={100}
            step={0.5}
            value={cuts.sectionPos}
            onChange={(v) => onCuts('sectionPos', v)}
            readout={`${cuts.axis === 'x' ? 'Y' : 'X'} ${signed(sectionMetres)}`}
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
          <Toggle label="Cut 3D model" value={cuts.cut3D} onChange={(v) => onCuts('cut3D', v)} />
        </div>
      )}
    </div>
  );
}
