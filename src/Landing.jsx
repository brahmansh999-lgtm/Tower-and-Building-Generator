/**
 * Start screen: choose what to design. Each card carries a line-drawn preview
 * of its studio; the tab bar stays available afterwards to switch at any time.
 */

function TowerArt() {
  // two twisting towers with a sky link, drawn as floor bands
  const bands = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const y = 190 - t * 170;
    const sway = Math.sin(t * Math.PI * 1.5) * 10;
    const r = 16 * (1 + 0.08 * Math.sin(Math.PI * t)) * (1 - 0.12 * t);
    const twist = Math.cos(t * 2.2);
    bands.push(<ellipse key={`a${i}`} cx={70 + sway} cy={y} rx={r} ry={3.2 * Math.abs(twist) + 1} className="art-line" />);
    if (t < 0.86) bands.push(<ellipse key={`b${i}`} cx={130 - sway} cy={y} rx={r * 0.9} ry={3 * Math.abs(Math.sin(t * 2.4)) + 1} className="art-line" />);
  }
  return (
    <svg viewBox="0 0 200 210" className="art">
      <line x1="10" y1="196" x2="190" y2="196" className="art-ground" />
      {bands}
      <path d="M86,88 C100,96 104,96 116,88 L116,98 C104,104 100,104 86,98 Z" className="art-accent" />
      <path d="M84,58 C100,64 104,64 118,58 L118,66 C104,72 100,72 84,66 Z" className="art-accent" />
    </svg>
  );
}

function VillaArt() {
  // a fluid two-level villa in plan: ground band, offset upper band, pool
  return (
    <svg viewBox="0 0 200 210" className="art">
      <rect x="14" y="30" width="172" height="150" className="art-plot" />
      <path d="M36,128 C60,104 88,140 116,118 C140,100 160,112 168,124 C176,140 150,152 124,146 C96,160 70,132 48,150 C30,162 22,140 36,128 Z" className="art-fill" />
      <path d="M70,112 C92,92 120,120 146,98 C164,84 182,100 170,114 C158,128 134,116 116,132 C96,148 76,128 70,112 Z" className="art-line strong" />
      <path d="M40,68 C64,58 98,62 132,56 C142,55 146,64 136,68 C102,76 66,74 42,78 C34,79 32,71 40,68 Z" className="art-pool" />
      <line x1="100" y1="180" x2="100" y2="150" className="art-line" />
    </svg>
  );
}

export default function Landing({ onChoose }) {
  return (
    <div className="landing">
      <header className="landing-head">
        <div className="title">PARAMETRIC STUDIO</div>
        <div className="subtitle">CHOOSE WHAT TO DESIGN · SWITCH ANY TIME FROM THE TABS AT THE TOP</div>
      </header>
      <div className="landing-cards">
        <button type="button" className="landing-card" onClick={() => onChoose('towers')}>
          <TowerArt />
          <span className="card-kicker">01</span>
          <span className="card-title">DESIGN A TOWER</span>
          <span className="card-text">
            Twisted, swaying high-rise clusters with sculpted sky links, structural cores, furnished floor plates,
            urban context and live plan and section.
          </span>
          <span className="card-cta">OPEN TOWER STUDIO →</span>
        </button>
        <button type="button" className="landing-card" onClick={() => onChoose('villas')}>
          <VillaArt />
          <span className="card-kicker">02</span>
          <span className="card-title">DESIGN A VILLA</span>
          <span className="card-text">
            Twelve fluid, Zaha-Hadid-inspired villa options on one plot and one brief: same area, same programme,
            fully planned rooms, furniture, pool, landscape and section.
          </span>
          <span className="card-cta">OPEN VILLA STUDIO →</span>
        </button>
      </div>
    </div>
  );
}
