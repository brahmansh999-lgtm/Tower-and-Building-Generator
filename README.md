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

- **Form:** base width (20–60 m), sway (0–30 m), twist (0–360°)
- **Cluster:** towers (1–5), links per connection (0–8), connection mode (pairs / all / chain)
- **Cuts:** plan level, section position and axis, and a toggle to slice the 3D model
- **Render (top right of the 3D view, in both studios):** STYLIZED (the line-drawing look) or REALISTIC; in realistic mode, a lighting preset (GOLDEN / DAY / DUSK / NIGHT) and a HERO camera

## Structure

- `src/geometry/generateTower.js` — the single geometry function; the 3D view, plan and section all read its output
- `src/views/Viewport3D.jsx` — Three.js model (stylized: unlit, shading baked into vertex colours) and the render-mode switch
- `src/views/PlanView.jsx`, `src/views/SectionView.jsx` — SVG drawings
- `src/ui/Controls.jsx` — parameter panel
- `src/geometry/generateVilla.js` — villa options, room partitioning, fit-out and suburban context
- `src/VillaStudio.jsx`, `src/views/Villa*.jsx`, `src/ui/VillaControls.jsx` — villa tab
- `src/geometry/buildVRMeshes.js` — VR geometry (ribbons, fin strips, bridge tubes, glow, walkable surfaces) built from the same generateTower() output
- `src/vr/` — VR session (towers) and VillaVRSession (villas), environment, interaction, control panel, drawing boards and intro
- `src/geometry/buildRealisticMeshes.js` — realistic-mode geometry (glass skin, slab edges, fins, terrace pockets, bridges, podium, crown, helipad, planting) from the same generateTower() output
- `src/geometry/buildRealisticVilla.js` — realistic-mode villa geometry (white ribbons, glazing, interiors, timber, pool, garden, planting) from the same generateVilla() output
- `src/render/` — realistic mode: materials and procedural textures, sky / sun / presets, city context, desktop post-processing, quality tiers and frame-rate guard, RealisticWorld (ties them together for the desktop view and VR, for towers or villas) and desktopRender (the mode switch both studios' 3D views use)

The layout adapts to phones: the model, controls and drawings stack in one scrolling column.

## VR (Towers and Villas)

An **ENTER VR** button appears at the bottom right of both studios when the browser supports immersive VR (Meta Quest Browser, Apple Vision Pro Safari, Chrome with a PC VR headset, or desktop Chrome with the Meta Immersive Web Emulator extension).

- **Tabletop (1:500):** the model stands on a glowing plinth at waist height. Grip (or trigger/pinch) and move a hand to rotate it; grab with both hands and pull apart to scale between 1:1000 and 1:200.
- **Human scale (1:1):** right stick forward aims a teleport arc, release to jump; right stick left/right snap-turns 30°. You can land on the ground, the podium roof, tower roofs and bridge roofs. With hand tracking, pinch-and-hold away from the menu to aim the arc.
- **Controls:** one wide three-column card that shows every control at once, with no scrolling: all the desktop sliders and buttons, plus scale mode, viewpoints, plan frame, context, smooth locomotion (off by default, with a comfort vignette), menu size (S / M / L) and a render-quality override. It is worn on your left wrist at the large (L) size by default; dock it to your left from the menu, and press **X** to hide or show it.
- **Villas in VR:** all twelve design options, target GFA, plan level and frame, section and cut. The tabletop is 1:100 (scale 1:250–1:30). At 1:1 you can walk the garden, both floors and the roof, with viewpoints for the garden, entrance, living room, upper floor, pool, roof and an aerial view.
- **Drawing boards:** the desktop plan (with the full fit-out and a "you are here" marker at human scale) and the section stand to your right and update live with the sliders. A data sheet to your left (hidden by default; turn it on with **SHOW · DATA**) lists the project figures: for towers, every tower, the current floor of each tower and every bridge; for villas, the brief figures and a room schedule per floor.
- Any trigger skips the opening build-up animation.

## Realistic mode (Towers and Villas)

The **STYLIZED | REALISTIC** toggle (top right of the 3D view, and at the top of the VR menu) switches the model to a lit, photoreal look, in both studios. The switch fades to black and back over about 0.6 s, without reloading or moving the camera. Desktop and VR share the setting. Every slider keeps working, and the plan and section drawings are unchanged. Stylized mode renders exactly as before.

- **Building:** a reflective blue-grey glass skin with a mullion grid that follows the floors, white-champagne slab edges and tapered fins, and 3–5 recessed planted terraces per tower that spiral up the facade. Fins rise past the roof as an open crown lattice, and the tallest tower has a helipad. The sky bridges are glass tubes with white ribs, a walkable deck and planting inside. The podium has curved glazing, a white sweeping canopy and a roof garden.
- **Lighting presets:** GOLDEN HOUR (default), DAY, DUSK and NIGHT. Each sets the sun, sky, haze and how many windows are lit. At night the windows, podium and bridge undersides glow, and the city has faint lights.
- **City:** blocks with window grids, asphalt streets with lane markings, pavements and trees, and a skyline that fades into the haze.
- **Glass:** see-through face-on and reflective at glancing angles, like real glazing. In the villas the furnished rooms show through by day and light up warm at dusk and night; the towers keep a mostly mirrored skin.
- **Villas:** white ribbon slabs and soffits, recessed full-height glazing, furnished interiors seen through the glass, timber floors and deck, a lit pool, lawn, boundary walls and planting, in a suburb of neighbouring houses. Every option and the GFA slider work in both modes.
- **HERO:** a low three-quarter view looking up at the building (for villas, from a garden corner with a clear view). Auto-rotate carries on from there.
- **Section cut:** CUT 3D MODEL cuts the realistic model too, showing the floor plates inside.
- **VR:** the same model, in tabletop and human scale. The opening animation becomes a sunrise while the tower assembles floor by floor. If the frame rate drops, quality steps down automatically (shadows, then planting, then resolution) and the menu shows **QUALITY AUTO-ADJUSTED**.

All textures are drawn in code, so there is nothing to download. Optionally, a CC0 HDRI at `public/hdri/sky_1k.hdr` is used for reflections if the sky reflection map cannot be generated on a device.

### Testing on a Quest over Wi-Fi

1. Put the computer and the headset on the same Wi-Fi network.
2. Run `npm run dev`. Vite prints a **Network** address such as `https://192.168.1.20:5173`.
3. In the Quest Browser, open that address. Choose **Advanced → Proceed** on the certificate warning (it is the dev server's self-signed certificate).
4. Open the Towers tab and press **ENTER VR**.

If the Network line is missing, allow Node.js through the Windows firewall for private networks.

To test without a headset, install the **Immersive Web Emulator** extension in desktop Chrome, open the dev URL, open DevTools → **WebXR** tab, then press ENTER VR.
