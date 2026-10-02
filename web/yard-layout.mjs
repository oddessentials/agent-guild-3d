// Where halls and heroes stand on the courtyard plate, as percentages.
// The plate is web/yard/court.webp. Heroes stand in front of a hall (larger y).

export const PLOTS = {
  anthropic: { x: 26, y: 33 },
  openai: { x: 66, y: 28 },
  google: { x: 78, y: 47 },
  xai: { x: 82, y: 71 },
  shell: { x: 18, y: 66 },
};

/** Clone and upgrade sessions share the cobbles in front of the well. */
export const CAMP = { x: 50, y: 60 };

export const MAX_SHOWN = 8;

const RING = [
  { x: 0, y: 5.6 },
  { x: -4.4, y: 8.2 },
  { x: 4.4, y: 8.4 },
  { x: -2.1, y: 10.8 },
  { x: 2.6, y: 11.1 },
  { x: -6.2, y: 11.4 },
  { x: 6.4, y: 11.6 },
  { x: 0.2, y: 13.6 },
];

function clamp(n) {
  return Math.max(6, Math.min(94, n));
}

/** github and agent-guild are tasks, not halls, so they rally at the well. */
export function groupKey(providerId) {
  if (PLOTS[providerId]) return providerId;
  if (!providerId || providerId === 'github' || providerId === 'agent-guild' || providerId === 'camp') return '__camp__';
  return providerId;
}

export function anchorForProvider(providerId, unknownIndex = 0) {
  if (providerId === '__camp__' || providerId === 'github' || providerId === 'agent-guild' || providerId === 'camp') {
    return { ...CAMP, camp: true };
  }
  if (PLOTS[providerId]) return { ...PLOTS[providerId], camp: false };
  const index = Number.isFinite(unknownIndex) && unknownIndex > 0 ? unknownIndex : 0;
  return { x: Math.min(90, 14 + index * 16), y: 90, camp: true };
}

/**
 * @param {{ id: string, providerId: string }[]} entries
 * @param {(providerId: string) => { x: number, y: number }} anchorFor
 * @returns {{ id: string, providerId: string, x: number, y: number, more: number }[]}
 */
export function layoutUnits(entries, anchorFor) {
  const groups = new Map();
  for (const entry of entries) {
    const key = groupKey(entry.providerId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const placed = [];
  for (const [key, list] of groups) {
    const origin = anchorFor(key);
    const shown = list.slice(0, MAX_SHOWN);
    const more = list.length - shown.length;
    shown.forEach((entry, index) => {
      const ring = RING[index];
      placed.push({
        id: entry.id,
        providerId: key,
        x: clamp(origin.x + ring.x),
        y: clamp(origin.y + ring.y),
        more: index === shown.length - 1 ? more : 0,
      });
    });
  }
  return placed;
}
