#!/usr/bin/env node
// selftest.mjs — TIER 0 regression suite for the MK V2 codified scripts.
//
// Why this exists. The four scripts in this folder are the only mechanical guards standing
// between a fully-autonomous run and a production deploy: they decide build order, whether CI
// is really green on the right commit, whether a migration is destructive, and whether a phase
// may be marked done. Every rule in them was written in response to a specific way a run could
// go wrong — a stale-green PR, a phase built without its sibling's edits, a DROP hidden in a DO
// block, a rubber-stamped gate. A regression in any one of them is silent: the run still goes
// green, it just stops actually checking the thing it claims to check.
//
// So each assertion below is pinned to the failure it prevents, and the suite is FAST and
// OFFLINE (no network, no gh, no database, ~seconds) so it can be run before every dry run and
// before every edit to these scripts.
//
//   node selftest.mjs           # run all
//   node selftest.mjs --verbose # show each case
//
// Exit: 0 all pass · 1 one or more failures.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');
const TMP = mkdtempSync(join(tmpdir(), 'mkv2-selftest-'));

let pass = 0;
const failures = [];

function check(name, why, fn) {
  try {
    fn();
    pass++;
    if (VERBOSE) process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failures.push({ name, why, message: e.message });
    process.stdout.write(`  FAIL ${name}\n         ${e.message}\n         guards: ${why}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

// Run a script and capture {status, stdout, stderr} without throwing on nonzero exit.
function run(script, args, opts = {}) {
  try {
    const stdout = execFileSync('node', [join(HERE, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd || HERE,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? -1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function writeJson(name, obj) { const p = join(TMP, name); writeFileSync(p, JSON.stringify(obj)); return p; }
function writeSql(name, sql) { const p = join(TMP, name); writeFileSync(p, sql); return p; }

// ---------------------------------------------------------------------------------------------
// wave-plan.mjs — build order. A wrong answer here does not fail loudly; it silently builds a
// phase against a base that is missing its sibling's edits.
// ---------------------------------------------------------------------------------------------
process.stdout.write('\nwave-plan.mjs\n');

const wave = (phases) => {
  const r = run('wave-plan.mjs', [writeJson('m.json', { phases })]);
  return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};

check('collision becomes a dependency edge',
  'two phases sharing a file must be ORDERED, not merely split into different waves — otherwise ' +
  'the later phase builds without the shared file\'s edits and is guaranteed to conflict at rebase',
  () => {
    const { json } = wave([
      { id: 'P1', files: ['lib/store.ts'], planIndex: 0 },
      { id: 'P2', files: ['lib/store.ts', 'app/page.tsx'], planIndex: 1 },
    ]);
    eq(json.collisionDeps, [{ dependent: 'P2', dependsOn: 'P1', files: ['lib/store.ts'] }], 'collisionDeps');
    eq(json.effectiveDeps.P2, ['P1'], 'P2 effective deps');
    eq(json.waves, [['P1'], ['P2']], 'waves');
    eq(json.buildBases.find(b => b.phase === 'P2').base, 'branch:P1', 'P2 build base');
  });

check('collision does not manufacture a cycle when deps already order the pair',
  'an explicit dep P1->P2 plus a shared file must not add the reverse edge P2->P1; that would turn ' +
  'a perfectly consistent plan into a spurious "dependency cycle" and halt the run',
  () => {
    const { status, json } = wave([
      { id: 'P1', files: ['a.ts'], deps: ['P2'], planIndex: 0 },
      { id: 'P2', files: ['a.ts'], planIndex: 1 },
    ]);
    eq(status, 0, 'exit');
    eq(json.collisionDeps, [], 'no inferred edge (already ordered)');
    eq(json.installOrder, ['P2', 'P1'], 'install order follows the explicit dep');
  });

check('build bases are transitively reduced',
  'P3 depending on P2 and P1 where P2 already depends on P1 must branch off P2 ALONE — listing ' +
  'both would spin up a pointless integration branch and add a merge that can conflict',
  () => {
    const { json } = wave([
      { id: 'P1', files: ['a.ts'], planIndex: 0 },
      { id: 'P2', files: ['b.ts'], deps: ['P1'], planIndex: 1 },
      { id: 'P3', files: ['c.ts'], deps: ['P1', 'P2'], planIndex: 2 },
    ]);
    const b3 = json.buildBases.find(b => b.phase === 'P3');
    eq(b3.base, 'branch:P2', 'P3 base');
    assert(!b3.mergeOf, 'P3 must NOT need an integration branch');
  });

check('genuinely independent multi-dep produces an integration branch',
  'when two deps are unrelated, the phase needs BOTH in its base — emitting only one would build ' +
  'against half its prerequisites',
  () => {
    const { json } = wave([
      { id: 'P1', files: ['a.ts'], planIndex: 0 },
      { id: 'P2', files: ['b.ts'], planIndex: 1 },
      { id: 'P3', files: ['c.ts'], deps: ['P1', 'P2'], planIndex: 2 },
    ]);
    const b3 = json.buildBases.find(b => b.phase === 'P3');
    eq(b3.base, 'integration', 'P3 base');
    eq(b3.mergeOf, ['P1', 'P2'], 'P3 mergeOf');
  });

check('migration-bearing phase is pulled earliest among ready peers',
  'migrations deploy separately from code, so a migration phase must land first or the app ships ' +
  'against a schema that does not exist yet',
  () => {
    const { json } = wave([
      { id: 'P1', files: ['a.ts'], planIndex: 0 },
      { id: 'P2', files: ['b.ts'], planIndex: 1, migration: true },
    ]);
    eq(json.installOrder, ['P2', 'P1'], 'install order');
  });

check('a real dependency cycle exits 3',
  'a cycle is unbuildable; silently picking an order would produce a base that cannot exist',
  () => {
    const { status } = wave([
      { id: 'P1', files: ['a.ts'], deps: ['P2'] },
      { id: 'P2', files: ['b.ts'], deps: ['P1'] },
    ]);
    eq(status, 3, 'exit');
  });

check('unknown dep id exits 2',
  'a typo\'d phase id must not be silently dropped — that would remove a real ordering constraint',
  () => eq(wave([{ id: 'P1', files: ['a.ts'], deps: ['NOPE'] }]).status, 2, 'exit'));

check('malformed manifest exits 2',
  'no input, no answer — guessing a wave plan from a broken manifest is worse than stopping',
  () => eq(run('wave-plan.mjs', [writeJson('bad.json', { nope: true })]).status, 2, 'exit'));

check('empty-file-set manifest warns',
  'an AI that forgot to fill in per-phase files would otherwise get a clean "no collisions" answer ' +
  'and full parallelism across phases that all touch the same code',
  () => {
    const { json } = wave([{ id: 'P1', files: [] }, { id: 'P2', files: [] }]);
    assert(json.warnings.some(w => /no file collisions/i.test(w)), 'expected a no-collisions warning');
  });

// ---------------------------------------------------------------------------------------------
// ledger.mjs — the gate ledger. Every failure here is a false green: a phase marked done whose
// gates never actually ran.
// ---------------------------------------------------------------------------------------------
process.stdout.write('\nledger.mjs\n');

const GATES = 'rebase,ci,codexreview,prreview,migration,switchon,functest,merge,prodtest';
const PREMERGE = 'rebase,ci,codexreview,prreview,migration,switchon,functest';
let ledgerSeq = 0;
function newLedger(extra = []) {
  const p = join(TMP, `l${++ledgerSeq}.json`);
  const r = run('ledger.mjs', ['init', p, '--phases', 'P1,P2', '--gates', GATES, '--premerge', PREMERGE, '--counters', 'refit', ...extra]);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr.trim()}`);
  return p;
}

check('a counter listed as a gate is refused at init',
  'refit is a budget ("1/2") and never begins with PASS, so as a gate it makes `done` permanently ' +
  'impossible — the run would deadlock at the last step of every phase',
  () => {
    const p = join(TMP, 'lc.json');
    const r = run('ledger.mjs', ['init', p, '--phases', 'P1', '--gates', 'ci,refit']);
    eq(r.status, 2, 'exit');
    assert(/COUNTERS, not gates/.test(r.stderr), 'expected an explanatory refusal');
  });

check('a --premerge set smaller than "all minus post-merge" is refused',
  'a drifted init that omits `ci` from the pre-merge list would let `ready` declare a branch ' +
  'MERGE-ELIGIBLE while its CI gate had never run',
  () => {
    const p = join(TMP, 'lp.json');
    const r = run('ledger.mjs', ['init', p, '--phases', 'P1', '--gates', GATES, '--premerge', 'rebase,codexreview']);
    eq(r.status, 2, 'exit');
    assert(/must be exactly every gate except/.test(r.stderr), 'expected the exact-set refusal');
  });

check('a bare "PASS" with no evidence is refused',
  'a cell reading just "PASS" is precisely the shape of a rubber-stamped gate; the convention is ' +
  '"PASS <evidence>" so a later reader can re-verify the claim',
  () => {
    const p = newLedger();
    const r = run('ledger.mjs', ['set', p, 'P1', 'ci', 'PASS']);
    eq(r.status, 2, 'exit');
    assert(/refusing a bare "PASS"/.test(r.stderr), 'expected the bare-PASS refusal');
    eq(run('ledger.mjs', ['set', p, 'P1', 'ci', 'PASS gh-checks@abc123']).status, 0, 'evidence form accepted');
  });

check('`ready` passes on pre-merge gates alone',
  'merge and prodtest can only be true AFTER the merge; requiring them at the merge gate is the ' +
  'deadlock that made the original D1 unsatisfiable',
  () => {
    const p = newLedger();
    for (const g of PREMERGE.split(',')) run('ledger.mjs', ['set', p, 'P1', g, `PASS evidence-${g}`]);
    const r = run('ledger.mjs', ['ready', p, 'P1']);
    eq(r.status, 0, 'exit');
    assert(/MERGE-ELIGIBLE/.test(r.stdout), 'expected MERGE-ELIGIBLE');
  });

check('`ready` refuses when a pre-merge gate is blank',
  'a blank cell means the gate never ran; treating absence as a pass is the core false-green',
  () => {
    const p = newLedger();
    for (const g of PREMERGE.split(',')) if (g !== 'ci') run('ledger.mjs', ['set', p, 'P1', g, `PASS e-${g}`]);
    const r = run('ledger.mjs', ['ready', p, 'P1']);
    eq(r.status, 1, 'exit');
    assert(/ci/.test(r.stderr), 'expected ci named as blocking');
  });

check('`done` refuses while merge/prodtest are outstanding',
  'a phase is only installed once it is merged AND verified in production; marking it done earlier ' +
  'loses the fact that the prod check is still owed',
  () => {
    const p = newLedger();
    for (const g of PREMERGE.split(',')) run('ledger.mjs', ['set', p, 'P1', g, `PASS e-${g}`]);
    eq(run('ledger.mjs', ['done', p, 'P1']).status, 1, 'exit');
  });

check('`done` succeeds only with every gate PASS, and a counter never blocks it',
  'the counter must be tracked but ignored by the invariant, or `refit 1/2` blocks a legitimate done',
  () => {
    const p = newLedger();
    for (const g of GATES.split(',')) run('ledger.mjs', ['set', p, 'P1', g, `PASS e-${g}`]);
    run('ledger.mjs', ['set', p, 'P1', 'refit', '1/2']);
    const r = run('ledger.mjs', ['done', p, 'P1']);
    eq(r.status, 0, 'exit');
    eq(run('ledger.mjs', ['validate', p]).status, 0, 'validate');
  });

check('`validate` catches a hand-edited done-with-blank-cell',
  'the JSON is editable, so the invariant must be re-checked rather than trusted once at write time',
  () => {
    const p = newLedger();
    for (const g of GATES.split(',')) run('ledger.mjs', ['set', p, 'P1', g, `PASS e-${g}`]);
    run('ledger.mjs', ['done', p, 'P1']);
    const s = JSON.parse(execFileSync('cat', [p], { encoding: 'utf8' }));
    delete s.phases.P1.cells.prodtest;                 // tamper: done, but prod never verified
    writeFileSync(p, JSON.stringify(s));
    const r = run('ledger.mjs', ['validate', p]);
    eq(r.status, 1, 'exit');
    assert(/INVALID: P1/.test(r.stderr), 'expected P1 flagged');
  });

check('duplicate gate names are refused at init',
  'a duplicated column silently collapses two distinct gates into one cell',
  () => eq(run('ledger.mjs', ['init', join(TMP, 'ld.json'), '--phases', 'P1', '--gates', 'ci,ci']).status, 2, 'exit'));

check('render shows counters raw and gates as marks',
  'the human-readable table is what a supervisor eyeballs; a counter rendered as ✗ reads as a failure',
  () => {
    const p = newLedger();
    run('ledger.mjs', ['set', p, 'P1', 'refit', '1/2']);
    run('ledger.mjs', ['set', p, 'P1', 'ci', 'PASS gh@abc']);
    const out = run('ledger.mjs', ['render', p]).stdout;
    assert(/\| 1\/2 \|/.test(out), 'counter should print raw');
    assert(/✓/.test(out), 'passing gate should print a tick');
  });

// ---------------------------------------------------------------------------------------------
// migration-safety.mjs — the blocking pre-screen. A false NEGATIVE lets destructive SQL through a
// gate in front of a live customer database. A false POSITIVE blocks every legitimate migration
// and makes the screen worthless. Both directions are tested.
// ---------------------------------------------------------------------------------------------
process.stdout.write('\nmigration-safety.mjs\n');

let sqlSeq = 0;
function screen(sql, extra = []) {
  const f = writeSql(`2099${String(++sqlSeq).padStart(4, '0')}_case.sql`, sql);
  const r = run('migration-safety.mjs', [f, ...extra]);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* contract test below reports this */ }
  return { ...r, json };
}
const blocks = (sql) => { const r = screen(sql); eq(r.status, 1, 'expected a BLOCK (exit 1)'); return r; };
const clean = (sql) => { const r = screen(sql); eq(r.status, 0, `expected CLEAN (exit 0), stderr: ${r.stderr.trim()}`); return r; };

check('stdout is parseable JSON on both outcomes',
  'the README promises a machine-readable report; prose appended after the object breaks every ' +
  'caller that JSON.parses it — which is how the supervisor reads this screen',
  () => {
    const ok = screen('CREATE TABLE t (id int);');
    assert(ok.json && typeof ok.json.clean === 'boolean', 'clean run must emit valid JSON');
    const bad = screen('DROP TABLE users;');
    assert(bad.json && bad.json.violations > 0, 'violating run must ALSO emit valid JSON');
  });

check('a plain expand-only migration is clean',
  'precision: a screen that flags routine additive migrations is a blocker-generator, and the team ' +
  'learns to ignore or bypass it',
  () => clean(`CREATE TABLE events (id bigserial primary key, title text not null);
CREATE INDEX events_title_idx ON events (title);
ALTER TABLE events ADD COLUMN location text;`));

check('DROP TABLE blocks', 'permanent data loss', () => blocks('DROP TABLE users;'));
check('TRUNCATE blocks', 'permanent data loss', () => blocks('TRUNCATE TABLE attendees;'));
check('SET NOT NULL on an existing column blocks',
  'old code still writes NULLs, so this breaks expand/contract in the window between deploys',
  () => blocks('ALTER TABLE events ALTER COLUMN location SET NOT NULL;'));
check('RENAME blocks', 'renaming breaks the currently-deployed code reading the old name',
  () => blocks('ALTER TABLE events RENAME COLUMN title TO name;'));
check('ADD COLUMN NOT NULL without DEFAULT blocks',
  'fails outright on a non-empty table',
  () => blocks('ALTER TABLE events ADD COLUMN owner uuid NOT NULL;'));

check('a destructive statement inside a DO block blocks',
  'a DO body EXECUTES at migration time. Masking every dollar-quoted body alike made this read ' +
  'CLEAN — a false-clean on a blocking production gate',
  () => blocks(`DO $$ BEGIN EXECUTE 'DROP TABLE legacy_users'; END $$;`));

check('an unguarded UPDATE inside a DO block blocks',
  'a DO block must not be a loophole for a whole-table write',
  () => blocks(`DO $$ BEGIN UPDATE profiles SET role = 'participant'; END $$;`));

check('a tautological WHERE inside a DO block still blocks',
  '`WHERE true` satisfies a naive has-a-WHERE check while touching every row; the predicate also ' +
  'must not run past the block\'s trailing `; END $$` or the tautology stops matching',
  () => blocks(`DO $$ BEGIN UPDATE profiles SET role = 'x' WHERE 1=1; END $$;`));

check('a CREATE FUNCTION body is NOT scanned',
  'SQL in a function body is code, not a migration-time action; scanning it flagged legitimate ' +
  'cleanup functions and was the single biggest source of false blocks',
  () => clean(`CREATE OR REPLACE FUNCTION purge_old() RETURNS void LANGUAGE plpgsql AS $$
BEGIN DELETE FROM events WHERE created_at < now() - interval '1 year'; END $$;`));

check('REVOKE listing TRUNCATE is not a TRUNCATE',
  'privilege hardening reads as destructive DML if you keyword-match inside it — this is the exact ' +
  'shape of the repo\'s grant-hardening migrations',
  () => clean('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON events FROM anon;'));

check('drop + recreate in the same file is a NOTE, not a block',
  'the standard idempotent-recreate form; blocking it would block most policy migrations',
  () => {
    const r = clean(`DROP POLICY IF EXISTS events_read ON events;
CREATE POLICY events_read ON events FOR SELECT TO authenticated USING (true);`);
    assert(r.json.notes > 0, 'expected a note recording the recreate');
  });

check('a policy dropped from one table and created on ANOTHER still blocks',
  'a policy name is only unique within its table, so name-only matching would call this an ' +
  'idempotent recreate while tenant_a lost its row-level protection',
  () => blocks(`DROP POLICY IF EXISTS p ON tenant_a;
CREATE POLICY p ON tenant_b FOR SELECT USING (true);`));

check('a dropped function overload is not covered by a different signature',
  'Postgres identifies a function by name AND argument types; dropping f(text) while creating ' +
  'f(integer) deletes the text API that deployed code is still calling',
  () => blocks(`DROP FUNCTION IF EXISTS f(text);
CREATE FUNCTION f(x integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`));

check('a zero-arg drop covered by a default-arg recreate is clean',
  'dropping f() while creating f(p uuid DEFAULT NULL) keeps every f() caller working — flagging it ' +
  'blocked two real migrations in this repo',
  () => clean(`DROP FUNCTION IF EXISTS f();
CREATE FUNCTION f(p uuid DEFAULT NULL) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`));

check('only ONE object of a multi-object DROP being recreated still blocks',
  'stopping at the first (recreated) object waves the permanent removal of the rest straight ' +
  'through the gate',
  () => blocks(`DROP FUNCTION IF EXISTS kept(), removed_forever();
CREATE FUNCTION kept() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`));

check('a multi-action ALTER TABLE is fully inspected',
  'inspecting only the first drop action lets `DROP CONSTRAINT IF EXISTS old, DROP COLUMN legacy` ' +
  'pass on the strength of the recreated constraint alone',
  () => blocks(`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey, DROP COLUMN legacy_field;
ALTER TABLE events ADD CONSTRAINT events_pkey PRIMARY KEY (id);`));

check('ALTER TABLE ONLY … DROP COLUMN blocks',
  'the ONLY keyword is legal and was not matched by the original pattern, so this evaded the screen',
  () => blocks('ALTER TABLE ONLY events DROP COLUMN location;'));

check('a DROP hidden in a NESTED block comment is correctly ignored',
  'Postgres block comments nest, so closing at the first */ leaves the DROP in the scanned text and ' +
  'blocks a migration that does nothing at all',
  () => clean(`/* outer /* inner */ DROP TABLE users; */
CREATE TABLE t (id int);`));

check('a DROP inside a string literal is not executable SQL',
  'storing SQL as data (`INSERT INTO docs(body) VALUES ($$DROP TABLE x$$)`) must not fail a ' +
  'blocking gate',
  () => clean(`CREATE TABLE docs (body text);
INSERT INTO docs (body) VALUES ($$DROP TABLE example$$);`));

check('a fake comment inside a literal does not hide a later DROP',
  'stripping comments before literals loses the DROP in `VALUES (\'--\'); DROP TABLE t;`',
  () => blocks(`CREATE TABLE t (c text);
INSERT INTO t (c) VALUES ('--');
DROP TABLE other;`));

check('an unbalanced dollar quote does not swallow the rest of the file',
  'one stray `$` masking everything after it turns every later DROP into a false clean',
  () => blocks(`SELECT 'price$';
DROP TABLE users;`));

check('a $ inside an identifier is not a dollar-quote opener',
  '`$` is legal in an unquoted identifier, so the tail of a name like foo$tag$ must not open a body',
  () => blocks(`CREATE TABLE foo$bar (id int);
DROP TABLE users;`));

check('concatenated dynamic EXECUTE is surfaced as a note',
  '`EXECUTE \'DROP \' || \'TABLE users\'` has pieces that individually look like nothing; it cannot ' +
  'be read statically, so the gate must be told to read the body by hand',
  () => {
    const r = screen(`DO $$ BEGIN EXECUTE 'DROP ' || 'TABLE users'; END $$;`);
    const all = JSON.stringify(r.json);
    assert(/dynamic EXECUTE/.test(all), 'expected a dynamic-EXECUTE note or violation');
  });

check('a dynamic drop-and-recreate loop is a note, not a block',
  'the `EXECUTE format(\'DROP TRIGGER … \')` + CREATE TRIGGER pattern is idempotent and real in ' +
  'this repo; blocking it produced two false positives',
  () => clean(`DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT unnest(ARRAY['a','b']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg ON %I', t);
    EXECUTE format('CREATE TRIGGER trg BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION f()', t);
  END LOOP; END $$;`));

check('a keyword that is merely DATA does not block',
  'an assertion comparing `privilege_type = \'TRUNCATE\'` is not a TRUNCATE — a bare literal with ' +
  'no object after the keyword is not a statement',
  () => clean(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE privilege_type = 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon still holds TRUNCATE';
  END IF; END $$;`));

check('a scoped backfill is a note, not a block',
  'a real WHERE-guarded backfill must reach the gate for judgment without mechanically blocking',
  () => {
    const r = clean(`UPDATE events SET location = 'unknown' WHERE location IS NULL;`);
    assert(r.json.notes > 0, 'expected a note');
  });

check('a filename with no version prefix blocks',
  'the migration registry is keyed on the numeric prefix; a file without one can never be recorded',
  () => {
    const f = writeSql('no_prefix.sql', 'CREATE TABLE t (id int);');
    eq(run('migration-safety.mjs', [f]).status, 1, 'exit');
  });

check('a version prefix already in the registry blocks',
  'reusing a prefix means only one file ever runs while BOTH are recorded as applied — this has ' +
  'silently orphaned four migrations in this repo already',
  () => {
    const reg = join(TMP, 'reg.txt');
    writeFileSync(reg, '20990001\n');
    const f = writeSql('20990001_dup.sql', 'CREATE TABLE t2 (id int);');
    const r = run('migration-safety.mjs', [f, '--registry', reg]);
    eq(r.status, 1, 'exit');
    assert(/already applied/.test(JSON.stringify(JSON.parse(r.stdout))), 'expected a registry collision');
  });

check('two given files sharing a prefix block each other',
  'same orphaning failure, caught within a single run rather than against the registry',
  () => {
    const a = writeSql('20990002_a.sql', 'CREATE TABLE a (id int);');
    const b = join(TMP, '20990002_b.sql');
    writeFileSync(b, 'CREATE TABLE b (id int);');
    eq(run('migration-safety.mjs', [a, b]).status, 1, 'exit');
  });

check('a called destructive function is surfaced as a note',
  'the body is masked (correctly), but a migration that then CALLS it does run that SQL at migrate ' +
  'time — silence here would hide the whole action behind one SELECT',
  () => {
    const r = clean(`CREATE FUNCTION reset_all() RETURNS void LANGUAGE plpgsql AS $$
BEGIN DROP TABLE IF EXISTS scratch; END $$;
SELECT reset_all();`);
    assert(/is CALLED in this migration/.test(JSON.stringify(r.json)), 'expected a called-function note');
  });

check('missing file exits 2, not 0',
  'a typo\'d path must never read as "nothing destructive found"',
  () => eq(run('migration-safety.mjs', [join(TMP, 'does-not-exist.sql')]).status, 2, 'exit'));

check('no arguments exits 2',
  'same reason: an empty invocation must not look like a clean screen',
  () => eq(run('migration-safety.mjs', []).status, 2, 'exit'));

// ---------------------------------------------------------------------------------------------
// jig-step.mjs — git/gh mechanics. Only the OFFLINE guards are tested here; ci-wait's polling
// needs a live PR and is covered by the dry run.
// ---------------------------------------------------------------------------------------------
process.stdout.write('\njig-step.mjs (offline guards)\n');

const REPO = join(TMP, 'repo');
mkdirSync(REPO, { recursive: true });
const g = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 'selftest@example.com');
g('config', 'user.name', 'selftest');
writeFileSync(join(REPO, 'f.txt'), 'hello\n');
g('add', '.');
g('commit', '-qm', 'init');
g('branch', 'feature-a');

check('rebase refuses when the worktree is on a DIFFERENT branch',
  'git rebase acts on what is CHECKED OUT, not the name passed. Run from the wrong worktree and ' +
  'you rebase someone else\'s branch while reporting success for this one — then push force-pushes ' +
  'an untouched ref and ci-wait inspects a stale-green PR',
  () => {
    const r = run('jig-step.mjs', ['rebase', 'feature-a', '--cwd', REPO]);
    eq(r.status, 2, 'exit');
    assert(/wrong checkout/.test(r.stderr), 'expected a wrong-checkout refusal');
  });

check('push refuses when the worktree is on a DIFFERENT branch',
  'same failure mode; otherwise the reported head SHA belongs to another branch entirely',
  () => {
    const r = run('jig-step.mjs', ['push', 'feature-a', '--cwd', REPO]);
    eq(r.status, 2, 'exit');
    assert(/wrong checkout/.test(r.stderr), 'expected a wrong-checkout refusal');
  });

check('rebase refuses a dirty working tree',
  'rebasing over uncommitted edits either aborts messily or silently drops them',
  () => {
    writeFileSync(join(REPO, 'f.txt'), 'dirty\n');
    const r = run('jig-step.mjs', ['rebase', 'main', '--cwd', REPO]);
    eq(r.status, 1, 'exit');
    assert(/not clean/.test(r.stderr), 'expected a dirty-tree refusal');
    g('checkout', '--', 'f.txt');
  });

check('unknown command exits 2',
  'a mistyped subcommand must not exit 0 and read as a passed step',
  () => eq(run('jig-step.mjs', ['bogus', 'x']).status, 2, 'exit'));

check('each subcommand requires its arguments',
  'a missing branch or path must fail loudly rather than operating on a default',
  () => {
    eq(run('jig-step.mjs', ['rebase']).status, 2, 'rebase without branch');
    eq(run('jig-step.mjs', ['ci-wait']).status, 2, 'ci-wait without branch');
    eq(run('jig-step.mjs', ['migration-diff', 'b', '--cwd', REPO]).status, 2, 'migration-diff without path');
  });

check('flags are not mistaken for positional arguments',
  'reading positionals by raw index bound migration-diff\'s <path> to the literal "--cwd", so the ' +
  'diff matched nothing and the step reported hasMigration:false with exit 0 — a FALSE NEGATIVE ' +
  'that makes the back gate skip the migration safety screen entirely',
  () => {
    mkdirSync(join(REPO, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(REPO, 'db', 'migrations', '20990101_x.sql'), 'CREATE TABLE z (id int);\n');
    g('add', '.');
    g('commit', '-qm', 'add migration');
    g('branch', '-f', 'feature-a', 'HEAD');
    // No origin in this scratch repo, so migration-diff's `git fetch origin` fails — but the
    // ARGUMENT BINDING is observable before that, which is what this case pins down.
    const r = run('jig-step.mjs', ['migration-diff', 'feature-a', 'db/migrations', '--cwd', REPO]);
    assert(!/"path": *"--cwd"/.test(r.stdout), 'path must never bind to a flag name');
    const bad = run('jig-step.mjs', ['migration-diff', 'feature-a', '--cwd', REPO]);
    eq(bad.status, 2, 'a flag must not be accepted AS the path');
  });

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${'-'.repeat(78)}\n`);
rmSync(TMP, { recursive: true, force: true });

if (failures.length) {
  process.stdout.write(`FAILED: ${failures.length} of ${pass + failures.length} checks\n\n`);
  for (const f of failures) process.stdout.write(`  · ${f.name}\n    ${f.message}\n`);
  process.stdout.write('\nEach failure above is a guard that has stopped working. The run would still\n' +
    'go green — it would simply no longer be checking the thing it claims to check.\n');
  process.exit(1);
}
process.stdout.write(`OK: all ${pass} checks passed — the codified guards still guard.\n`);
