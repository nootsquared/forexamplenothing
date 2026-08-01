import { vec } from './core/math';
import { World } from './sim/world';
import { PlayerBody, PlayerInput } from './sim/player';
import { PITCH } from './sim/constants';
import { FORMATIONS, Formation } from './data/formations';
import { buildSquad } from './data/roster';
import { TeamBrain } from './ai/blackboard';
import { Brain } from './ai/brain';

// A full 11v11: bodies, team blackboards, and a brain for every body.
// The browser and the headless tests assemble the exact same match.

export interface Match {
  world: World;
  teamBrains: [TeamBrain, TeamBrain];
  brains: Brain[];
}

export function createMatch(homeShape = '4-3-3', awayShape = '4-4-2'): Match {
  const world = new World();
  fieldTeam(world, 0, FORMATIONS[homeShape], 101);
  fieldTeam(world, 1, FORMATIONS[awayShape], 202);
  const teamBrains: [TeamBrain, TeamBrain] = [new TeamBrain(0), new TeamBrain(1)];
  const brains = world.players.map((p, i) => new Brain(i, teamBrains[p.id.team]));
  return { world, teamBrains, brains };
}

// One fixed tick: blackboards read the world, brains emit inputs, humans
// override theirs, the sim steps. AI and people share one interface.
export function advanceMatch(match: Match, dt: number, overrides: Record<number, PlayerInput> = {}) {
  match.teamBrains[0].update(match.world, dt);
  match.teamBrains[1].update(match.world, dt);
  const inputs = match.world.players.map((_, i) => overrides[i] ?? match.brains[i].tick(match.world, dt));
  match.world.step(dt, inputs);
}

// Kickoff spots: the formation squeezed into its own half
function fieldTeam(world: World, team: 0 | 1, formation: Formation, seed: number) {
  const squad = buildSquad(formation, seed);
  formation.slots.forEach((slot, i) => {
    const axis = 2.5 + slot.x * 46; // meters out from our own goal line
    const x = team === 0 ? axis : PITCH.length - axis;
    const y = slot.y * PITCH.width;
    world.players.push(new PlayerBody(vec(x, y), squad[i].stats, {
      team, role: slot.role, anchor: vec(slot.x, slot.y), number: squad[i].number,
    }));
  });
}
