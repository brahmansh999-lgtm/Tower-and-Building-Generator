# Tower and Building Generator

A browser-based parametric configurator for one tower typology: twisted, swaying oval towers on a shared podium, joined by sculpted sky links. Each tower in the cluster has its own height, plate shape, twist and sway character.

Built with React, Vite and Three.js. Everything runs in the browser; there is no backend.

A second **Villas** tab generates seven residential villa options inspired by Zaha Hadid's fluid language (Ribbon, Petal, Wave, Dunes, Crescent, Loop, Shell). Every option sits on the same 64 × 44 m plot with the same road, context, two-level programme and gross floor area; only the architecture changes. Each option comes with a 3D model, furnished plans and a section. Link straight to one with `#villas/3`.

## Run

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (default http://localhost:5173).

## Controls

- **Form:** height (30–120 floors, tallest tower), base width (20–60 m), sway (0–30 m), twist (0–360°)
- **Cluster:** towers (1–5), links per connection (0–8), connection mode (pairs / all / chain)
- **Cuts:** plan level, section position and axis, and a toggle to slice the 3D model

## Structure

- `src/geometry/generateTower.js` — the single geometry function; the 3D view, plan and section all read its output
- `src/views/Viewport3D.jsx` — Three.js model (unlit, shading baked into vertex colours)
- `src/views/PlanView.jsx`, `src/views/SectionView.jsx` — SVG drawings
- `src/ui/Controls.jsx` — parameter panel
- `src/geometry/generateVilla.js` — villa options, room partitioning, fit-out and suburban context
- `src/VillaStudio.jsx`, `src/views/Villa*.jsx`, `src/ui/VillaControls.jsx` — villa tab

The layout adapts to phones: the model, controls and drawings stack in one scrolling column.
