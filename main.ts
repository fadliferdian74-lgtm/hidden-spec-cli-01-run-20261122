// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they
// are, and write the CLI.

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

/** A file split into lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in the file's lines at one tier. */
function occurrencesAt(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    const positions = occurrencesAt(fileLines, O, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of the replacement text: a context line (written as the file's own matched line) or a new line. */
interface NEntry {
  text: string;
  /** index of the matching line inside O when this is a context line, else -1 */
  ctx: number;
}

/**
 * Build the lines that replace O at position `pos`: context lines come from the file itself;
 * at tier 2 every other non-blank line is re-indented from O's first line's indent to the
 * file's first matched line's indent (SPEC.md section 5).
 */
function buildReplacement(fileLines: string[], pos: number, O: string[], N: NEntry[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadingWs(fileLines[pos]!);
    p = leadingWs(O[0]!);
  }
  for (const e of N) {
    if (e.ctx >= 0) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    const t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** Moves a successful move edit records, so the output can print an R line for it. */
type MoveSink = (oldPath: string, newPath: string) => void;

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  /** Old-file start line, 1-based, from the @@ header. */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines: context lines (ctx >= 0) and `+` lines, in body order. */
  n: NEntry[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
  /** True when a `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
}

interface UnifiedSection {
  oldPath: string | null; // null: /dev/null (no file)
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '';
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/**
 * Parse one hunk starting at lines[i] (a @@ header). Returns the hunk and the index of
 * the first line after its body.
 */
function parseHunk(lines: string[], i: number): { hunk: UnifiedHunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l.startsWith('-')) o.push(l.slice(1));
    else if (l.startsWith('+')) n.push({ text: l.slice(1), ctx: -1 });
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l.startsWith(' ') || l.startsWith('+') || l === '') lastCtxOrPlus = k;
    if (l.startsWith('+')) lastPlus = k;
  }
  const backslashAfterLast =
    lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const backslashAfterLastPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { hunk: { a, o, n, backslashAfterLast, backslashAfterLastPlus }, next: j };
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A section starting at its ---/+++ pair; fall through to the header loop.
    } else {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // Header loop: before the first hunk.
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isCreate = false;
    let isDelete = false;
    let sawPair = false;
    const hunks: UnifiedHunk[] = [];
    let inHeader = true;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader) {
          oldPath = headerPath(l);
          newPath = headerPath(lines[i + 1]!);
          sawPair = true;
          i += 2;
          continue;
        }
        break; // a new section starts here
      }
      if (l.startsWith('--- ')) {
        if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunk(lines, i);
        hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      if (inHeader) {
        if (l.startsWith('rename from ')) oldPath = l.slice('rename from '.length).trim();
        else if (l.startsWith('rename to ')) newPath = l.slice('rename to '.length).trim();
        else if (l.startsWith('new file mode')) isCreate = true;
        else if (l.startsWith('deleted file mode')) isDelete = true;
        i += 1;
        continue;
      }
      i += 1; // prose outside bodies, ignored
    }
    if (oldPath === null) oldPath = diffOld;
    if (newPath === null) newPath = diffNew;
    if (!sawPair && diffOld === null && oldPath === null) oldPath = '';
    if (!sawPair && diffNew === null && newPath === null) newPath = '';
    sections.push({
      oldPath: oldPath === '' ? null : oldPath,
      newPath: newPath === '' ? null : newPath,
      isCreate,
      isDelete,
      hunks,
    });
  }
  return sections;
}

/** Apply one hunk to a file's lines; d is the drift of this section's hunks applied so far. */
function applyUnifiedHunk(state: FileState, hunk: UnifiedHunk, strict: boolean, d: number, path: string): FileState {
  const lines = state.lines;
  let final = state.final;
  if (hunk.o.length > 0) {
    const found = findTier(lines, hunk.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const replacement = buildReplacement(lines, pos, hunk.o, hunk.n, found.tier);
    const next = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + hunk.o.length)];
    if (pos + hunk.o.length === lines.length) final = !hunk.backslashAfterLast;
    return { br: state.br, lines: next, final };
  }
  const insertAt = Math.min(Math.max(hunk.a + d, 0), lines.length);
  const added = hunk.n.map((e) => e.text);
  const next = [...lines.slice(0, insertAt), ...added, ...lines.slice(insertAt)];
  if (insertAt === lines.length) final = !hunk.backslashAfterLast;
  return { br: state.br, lines: next, final };
}

function unifiedEdits(lines: string[], strict: boolean, recordMove: MoveSink): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((section) => (tree: Tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (section.isCreate || oldP === null) {
      const p = newP ?? oldP ?? '';
      if (p === '') throw new Fail('unsafe', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of section.hunks) {
        for (const e of h.n) if (e.ctx < 0) plus.push(e.text);
        if (h.backslashAfterLastPlus) noBreak = true;
        else if (h.n.some((e) => e.ctx < 0)) noBreak = false;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (section.isDelete || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let state = splitFile(before);
      let d = 0;
      for (const h of section.hunks) {
        state = applyUnifiedHunk(state, h, strict, d, oldP!);
        d += h.n.length - h.o.length;
      }
      tree.now.set(oldP!, null);
      tree.now.set(newP!, joinFile(state));
      recordMove(oldP!, newP!);
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    let state = splitFile(before);
    let d = 0;
    for (const h of section.hunks) {
      state = applyUnifiedHunk(state, h, strict, d, oldP!);
      d += h.n.length - h.o.length;
    }
    tree.now.set(oldP!, joinFile(state));
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SearchBlock[] {
  const blocks: SearchBlock[] = [];
  let searchFrom = 0; // lines before this belong to earlier blocks
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path: the nearest line before the SEARCH line, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // Old lines up to =======, then new lines up to >>>>>>> REPLACE.
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const l = lines[k]!.trimEnd();
      if (l === '=======') {
        sep = k;
        break;
      }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    for (let k = sep + 1; k < lines.length; k += 1) {
      const l = lines[k]!.trimEnd();
      if (l === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (l === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((block) => (tree: Tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.newLines.length === 0 ? '' : `${block.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = splitFile(before);
    const found = findTier(state.lines, block.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const replacement = buildReplacement(state.lines, pos, block.oldLines, block.newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
    const next = [...state.lines.slice(0, pos), ...replacement, ...state.lines.slice(pos + block.oldLines.length)];
    tree.now.set(p, joinFile({ br: state.br, lines: next, final: state.final }));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null: no anchor (empty @@ text counts as none)
  o: string[];
  n: NEntry[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the file's lines. Update File: its chunks. */
  lines: string[];
  chunks: V4aChunk[];
  /** 1-based line of the section's header, for parse errors. */
  headerLine: number;
}

function parseV4aChunkBody(body: string[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l.startsWith('-')) o.push(l.slice(1));
    else if (l.startsWith('+')) n.push({ text: l.slice(1), ctx: -1 });
  }
  return { o, n };
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    // Collect the section's lines, up to the next section or the End Patch line.
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const x = lines[j]!;
      if (
        x.startsWith('*** Add File: ') ||
        x.startsWith('*** Delete File: ') ||
        x.startsWith('*** Update File: ') ||
        x.trim() === '*** End Patch'
      ) {
        break;
      }
      raw.push(x);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const section: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], headerLine };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const x = raw[k]!;
        if (x.startsWith('+')) section.lines.push(x.slice(1));
        else if (x === '') section.lines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
    } else {
      // Update File: an optional Move to first, then chunks.
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        section.moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let chunkBody: string[] = [];
      let anchor: string | null = null;
      let eof = false;
      let haveChunk = false;
      const flush = (): void => {
        if (!haveChunk) return;
        const { o, n } = parseV4aChunkBody(chunkBody);
        section.chunks.push({ anchor, o, n, eof });
        chunkBody = [];
        anchor = null;
        eof = false;
        haveChunk = false;
      };
      while (k < raw.length) {
        const x = raw[k]!;
        if (x.startsWith('@@')) {
          flush();
          anchor = x.slice(2).trim();
          if (anchor === '') anchor = null;
          haveChunk = true;
          eof = false;
          k += 1;
          continue;
        }
        if (x.trim() === '*** End of File') {
          if (!haveChunk) {
            // An End of File with no chunk open starts an empty end-of-file chunk.
            haveChunk = true;
            anchor = null;
          }
          eof = true;
          flush();
          k += 1;
          continue;
        }
        if (x.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 2 + k}`);
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || x === '') {
          if (!haveChunk) {
            haveChunk = true;
            anchor = null;
            eof = false;
          }
          chunkBody.push(x);
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      flush();
      if (section.chunks.length === 0 && section.moveTo === null) {
        throw new Exit2(`error: parse ${headerLine}`);
      }
    }
    sections.push(section);
    i = j;
  }
  return sections;
}

function applyV4aChunk(state: FileState, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let found: number | null = null;
    const maxTier = strict ? 0 : 2;
    for (let t = 0; t <= maxTier && found === null; t += 1) {
      for (let i = cur; i < state.lines.length; i += 1) {
        if (lineEq(state.lines[i]!, chunk.anchor, t)) {
          found = i;
          break;
        }
      }
    }
    if (found === null) throw new Fail('no-match', path);
    cur = found + 1;
  }
  if (chunk.o.length === 0) {
    const at = chunk.eof ? state.lines.length : cur;
    const added = chunk.n.map((e) => e.text);
    const next = [...state.lines.slice(0, at), ...added, ...state.lines.slice(at)];
    return { state: { br: state.br, lines: next, final: state.final }, cursor: at + added.length };
  }
  let pos: number | null = null;
  let tier = 0;
  if (chunk.eof) {
    const want = state.lines.length - chunk.o.length;
    if (want >= cur) {
      const maxTier = strict ? 0 : 2;
      for (let t = 0; t <= maxTier; t += 1) {
        let ok = true;
        for (let j = 0; j < chunk.o.length; j += 1) {
          if (!lineEq(state.lines[want + j]!, chunk.o[j]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          pos = want;
          tier = t;
          break;
        }
      }
    }
  } else {
    const found = findTier(state.lines.slice(cur), chunk.o, strict);
    if (found !== null) {
      pos = cur + found.positions[0]!;
      tier = found.tier;
    }
  }
  if (pos === null) throw new Fail('no-match', path);
  const replacement = buildReplacement(state.lines, pos, chunk.o, chunk.n, tier);
  const next = [...state.lines.slice(0, pos), ...replacement, ...state.lines.slice(pos + chunk.o.length)];
  return { state: { br: state.br, lines: next, final: state.final }, cursor: pos + replacement.length };
}

function v4aEdits(lines: string[], strict: boolean, recordMove: MoveSink): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((section) => (tree: Tree) => {
    const p = section.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (section.moveTo !== null && !safe(section.moveTo)) throw new Fail('unsafe', section.moveTo);
    if (section.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, section.lines.length === 0 ? '' : `${section.lines.join('\n')}\n`);
      return;
    }
    if (section.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (section.moveTo !== null && tree.get(section.moveTo) !== null) throw new Fail('exists', section.moveTo);
    let state = splitFile(before);
    let cursor = 0;
    for (const chunk of section.chunks) {
      const r = applyV4aChunk(state, chunk, cursor, strict, p);
      state = r.state;
      cursor = r.cursor;
    }
    const out = joinFile(state);
    if (section.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(section.moveTo, out);
      recordMove(p, section.moveTo);
    } else {
      tree.now.set(p, out);
    }
  });
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const recordMove: MoveSink = (oldPath, newPath) => {
    moves.push([oldPath, newPath]);
  };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, recordMove)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, recordMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Write every change (unless --check), then report them in byte order of the paths.
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const consumed = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
