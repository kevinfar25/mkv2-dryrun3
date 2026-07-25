#!/usr/bin/env node
// migration-safety.mjs — DETERMINISTIC static pre-screen for the MIGRATION SAFETY GATE.
//
// This does NOT replace the gate's judgment (expand/contract reasoning against the LIVE prod
// schema, the staging dry-run, the LIVE prod-object check). It is the mechanical HALF: catch
// the unambiguously destructive patterns and version-prefix collisions BEFORE a human/AI
// looks, so a clearly-unsafe migration fails loudly and cheaply. A PASS here is necessary,
// not sufficient — the AI still runs the full gate. A FAIL here blocks, full stop.
//
// BECAUSE a FAIL blocks, precision matters more than recall: a screen that flags every
// migration is a blocker-generator, not a gate. So it works STATEMENT BY STATEMENT, with
// three structural exclusions that killed the original false positives:
//   1. A CREATE FUNCTION / PROCEDURE body ($$ … $$) is MASKED. SQL in a function body is not
//      executed at migrate time — a `DELETE FROM` there is code, not a destructive migration.
//      ⚠ A `DO $$ … $$` block is the OPPOSITE: its body RUNS during the migration. DO bodies are
//      therefore SCANNED, including inside string literals, so `DO $$ BEGIN EXECUTE 'DROP TABLE
//      x'; END $$;` is caught rather than erased. Masking every dollar-quoted body alike is a
//      false-clean on a blocking prod gate (found by adversarial review; 14 migrations in this
//      repo use DO blocks).
//   2. GRANT / REVOKE statements are skipped. `REVOKE INSERT, UPDATE, DELETE, TRUNCATE …`
//      is privilege HARDENING; matching DML keywords inside it is nonsense.
//   3. `DROP <policy|trigger|function|index|constraint> IF EXISTS` that is RE-CREATED in the
//      same file is the standard idempotent-recreate form → a note, not a violation. A drop
//      with NO recreate stays a violation (that is a real contract migration). Identity is
//      compared per KIND — a policy/trigger includes its table, a function its qualified name —
//      so `DROP POLICY p ON tenant_a` + `CREATE POLICY p ON tenant_b` is NOT a recreate.
// Data-touching statements that ARE scoped (UPDATE/DELETE with a WHERE) are reported as
// NOTES: the gate must still reason about the backfill, but they do not block mechanically.
//
// Comments and string literals are resolved in ONE left-to-right pass, because doing them in
// sequence is exploitable either way: strip comments first and `VALUES ('--'); DROP TABLE t;`
// loses the DROP to a fake comment; mask literals first and `-- don't` opens a fake literal.
//
// Usage:  node migration-safety.mjs <file1.sql> [file2.sql ...] [--registry <prefixes.txt>]
//   --registry : optional newline-list of already-applied version prefixes (collision check)
//
// Output: JSON report to stdout {clean, violations, notes, reports:[{file,prefix,violations,notes}]}.
// Exit: 0 clean (notes allowed) · 1 violation(s) · 2 usage/IO error.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

// --- masking: blank out a span but KEEP its newlines so line numbers stay honest ---
const blank = (s) => s.replace(/[^\n]/g, ' ');

// ONE left-to-right lexer for comments, string literals and dollar-quoted bodies. Returns:
//   code    — scannable SQL: comments/literals/dollar-bodies blanked (line numbers preserved)
//   doBodies— RAW text of each body that EXECUTES at migration time (DO blocks), with literals
//             intact, so dynamic `EXECUTE 'DROP …'` is still visible to the rules.
function lex(sql) {
  let code = '';
  const doBodies = [];
  const fnBodies = [];
  let i = 0;
  const keep = (n) => { code += sql.slice(i, i + n); i += n; };
  const hide = (end) => { code += blank(sql.slice(i, end)); i = end; };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') { const nl = sql.indexOf('\n', i); hide(nl === -1 ? sql.length : nl); continue; }
    // Postgres block comments NEST: `/* outer /* inner */ DROP TABLE old; */` is entirely a
    // comment. Closing at the first `*/` would leave the DROP in the scanned text and block a
    // migration that does nothing.
    if (two === '/*') {
      let j = i + 2, depth = 1;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; }
        else if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; }
        else j++;
      }
      hide(j);
      continue;
    }

    if (sql[i] === "'") {                        // string literal ('' is an escaped quote)
      keep(1);
      let j = i;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      hide(j);
      if (sql[j] === "'") keep(1);
      continue;
    }

    // A dollar quote only OPENS at a token boundary: `$` is legal inside an unquoted identifier,
    // so the `$tag$` tail of a name like `foo$tag$` is not an opener. And if no closing delimiter
    // exists, do NOT swallow the rest of the file — treat the `$` as ordinary text and keep
    // scanning, or one stray `$` would hide every later DROP behind a false clean.
    const atBoundary = i === 0 || !/[\w$]/.test(sql[i - 1]);
    const dq = atBoundary ? /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i)) : null;
    if (dq && sql.indexOf(dq[0], i + dq[0].length) === -1) { keep(1); continue; }
    if (dq) {
      const tag = dq[0];
      // Whose body is this? Look back over the statement head — BEFORE the opening tag is
      // emitted, or `head` ends in "$$" and no end-anchored test can match it.
      const head = code.slice(code.lastIndexOf(';') + 1);
      keep(tag.length);
      const close = sql.indexOf(tag, i);
      const end = close === -1 ? sql.length : close;
      const fn = head.match(new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${IDENT}`, 'i'));
      // Only an actual `DO [LANGUAGE x] $$…$$` body EXECUTES. Dollar quoting is also just a
      // string syntax — `INSERT INTO docs(body) VALUES ($$DROP TABLE example$$)` stores text and
      // must NOT be scanned as executable, or storing SQL-as-data fails a blocking gate.
      const isDo = /(^|;)\s*DO(\s+LANGUAGE\s+[\w"]+)?\s*$/i.test(head);
      if (fn) fnBodies.push({ name: fn[1], text: sql.slice(i, end), offset: i });   // defined, not run
      else if (isDo) doBodies.push({ text: sql.slice(i, end), offset: i });         // DO block → RUNS
      hide(end);                                 // blanked in `code` either way (keeps stmt split sane)
      if (close !== -1) keep(tag.length);
      continue;
    }

    keep(1);
  }
  return { code, doBodies, fnBodies };
}

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

// Split on semicolons (dollar-quoted bodies are already masked, so none are nested here),
// keeping each statement's offset for line reporting.
function statements(sql) {
  const out = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== ';') continue;
    out.push({ text: sql.slice(start, i), start });
    start = i + 1;
  }
  if (sql.slice(start).trim()) out.push({ text: sql.slice(start), start });
  return out.filter(s => s.text.trim());
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 90);

// "Has a WHERE" is NOT the same as "is scoped". `DELETE FROM profiles WHERE true` and
// `UPDATE profiles SET … WHERE id IS NOT NULL` touch every row while satisfying a naive
// WHERE check — which on a live tenant DB is the whole risk. A WHERE whose ENTIRE predicate is
// a tautology counts as unguarded.
function scoped(stmt) {
  const m = /\bWHERE\b([\s\S]*)$/i.exec(stmt);
  if (!m) return false;                                  // no WHERE at all
  // End the predicate where the STATEMENT ends — otherwise a DO block's trailing `; END $$`
  // gets glued onto `WHERE 1=1` and the tautology stops matching.
  let pred = m[1];
  const semi = pred.indexOf(';');
  if (semi > -1) pred = pred.slice(0, semi);
  pred = pred.replace(/\s*RETURNING[\s\S]*$/i, '').replace(/\bEND\b[\s\S]*$/i, '')
    .replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!pred) return false;
  if (/^(true|1\s*=\s*1|'t')$/i.test(pred)) return false;             // WHERE true
  if (/^[\w."]+\s+IS\s+NOT\s+NULL$/i.test(pred)) return false;        // every non-null row
  return true;
}
// An identifier may be quoted AND contain spaces ("Tournament rounds viewable by …").
const IDENT = '("[^"]*"|[\\w.]+)';
const bare = (n) => String(n).replace(/"/g, '').replace(/\(.*$/, '').replace(/^.*\./, '').trim().toLowerCase();

// An object's IDENTITY for recreate-matching. A policy or trigger name is only unique WITHIN a
// table, so the table is part of the key: `DROP POLICY p ON tenant_a` + `CREATE POLICY p ON
// tenant_b` removed a policy from tenant_a and must NOT read as an idempotent recreate.
// NOT indexes: an index name is SCHEMA-scoped, and `DROP INDEX idx` carries no table at all, so
// keying it by table would never match its `CREATE INDEX idx ON t` and every routine
// drop-and-recreate would read as destructive.
const TABLE_SCOPED = new Set(['POLICY', 'TRIGGER', 'CONSTRAINT']);

// Postgres identifies a function by name AND argument types, so an overload is a DIFFERENT
// function: `DROP FUNCTION f(text)` + `CREATE FUNCTION f(integer)` deletes the text API and is
// NOT an idempotent recreate. Normalize both sides to a comparable signature. A DROP lists bare
// types, a CREATE lists `name type [DEFAULT …]` — reduced to the same shape here.
const TYPE_ALIAS = new Map([
  ['int', 'integer'], ['int4', 'integer'], ['int2', 'smallint'], ['int8', 'bigint'],
  ['bool', 'boolean'], ['varchar', 'character varying'], ['char', 'character'],
  ['timestamptz', 'timestamp with time zone'], ['timetz', 'time with time zone'],
  ['float8', 'double precision'], ['float4', 'real'], ['decimal', 'numeric'],
]);
const MULTIWORD_TYPE = /^(timestamp|time)(\s+with(out)?\s+time\s+zone)?$|^double\s+precision$|^character(\s+varying)?(\(\d+\))?$|^bit(\s+varying)?$/i;

function splitTopLevel(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// argText → { types: ['uuid','text'], required: n }  (n = params with no DEFAULT)
function parseParams(argText) {
  if (argText == null) return null;
  const inner = argText.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();
  if (!inner) return { types: [], required: 0 };
  const types = [], defaults = [];
  for (const raw of splitTopLevel(inner)) {
    const hasDefault = /\s(DEFAULT\s|=\s*)/i.test(raw);
    let p = raw.replace(/\s*(DEFAULT\s+[\s\S]*|=\s*[\s\S]*)$/i, '')        // drop default
      .replace(/^\s*(IN|OUT|INOUT|VARIADIC)\s+/i, '')                      // drop arg mode
      .replace(/\s+/g, ' ').trim();
    if (!MULTIWORD_TYPE.test(p)) {
      const tok = p.split(' ');
      // `p_name text` → the type is everything after the parameter name; a lone token IS the type.
      if (tok.length > 1) p = tok.slice(1).join(' ');
    }
    p = p.toLowerCase().replace(/\s+/g, ' ');
    types.push(TYPE_ALIAS.get(p) || p);
    defaults.push(hasDefault);
  }
  return { types, required: defaults.filter(d => !d).length };
}

function normalizeSignature(argText) {
  const p = parseParams(argText);
  if (!p) return '';                                     // no arg list given at all
  return `(${p.types.join(',')})`;
}

// Can a call written against `dropped` still resolve to the created overload `sig`? Dropping
// `f()` while creating `f(p uuid DEFAULT NULL)` keeps every `f()` caller working (Postgres fills
// the default), so that is an idempotent-ish recreate, not a removed API. Dropping `f(text)`
// while creating `f(integer)` does NOT — same arity, incompatible type.
function callableWith(sig, dropped) {
  if (!sig || !dropped) return false;
  const n = dropped.types.length;
  if (n < sig.required || n > sig.types.length) return false;
  return dropped.types.every((t, i) => t === sig.types[i]);
}

function objKey(kind, name, table, argText) {
  const k = kind.toUpperCase();
  if (k === 'FUNCTION' || k === 'PROCEDURE') return `${k}:${bare(name)}${normalizeSignature(argText)}`;
  return `${k}:${bare(name)}${TABLE_SCOPED.has(k) && table ? '@' + bare(table) : ''}`;
}

// Every object CREATEd (or constraint ADDed) in this file, keyed by identity. Functions get TWO
// keys: the exact signature, and a `*` name-only key used when a DROP omits the arg list.
function createdKeys(stmts) {
  const keys = new Set();
  const fnSigs = new Map();          // bare fn name → [{types, required}] for every overload created
  const CREATE = new RegExp(
    `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?(MATERIALIZED\\s+VIEW|POLICY|TRIGGER|FUNCTION|PROCEDURE|INDEX|VIEW|TABLE|SEQUENCE|TYPE|SCHEMA)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'i');
  const ON = new RegExp(`\\bON\\s+(?:TABLE\\s+)?${IDENT}`, 'i');
  const ALTER = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT}`, 'i');
  const ADDC = new RegExp(`\\bADD\\s+CONSTRAINT\\s+${IDENT}`, 'gi');
  for (const { text } of stmts) {
    const s = text.trim();
    const c = s.match(CREATE);
    if (c) {
      const kind = c[1].replace(/\s+/g, ' ').toUpperCase();
      const tail = s.slice(c[0].length);
      if (kind === 'FUNCTION' || kind === 'PROCEDURE') {
        const args = tail.startsWith('(') ? tail.slice(0, matchParen(tail) + 1) : null;
        keys.add(objKey(kind, c[2], null, args));
        keys.add(`${kind}:${bare(c[2])}*`);
        const sig = parseParams(args);
        if (sig) { const n = bare(c[2]); fnSigs.set(n, [...(fnSigs.get(n) || []), sig]); }
      } else {
        const t = TABLE_SCOPED.has(kind) ? tail.match(ON) : null;
        keys.add(objKey(kind, c[2], t && t[1]));
      }
    }
    const a = s.match(ALTER);
    if (a) { let m; ADDC.lastIndex = 0; while ((m = ADDC.exec(s)) !== null) keys.add(objKey('CONSTRAINT', m[1], a[1])); }
  }
  keys.fnSigs = fnSigs;              // carried alongside so call sites keep using one value
  return keys;
}

function matchParen(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length - 1;
}

// Was this dropped object re-created in the file? Functions compare by SIGNATURE when the DROP
// gives one; a DROP with no arg list can only be matched by name.
function wasRecreated(created, kind, name, table, argText) {
  const k = kind.toUpperCase();
  if (k === 'FUNCTION' || k === 'PROCEDURE') {
    if (created.has(objKey(k, name, null, argText))) return true;          // identical signature
    if (!argText) return created.has(`${k}:${bare(name)}*`);               // DROP gave no arg list
    const dropped = parseParams(argText);
    const sigs = created.fnSigs?.get(bare(name)) || [];
    return sigs.some(sig => callableWith(sig, dropped));                   // still callable?
  }
  return created.has(objKey(k, name, table));
}

// Dropping one of these is never "just a recreate" — always a real violation.
const NEVER_BENIGN = new Set(['TABLE', 'SCHEMA', 'SEQUENCE', 'TYPE', 'MATERIALIZED VIEW']);

function scanStatement(st, sql, created, violations, notes) {
  const s = st.text.trim();
  const line = lineOf(sql, st.start + (st.text.length - st.text.trimStart().length));
  const add = (bucket, rule) => bucket.push({ rule, line, text: oneLine(s) });

  // (2) privilege statements are hardening, never destructive DML.
  if (/^(GRANT|REVOKE)\b/i.test(s)) return;

  // DROP <kind> [IF EXISTS] <name>[(args)] [, <name2>…] [ON <table>] [CASCADE|RESTRICT]
  // ⚠ One DROP can name SEVERAL objects: `DROP FUNCTION IF EXISTS kept(), removed();`. Judge
  // EVERY object — stopping at the first (recreated) one would wave the permanent removal of the
  // rest straight through this blocking gate.
  let m = s.match(new RegExp(
    `^DROP\\s+(MATERIALIZED\\s+VIEW|TABLE|SCHEMA|VIEW|SEQUENCE|TYPE|POLICY|TRIGGER|FUNCTION|INDEX|CONSTRAINT)\\s+(?:IF\\s+EXISTS\\s+)?`, 'i'));
  if (m) {
    const kind = m[1].replace(/\s+/g, ' ').toUpperCase();
    const ifExists = /\bIF\s+EXISTS\b/i.test(s);
    let list = s.slice(m[0].length);
    // `ON <table>` (policy/trigger) and CASCADE/RESTRICT are statement-level, not object-level.
    const onTable = list.match(new RegExp(`\\bON\\s+(?:TABLE\\s+)?${IDENT}`, 'i'));
    list = list.replace(new RegExp(`\\bON\\s+(?:TABLE\\s+)?${IDENT}[\\s\\S]*$`, 'i'), '')
      .replace(/\b(CASCADE|RESTRICT)\b[\s\S]*$/i, '');
    const objects = splitTopLevel(list).map(o => o.trim()).filter(Boolean);
    if (!objects.length) { add(violations, `DROP ${kind}`); return; }
    for (const obj of objects) {
      const nm = obj.match(new RegExp(`^${IDENT}`, 'i'));
      if (!nm) { add(violations, `DROP ${kind}`); continue; }
      const after = obj.slice(nm[0].length).trimStart();
      const args = after.startsWith('(') ? after.slice(0, matchParen(after) + 1) : null;
      const recreated = wasRecreated(created, kind, nm[1], onTable && onTable[1], args);
      if (!NEVER_BENIGN.has(kind) && ifExists && recreated)
        add(notes, `DROP ${kind} ${bare(nm[1])} IF EXISTS + re-created in this file (idempotent recreate)`);
      else
        add(violations, `DROP ${kind} ${bare(nm[1])}`);
    }
    return;
  }

  // ALTER TABLE … DROP COLUMN|CONSTRAINT — scoped to THIS statement, so an
  // `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` followed later by a `DROP POLICY …;`
  // no longer matches as one destructive ALTER (the old cross-statement false positive).
  // One ALTER TABLE can carry SEVERAL comma-separated actions — `DROP CONSTRAINT IF EXISTS old,
  // DROP COLUMN legacy`. Inspect EVERY drop action, not just the first: stopping at an
  // idempotently-recreated constraint would wave the column drop straight through.
  const at = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT}`, 'i'));
  if (at) {
    const dropAction = new RegExp(`\\bDROP\\s+(COLUMN|CONSTRAINT)\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'gi');
    let hit = false, d;
    while ((d = dropAction.exec(s)) !== null) {
      hit = true;
      const kind = d[1].toUpperCase();
      const ifExists = /\bIF\s+EXISTS\b/i.test(d[0]);
      if (kind === 'CONSTRAINT' && ifExists && created.has(objKey('CONSTRAINT', d[2], at[1])))
        add(notes, 'ALTER TABLE … DROP CONSTRAINT IF EXISTS + re-added in this file');
      else
        add(violations, `ALTER TABLE … DROP ${kind}`);
    }
    if (hit) return;
  }

  if (/\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i.test(s)) return add(violations, 'RENAME (breaks old code)');
  if (/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i.test(s)) return add(violations, 'ALTER COLUMN TYPE (narrowing risk)');
  if (/\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i.test(s)) return add(violations, 'SET NOT NULL on existing column');
  if (/\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s) && !/\bGENERATED\b/i.test(s))
    return add(violations, 'ADD COLUMN NOT NULL without DEFAULT');
  if (/^TRUNCATE\b/i.test(s)) return add(violations, 'TRUNCATE');

  if (/^DELETE\s+FROM\b/i.test(s)) {
    return scoped(s)
      ? add(notes, 'scoped DELETE (data-touching — the full gate must judge it)')
      : add(violations, 'unguarded DELETE (no WHERE, or a WHERE that matches every row)');
  }
  if (/^UPDATE\s+\S+\s+SET\b/i.test(s)) {
    return scoped(s)
      ? add(notes, 'scoped UPDATE / backfill (data-touching — the full gate must judge it)')
      : add(violations, 'unguarded UPDATE (no WHERE, or a WHERE that matches every row)');
  }
}

// A DO block RUNS at migration time, so its body IS scanned. But a body is procedural code, so
// two things must be separated or the screen goes back to flagging everything:
//   · EXECUTED SQL — statements written directly in the body, PLUS string literals that actually
//     look like a SQL statement (`EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', …)`).
//   · MENTIONED SQL — a keyword that is merely data: `WHERE privilege_type = 'TRUNCATE'` in an
//     assertion, or an identifier like `v_bad_truncate`. A bare literal with no object after the
//     keyword is not a statement, so it is ignored. (Both patterns are real in this repo.)
// A dynamic drop+recreate loop (`DROP TRIGGER …` + `CREATE TRIGGER …` in the same body) is the
// idempotent form again → note, plus a dynamic-EXECUTE note telling the gate to read the body.
const DO_STMT = /^\s*(?:DROP\s+(?:MATERIALIZED\s+VIEW|TABLE|SCHEMA|VIEW|SEQUENCE|TYPE|POLICY|TRIGGER|FUNCTION|INDEX)|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM|UPDATE|ALTER\s+TABLE)\s+\S/i;

function executedSql(body) {
  const lits = [];
  // Literals are candidate dynamic SQL; blank them out of the direct-code view.
  const direct = body.replace(/'((?:[^']|'')*)'/g, (whole, inner) => {
    if (DO_STMT.test(inner)) lits.push(inner);
    return blank(whole);
  });
  return [direct, ...lits];
}

function scanDoBody(body, sql, created, violations, notes) {
  const line = lineOf(sql, body.offset);
  const b = body.text;
  const add = (bucket, rule) => bucket.push({ rule: `in DO block: ${rule}`, line, text: oneLine(b) });
  const fragments = executedSql(b);
  // A CREATE of the same kind anywhere in the body (literal or not) = a dynamic recreate loop.
  const recreatesKind = (kind) => new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?${kind.replace(/\s+/g, '\\s+')}\\b`, 'i').test(b);
  const seen = new Set();
  const once = (bucket, rule) => { if (!seen.has(rule)) { seen.add(rule); add(bucket, rule); } };

  for (const frag of fragments) {
    const dropRe = new RegExp(`\\bDROP\\s+(MATERIALIZED\\s+VIEW|TABLE|SCHEMA|VIEW|SEQUENCE|TYPE|POLICY|TRIGGER|FUNCTION|INDEX)\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT.slice(1, -1)}|%[Isq])`, 'gi');
    let m;
    while ((m = dropRe.exec(frag)) !== null) {
      const kind = m[1].replace(/\s+/g, ' ').toUpperCase();
      const ifExists = /\bIF\s+EXISTS\b/i.test(m[0]);
      const after = frag.slice(m.index + m[0].length);
      const onTable = after.match(new RegExp(`^\\s*ON\\s+(?:TABLE\\s+)?${IDENT}`, 'i'));
      const args = after.trimStart().startsWith('(') ? after.trimStart().slice(0, matchParen(after.trimStart()) + 1) : null;
      const benign = !NEVER_BENIGN.has(kind) && ifExists &&
        (wasRecreated(created, kind, m[2], onTable && onTable[1], args) || recreatesKind(kind));
      if (benign) once(notes, `DROP ${kind} IF EXISTS + re-created in this block/file`);
      else once(violations, `DROP ${kind} (executes at migration time)`);
    }
    if (/\bTRUNCATE(\s+TABLE)?\s+\S/i.test(frag)) once(violations, 'TRUNCATE');
    if (/\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(COLUMN|CONSTRAINT)\b/i.test(frag)) once(violations, 'ALTER TABLE … DROP COLUMN/CONSTRAINT');
    if (/\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i.test(frag)) once(violations, 'RENAME');
    // Same bar as a top-level statement (incl. the tautological-WHERE rule): a DO block is not a
    // loophole for a whole-table DELETE/UPDATE, written directly or via `EXECUTE 'UPDATE …'`.
    const dml = /\b(DELETE\s+FROM|UPDATE)\s+[\s\S]*$/i.exec(frag);
    if (/\bDELETE\s+FROM\s+\S/i.test(frag))
      scoped(dml ? dml[0] : frag) ? once(notes, 'scoped DELETE (data-touching)') : once(violations, 'unguarded DELETE (no WHERE, or a WHERE that matches every row)');
    if (/\bUPDATE\s+\S+\s+SET\b/i.test(frag))
      scoped(dml ? dml[0] : frag) ? once(notes, 'scoped UPDATE / backfill (data-touching)') : once(violations, 'unguarded UPDATE (no WHERE, or a WHERE that matches every row)');
  }
  // Dynamic SQL we cannot statically read. Not a blocker; the gate MUST read it by hand.
  // "Readable" means the EXECUTE argument is ONE complete string literal (already scanned above
  // as a fragment). Anything else — a variable, `format(…)`, or CONCATENATION like
  // `EXECUTE 'DROP ' || 'TABLE users'` (whose pieces individually look like nothing) — is
  // unreadable statically and must be surfaced rather than silently passed.
  const ex = /\bEXECUTE\b/gi;
  let e;
  while ((e = ex.exec(b)) !== null) {
    let arg = b.slice(e.index + e[0].length);
    const stop = arg.indexOf(';');
    if (stop > -1) arg = arg.slice(0, stop);
    arg = arg.trim();
    // strip one complete leading literal, if that is how it starts
    let rest = arg;
    if (arg.startsWith("'")) {
      let j = 1;
      while (j < arg.length) {
        if (arg[j] === "'" && arg[j + 1] === "'") { j += 2; continue; }
        if (arg[j] === "'") break;
        j++;
      }
      rest = arg.slice(j + 1);
    }
    if (!arg.startsWith("'") || rest.trim())
      once(notes, 'dynamic EXECUTE (variable, format() or concatenated SQL) — the full gate must read this body');
  }
}

// Version prefix = leading digits of the filename before the first underscore.
function prefixOf(file) { const m = basename(file).match(/^(\d+)/); return m ? m[1] : null; }

// A function body is not executed when it is DEFINED — but a migration that then CALLS it
// (`SELECT public.__reset_policies('contests')`) does run that SQL at migration time. Chasing
// the indirection statically is out of scope; flagging it is not. NOTE, not violation.
function scanCalledFunctions(fnBodies, code, callerText, notes) {
  for (const fb of fnBodies) {
    const destructive = /\bDROP\s+(TABLE|POLICY|TRIGGER|FUNCTION|INDEX|CONSTRAINT|VIEW|SCHEMA|TYPE|SEQUENCE)\b|\bTRUNCATE\s+\S|\bDELETE\s+FROM\s+\S|\bALTER\s+TABLE\b[\s\S]*?\bDROP\b|\bRENAME\s+(TO|COLUMN)\b/i.exec(fb.text);
    if (!destructive) continue;
    const n = bare(fb.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const called = new RegExp(`\\b(?:SELECT|PERFORM|CALL)\\s+(?:[\\w"]+\\.)?${n}\\s*\\(`, 'i').test(callerText);
    if (called) notes.push({
      rule: `function ${bare(fb.name)}() contains "${destructive[0].replace(/\s+/g, ' ').trim().slice(0, 40)}" AND is CALLED in this migration — the full gate must read it`,
      line: lineOf(code, fb.offset), text: '',
    });
  }
}

function scan(file) {
  if (!existsSync(file)) fail(2, `sql file not found: ${file}`);
  const { code, doBodies, fnBodies } = lex(readFileSync(file, 'utf8'));
  const stmts = statements(code);
  const created = createdKeys(stmts);
  const violations = [], notes = [];
  for (const st of stmts) scanStatement(st, code, created, violations, notes);
  for (const body of doBodies) scanDoBody(body, code, created, violations, notes);
  // A call can be top-level OR inside a DO block (`PERFORM public.__reset_policies(t)`), and DO
  // bodies are blanked out of `code` — so look for callers in both.
  scanCalledFunctions(fnBodies, code, code + doBodies.map(b => b.text).join('\n'), notes);
  return { file, prefix: prefixOf(file), violations, notes };
}

const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--registry');
const regIdx = argv.indexOf('--registry');
if (!files.length) fail(2, 'usage: node migration-safety.mjs <file.sql...> [--registry prefixes.txt]');

let registry = [];
if (regIdx > -1) {
  const rp = argv[regIdx + 1];
  if (!rp || !existsSync(rp)) fail(2, `--registry file not found: ${rp}`);
  registry = readFileSync(rp, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
}

const reports = files.map(scan);

// Version-prefix collisions: among the given files AND against the registry.
const seen = new Map();
for (const r of reports) {
  if (!r.prefix) { r.violations.push({ rule: 'filename has no numeric version prefix', line: 0, text: basename(r.file) }); continue; }
  if (registry.includes(r.prefix)) r.violations.push({ rule: `version prefix ${r.prefix} already applied (registry)`, line: 0, text: '' });
  if (seen.has(r.prefix)) r.violations.push({ rule: `version prefix ${r.prefix} collides with ${basename(seen.get(r.prefix))}`, line: 0, text: '' });
  else seen.set(r.prefix, r.file);
}

const total = reports.reduce((n, r) => n + r.violations.length, 0);
const noteCount = reports.reduce((n, r) => n + r.notes.length, 0);
process.stdout.write(JSON.stringify({ clean: total === 0, violations: total, notes: noteCount, reports }, null, 2) + '\n');
if (total) { process.stderr.write(`\n${total} violation(s) — NOT expand-only-safe; the migration gate must not pass on the static screen alone.\n`); process.exit(1); }
// STDOUT IS JSON ONLY — the header and README promise a parseable report, so the human-readable
// summary goes to stderr. Appending prose after the object breaks every caller that JSON.parses it.
process.stderr.write(`static screen clean${noteCount ? ` (${noteCount} note(s) for the gate to judge — data-touching but scoped)` : ''} — proceed to the full migration gate (staging dry-run + LIVE prod-schema check).\n`);
