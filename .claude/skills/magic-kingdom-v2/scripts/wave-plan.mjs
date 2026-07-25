#!/usr/bin/env node
// wave-plan.mjs — DETERMINISTIC wave + install-order derivation for MK V2.
//
// The line: reading the plan to decide WHICH files each phase touches is judgment (AI).
// Turning that file map into build waves + a serial install order is a pure graph problem
// — so it lives here, where the same input always yields the same output. The AI produces
// the manifest; this script produces the waves. No LLM re-derivation, no drift.
//
// A FILE COLLISION IS A DEPENDENCY. Two phases that touch the same file are not merely
// "don't build these together" — the second one must build ON TOP of the first, because
// SKILL.md's own rule is "a phase depends on every phase that creates or heavily modifies a
// file it also touches". Splitting them into different waves but leaving the later phase's
// build base at bare origin/main means it never sees its sibling's edits to the shared file:
// it may not compile, and it is GUARANTEED to conflict when the jig rebases it after the
// sibling merges — burning the ≤2 refit budget on exactly the clash the wave split existed to
// avoid, and possibly ending held. So every collision becomes a real dependency edge here,
// oriented earlier-plan-phase-first, and that edge then drives waves, install order, AND the
// emitted build base.
//
// Usage:   node wave-plan.mjs <manifest.json>
// Manifest: { "phases": [ { "id":"P1", "files":["a.ts","b.ts"], "deps":["P0"],
//                           "migration": true, "planIndex": 0 } ] }
//   - files   : repo-relative paths this phase creates/edits (the collision key)
//   - deps    : phase ids that must be INSTALLED before this one (dependency edges)
//   - migration (optional): does this phase carry a schema migration (install-order tiebreak)
//   - planIndex (optional): stable order from the plan; defaults to array position
//
// Output (stdout, JSON):
//   { collisions, collisionDeps, effectiveDeps, buildBases, waves, installOrder, warnings }
//   collisionDeps= the edges INFERRED from shared files: [{dependent, dependsOn, files}]. Read
//                  these — they are the ones you did not write in the manifest.
//   effectiveDeps= per phase, explicit deps + inferred collision deps (what everything below uses)
//   buildBases   = per phase, the branch(es) its worktree must be created from. This is the
//                  load-bearing value the supervisor needs and must not hand-derive:
//                  {phase, base:"origin/main"} | {phase, base:"<dep>", from:"branch"} |
//                  {phase, base:"integration", mergeOf:[...]}   (direct deps only — a dep's own
//                  base is already in its branch, so transitive deps need no re-merge)
//   waves        = parallel BUILD groups: within a wave, no two phases share a file AND no
//                  phase depends on another in the same/later wave.
//   installOrder = serial MERGE order: a topological sort, migration-bearing phases pulled
//                  earliest among ready peers, then lowest planIndex.
//
// Exit: 0 ok · 2 malformed input · 3 dependency cycle.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

export function derive(manifest) {
  if (!manifest || !Array.isArray(manifest.phases)) fail(2, 'manifest.phases must be an array');
  const phases = manifest.phases.map((p, i) => ({
    id: String(p.id),
    files: Array.isArray(p.files) ? p.files.map(String) : [],
    deps: Array.isArray(p.deps) ? p.deps.map(String) : [],
    migration: !!p.migration,
    planIndex: Number.isFinite(p.planIndex) ? p.planIndex : i,
  }));
  const ids = new Set(phases.map(p => p.id));
  if (ids.size !== phases.length) fail(2, 'duplicate phase id');
  const byId = new Map(phases.map(p => [p.id, p]));
  const warnings = [];
  for (const p of phases) for (const d of p.deps)
    if (!ids.has(d)) fail(2, `phase ${p.id} depends on unknown phase ${d}`);

  // --- collision graph: two phases collide iff their file sets intersect ---
  const collisions = [];
  const collidesWith = new Map(phases.map(p => [p.id, new Set()]));
  for (let i = 0; i < phases.length; i++) for (let j = i + 1; j < phases.length; j++) {
    const a = phases[i], b = phases[j];
    const shared = a.files.filter(f => b.files.includes(f));
    if (shared.length) {
      collisions.push({ a: a.id, b: b.id, files: shared });
      collidesWith.get(a.id).add(b.id);
      collidesWith.get(b.id).add(a.id);
    }
  }

  // --- COLLISION ⇒ DEPENDENCY -------------------------------------------------------------
  // A shared file is a build-order constraint, not just a "keep them apart" hint: the later
  // phase must branch off the earlier one or it never sees its edits. Orient each collision
  // earlier-planIndex-first and record it as a real edge. Skip a pair the explicit deps already
  // order (in EITHER direction, transitively) — re-adding it in the opposite direction would
  // manufacture a cycle out of a plan that is perfectly consistent.
  const explicitDeps = new Map(phases.map(p => [p.id, [...p.deps]]));
  const deps = new Map(phases.map(p => [p.id, [...p.deps]]));   // effective (grows below)
  const mustPrecede = (id) => {                                  // transitive closure of deps
    const seen = new Set(), stack = [...(deps.get(id) || [])];
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      for (const dd of deps.get(d) || []) stack.push(dd);
    }
    return seen;
  };
  const collisionDeps = [];
  const pairs = [...collisions].sort((x, y) =>
    (byId.get(x.a).planIndex - byId.get(y.a).planIndex) || (byId.get(x.b).planIndex - byId.get(y.b).planIndex));
  for (const c of pairs) {
    const [lo, hi] = byId.get(c.a).planIndex <= byId.get(c.b).planIndex ? [c.a, c.b] : [c.b, c.a];
    if (mustPrecede(hi).has(lo) || mustPrecede(lo).has(hi)) continue;   // already ordered
    deps.get(hi).push(lo);
    collisionDeps.push({ dependent: hi, dependsOn: lo, files: c.files });
  }

  // --- BUILD WAVES: dependency layers over the EFFECTIVE deps -------------------------------
  // A phase is eligible once every effective dep is in an EARLIER wave. Because a collision is
  // now an edge, colliding phases cannot land in one wave — the collision check below is kept
  // only as an assertion that this holds.
  const waveOf = new Map();
  const ordered = [...phases].sort((a, b) => a.planIndex - b.planIndex);
  let w = 0;
  const remaining = new Set(phases.map(p => p.id));
  let guard = phases.length + 1;
  while (remaining.size && guard-- > 0) {
    const wave = [];
    for (const p of ordered) {
      if (!remaining.has(p.id)) continue;
      const depsReady = deps.get(p.id).every(d => waveOf.has(d) && waveOf.get(d) < w);
      if (!depsReady) continue;
      if (wave.some(q => collidesWith.get(p.id).has(q))) continue; // must never fire now
      wave.push(p.id);
    }
    if (!wave.length) fail(3, 'dependency cycle or unsatisfiable deps: ' + [...remaining].join(','));
    for (const id of wave) { waveOf.set(id, w); remaining.delete(id); }
    w++;
  }
  if (remaining.size) fail(3, 'dependency cycle: ' + [...remaining].join(','));
  const waves = [];
  for (const [id, wv] of waveOf) (waves[wv] ||= []).push(id);
  for (const wv of waves) wv.sort((a, b) => byId.get(a).planIndex - byId.get(b).planIndex);

  // --- INSTALL ORDER: topological over EFFECTIVE deps, migration-first then planIndex ---
  // Using the effective deps is what guarantees a colliding sibling installs FIRST, so the
  // jig's rebase of the later phase is a fast-forward over code it was already built on.
  const indeg = new Map(phases.map(p => [p.id, 0]));
  const dependents = new Map(phases.map(p => [p.id, []]));
  for (const p of phases) for (const d of deps.get(p.id)) {
    indeg.set(p.id, indeg.get(p.id) + 1);
    dependents.get(d).push(p.id);
  }
  const installOrder = [];
  const ready = phases.filter(p => indeg.get(p.id) === 0).map(p => p.id);
  const pick = (arr) => arr.sort((x, y) => {
    const a = byId.get(x), b = byId.get(y);
    if (a.migration !== b.migration) return a.migration ? -1 : 1; // migrations earliest
    return a.planIndex - b.planIndex;
  })[0];
  const readySet = new Set(ready);
  while (readySet.size) {
    const next = pick([...readySet]);
    readySet.delete(next);
    installOrder.push(next);
    for (const dep of dependents.get(next)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) readySet.add(dep);
    }
  }
  if (installOrder.length !== phases.length) fail(3, 'dependency cycle (install order)');

  // --- BUILD BASES: what each phase's worktree branches OFF ---------------------------------
  // Only DIRECT effective deps matter: a dep's branch already contains its own base, so a
  // transitive dep needs no second merge. No deps → origin/main. One → that dep's branch.
  // Several → an ephemeral integration branch merging them, then branch the phase off that.
  // Transitive reduction first: if P3 depends on both P2 and P1 but P2 already depends on P1,
  // then branching off P2 ALREADY carries P1 — listing both would spin up an integration branch
  // for nothing. Keep only deps not reachable through another dep.
  const buildBases = installOrder.map(id => {
    const d = deps.get(id);
    const minimal = d.filter(x => !d.some(y => y !== x && mustPrecede(y).has(x)));
    if (!minimal.length) return { phase: id, base: 'origin/main' };
    if (minimal.length === 1) return { phase: id, base: `branch:${minimal[0]}`, dependsOn: minimal };
    return { phase: id, base: 'integration', mergeOf: [...minimal].sort(), dependsOn: minimal };
  });

  if (!collisions.length && phases.length > 1)
    warnings.push('no file collisions detected — verify the manifest lists real per-phase files, not an empty set');
  if (collisionDeps.length)
    warnings.push(`${collisionDeps.length} dependency edge(s) INFERRED from shared files — these phases must ` +
      `build on each other, not on bare origin/main: ` +
      collisionDeps.map(c => `${c.dependent}→${c.dependsOn}`).join(', '));

  const effectiveDeps = Object.fromEntries(phases.map(p => [p.id, deps.get(p.id)]));
  const explicit = Object.fromEntries(phases.map(p => [p.id, explicitDeps.get(p.id)]));
  return { collisions, collisionDeps, explicitDeps: explicit, effectiveDeps, buildBases, waves, installOrder, warnings };
}

// --- CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) fail(2, 'usage: node wave-plan.mjs <manifest.json>');
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { fail(2, 'cannot read/parse manifest: ' + e.message); }
  process.stdout.write(JSON.stringify(derive(manifest), null, 2) + '\n');
}
