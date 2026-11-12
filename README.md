# Tower and Building Generator

A browser-based parametric configurator for one tower typology: twisted, swaying oval towers on a shared podium, joined by sculpted sky links. Each tower in the cluster has its own height, plate shape, twist and sway character.

Built with React, Vite and Three.js. Everything runs in the browser; there is no backend.

The app opens on a start screen where you choose to design a tower or a villa; the tabs at the top switch between the two studios at any time.

The **Villas** studio generates twelve residential villa options inspired by Zaha Hadid's fluid language (Ribbon, Petal, Wave, Dunes, Crescent, Loop, Shell, Twin Pod, Swirl, Cascade, Flux, Lens). Every option sits on the same 64 × 44 m plot with the same road, context, two-level programme and gross floor area; only the architecture changes. Each option is laid out as a designed plan — a curved hall with service rooms on the road side, open-plan living facing the garden, and en-suite bedroom suites — with a 3D model, furnished plans and a section. Link straight to one with `#villas/3`.

## Run

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (default https://localhost:5173). The dev server uses a self-signed certificate (WebXR needs HTTPS), so accept the browser warning once.

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
- `src/geometry/buildVRMeshes.js` — VR geometry (ribbons, fin strips, bridge tubes, glow, walkable surfaces) built from the same generateTower() output
- `src/vr/` — VR session (towers) and VillaVRSession (villas), environment, interaction, control panel, drawing boards and intro

The layout adapts to phones: the model, controls and drawings stack in one scrolling column.

## VR (Towers and Villas)

An **ENTER VR** button appears at the bottom right of both studios when the browser supports immersive VR (Meta Quest Browser, Apple Vision Pro Safari, Chrome with a PC VR headset, or desktop Chrome with the Meta Immersive Web Emulator extension).

- **Tabletop (1:500):** the model stands on a glowing plinth at waist height. Grip (or trigger/pinch) and move a hand to rotate it; grab with both hands and pull apart to scale between 1:1000 and 1:200.
- **Human scale (1:1):** right stick forward aims a teleport arc, release to jump; right stick left/right snap-turns 30°. You can land on the ground, the podium roof, tower roofs and bridge roofs. With hand tracking, pinch-and-hold away from the menu to aim the arc.
- **Controls:** one wide three-column card that shows every control at once, with no scrolling: all the desktop sliders and buttons, plus scale mode, viewpoints, plan frame, context, smooth locomotion (off by default, with a comfort vignette), menu size (S / M / L) and a render-quality override. It is docked to your left by default; switch it to your left wrist from the menu, and press **X** to hide or show it.
- **Villas in VR:** all twelve design options, target GFA, plan level and frame, section and cut. The tabletop is 1:100 (scale 1:250–1:30). At 1:1 you can walk the garden, both floors and the roof, with viewpoints for the garden, entrance, living room, upper floor, pool, roof and an aerial view.
- **Drawing boards:** the desktop plan (with the full fit-out and a "you are here" marker at human scale) and the section stand to your right and update live with the sliders. A data sheet to your left lists the project figures: for towers, every tower, the current floor of each tower and every bridge; for villas, the brief figures and a room schedule per floor.
- Any trigger skips the opening build-up animation.

### Testing on a Quest over Wi-Fi

1. Put the computer and the headset on the same Wi-Fi network.
2. Run `npm run dev`. Vite prints a **Network** address such as `https://192.168.1.20:5173`.
3. In the Quest Browser, open that address. Choose **Advanced → Proceed** on the certificate warning (it is the dev server's self-signed certificate).
4. Open the Towers tab and press **ENTER VR**.

If the Network line is missing, allow Node.js through the Windows firewall for private networks.

To test without a headset, install the **Immersive Web Emulator** extension in desktop Chrome, open the dev URL, open DevTools → **WebXR** tab, then press ENTER VR.
