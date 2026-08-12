import { describe, it } from 'vitest';
import { createMatch, advanceMatch } from '../src/match';
import { AI_PROFILES } from '../src/ai/blackboard';
import { leadTarget, passMargin } from '../src/ai/intercept';
import { FORMATIONS } from '../src/data/formations';
import { buildSquad } from '../src/data/roster';
import { PITCH } from '../src/sim/constants';
import { clamp, dist, vec, Vec2 } from '../src/core/math';

// DIAGNOSTIC HARNESS (temporary). Runs headless AI-vs-AI and measures:
//  A) possession spells + turnover taxonomy (deliberate steal vs error)
//  B) pass direction ledger + interception anatomy
//  C) carrier's true open options (ground truth + carrier's beliefs)
//  D) defender dilemma frequency (uncovered dangerous receivers / conflicted defenders)
//  E) run-engine census (which run ideas actually run, sprint gating)

const DT = 1 / 60;

interface Turnover { cause: string; sub: string }
interface Spell {
  team: 0 | 1; ticks: number; startAxis: number; maxAxis: number; endAxis: number;
  passes: number; shot: boolean; wonBy: string; ftAt: number; // ticks until final third, -1 never
}

function pct(a: number, b: number): string {
  return b === 0 ? '-' : ((100 * a) / b).toFixed(1) + '%';
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// perp distance from point to segment a→b
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const L2 = abx * abx + aby * aby;
  if (L2 < 1e-9) return dist(p, a);
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / L2, 0, 1);
  return dist(p, vec(a.x + abx * t, a.y + aby * t));
}

function runDiag(label: string, cfg: Parameters<typeof createMatch>[0], minutes: number) {
  const match = createMatch(cfg);
  const w = match.world;
  const bb = match.teamBrains;
  const ticks = Math.round(minutes * 3600);

  // A) spells & turnovers
  const spells: Spell[] = [];
  const turnovers: Turnover[] = [];
  let curTeam: 0 | 1 = w.lastTouch?.team ?? 0;
  let spell: Spell = { team: curTeam, ticks: 0, startAxis: bb[curTeam].axisOf(w.ball.pos.x), maxAxis: 0, endAxis: 0, passes: 0, shot: false, wonBy: 'kickoff', ftAt: -1 };
  spell.maxAxis = spell.startAxis;
  let flipSince = -1;
  const recentEvents: { kind: string; tick: number }[] = [];

  const closeSpell = (cause: string, sub: string) => {
    spell.endAxis = bb[curTeam].axisOf(w.ball.pos.x);
    spells.push(spell);
    turnovers.push({ cause, sub });
    curTeam = curTeam === 0 ? 1 : 0;
    spell = { team: curTeam, ticks: 0, startAxis: bb[curTeam].axisOf(w.ball.pos.x), maxAxis: bb[curTeam].axisOf(w.ball.pos.x), endAxis: 0, passes: 0, shot: false, wonBy: cause, ftAt: -1 };
    flipSince = -1;
  };

  // B) pass ledger
  interface OpenPass {
    team: 0 | 1; idx: number; tick: number; from: Vec2; dirClass: 'fwd' | 'lat' | 'back';
    shot: boolean; marginAtLaunch: number; oppSnap: Vec2[];
  }
  let openPass: OpenPass | null = null;
  const passes = { fwd: [0, 0], lat: [0, 0], back: [0, 0] } as Record<string, [number, number]>; // [attempted, completed]
  let interceptStood = 0, interceptMoved = 0, interceptDeadAtLaunch = 0, interceptTotal = 0;

  // C) options samples
  const optTruthOpen: number[] = [], optTruthFwd: number[] = [], optTruthPen: number[] = [];
  const optBeliefOpen: number[] = [], optBeliefFwd: number[] = [];
  let optSamples = 0, zeroFwdTruth = 0, zeroPenTruth = 0, zeroFwdBelief = 0;
  const bestFwdMargins: number[] = [];

  // D) dilemma samples
  let dilemmaSamples = 0, samplesWithFree = 0, conflictedSamples = 0;
  const freeCounts: number[] = [];

  // E) run census
  const runCounts: Record<string, number> = {};
  let runSamples = 0, sprintingRuns = 0, linebreakGated = 0, linebreakTotal = 0;
  let loadedTicks = 0, attackTicks = 0;
  const linebreakSep: number[] = [];

  // F) completion by launch margin (non-shot passes)
  const marginBuckets: Record<string, [number, number]> = {
    '<0': [0, 0], '0-0.15': [0, 0], '0.15-0.35': [0, 0], '0.35-0.6': [0, 0], '>0.6': [0, 0],
  };
  const bucketOf = (m: number) => (m < 0 ? '<0' : m < 0.15 ? '0-0.15' : m < 0.35 ? '0.15-0.35' : m < 0.6 ? '0.35-0.6' : '>0.6');

  const liveNow = () => w.restartLock <= 0 && w.ceremony === 'live' && !w.awaitingRestart;

  for (let t = 0; t < ticks; t++) {
    advanceMatch(match, DT);
    for (const e of w.events) recentEvents.push({ kind: e.kind, tick: t });
    while (recentEvents.length && recentEvents[0].tick < t - 90) recentEvents.shift();

    // ---- events of this tick ----
    for (const e of w.events) {
      if (e.kind === 'kick') {
        const team = w.players[e.idx].id.team;
        const sp = w.ball.speed();
        if (sp > 1) {
          const sign = w.attackSign(team);
          const cos = (w.ball.vel.x * sign) / sp;
          const dirClass = cos > 0.42 ? 'fwd' : cos < -0.42 ? 'back' : 'lat';
          // shot? replicate classifyKick
          const goalX = w.goalXOf(team);
          const toward = sign > 0 ? w.ball.vel.x > 3 : w.ball.vel.x < -3;
          const dGoal = Math.abs(goalX - w.ball.pos.x);
          let shot = false;
          if (toward && dGoal <= 38) {
            const yAtLine = w.ball.pos.y + w.ball.vel.y * (dGoal / Math.abs(w.ball.vel.x));
            shot = Math.abs(yAtLine - PITCH.width / 2) < PITCH.goalWidth / 2 + 5;
          }
          if (shot) spell.shot = true;
          // intended receiver ≈ teammate nearest the flight line, ahead of the kick
          const dLen = sp;
          let margin = 9;
          let found = false;
          for (let i = 0; i < w.players.length; i++) {
            const mate = w.players[i];
            if (mate.id.team !== team || i === e.idx || mate.id.role === 'GK') continue;
            const tox = mate.pos.x - w.ball.pos.x, toy = mate.pos.y - w.ball.pos.y;
            const along = (tox * w.ball.vel.x + toy * w.ball.vel.y) / dLen;
            const perp = Math.abs(tox * w.ball.vel.y - toy * w.ball.vel.x) / dLen;
            if (along < 2 || perp > 7) continue;
            const meet = leadTarget(w.ball.pos, mate.pos, mate.vel, sp);
            const opps = w.players.filter((q) => q.id.team !== team).map((q) => q.pos);
            const m = passMargin(w.ball.pos, meet, sp, opps);
            if (!found || m > margin) { margin = m; found = true; }
          }
          const oppSnap = w.players.filter((q) => q.id.team !== team).map((q) => vec(q.pos.x, q.pos.y));
          openPass = { team, idx: e.idx, tick: t, from: vec(w.ball.pos.x, w.ball.pos.y), dirClass, shot, marginAtLaunch: found ? margin : -9, oppSnap };
          if (!shot) { passes[dirClass][0]++; spell.passes++; }
        }
      }
      if (e.kind === 'restart') {
        if (e.team !== curTeam) {
          const sub = e.restart;
          const cause = e.restart === 'offside' ? 'offside' : e.restart === 'freekick' ? 'foul' : 'outOfPlay';
          closeSpell(cause, sub);
        }
        openPass = null;
      }
      if (e.kind === 'goal') closeSpell('goal', 'goal');
    }

    // pass resolution: someone else touched it
    if (openPass && w.lastTouch && w.lastTouch.idx !== openPass.idx) {
      const p = openPass;
      if (!p.shot && p.marginAtLaunch > -9) {
        const b = marginBuckets[bucketOf(p.marginAtLaunch)];
        b[0]++;
        if (w.lastTouch.team === p.team) b[1]++;
      }
      if (w.lastTouch.team === p.team) {
        if (!p.shot) passes[p.dirClass][1]++;
      } else if (!p.shot) {
        interceptTotal++;
        if (p.marginAtLaunch < 0) interceptDeadAtLaunch++;
        // which opponent picked it off, and was he already standing in the lane?
        const takerIdx = w.lastTouch.idx;
        const takerTeamIdx = w.players.filter((q) => q.id.team !== p.team).findIndex((q) => q === w.players[takerIdx]);
        if (takerTeamIdx >= 0) {
          const at = p.oppSnap[takerTeamIdx];
          const d = segDist(at, p.from, w.ball.pos);
          if (d < 2.2) interceptStood++; else interceptMoved++;
        }
      }
      openPass = null;
    }

    // ---- flip confirmation ----
    if (liveNow()) {
      const latchTeam = w.carrier ? w.players[w.carrier.idx].id.team : null;
      const holder = latchTeam ?? w.lastTouch?.team ?? curTeam;
      if (holder === curTeam) flipSince = -1;
      else {
        if (flipSince < 0) flipSince = t;
        const confirmed = latchTeam !== null && latchTeam !== curTeam ? true : t - flipSince >= 30;
        if (confirmed) {
          const recent = (k: string) => recentEvents.some((r) => r.kind === k && r.tick > t - 45);
          const kickRecent = recentEvents.some((r) => r.kind === 'kick' && r.tick > t - 90);
          if (recent('steal')) closeSpell('steal', 'steal');
          else if (recent('save') || recent('parry')) closeSpell('keeper', 'keeper');
          else if (kickRecent) closeSpell('interception', 'interception');
          else closeSpell('scramble', 'scramble');
        }
      }
    }
    spell.ticks++;
    spell.maxAxis = Math.max(spell.maxAxis, bb[curTeam].axisOf(w.ball.pos.x));
    if (spell.ftAt < 0 && spell.maxAxis > PITCH.length * (2 / 3)) spell.ftAt = spell.ticks;

    // ---- 10Hz samples: options + dilemma ----
    if (t % 6 === 0 && liveNow() && w.carrier) {
      const ci = w.carrier.idx;
      const carrier = w.players[ci];
      const team = carrier.id.team;
      const myBB = bb[team];
      const myAxis = myBB.axisOf(carrier.pos.x);
      const oppsTruth = w.players.filter((q) => q.id.team !== team).map((q) => q.pos);
      const oppsBelief: Vec2[] = (match.brains[ci] as unknown as { oppBuf: Vec2[] }).oppBuf;
      const evalOptions = (opps: Vec2[]) => {
        let open = 0, fwd = 0, pen = 0, bestFwdMargin = -9;
        for (let i = 0; i < w.players.length; i++) {
          const p = w.players[i];
          if (p.id.team !== team || i === ci || p.id.role === 'GK') continue;
          const d = dist(carrier.pos, p.pos);
          if (d < 4 || d > 48) continue;
          if (myBB.axisOf(p.pos.x + p.vel.x * 0.25) > myBB.offsideSafeAxis() - 0.4) continue;
          const speedWanted = clamp(10 + d * 0.5, 11, 23);
          const meet = leadTarget(carrier.pos, p.pos, p.vel, speedWanted);
          const m = passMargin(carrier.pos, meet, speedWanted, opps);
          if (m < 0.15) continue;
          open++;
          const gain = myBB.axisOf(meet.x) - myAxis;
          if (gain > 5) { fwd++; bestFwdMargin = Math.max(bestFwdMargin, m); }
          if (gain > 12) pen++;
        }
        return { open, fwd, pen, bestFwdMargin };
      };
      const truth = evalOptions(oppsTruth);
      const belief = evalOptions(oppsBelief);
      optSamples++;
      optTruthOpen.push(truth.open); optTruthFwd.push(truth.fwd); optTruthPen.push(truth.pen);
      optBeliefOpen.push(belief.open); optBeliefFwd.push(belief.fwd);
      if (truth.fwd === 0) zeroFwdTruth++;
      if (truth.pen === 0) zeroPenTruth++;
      if (belief.fwd === 0) zeroFwdBelief++;
      if (truth.bestFwdMargin > -9) bestFwdMargins.push(truth.bestFwdMargin);

      // D) dilemma: open receivers ahead of the ball with nobody covering
      const defTeam = team === 0 ? 1 : 0;
      const defenders = w.players.filter((q) => q.id.team === defTeam && q.id.role !== 'GK');
      const ballAxis = myBB.axisOf(w.ball.pos.x);
      const dangerous: { meet: Vec2; covered: boolean; nearestDef: number }[] = [];
      for (let i = 0; i < w.players.length; i++) {
        const p = w.players[i];
        if (p.id.team !== team || i === ci || p.id.role === 'GK') continue;
        if (myBB.axisOf(p.pos.x + p.vel.x * 0.25) > myBB.offsideSafeAxis() - 0.4) continue;
        const d = dist(carrier.pos, p.pos);
        if (d < 4 || d > 48) continue;
        const speedWanted = clamp(10 + d * 0.5, 11, 23);
        const meet = leadTarget(carrier.pos, p.pos, p.vel, speedWanted);
        const m = passMargin(carrier.pos, meet, speedWanted, oppsTruth);
        if (m < 0.15) continue;
        const gain = myBB.axisOf(meet.x) - ballAxis;
        const nearGoal = dist(meet, myBB.goalWeAttack()) < 30;
        if (gain < 3 && !nearGoal) continue; // not a forward threat
        let covered = false;
        let nearestDef = 99;
        for (const dfd of defenders) {
          nearestDef = Math.min(nearestDef, dist(dfd.pos, meet));
          if (dist(dfd.pos, meet) < 4 || segDist(dfd.pos, carrier.pos, meet) < 2.2) { covered = true; }
        }
        dangerous.push({ meet, covered, nearestDef });
      }
      dilemmaSamples++;
      const free = dangerous.filter((d) => !d.covered).length;
      freeCounts.push(free);
      if (free >= 1) samplesWithFree++;
      // conflicted defender: nearest defender shared by two uncovered-or-covered threats far apart
      const uncov = dangerous.filter((d) => !d.covered);
      let conflicted = false;
      for (let a = 0; a < uncov.length && !conflicted; a++) {
        for (let b = a + 1; b < uncov.length && !conflicted; b++) {
          if (dist(uncov[a].meet, uncov[b].meet) > 7) conflicted = true;
        }
      }
      if (conflicted) conflictedSamples++;
    }

    // ---- 2Hz run census ----
    if (t % 30 === 0 && liveNow()) {
      for (const side of [0, 1] as const) {
        if (bb[side].phase !== 'attack') continue;
        attackTicks++;
        if (bb[side].carrierLoaded) loadedTicks++;
        for (let i = 0; i < w.players.length; i++) {
          const p = w.players[i];
          if (p.id.team !== side || p.id.role === 'GK' || i === bb[side].possessorIdx) continue;
          const brain = match.brains[i] as unknown as { run: string; runFree: number; intent: { kind: string } };
          if (brain.intent.kind !== 'run') continue;
          runSamples++;
          runCounts[brain.run] = (runCounts[brain.run] ?? 0) + 1;
          if (p.isSprinting) sprintingRuns++;
          if (brain.run === 'linebreak') {
            linebreakTotal++;
            if (brain.runFree <= 0 && !bb[side].carrierLoaded) linebreakGated++;
            let sep = 99;
            for (const q of w.players) {
              if (q.id.team !== side && q.id.role !== 'GK') sep = Math.min(sep, dist(q.pos, p.pos));
            }
            linebreakSep.push(sep);
          }
        }
      }
    }
  }

  // ---- report ----
  const s = match.stats;
  const causes: Record<string, number> = {};
  for (const t of turnovers) causes[t.cause] = (causes[t.cause] ?? 0) + 1;
  const nT = turnovers.length;
  const spellSecs = spells.map((sp) => sp.ticks / 60);
  const netGain = spells.map((sp) => sp.endAxis - sp.startAxis);
  const maxGain = spells.map((sp) => sp.maxAxis - sp.startAxis);
  const finalThird = spells.filter((sp) => sp.maxAxis > PITCH.length * (2 / 3)).length;
  const withShot = spells.filter((sp) => sp.shot).length;

  const lines = [
    `\n===== ${label} (${minutes} sim-min) =====`,
    `score ${w.score.left}-${w.score.right} | shots ${s.shots[0]}/${s.shots[1]} (on ${s.onTarget[0]}/${s.onTarget[1]}) | poss ${pct(s.possession[0], s.possession[0] + s.possession[1])} | passes ${s.passes[0] + s.passes[1]} good ${s.passesGood[0] + s.passesGood[1]} | tackles ${s.tacklesWon[0] + s.tacklesWon[1]}`,
    `SPELLS n=${spells.length} medianSec=${median(spellSecs).toFixed(1)} meanSec=${mean(spellSecs).toFixed(1)} | meanNetAxisGain=${mean(netGain).toFixed(1)}m meanMaxGain=${mean(maxGain).toFixed(1)}m | reachFinalThird=${pct(finalThird, spells.length)} | endInShot=${pct(withShot, spells.length)}`,
    `TURNOVERS n=${nT}: ` + Object.entries(causes).map(([k, v]) => `${k}=${v} (${pct(v, nT)})`).join('  '),
    `  interceptions: total=${interceptTotal} deadAtLaunch=${pct(interceptDeadAtLaunch, interceptTotal)} stoodInLane=${pct(interceptStood, interceptTotal)} movedToWin=${pct(interceptMoved, interceptTotal)}`,
    `PASSES fwd=${passes.fwd[0]} (${pct(passes.fwd[1], passes.fwd[0])} ok) lat=${passes.lat[0]} (${pct(passes.lat[1], passes.lat[0])} ok) back=${passes.back[0]} (${pct(passes.back[1], passes.back[0])} ok) | fwdShare=${pct(passes.fwd[0], passes.fwd[0] + passes.lat[0] + passes.back[0])}`,
    `OPTIONS (${optSamples} samples @10Hz): truth open=${mean(optTruthOpen).toFixed(2)} fwd+5m=${mean(optTruthFwd).toFixed(2)} pen+12m=${mean(optTruthPen).toFixed(2)} | zeroFwd=${pct(zeroFwdTruth, optSamples)} zeroPen=${pct(zeroPenTruth, optSamples)} | belief open=${mean(optBeliefOpen).toFixed(2)} fwd=${mean(optBeliefFwd).toFixed(2)} zeroFwd=${pct(zeroFwdBelief, optSamples)} | bestFwdMargin med=${median(bestFwdMargins).toFixed(2)}s`,
    `DILEMMA (${dilemmaSamples} samples): freeDangerous mean=${mean(freeCounts).toFixed(2)} | samplesWithFree>=1: ${pct(samplesWithFree, dilemmaSamples)} | twoFreeFarApart: ${pct(conflictedSamples, dilemmaSamples)}`,
    `RUNS (${runSamples} player-samples @2Hz in attack): ` + Object.entries(runCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${pct(v, runSamples)}`).join(' ') + ` | sprinting=${pct(sprintingRuns, runSamples)} | linebreak gated=${pct(linebreakGated, linebreakTotal)} | carrierLoaded duty=${pct(loadedTicks, attackTicks)}`,
    `LINEBREAK SEP: median=${median(linebreakSep).toFixed(1)}m mean=${mean(linebreakSep).toFixed(1)}m | >3m=${pct(linebreakSep.filter((x) => x > 3).length, linebreakSep.length)} >5m=${pct(linebreakSep.filter((x) => x > 5).length, linebreakSep.length)}`,
    `MARGIN→COMPLETION: ` + Object.entries(marginBuckets).map(([k, [a, c]]) => `${k}: ${c}/${a} (${pct(c, a)})`).join('  '),
    `PAYOFF BY HOW WON: ` + ['steal', 'interception', 'scramble'].map((cause) => {
      const set = spells.filter((sp) => sp.wonBy === cause);
      const ft = set.filter((sp) => sp.ftAt >= 0);
      const shot = set.filter((sp) => sp.shot);
      const med = median(ft.map((sp) => sp.ftAt / 60));
      return `${cause}: n=${set.length} reachFT=${pct(ft.length, set.length)} medSecToFT=${ft.length ? med.toFixed(1) : '-'} shot=${pct(shot.length, set.length)}`;
    }).join('  |  '),
  ];
  console.log(lines.join('\n'));
}

// Skipped by default: this is the measurement instrument for the off-ball
// threat work, not a regression test. Re-enable to compare before/after.
describe('gameplay diagnosis', () => {
  it.skip('measures the combined game', { timeout: 600_000 }, () => {
    runDiag('base 4-3-3 v 4-4-2 SHARP', {}, 12);
    runDiag('away MEDIUM profile', { awayProfile: AI_PROFILES[1] }, 12);
    runDiag('alt 3-5-2 v 4-2-3-1 SHARP', {
      homeShape: '3-5-2', awayShape: '4-2-3-1',
      homeSquad: buildSquad(FORMATIONS['3-5-2'], 707),
      awaySquad: buildSquad(FORMATIONS['4-2-3-1'], 808),
    }, 12);
  });
});
