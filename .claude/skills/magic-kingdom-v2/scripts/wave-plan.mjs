#!/usr/bin/env node
// wave-plan.mjs — DETERMINISTIC wave + install-order derivation for MK V2.
//
// The line: reading the plan to decide WHICH files each phase touches is judgment (AI).
// Turning that file map into build waves + a serial install order is a pure graph problem
// — so it lives here, where the same input always yields the same output. The AI produces
// the manifest; this script produces the waves. No LLM re-derivation, no drift.
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
//   { collisions:[{a,b,files}], waves:[["P1","P5"],...], installOrder:["P1",...], warnings:[] }
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

  // --- BUILD WAVES: dependency layers, split within a layer by file-collision ---
  // A phase is eligible once every dep is in an EARLIER wave. Within one wave, greedily
  // admit eligible phases in planIndex order, skipping any that collide with one already
  // admitted; skipped phases fall to a later wave. Terminates: each pass assigns ≥1 phase.
  const waveOf = new Map();
  const ordered = [...phases].sort((a, b) => a.planIndex - b.planIndex);
  let w = 0;
  const remaining = new Set(phases.map(p => p.id));
  let guard = phases.length + 1;
  while (remaining.size && guard-- > 0) {
    const wave = [];
    for (const p of ordered) {
      if (!remaining.has(p.id)) continue;
      const depsReady = p.deps.every(d => waveOf.has(d) && waveOf.get(d) < w);
      if (!depsReady) continue;
      if (wave.some(q => collidesWith.get(p.id).has(q))) continue; // file clash within wave
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

  // --- INSTALL ORDER: topological, migration-first then planIndex among ready peers ---
  const indeg = new Map(phases.map(p => [p.id, 0]));
  const dependents = new Map(phases.map(p => [p.id, []]));
  for (const p of phases) for (const d of p.deps) {
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

  if (!collisions.length && phases.length > 1)
    warnings.push('no file collisions detected — verify the manifest lists real per-phase files, not an empty set');

  return { collisions, waves, installOrder, warnings };
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
