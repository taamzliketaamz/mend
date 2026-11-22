// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads an edit in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines: its own line break, and whether its text ends with that break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function parseFL(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serialize(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.finalBreak ? fl.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) recorded by move edits that ran, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/* Section 5: matching lines at three tiers. */

const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

/** Every 0-based position at or after `from` where O's lines match the file's lines at `tier`; may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk, chunk or block: context, old-only or new-only. */
interface Ent {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this body line (no line break after it at the end of a file). */
  noEol?: boolean;
  /** This entry came from a bare empty patch line rather than a prefixed one. */
  fromEmpty?: boolean;
  /** The patch line this entry came from was blank (empty or only whitespace). */
  srcBlank?: boolean;
}

/**
 * The lines N writes when O matched at `start`: context lines are the file's own matched lines; at tier 2 the
 * other lines are re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function buildN(entries: Ent[], fileLines: string[], start: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let f = '';
  let p = '';
  if (tier === 2) {
    const firstO = entries.find((e) => e.kind !== 'add');
    if (firstO !== undefined) {
      f = leadWS(fileLines[start] ?? '');
      p = leadWS(firstO.text);
    }
  }
  for (const e of entries) {
    if (e.kind === 'del') {
      oi += 1;
      continue;
    }
    if (e.kind === 'ctx') {
      out.push(fileLines[start + oi]!);
      oi += 1;
      continue;
    }
    if (tier === 2 && !/^[ \t]*$/.test(e.text) && e.text.startsWith(p)) out.push(f + e.text.slice(p.length));
    else out.push(e.text);
  }
  return out;
}

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

/* Section 6: unified diffs. */

interface UHunk {
  a: number;
  entries: Ent[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  oldP: string | null | undefined;
  newP: string | null | undefined;
  pairSeen: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `---` or `+++` header line names: after the four characters, to the first tab, spaces removed. */
function headPath(line: string): string | null {
  let t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Apply a section's hunks in order to a file's lines; d tracks the sections' length change so far. */
function applyHunks(fl: FileLines, hunks: UHunk[], strict: boolean, path: string): FileLines {
  const lines = [...fl.lines];
  let finalBreak = fl.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const o = h.entries.filter((e) => e.kind !== 'add');
    const n = h.entries.filter((e) => e.kind !== 'del');
    if (o.length > 0) {
      const found = findTier(lines, o.map((e) => e.text), strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      for (const i of found.occ) if (Math.abs(i - target) < Math.abs(at - target)) at = i;
      const written = buildN(h.entries, lines, at, found.tier);
      const endsEof = at + o.length === lines.length;
      lines.splice(at, o.length, ...written);
      if (endsEof) {
        const lastN = n[n.length - 1];
        finalBreak = lastN !== undefined ? !lastN.noEol : lines.length > 0;
      }
    } else if (n.length > 0) {
      const pos = Math.min(h.a + d, lines.length);
      const written = buildN(h.entries, lines, pos, 0);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...written);
      if (atEnd) finalBreak = !n[n.length - 1]!.noEol;
    }
    d += n.length - o.length;
  }
  return { lines, br: fl.br, finalBreak };
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.oldP !== undefined ? s.oldP : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
  const newPath = s.newP !== undefined ? s.newP : s.renameTo !== undefined ? s.renameTo : s.diffNew;
  return (tree) => {
    if (oldPath !== null && oldPath !== undefined && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== undefined && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreate = oldPath === null || s.newFile;
    const isDelete = !isCreate && (newPath === null || s.delFile);
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const adds: Ent[] = [];
      for (const h of s.hunks) for (const e of h.entries) if (e.kind === 'add') adds.push(e);
      const last = adds[adds.length - 1];
      tree.now.set(p, serialize({ lines: adds.map((e) => e.text), br: '\n', finalBreak: last !== undefined ? !last.noEol : false }));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
    const fl = applyHunks(parseFL(before), s.hunks, strict, op);
    tree.now.set(np, serialize(fl));
    if (np !== op) {
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: UHunk | null = null;
  let pendingEmpty = 0;
  const flushEmpty = (): void => {
    while (pendingEmpty > 0) {
      hunk!.entries.push({ kind: 'ctx', text: '', fromEmpty: true });
      pendingEmpty -= 1;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    const next = lines[i + 1] ?? '';
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && next.startsWith('+++ '))) {
        hunk = null;
        pendingEmpty = 0;
      } else if (line === '') {
        pendingEmpty += 1;
        i += 1;
        continue;
      } else if (line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        flushEmpty();
        if (line[0] === ' ') hunk.entries.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') hunk.entries.push({ kind: 'del', text: line.slice(1) });
        else if (line[0] === '+') hunk.entries.push({ kind: 'add', text: line.slice(1) });
        else {
          const last = hunk.entries[hunk.entries.length - 1];
          if (last !== undefined) last.noEol = true;
        }
        i += 1;
        continue;
      } else {
        hunk = null;
        pendingEmpty = 0;
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*) b\/(.*)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${no}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, oldP: undefined, newP: undefined, pairSeen: false, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${no}`);
      hunk = { a: Number.parseInt(m[1]!, 10), entries: [] };
      cur.hunks.push(hunk);
      pendingEmpty = 0;
      i += 1;
      continue;
    }
    const inHeader = cur !== null && cur.hunks.length === 0;
    if (line.startsWith('--- ')) {
      if (next.startsWith('+++ ')) {
        if (inHeader && !cur!.pairSeen) {
          cur!.oldP = headPath(line);
          cur!.newP = headPath(next);
          cur!.pairSeen = true;
        } else {
          cur = { diffOld: null, diffNew: null, oldP: headPath(line), newP: headPath(next), pairSeen: true, newFile: false, delFile: false, hunks: [] };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${no + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) cur!.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur!.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur!.newFile = true;
      else if (line.startsWith('deleted file mode')) cur!.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serialize({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = parseFL(before);
    const found = findTier(fl.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const entries: Ent[] = [
      ...oldLines.map((t) => ({ kind: 'del' as const, text: t })),
      ...newLines.map((t) => ({ kind: 'add' as const, text: t })),
    ];
    const written = buildN(entries, fl.lines, at, found.tier);
    const lines = [...fl.lines];
    lines.splice(at, oldLines.length, ...written);
    tree.now.set(path, serialize({ lines, br: fl.br, finalBreak: fl.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t) || t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Ent[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  moveTo?: string;
  addLines: string[];
  addFromEmpty: boolean[];
  /** Line numbers of whitespace-only lines held in an Add File section: dropped at its end, a fault mid-section. */
  pendingBlank: number[];
  chunks: VChunk[];
}

/** Apply an Update File section's chunks in order, with the cursor of section 8. */
function applyChunks(fl: FileLines, chunks: VChunk[], strict: boolean, path: string): FileLines {
  const lines = [...fl.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let at = -1;
      for (const t of tiers) {
        for (let i = cursor; i < lines.length; i += 1) {
          if (lineEq(lines[i]!, ch.anchor, t)) {
            at = i;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const o = ch.entries.filter((e) => e.kind !== 'add');
    const n = ch.entries.filter((e) => e.kind !== 'del');
    if (o.length === 0) {
      const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      const written = n.map((e) => e.text);
      lines.splice(pos, 0, ...written);
      cursor = pos + written.length;
    } else {
      const tiers = strict ? [0] : [0, 1, 2];
      let pick: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(lines, o.map((e) => e.text), t, cursor).filter((i) => !ch.eof || i + o.length === lines.length);
        if (occ.length > 0) {
          pick = { tier: t, at: occ[0]! };
          break;
        }
      }
      if (pick === null) throw new Fail('no-match', path);
      const written = buildN(ch.entries, lines, pick.at, pick.tier);
      lines.splice(pick.at, o.length, ...written);
      cursor = pick.at + written.length;
    }
  }
  return { lines, br: fl.br, finalBreak: fl.finalBreak };
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, serialize({ lines: [...s.addLines], br: '\n', finalBreak: true }));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    const dest = s.moveTo ?? s.path;
    if (dest !== s.path && tree.get(dest) !== null) throw new Fail('exists', dest);
    const fl = applyChunks(parseFL(before), s.chunks, strict, s.path);
    tree.now.set(dest, serialize(fl));
    if (dest !== s.path) {
      tree.now.set(s.path, null);
      tree.moves.push([s.path, dest]);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  const endSection = (): void => {
    if (cur !== null && cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addFromEmpty[cur.addLines.length - 1]) {
        cur.addLines.pop();
        cur.addFromEmpty.pop();
      }
    }
    if (cur !== null && cur.kind === 'upd' && chunk !== null) {
      while (chunk.entries.length > 0 && chunk.entries[chunk.entries.length - 1]!.srcBlank) chunk.entries.pop();
    }
    cur = null;
    chunk = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:')) {
      endSection();
      const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'del' : 'upd';
      const head = kind === 'add' ? '*** Add File:' : kind === 'del' ? '*** Delete File:' : '*** Update File:';
      cur = { kind, path: line.slice(head.length).trim(), lineNo: no, addLines: [], addFromEmpty: [], pendingBlank: [], chunks: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        if (cur.pendingBlank.length > 0) throw new Exit2(`error: parse ${cur.pendingBlank[0]}`);
        cur.addLines.push(line.slice(1));
        cur.addFromEmpty.push(false);
      } else if (line === '') {
        if (cur.pendingBlank.length > 0) throw new Exit2(`error: parse ${cur.pendingBlank[0]}`);
        cur.addLines.push('');
        cur.addFromEmpty.push(true);
      } else if (blank(line)) {
        cur.pendingBlank.push(no);
      } else throw new Exit2(`error: parse ${no}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    // Update File section.
    if (line.startsWith('*** Move to:')) {
      if (cur.moveTo !== undefined || chunk !== null || cur.chunks.length > 0) throw new Exit2(`error: parse ${no}`);
      cur.moveTo = line.slice('*** Move to:'.length).trim();
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${no}`);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim() || null, eof: false, entries: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, entries: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.entries.push({ kind: 'ctx', text: '', fromEmpty: true, srcBlank: true });
      else if (line[0] === ' ') chunk.entries.push({ kind: 'ctx', text: line.slice(1), srcBlank: blank(line) });
      else if (line[0] === '-') chunk.entries.push({ kind: 'del', text: line.slice(1) });
      else chunk.entries.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  endSection();
  for (const s of sections) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.lineNo}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

/* Section 9: JSON edits. */

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
      const fl = parseFL(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      const lines = [...fl.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, serialize({ lines, br: fl.br, finalBreak: fl.finalBreak }));
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

/* Sections 1, 2 and 10: the command line, the output and the all-or-nothing write. */

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, { key: string; line: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of tree.moves) {
    if (tree.original(o) === null || tree.get(o) !== null || tree.original(n) !== null || tree.get(n) === null) continue;
    const ro = rows.get(o);
    const rn = rows.get(n);
    if (ro === undefined || rn === undefined || !ro.line.startsWith('D ') || !rn.line.startsWith('A ')) continue;
    rows.delete(o);
    rows.set(n, { key: n, line: `R ${o} -> ${n}` });
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...sorted.map((r) => r.line), `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`] };
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
