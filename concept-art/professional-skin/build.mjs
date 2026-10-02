// Builds the Professional skin's graphics into web/skins/professional/.
// Run: node concept-art/professional-skin/build.mjs
// Every file is plain SVG, generated from the palette below so the set stays consistent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/skins/professional');
const PROVIDERS = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
  xai: '#14b8c4',
  shell: '#7c6cf0',
};
const LOCKED = '#8b929e';
const MODES = {
  light: { surface: '#ffffff', back: '#f1f3f6', border: '#d5dae1', line: '#e4e7ec', dot: '#cbd2db', accent: '#2563eb', grid: '#0f172a', gridOpacity: 0.075, glow: 0.07 },
  dark: { surface: '#171b23', back: '#11151b', border: '#2e3440', line: '#262c37', dot: '#3a4250', accent: '#5b8def', grid: '#ffffff', gridOpacity: 0.06, glow: 0.12 },
};

function write(rel, svg) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${svg.replace(/\n\s*/g, '')}\n`);
}

function random(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;

/** A smooth path through points (Catmull-Rom as cubic Béziers). */
function smooth(points) {
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[i - 1] ?? points[i], points[i], points[i + 1], points[i + 2] ?? points[i + 1]];
    d += `C${r1(p1[0] + (p2[0] - p0[0]) / 6)} ${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)} ${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return d;
}

/** Card art: a contour field with a few linked nodes. 640×400, transparent, cropped by the card. */
function banner(id, color, state) {
  const rand = random(id);
  const c = state === 'locked' ? LOCKED : color;
  const waves = Array.from({ length: 3 }, () => ({ f: 0.006 + rand() * 0.01, p: rand() * Math.PI * 2, a: 8 + rand() * 18 }));
  const lines = [];
  const contours = [];
  for (let i = 0; i < 11; i++) {
    const base = 18 + i * 37;
    const pts = [];
    for (let x = -40; x <= 680; x += 40) {
      const y = base + waves.reduce((sum, w, k) => sum + w.a * Math.sin(x * w.f * (1 + k * 0.35) + w.p + i * 0.32), 0);
      pts.push([x, y]);
    }
    contours.push(pts);
    const opacity = state === 'locked' ? 0.28 : 0.2 + 0.28 * Math.sin((i / 10) * Math.PI);
    lines.push(`<path d="${smooth(pts)}" stroke-opacity="${opacity.toFixed(2)}"/>`);
  }
  const nodes = [2, 4, 5, 7, 8].map((row, k) => {
    const pts = contours[row];
    const idx = 3 + Math.floor((k / 5) * 11 + rand() * 2);
    return pts[Math.min(idx, pts.length - 2)];
  });
  const glow = state === 'working' ? 0.5 : state === 'locked' ? 0.14 : 0.32;
  const [gx, gy] = [260 + rand() * 120, 150 + rand() * 80];
  const link = nodes.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');
  const dots = nodes.map(([x, y]) => (state === 'locked'
    ? `<circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="none" stroke="${c}" stroke-width="1.5"/>`
    : `<circle cx="${r1(x)}" cy="${r1(y)}" r="10" fill="${c}" fill-opacity="${state === 'working' ? 0.22 : 0.12}"/><circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="${c}"/>`)).join('');
  let pulse = '';
  if (state === 'working') {
    const y = 214;
    const d = `M0 ${y}H250l14-30 18 64 16-74 16 52 12-12H640`;
    pulse = `<path d="${d}" fill="none" stroke="${c}" stroke-width="8" stroke-opacity="0.18" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${d}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice">
    <defs>
      <radialGradient id="g" cx="${r1(gx)}" cy="${r1(gy)}" r="300" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${c}" stop-opacity="${glow}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/>
      </radialGradient>
      <pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse">
        <path d="M32 0H0V32" fill="none" stroke="${c}" stroke-opacity="0.12" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="640" height="400" fill="url(#p)"/>
    <rect width="640" height="400" fill="url(#g)"/>
    <g fill="none" stroke="${c}" stroke-width="1.3">${lines.join('')}</g>
    <path d="${link}" fill="none" stroke="${c}" stroke-opacity="${state === 'locked' ? 0.3 : 0.55}" stroke-width="1.2" stroke-dasharray="3 5"/>
    ${dots}${pulse}
  </svg>`;
}

// Vendor marks from @lobehub/icons-static-svg 1.95.1 (MIT), 24×24, drawn white.
const MARKS = {
  anthropic: 'M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z',
  openai: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
  google: 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z',
  xai: 'M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z',
};
const SHELL = '<g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 24l8 8-8 8M33 41h11"/></g>';

/** Provider icon: a rounded tile in the provider's colour with the vendor's mark in white. 64×64. */
function icon(id, color) {
  const mark = MARKS[id] ? `<path transform="translate(17 17) scale(1.25)" fill="#fff" fill-rule="evenodd" d="${MARKS[id]}"/>` : SHELL;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity="0.82"/>
    </linearGradient></defs>
    <rect width="64" height="64" rx="15" fill="#0b0d12"/>
    <rect width="64" height="64" rx="15" fill="url(#t)"/>
    <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="1.5"/>
    ${mark}
  </svg>`;
}

const lock = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="10" fill="#0f172a" fill-opacity="0.72"/>
  <rect x="0.5" y="0.5" width="39" height="39" rx="9.5" fill="none" stroke="#fff" stroke-opacity="0.16"/>
  <path d="M15 18v-3.2a5 5 0 0 1 10 0V18" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="12.5" y="18" width="15" height="11" rx="2.4" fill="#fff"/>
  <circle cx="20" cy="23" r="1.6" fill="#0f172a"/>
</svg>`;

/** Empty sessions: a terminal window waiting for its first session. 240×180. */
function emptyState(m) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180">
    <rect x="58" y="22" width="152" height="104" rx="10" fill="${m.back}" stroke="${m.border}"/>
    <rect x="30" y="42" width="168" height="116" rx="10" fill="${m.surface}" stroke="${m.border}"/>
    <path d="M30 66h168" stroke="${m.border}"/>
    <g fill="${m.dot}"><circle cx="44" cy="54" r="3.2"/><circle cx="55" cy="54" r="3.2"/><circle cx="66" cy="54" r="3.2"/></g>
    <path d="M46 86l7 6-7 6" fill="none" stroke="${m.accent}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="60" y="96" width="12" height="3" rx="1.5" fill="${m.accent}"/>
    <rect x="46" y="112" width="96" height="6" rx="3" fill="${m.line}"/>
    <rect x="46" y="126" width="64" height="6" rx="3" fill="${m.line}"/>
    <circle cx="192" cy="146" r="17" fill="${m.accent}"/>
    <path d="M192 138v16M184 146h16" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}

/** Page background: a dot grid that fades out down the page, with a soft accent glow at the top. 1600×1000. */
function page(m) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000">
    <defs>
      <pattern id="d" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.1" fill="${m.grid}" fill-opacity="${m.gridOpacity}"/></pattern>
      <radialGradient id="f" cx="800" cy="0" r="900" gradientTransform="matrix(1 0 0 0.62 0 0)" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff"/><stop offset="0.75" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <mask id="m"><rect width="1600" height="1000" fill="url(#f)"/></mask>
      <radialGradient id="g" cx="800" cy="-120" r="760" gradientTransform="matrix(1 0 0 0.45 0 -66)" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${m.accent}" stop-opacity="${m.glow}"/><stop offset="1" stop-color="${m.accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#d)" mask="url(#m)"/>
    <rect width="1600" height="1000" fill="url(#g)"/>
  </svg>`;
}

for (const [id, color] of Object.entries(PROVIDERS)) {
  for (const state of ['idle', 'working', 'locked']) write(`banners/${id}/${state}.svg`, banner(id, color, state));
  write(`icons/${id}.svg`, icon(id, color));
}
write('ui/lock.svg', lock);
write('ui/empty-state.svg', emptyState(MODES.dark));
write('ui/empty-state-light.svg', emptyState(MODES.light));
write('page.svg', page(MODES.dark));
write('page-light.svg', page(MODES.light));
console.log(`wrote ${OUT}`);
