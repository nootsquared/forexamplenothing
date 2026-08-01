import { Formation, Role } from './formations';
import { SquadPlayer } from './roster';
import { StarPlayer, PLAYER_POOL, academyPlayer } from './players';

// The pre-match draft, as specced: coin flip, snake picks (ABBA), a budget
// deep enough for a GALAXY of stars, and role quotas so both sides leave
// with a real XI. Pure logic — the UI renders it, the tests drive it headless.

// Role quotas and budgets scale with the side size — 5s, 7s, or full 11s
export function quotaFor(size: number): Record<Role, number> {
  if (size === 5) return { GK: 1, DF: 2, MF: 1, FW: 1 };
  if (size === 7) return { GK: 1, DF: 3, MF: 2, FW: 1 };
  return { GK: 1, DF: 4, MF: 4, FW: 2 };
}
export function budgetFor(size: number): number {
  return size === 5 ? 90 : size === 7 ? 130 : 200;
}
export const QUOTA = quotaFor(11);
export const SQUAD_SIZE = 11;

export interface DraftSide {
  budget: number;
  picks: StarPlayer[];
  quota: Record<Role, number>;
  size: number;
}

export interface Draft {
  pool: StarPlayer[];
  sides: [DraftSide, DraftSide];
  order: (0 | 1)[]; // snake ABBA turns from the coin-flip winner
  turn: number;     // index into order; >= order.length = done
}

export function createDraft(first: 0 | 1, size = 11, snake = true): Draft {
  const order: (0 | 1)[] = [];
  let a: 0 | 1 = first;
  for (let round = 0; round < size; round++) {
    order.push(a, a === 0 ? 1 : 0);
    // snake (ABBA) for the market's money game; the wheel takes honest
    // one-each turns so nobody watches the CPU spin three in a row
    if (snake) a = a === 0 ? 1 : 0;
  }
  const side = (): DraftSide => ({ budget: budgetFor(size), picks: [], quota: quotaFor(size), size });
  return {
    pool: [...PLAYER_POOL].sort((x, y) => y.ovr - x.ovr),
    sides: [side(), side()],
    order,
    turn: 0,
  };
}

export function needsOf(side: DraftSide): Record<Role, number> {
  const left = { ...side.quota };
  for (const p of side.picks) left[p.role]--;
  return left;
}

// A pick is legal if the role is still needed and paying for it leaves
// enough to fill every remaining slot from the academy
export function canPick(side: DraftSide, player: StarPlayer): boolean {
  const needs = needsOf(side);
  if ((needs[player.role] ?? 0) <= 0) return false;
  const slotsAfter = side.size - side.picks.length - 1;
  return side.budget - player.price >= slotsAfter * 1.0;
}

export function pick(draft: Draft, poolIdx: number) {
  const who = draft.order[draft.turn];
  const player = draft.pool[poolIdx];
  const side = draft.sides[who];
  side.picks.push(player);
  side.budget = Math.round((side.budget - player.price) * 10) / 10;
  draft.pool.splice(poolIdx, 1);
  draft.turn++;
}

// The AI drafts on value: best OVR it can afford within quota, with a nudge
// toward covering the spine (GK and DF before the shelf runs bare)
export function aiPickIndex(draft: Draft): number {
  const who = draft.order[draft.turn];
  const side = draft.sides[who];
  const needs = needsOf(side);
  const roundsLeft = side.size - side.picks.length;
  let best = -1;
  let bestScore = -Infinity;
  draft.pool.forEach((p, i) => {
    if (!canPick(side, p)) return;
    let s = p.ovr + Math.random() * 2;
    if (p.role === 'GK' && needs.GK > 0 && roundsLeft <= 4) s += 8; // don't get caught without hands
    if (p.role === 'DF' && needs.DF >= roundsLeft - 2) s += 5;
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

// Nothing legal on the shelf this turn: take an academy body for a needed role
export function pickAcademy(draft: Draft, role: Role) {
  const who = draft.order[draft.turn];
  const side = draft.sides[who];
  const junior = academyPlayer(role, side.picks.length + 1);
  side.picks.push(junior);
  side.budget = Math.round((side.budget - junior.price) * 10) / 10;
  draft.turn++;
}

// A drafted XI laid onto any formation: exact roles first by OVR, then the
// nearest role fills what's left — a striker CAN play wide mid, just oddly
const ROLE_AXIS: Record<Role, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };
export function assignToFormation(picks: StarPlayer[], slots: { role: Role }[]): StarPlayer[] {
  const left = [...picks];
  return slots.map((slot) => {
    let best = -1;
    let bestScore = -Infinity;
    left.forEach((p, i) => {
      const s = -Math.abs(ROLE_AXIS[p.role] - ROLE_AXIS[slot.role]) * 100 + p.ovr;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    return left.splice(best, 1)[0];
  });
}

// Stars laid onto a shape as sim squad players wearing their REAL shirt
// numbers — collisions (two drafted tens) settle for the lowest free shirt
export function toSquad(stars: StarPlayer[], shape: Formation): SquadPlayer[] {
  const assigned = assignToFormation(stars, shape.slots);
  const worn = new Set<number>();
  return assigned.map((p, i) => {
    let number = p.number;
    if (number <= 0 || worn.has(number)) {
      number = 1;
      while (worn.has(number)) number++;
    }
    worn.add(number);
    return { number, name: p.name, role: shape.slots[i].role, stats: p.stats };
  });
}

// The UI's arranged XI, slot-for-slot: stars[i] PLAYS shape.slots[i] — no
// auto-assignment second-guessing the manager's drag-and-drop
export function toSquadOrdered(stars: StarPlayer[], shape: Formation): SquadPlayer[] {
  const worn = new Set<number>();
  return stars.map((p, i) => {
    let number = p.number;
    if (number <= 0 || worn.has(number)) {
      number = 1;
      while (worn.has(number)) number++;
    }
    worn.add(number);
    return { number, name: p.name, role: shape.slots[i].role, stats: p.stats };
  });
}

// Where a fresh signing stands: his own role's open slot first, else the
// nearest role still empty
export function bestOpenSlot(slots: { role: Role }[], taken: (number | null)[], role: Role): number {
  let best = -1;
  let bestScore = -Infinity;
  slots.forEach((s, i) => {
    if (taken[i] !== null) return;
    const score = -Math.abs(ROLE_AXIS[s.role] - ROLE_AXIS[role]) * 10 - i * 0.01;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// Quick match: the world's best dealt into two fair sides, alternating down
// each role's rank with an offset so neither side hoards every number one
export function quickSplit(size = 11): [StarPlayer[], StarPlayer[]] {
  const quota = quotaFor(size);
  const a: StarPlayer[] = [];
  const b: StarPlayer[] = [];
  (['GK', 'DF', 'MF', 'FW'] as Role[]).forEach((role, r) => {
    PLAYER_POOL.filter((p) => p.role === role)
      .sort((x, y) => y.ovr - x.ovr)
      .slice(0, quota[role] * 2)
      .forEach((p, i) => (((i + r) % 2 === 0) ? a : b).push(p));
  });
  return [a, b];
}

// Draft over (or a side priced out of a role): finish the XI from the academy
export function fillWithAcademy(side: DraftSide) {
  const needs = needsOf(side);
  let n = 1;
  (Object.keys(needs) as Role[]).forEach((role) => {
    for (let i = 0; i < needs[role]; i++) {
      const junior = academyPlayer(role, n++);
      side.picks.push(junior);
      side.budget = Math.round((side.budget - junior.price) * 10) / 10;
    }
  });
}
