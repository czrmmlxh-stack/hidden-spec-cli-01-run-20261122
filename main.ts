// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. Sections 1 to 4 (invocation,
// output, paths, detection), 9 (JSON) and 10 (order and atomicity) follow the
// kit starter's shape; sections 5 (matching), 6 (unified), 7 (SEARCH/REPLACE)
// and 8 (V4A) are implemented here, with move output (`R old -> new`).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs recorded by move edits that succeeded, in patch order. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break and its final line break. */
/* ------------------------------------------------------------------ */

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/* --------------------------------------------------------------- */
/* Section 5: matching lines at the first tier with an occurrence. */
/* --------------------------------------------------------------- */

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O matches `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, or 0..2 unless strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** N as it is written over the matched lines at `pos`: context lines come from
 * the file's own matched lines; at tier 2 every other line is re-indented. */
function buildN(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const p = leadingWs(o[0] ?? '');
  const f = leadingWs(fileLines[pos] ?? '');
  return n.map((nl) => {
    if (nl.ctx >= 0) return fileLines[pos + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      return f + nl.text.slice(p.length);
    }
    return nl.text;
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* -------------------------------------------------------------- */
/* Section 6: unified diff.                                      */
/* -------------------------------------------------------------- */

interface Hunk {
  /** Old start line (1-based), from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  /** Raw body lines, trailing empty lines stripped. */
  body: string[];
  /** Old lines and new lines, derived from the body. */
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNl: boolean;
}

interface Section {
  oldPath: string | null; // null when the path is /dev/null (no file)
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The header path from `--- X` or `+++ X`: up to the first tab, spaces trimmed. */
function headerPath(l: string): string {
  const rest = l.slice(4);
  return rest.split('\t')[0]!.trim();
}

/** The path from `--- ` / `+++ `, null for /dev/null, a/b stripped. */
function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function deriveHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
      lastPlus = k;
      lastCtxOrPlus = k;
    }
    // '\' lines are annotations, not lines.
  }
  const noNl = lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const lastPlusNoNl = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, body, o, n, noNl, lastPlusNoNl };
}

/** Body lines of one hunk, from `i` until the first other line. */
function hunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let pairSeen = false;
  let phase: 'none' | 'header' | 'hunks' = 'none';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      pairSeen = false;
      phase = 'header';
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (phase === 'header' && cur !== null) {
        cur.oldPath = stripAB(headerPath(l));
        cur.newPath = stripAB(headerPath(lines[i + 1]!));
        pairSeen = true;
        i += 2;
        continue;
      }
      cur = { oldPath: stripAB(headerPath(l)), newPath: stripAB(headerPath(lines[i + 1]!)), isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      pairSeen = true;
      phase = 'header';
      i += 2;
      continue;
    }
    if (phase === 'header' && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = hunkBody(lines, i + 1);
        cur.hunks.push(deriveHunk(parseInt(m[1]!, 10), body));
        phase = 'hunks';
        i = next;
        continue;
      }
      if (l.startsWith('rename from ') && !pairSeen) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !pairSeen) cur.newPath = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isCreate = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDelete = true;
      // index, old mode, new mode, similarity, dissimilarity, Index: and other lines ignored.
      i++;
      continue;
    }
    if (phase === 'hunks' && cur !== null) {
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const { body, next } = hunkBody(lines, i + 1);
        cur.hunks.push(deriveHunk(parseInt(m[1]!, 10), body));
        i = next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree) => applyUnifiedSection(tree, sec, strict));
}

/** One hunk over `f`, with the section drift `d` added to its old start. */
function applyHunk(f: FileState, hunk: Hunk, strict: boolean, d: number, path: string): FileState {
  if (hunk.o.length === 0) {
    const at = Math.min(hunk.a + d, f.lines.length);
    const lines = [...f.lines];
    lines.splice(at, 0, ...hunk.n.map((nl) => nl.text));
    const runsToEnd = at === f.lines.length;
    return { br: f.br, lines, final: runsToEnd ? !hunk.noNl : f.final };
  }
  const found = findTier(f.lines, hunk.o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const runsToEnd = best + hunk.o.length === f.lines.length;
  const rep = buildN(f.lines, best, hunk.o, hunk.n, found.tier);
  const lines = [...f.lines];
  lines.splice(best, hunk.o.length, ...rep);
  return { br: f.br, lines, final: runsToEnd ? !hunk.noNl : f.final };
}

function applyUnifiedSection(tree: Tree, sec: Section, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (sec.isCreate || oldP === null) {
    const p = newP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const plus: string[] = [];
    let lastPlusNoNl = false;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        const l = h.body[k]!;
        if (l[0] === '+') {
          plus.push(l.slice(1));
          lastPlusNoNl = h.body[k + 1] !== undefined && h.body[k + 1]!.startsWith('\\');
        }
      }
    }
    tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNl ? '' : '\n'));
    return;
  }
  if (sec.isDelete || newP === null) {
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  if (oldP !== newP) {
    if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
    if (!safe(newP!)) throw new Fail('unsafe', newP!);
    const cur = tree.get(oldP!);
    if (cur === null) throw new Fail('missing', oldP!);
    if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyHunk(f, h, strict, d, oldP!);
      d += h.n.length - h.o.length;
    }
    tree.now.set(newP!, joinFile(f));
    tree.now.set(oldP!, null);
    tree.moves.push([oldP!, newP!]);
    return;
  }
  if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
  const cur = tree.get(oldP!);
  if (cur === null) throw new Fail('missing', oldP!);
  let f = splitFile(cur);
  let d = 0;
  for (const h of sec.hunks) {
    f = applyHunk(f, h, strict, d, oldP!);
    d += h.n.length - h.o.length;
  }
  tree.now.set(oldP!, joinFile(f));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                  */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; old: string[]; nw: string[] }[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, sep), nw: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.old, strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0]!;
    const rep = buildN(f.lines, pos, b.old, b.nw.map((t) => ({ text: t, ctx: -1 })), found.tier);
    const out = [...f.lines];
    out.splice(pos, b.old.length, ...rep);
    tree.now.set(p, joinFile({ ...f, lines: out }));
  });
}

/* -------------------------------------------------------------- */
/* Section 8: V4A.                                                */
/* -------------------------------------------------------------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

function buildVChunk(anchor: string | null, eof: boolean, lines: string[]): VChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of lines) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { anchor, eof, o, n };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const isAdd = l.startsWith('*** Add File: ');
    const isDel = l.startsWith('*** Delete File: ');
    const isUpd = l.startsWith('*** Update File: ');
    if (!isAdd && !isDel && !isUpd) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last) {
      const m = lines[j]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      j++;
    }
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    edits.push(parseV4aSection(l, body, i + 1, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4aSection(header: string, body: string[], headerLine: number, strict: boolean): Edit {
  if (header.startsWith('*** Add File: ')) {
    const p = header.slice('*** Add File: '.length).trim();
    const fileLines: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${headerLine + 1 + k}`);
    }
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (header.startsWith('*** Delete File: ')) {
    const p = header.slice('*** Delete File: '.length).trim();
    for (let k = 0; k < body.length; k++) {
      if (!blank(body[k]!)) throw new Exit2(`error: parse ${headerLine + 1 + k}`);
    }
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = header.slice('*** Update File: '.length).trim();
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; lines: string[] } | null = null;
  let started = false;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur.anchor, cur.eof, cur.lines));
      cur = null;
    }
  };
  while (k < body.length) {
    const l = body[k]!;
    const lineNo = headerLine + 1 + k;
    if (l.startsWith('@@')) {
      flush();
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, lines: [] };
      started = true;
      k++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      k++;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, lines: [] };
        started = true;
      }
      cur.lines.push(l);
      k++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const curText = tree.get(p);
    if (curText === null) throw new Fail('missing', p);
    let dest: string | null = null;
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      dest = moveTo;
    }
    let f = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTier(f.lines, [ch.anchor], strict, cursor);
        if (a === null) throw new Fail('no-match', p);
        cursor = a.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const rep = ch.n.map((nl) => nl.text);
        const lines = [...f.lines];
        lines.splice(at, 0, ...rep);
        f = { ...f, lines };
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(f.lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos = found.pos[0]!;
      if (ch.eof) {
        const ok = found.pos.filter((q) => q + ch.o.length === f.lines.length);
        if (ok.length === 0) throw new Fail('no-match', p);
        pos = ok[0]!;
      }
      const rep = buildN(f.lines, pos, ch.o, ch.n, found.tier);
      const lines = [...f.lines];
      lines.splice(pos, ch.o.length, ...rep);
      f = { ...f, lines };
      cursor = pos + rep.length;
    }
    const out = joinFile(f);
    if (dest !== null) {
      tree.now.set(dest, out);
      tree.now.set(p, null);
      tree.moves.push([p, dest]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/* -------------------------------------------------------------- */
/* Section 1 and 2: invocation, output and exit codes.            */
/* -------------------------------------------------------------- */

interface Result {
  code: number;
  out: string[];
}

function run(args: string[], input: string): Result {
  let format = 'auto';
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let seenDashDash = false;
  for (const a of args) {
    if (seenDashDash) {
      if (positional !== null) return { code: 2, out: ['error: usage'] };
      positional = a;
      continue;
    }
    if (a === '--') {
      seenDashDash = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const value = eq === -1 ? null : a.slice(eq + 1);
      if (name === '--format') {
        if (format !== 'auto') return { code: 2, out: ['error: usage'] };
        if (value === null || !FORMATS.includes(value) || value === 'auto') return { code: 2, out: ['error: usage'] };
        format = value;
      } else if (name === '--check') {
        if (check || value !== null) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (name === '--strict') {
        if (strict || value !== null) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else if (a.startsWith('-') && a !== '-') {
      return { code: 2, out: ['error: usage'] };
    } else {
      if (positional !== null) return { code: 2, out: ['error: usage'] };
      positional = a;
    }
  }
  let patch: string;
  if (positional !== null && positional !== '-') {
    try {
      patch = readFileSync(positional, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    patch = input;
  }
  const lines = patchLines(patch);
  const kind = format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(patch, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (process.env.MAKEFUN_ENV_URL) {
    const { runTrial } = await import('./runner.ts');
    await runTrial();
    return;
  }
  if (argv.length === 0) {
    const chunks: string[] = [];
    let ended = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => chunks.push(c));
    process.stdin.on('end', () => {
      ended = true;
    });
    await new Promise<void>((resolve) => {
      process.stdin.on('end', resolve);
    });
    if (!ended) return;
    const r = run([], chunks.join(''));
    for (const line of r.out) writeSync(1, line + '\n');
    process.exitCode = r.code;
    return;
  }
  const patchFile = argv.find((a) => !a.startsWith('-') && a !== '--');
  if (patchFile !== undefined && patchFile !== '-') {
    const r = run(argv, '');
    for (const line of r.out) writeSync(1, line + '\n');
    process.exitCode = r.code;
    return;
  }
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c: string) => chunks.push(c));
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
  });
  const r = run(argv, chunks.join(''));
  for (const line of r.out) writeSync(1, line + '\n');
  process.exitCode = r.code;
}

await main();
