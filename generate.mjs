#!/usr/bin/env node
/**
 * Generates an animated "rocket over contribution grid" SVG using a GitHub
 * user's REAL contribution calendar (last 34 weeks, same layout as
 * GitHub's own heatmap: 34 columns x 7 rows).
 *
 * Env vars:
 *   GH_USERNAME  - GitHub login to fetch contributions for (required)
 *   GH_TOKEN     - token with access to the GraphQL API (required).
 *                  In Actions, the default GITHUB_TOKEN works fine since
 *                  contribution calendars are public data.
 *   OUTPUT_PATH  - where to write the SVG (default: dist/github-jet.svg)
 */

import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUTPUT = process.env.OUTPUT_PATH || "dist/github-jet.svg";
const COLS = 34; // weeks shown, matches the reference design
const ROWS = 7;
const CELL = 11;
const STEP = 14; // cell + gap
const GRID_X = 20;
const GRID_Y = 15;
const WIDTH = 513;
const HEIGHT = 170;
const ROCKET_X_START = 35;
const ROCKET_X_END = 478;
const LOOP_DUR = 20; // seconds, one full there-and-back pass
const MAX_TARGETS = 12; // how many "busiest" days the rocket fires on
const FLASH_COLOR = "#39d353";
const BULLET_COLOR = "#7ee787";
const BLAST_COLOR = "#56d364";
const PAD_Y = 128; // where bullets launch from (just under the grid)
const EASE = "0.42 0 0.58 1"; // ease-in-out, used for smooth flight motion

// Fixed dark-theme contribution palette (matches GitHub's own dark scheme).
// The GraphQL API's `color` field returns *light*-theme hex codes regardless
// of the caller's own theme, which is why cells used to render as pale
// squares on our dark card background. contributionLevel is theme-agnostic,
// so we map it ourselves.
const LEVEL_COLOR = {
  NONE: "#161b22",
  FIRST_QUARTILE: "#0e4429",
  SECOND_QUARTILE: "#006d32",
  THIRD_QUARTILE: "#26a641",
  FOURTH_QUARTILE: "#39d353",
};

if (!USERNAME) {
  console.error("Missing GH_USERNAME env var");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing GH_TOKEN / GITHUB_TOKEN env var");
  process.exit(1);
}

const QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

async function fetchWeeks() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

function buildCells(weeks) {
  // Take the most recent COLS weeks, left-padding with empty weeks if the
  // account is newer than COLS weeks old.
  const recent = weeks.slice(-COLS);
  const padCount = COLS - recent.length;
  const padded = Array.from({ length: padCount }, () => ({
    contributionDays: Array.from({ length: ROWS }, () => ({
      contributionCount: 0,
      contributionLevel: "NONE",
      date: null,
    })),
  })).concat(recent);

  const cells = [];
  padded.forEach((week, col) => {
    week.contributionDays.forEach((day, row) => {
      cells.push({
        col,
        row,
        x: GRID_X + col * STEP,
        y: GRID_Y + row * STEP,
        color: LEVEL_COLOR[day.contributionLevel] || LEVEL_COLOR.NONE,
        count: day.contributionCount || 0,
        date: day.date,
      });
    });
  });
  return cells;
}

function pickTargets(cells) {
  return [...cells]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TARGETS)
    .sort((a, b) => a.col - b.col || a.row - b.row);
}

// Map a column index to the keyTime fraction along ONE direction of travel
// (forward pass spans keyTime 0 -> 0.5, backward spans 0.5 -> 1).
function keyTimeForCol(col, direction) {
  const span = 0.46; // leave a little headroom at both ends
  const t = 0.02 + (col / (COLS - 1)) * span;
  return direction === "forward" ? t : 1 - t;
}

function fmt(n) {
  return Number(n.toFixed(4));
}

function buildGrid(cells, targets) {
  const targetKey = new Set(targets.map((t) => `${t.col}-${t.row}`));
  let svg = "";
  for (const c of cells) {
    const isTarget = targetKey.has(`${c.col}-${c.row}`);
    if (!isTarget) {
      svg += `<rect x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${c.color}"/>\n`;
      continue;
    }
    // Flash brighter twice: once as the rocket passes forward, once on the way back.
    // rise/fall are clamped to whatever gap actually exists before the next
    // keyTime (both the t1->t2 gap and the t2->1 tail) so keyTimes stay
    // strictly increasing even for edge columns where the forward and
    // backward passes land close together (e.g. the last column, where the
    // turnaround puts both hits ~0.04 apart).
    const tFwd = keyTimeForCol(c.col, "forward");
    const tBack = keyTimeForCol(c.col, "backward");
    const [t1, t2] = [Math.min(tFwd, tBack), Math.max(tFwd, tBack)];
    const safeGap = Math.min(t2 - t1, 1 - t2);
    const fall = Math.min(0.05, safeGap * 0.4);
    const rise = Math.min(0.01, fall * 0.3);
    svg += `<rect x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${c.color}">` +
      `<animate attributeName="fill" dur="${LOOP_DUR}s" repeatCount="indefinite" calcMode="spline" ` +
      `keyTimes="0;${fmt(t1)};${fmt(t1 + rise)};${fmt(t1 + fall)};${fmt(t2)};${fmt(t2 + rise)};${fmt(t2 + fall)};1" ` +
      `keySplines="${EASE};${EASE};${EASE};${EASE};${EASE};${EASE};${EASE}" ` +
      `values="${c.color};${c.color};${FLASH_COLOR};${c.color};${c.color};${FLASH_COLOR};${c.color};${c.color}"/>` +
      `</rect>\n`;
  }
  return svg;
}

function buildBulletsAndBlasts(targets) {
  let bullets = "";
  let blasts = "";
  const dur = 0.006;

  for (const dir of ["forward", "backward"]) {
    const ordered = dir === "forward" ? targets : [...targets].reverse();
    for (const c of ordered) {
      const t = keyTimeForCol(c.col, dir);
      // Clamp to (0, 1) so extreme columns (near col 0 or COLS-1, where the
      // backward/forward hit time sits close to the timeline start/end)
      // can't push a keyTime past the 0..1 bounds animate requires.
      const rise = Math.max(t - dur * 3, 0.0005);
      const arrive = t;
      const fadeEnd = Math.min(t + dur * 4, 0.9995);
      const cx = fmt(c.x + CELL / 2);
      const targetY = fmt(c.y + CELL / 2);

      bullets += `<circle cx="${cx}" cy="${PAD_Y}" r="2" fill="${BULLET_COLOR}" filter="url(#softGlow)">` +
        `<animate attributeName="cy" dur="${LOOP_DUR}s" repeatCount="indefinite" calcMode="spline" ` +
        `keyTimes="0;${fmt(rise)};${fmt(arrive)};1" keySplines="${EASE};${EASE};${EASE}" ` +
        `values="${PAD_Y};${PAD_Y};${targetY};${targetY}"/>` +
        `<animate attributeName="opacity" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
        `keyTimes="0;${fmt(rise)};${fmt(arrive)};${fmt(fadeEnd)};1" values="0;1;1;0;0"/>` +
        `</circle>\n`;

      blasts += `<circle cx="${cx}" cy="${targetY}" r="0" fill="url(#blastGlow)" opacity="0">` +
        `<animate attributeName="r" dur="${LOOP_DUR}s" repeatCount="indefinite" calcMode="spline" ` +
        `keyTimes="0;${fmt(arrive)};${fmt(fadeEnd)};1" keySplines="${EASE};${EASE};${EASE}" values="0;1;8;8"/>` +
        `<animate attributeName="opacity" dur="${LOOP_DUR}s" repeatCount="indefinite" calcMode="spline" ` +
        `keyTimes="0;${fmt(arrive)};${fmt(fadeEnd)};1" keySplines="${EASE};${EASE};${EASE}" values="0;0.85;0;0"/>` +
        `</circle>\n`;
    }
  }
  return { bullets, blasts };
}

function buildStars() {
  const pts = [
    [8, 20, 1.2], [8, 60, 1.6], [8, 100, 2.0],
    [505, 25, 1.2], [505, 70, 1.6], [505, 110, 2.0],
    [30, 164, 1.2], [483, 164, 1.6],
  ];
  return pts.map(([x, y, dur]) =>
    `<circle cx="${x}" cy="${y}" r="1.1" fill="#8b949e"><animate attributeName="opacity" values="0.2;1;0.2" dur="${dur}s" repeatCount="indefinite"/></circle>`
  ).join("\n");
}

// A small, smooth rocket: rounded fuselage + gradient fill + soft blurred
// engine glow. Travels the flight path with eased (not linear) motion so it
// accelerates/decelerates instead of moving at a constant robotic speed.
function buildRocket() {
  return `<g id="rocket">
  <g transform="translate(0,0)">
    <ellipse cx="0" cy="10" rx="5.5" ry="3.2" fill="#38bdf8" opacity="0.35" filter="url(#softGlow)">
      <animate attributeName="rx" values="4.5;6.5;4.5" dur="0.5s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.25;0.55;0.25" dur="0.5s" repeatCount="indefinite"/>
    </ellipse>
    <path d="M0,-15 C4.5,-9 4.5,3 2.6,8 L-2.6,8 C-4.5,3 -4.5,-9 0,-15 Z" fill="url(#rocketBody)" stroke="#0b3a55" stroke-width="0.6"/>
    <path d="M-2.6,8 L-6.5,14 L-2.2,10.5 Z" fill="#7c3aed"/>
    <path d="M2.6,8 L6.5,14 L2.2,10.5 Z" fill="#7c3aed"/>
    <circle cx="0" cy="-4" r="2.1" fill="#e0f2fe" opacity="0.9"/>
    <path d="M-1.8,9 C-1.8,12 0,16 0,16 C0,16 1.8,12 1.8,9 Z" fill="url(#flame)">
      <animate attributeName="opacity" values="0.7;1;0.75;0.95;0.7" dur="0.22s" repeatCount="indefinite"/>
    </path>
  </g>
  <animateTransform attributeName="transform" attributeType="XML" type="translate"
    dur="${LOOP_DUR}s" repeatCount="indefinite" calcMode="spline"
    keyTimes="0;0.5;1" keySplines="${EASE};${EASE}"
    values="${ROCKET_X_START}.00,140.00;${ROCKET_X_END}.00,140.00;${ROCKET_X_START}.00,140.00"/>
</g>`;
}

function buildDefs() {
  return `<defs>
  <linearGradient id="rocketBody" x1="0" y1="-15" x2="0" y2="8" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="#7ee7ff"/>
    <stop offset="55%" stop-color="#38bdf8"/>
    <stop offset="100%" stop-color="#1f6feb"/>
  </linearGradient>
  <linearGradient id="flame" x1="0" y1="8" x2="0" y2="16" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="#fef08a"/>
    <stop offset="45%" stop-color="#f59e0b"/>
    <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="blastGlow">
    <stop offset="0%" stop-color="${BLAST_COLOR}" stop-opacity="0.9"/>
    <stop offset="100%" stop-color="${BLAST_COLOR}" stop-opacity="0"/>
  </radialGradient>
  <filter id="softGlow" x="-150%" y="-150%" width="400%" height="400%">
    <feGaussianBlur stdDeviation="1.6" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>`;
}

function buildSvg(weeks) {
  const cells = buildCells(weeks);
  const targets = pickTargets(cells);
  const { bullets, blasts } = buildBulletsAndBlasts(targets);

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
${buildDefs()}
<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#0d1117"/>
${buildStars()}
<g id="grid">
${buildGrid(cells, targets)}</g>
<g id="blasts">
${blasts}</g>
<g id="bullets">
${bullets}</g>
${buildRocket()}
</svg>`;
}

async function main() {
  console.log(`Fetching contributions for ${USERNAME}...`);
  const weeks = await fetchWeeks();
  const svg = buildSvg(weeks);
  const outPath = path.resolve(OUTPUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
