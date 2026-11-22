// mend: one patch tool for every AI edit format.
//
// Implements SPEC.md version 1 (see SPEC.md in this repository): a unified
// diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
// format and text-editor tool calls as JSON are all read to the one written
// specification, the lines an edit names are found even when the model
// drifted their whitespace or indentation, and every file is changed or
// none is. Node 22, standard library only. Run as:
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// in the root of a tree of text files. When MAKEFUN_ENV_URL is set, this
// file hands the trial over to runner.ts instead of running as a CLI.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function failParse(line: number): never {
  throw new ParseError(line);
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t\r]+$/, '');
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A patch's lines: split at `\n`, one trailing `\r` removed each, without
 *  the empty piece after a final `\n`. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

// ---------------------------------------------------------------------------
// Files: line model (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  brk: string; // '\n' or '\r\n'
  ends: boolean; // the text ends with a line break
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const brk = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let ends = false;
  if (text.endsWith(brk)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, brk, ends };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

// ---------------------------------------------------------------------------
// Paths (SPEC.md section 3)
// ---------------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(F: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(F[i + j], O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(
  F: string[],
  O: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(F, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type NItem = { kind: 'ctx'; oIndex: number } | { kind: 'new'; text: string };

/** Write N's lines: a context line is the file's own matched line, never
 *  the patch's; at tier 2 every other line is re-indented. */
function writeN(
  n: NItem[],
  F: string[],
  pos: number,
  O: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const fLead = pos < F.length ? leadingWs(F[pos]) : '';
  const pLead = O.length > 0 ? leadingWs(O[0]) : '';
  for (const item of n) {
    if (item.kind === 'ctx') {
      out.push(F[pos + item.oIndex]);
    } else {
      let text = item.text;
      if (
        tier === 2 &&
        text !== '' &&
        text.trim() !== '' &&
        text.startsWith(pLead)
      ) {
        text = fLead + text.slice(pLead.length);
      }
      out.push(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface Hunk {
  a: number; // the -A of the hunk header
  o: string[]; // old lines: context and `-` lines
  n: NItem[]; // new lines: context and `+` lines
  backslashAfterLastCtxOrPlus: boolean;
  backslashAfterLastPlus: boolean | null; // null when the hunk has no `+` line
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

type Edit =
  | {
      kind: 'unified';
      oldPath: string | null;
      newPath: string | null;
      isCreate: boolean;
      isDelete: boolean;
      hunks: Hunk[];
    }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; content: string }
  | { kind: 'v4a-delete'; path: string }
  | {
      kind: 'v4a-update';
      path: string;
      moveTo: string | null;
      chunks: VChunk[];
    }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | {
      kind: 'json-insert';
      path: string;
      insertLine: number;
      newStr: string;
    };

interface EditFailure {
  code: string;
  path: string;
}

interface Move {
  old: string;
  new: string;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank !== -1) {
    const t = lines[firstNonBlank].trim();
    if (t === '*** Begin Patch') return 'v4a';
    const c = t.charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const line of lines) {
    if (stripTrailingWs(line) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UniSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newUniSection(): UniSection {
  return {
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces
 *  removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function parseUniPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

type BodyLine =
  | { kind: 'ctx'; text: string }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'backslash' };

function hunkFromBody(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ kind: 'ctx', oIndex: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ kind: 'new', text: b.text });
    }
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') lastCtxOrPlus = i;
    if (body[i].kind === 'new') lastPlus = i;
  }
  const backslashAfterLastCtxOrPlus =
    lastCtxOrPlus !== -1 &&
    lastCtxOrPlus + 1 < body.length &&
    body[lastCtxOrPlus + 1].kind === 'backslash';
  const backslashAfterLastPlus =
    lastPlus === -1
      ? null
      : lastPlus + 1 < body.length &&
        body[lastPlus + 1].kind === 'backslash';
  return { a, o, n, backslashAfterLastCtxOrPlus, backslashAfterLastPlus };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let current: UniSection | null = null;
  let inHeader = false; // current section has no hunk yet
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) failParse(i + 1);
      current = newUniSection();
      current.gitOld = m[1];
      current.gitNew = m[2];
      sections.push(current);
      inHeader = true;
      i += 1;
      continue;
    }
    if (
      line.startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      if (current !== null && inHeader) {
        // Part of the current section's header.
        current.pairOld = parseUniPath(line);
        current.pairNew = parseUniPath(lines[i + 1]);
      } else {
        current = newUniSection();
        current.pairOld = parseUniPath(line);
        current.pairNew = parseUniPath(lines[i + 1]);
        sections.push(current);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (current !== null && inHeader) failParse(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) failParse(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) failParse(i + 1);
      const a = Number(m[1]);
      // Consume the body: lines starting with ` `, `-`, `+` or `\`, or
      // empty. It ends at a `diff --git ` line, at a `--- ` line followed
      // by a `+++ ` line, or at any other line.
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (
          bl.startsWith('--- ') &&
          j + 1 < lines.length &&
          lines[j + 1].startsWith('+++ ')
        ) {
          break;
        }
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          j += 1;
        } else if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          j += 1;
        } else if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1) });
          j += 1;
        } else if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1) });
          j += 1;
        } else if (bl.startsWith('\\')) {
          body.push({ kind: 'backslash' });
          j += 1;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const last = body[body.length - 1];
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      current.hunks.push(hunkFromBody(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        current.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line: ignored.
      i += 1;
      continue;
    }
    // Prose, code fences and anything else outside a section: ignored.
    i += 1;
  }
  if (sections.length === 0) failParse(1);
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath =
      s.pairOld !== undefined
        ? s.pairOld
        : s.renameFrom !== undefined
          ? s.renameFrom
          : (s.gitOld ?? null);
    const newPath =
      s.pairNew !== undefined
        ? s.pairNew
        : s.renameTo !== undefined
          ? s.renameTo
          : (s.gitNew ?? null);
    const isCreate = s.newFile || oldPath === null;
    const isDelete = !isCreate && (s.deletedFile || newPath === null);
    edits.push({
      kind: 'unified',
      oldPath,
      newPath,
      isCreate,
      isDelete,
      hunks: s.hunks,
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function isMarker(line: string, marker: string): boolean {
  return stripTrailingWs(line) === marker;
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let i = 0;
  while (i < lines.length) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) failParse(searchIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isMarker(lines[j], '=======')) {
        eq = j;
        break;
      }
      if (
        isMarker(lines[j], '>>>>>>> REPLACE') ||
        isMarker(lines[j], '<<<<<<< SEARCH')
      ) {
        failParse(searchIdx + 1);
      }
    }
    if (eq === -1) failParse(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (isMarker(lines[j], '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
      if (isMarker(lines[j], '<<<<<<< SEARCH')) failParse(searchIdx + 1);
    }
    if (rep === -1) failParse(searchIdx + 1);
    edits.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(i + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(line: string): boolean {
  return (
    line.startsWith(V4A_ADD) ||
    line.startsWith(V4A_DELETE) ||
    line.startsWith(V4A_UPDATE)
  );
}

function chunkFromBody(body: BodyLine[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ kind: 'ctx', oIndex: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ kind: 'new', text: b.text });
    }
  }
  return { o, n };
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) failParse(1);
  if (lines[first].trim() !== '*** Begin Patch') failParse(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') failParse(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aSectionStart(line)) failParse(i + 1);
    const headerLine = i;
    // Collect the section's lines: up to the next section start or
    // `*** End Patch`, then drop blank lines at the end of the section.
    let j = i + 1;
    const raw: { text: string; no: number }[] = [];
    while (j < last && !isV4aSectionStart(lines[j])) {
      if (lines[j].trim() === '*** End Patch') break;
      raw.push({ text: lines[j], no: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();

    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else failParse(r.no);
      }
      edits.push({
        kind: 'v4a-add',
        path,
        content:
          fileLines.length === 0 ? '' : fileLines.join('\n') + '\n',
      });
    } else if (line.startsWith(V4A_DELETE)) {
      const path = line.slice(V4A_DELETE.length).trim();
      for (const r of raw) {
        if (!isBlank(r.text)) failParse(r.no);
      }
      edits.push({ kind: 'v4a-delete', path });
    } else {
      // Update File.
      const path = line.slice(V4A_UPDATE.length).trim();
      let moveTo: string | null = null;
      let body = raw;
      if (body.length > 0 && body[0].text.startsWith(V4A_MOVE)) {
        moveTo = body[0].text.slice(V4A_MOVE.length).trim();
        body = body.slice(1);
      }
      const chunks: VChunk[] = [];
      let currentBody: BodyLine[] | null = null;
      let currentAnchor: string | null = null;
      let currentEof = false;
      const closeChunk = (): void => {
        if (currentBody !== null) {
          const { o, n } = chunkFromBody(currentBody);
          chunks.push({
            anchor: currentAnchor,
            eof: currentEof,
            o,
            n,
          });
          currentBody = null;
          currentAnchor = null;
          currentEof = false;
        }
      };
      for (const r of body) {
        const l = r.text;
        if (l.startsWith('@@')) {
          closeChunk();
          currentBody = [];
          currentAnchor = l.slice(2).trim();
          if (currentAnchor === '') currentAnchor = null;
          currentEof = false;
        } else if (l === '*** End of File') {
          if (currentBody === null) failParse(r.no);
          currentEof = true;
          closeChunk();
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (currentBody === null) {
            if (chunks.length !== 0) failParse(r.no);
            currentBody = [];
            currentAnchor = null;
            currentEof = false;
          }
          if (l === '') currentBody.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) {
            currentBody.push({ kind: 'ctx', text: l.slice(1) });
          } else if (l.startsWith('-')) {
            currentBody.push({ kind: 'old', text: l.slice(1) });
          } else {
            currentBody.push({ kind: 'new', text: l.slice(1) });
          }
        } else {
          failParse(r.no);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) {
        failParse(headerLine + 1);
      }
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
    }
    i = j;
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(
  obj: unknown,
  lineNo: number,
): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    failParse(lineNo);
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') failParse(lineNo);
  if (typeof o.command !== 'string') failParse(lineNo);
  const path = o.path as string;
  const command = o.command as string;
  if (command === 'create') {
    if (typeof o.file_text !== 'string') failParse(lineNo);
    return { kind: 'json-create', path, fileText: o.file_text as string };
  }
  if (command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') failParse(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') {
      failParse(lineNo);
    }
    return {
      kind: 'json-str-replace',
      path,
      oldStr: o.old_str as string,
      newStr: (o.new_str as string | undefined) ?? '',
    };
  }
  if (command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      failParse(lineNo);
    }
    if (typeof o.new_str !== 'string') failParse(lineNo);
    return {
      kind: 'json-insert',
      path,
      insertLine: o.insert_line as number,
      newStr: o.new_str as string,
    };
  }
  failParse(lineNo);
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) failParse(1);
  if (lines[first].trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the line where the
    // array starts.
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      failParse(first + 1);
    }
    if (!Array.isArray(arr)) failParse(first + 1);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(validateJsonEdit(el, first + 1));
    if (edits.length === 0) failParse(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      failParse(i + 1);
    }
    edits.push(validateJsonEdit(obj, i + 1));
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC.md sections 5-10)
// ---------------------------------------------------------------------------

/** Apply one unified hunk to a file state; null when it does not match. */
function applyHunk(
  cur: FileState,
  h: Hunk,
  d: number,
  strict: boolean,
): FileState | null {
  if (h.o.length === 0) {
    const idx = Math.min(Math.max(h.a + d, 0), cur.lines.length);
    const written = writeN(h.n, cur.lines, idx, h.o, 0);
    const lines = [
      ...cur.lines.slice(0, idx),
      ...written,
      ...cur.lines.slice(idx),
    ];
    const ends =
      idx === cur.lines.length ? !h.backslashAfterLastCtxOrPlus : cur.ends;
    return { lines, brk: cur.brk, ends };
  }
  const found = findTier(cur.lines, h.o, strict);
  if (found === null) return null;
  const target = h.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const written = writeN(h.n, cur.lines, best, h.o, found.tier);
  const lines = [
    ...cur.lines.slice(0, best),
    ...written,
    ...cur.lines.slice(best + h.o.length),
  ];
  const ends =
    best + h.o.length === cur.lines.length
      ? !h.backslashAfterLastCtxOrPlus
      : cur.ends;
  return { lines, brk: cur.brk, ends };
}

function applyUnifiedHunks(
  text: string,
  hunks: Hunk[],
  strict: boolean,
): string | null {
  let cur = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const next = applyHunk(cur, h, d, strict);
    if (next === null) return null;
    d += h.n.length - h.o.length;
    cur = next;
  }
  return serializeFile(cur);
}

function findAnchor(
  F: string[],
  anchor: string,
  cursor: number,
  strict: boolean,
): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < F.length; i += 1) {
      if (lineEq(F[i], anchor, t)) return i;
    }
  }
  return null;
}

function findFirstAtOrAfter(
  F: string[],
  O: string[],
  cursor: number,
  strict: boolean,
  eof: boolean,
): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(F, O, t).filter(
      (p) => p >= cursor && (!eof || p + O.length === F.length),
    );
    if (occ.length > 0) return { pos: occ[0], tier: t };
  }
  return null;
}

function applyV4aChunks(
  text: string,
  chunks: VChunk[],
  strict: boolean,
): string | null {
  let cur = parseFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const idx = findAnchor(cur.lines, ch.anchor, cursor, strict);
      if (idx === null) return null;
      cursor = idx + 1;
    }
    if (ch.o.length === 0) {
      const idx = ch.eof
        ? cur.lines.length
        : Math.min(cursor, cur.lines.length);
      const written = writeN(ch.n, cur.lines, idx, ch.o, 0);
      cur = {
        lines: [
          ...cur.lines.slice(0, idx),
          ...written,
          ...cur.lines.slice(idx),
        ],
        brk: cur.brk,
        ends: cur.ends,
      };
      cursor = idx + written.length;
    } else {
      const found = findFirstAtOrAfter(
        cur.lines,
        ch.o,
        cursor,
        strict,
        ch.eof,
      );
      if (found === null) return null;
      const written = writeN(ch.n, cur.lines, found.pos, ch.o, found.tier);
      cur = {
        lines: [
          ...cur.lines.slice(0, found.pos),
          ...written,
          ...cur.lines.slice(found.pos + ch.o.length),
        ],
        brk: cur.brk,
        ends: cur.ends,
      };
      cursor = found.pos + written.length;
    }
  }
  return serializeFile(cur);
}

function countOccurrences(text: string, sub: string): number {
  let n = 0;
  let at = 0;
  for (;;) {
    const idx = text.indexOf(sub, at);
    if (idx === -1) return n;
    n += 1;
    at = idx + 1; // positions may overlap
  }
}

/** Split a JSON `new_str` into lines: split at `\n`, one trailing `\r`
 *  removed each, without the empty piece after a final `\n`. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function applyEdit(
  tree: Map<string, string>,
  edit: Edit,
  strict: boolean,
  moves: Move[],
): EditFailure | null {
  switch (edit.kind) {
    case 'unified': {
      const { oldPath, newPath, isCreate, isDelete, hunks } = edit;
      if (isCreate) {
        if (newPath === null) return null; // no file named: nothing to do
        if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
        if (tree.has(newPath)) return { code: 'exists', path: newPath };
        const plus: string[] = [];
        let lastPlusBackslash: boolean | null = null;
        for (const h of hunks) {
          for (const item of h.n) {
            if (item.kind === 'new') plus.push(item.text);
          }
          if (h.backslashAfterLastPlus !== null) {
            lastPlusBackslash = h.backslashAfterLastPlus;
          }
        }
        const text =
          plus.length === 0
            ? ''
            : plus.join('\n') + (lastPlusBackslash === true ? '' : '\n');
        tree.set(newPath, text);
        return null;
      }
      if (isDelete) {
        if (oldPath === null) return null;
        if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
        if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
        tree.delete(oldPath);
        return null;
      }
      if (oldPath === null || newPath === null) return null;
      if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
      if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
      if (oldPath !== newPath) {
        // Move.
        if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
        if (tree.has(newPath)) return { code: 'exists', path: newPath };
        const next = applyUnifiedHunks(tree.get(oldPath) as string, hunks, strict);
        if (next === null) return { code: 'no-match', path: oldPath };
        tree.delete(oldPath);
        tree.set(newPath, next);
        moves.push({ old: oldPath, new: newPath });
        return null;
      }
      // Change of the one path.
      if (!tree.has(oldPath)) return { code: 'missing', path: oldPath };
      const next = applyUnifiedHunks(tree.get(oldPath) as string, hunks, strict);
      if (next === null) return { code: 'no-match', path: oldPath };
      tree.set(oldPath, next);
      return null;
    }
    case 'sr': {
      const { path, oldLines, newLines } = edit;
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (oldLines.length === 0) {
        if (tree.has(path)) return { code: 'exists', path };
        tree.set(
          path,
          newLines.length === 0 ? '' : newLines.join('\n') + '\n',
        );
        return null;
      }
      if (!tree.has(path)) return { code: 'missing', path };
      const cur = parseFile(tree.get(path) as string);
      const found = findTier(cur.lines, oldLines, strict);
      if (found === null) return { code: 'no-match', path };
      if (found.occ.length > 1) return { code: 'ambiguous', path };
      const pos = found.occ[0];
      const items: NItem[] = newLines.map((text) => ({ kind: 'new', text }));
      const written = writeN(items, cur.lines, pos, oldLines, found.tier);
      const lines = [
        ...cur.lines.slice(0, pos),
        ...written,
        ...cur.lines.slice(pos + oldLines.length),
      ];
      tree.set(path, serializeFile({ lines, brk: cur.brk, ends: cur.ends }));
      return null;
    }
    case 'v4a-add': {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (tree.has(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, edit.content);
      return null;
    }
    case 'v4a-delete': {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
      tree.delete(edit.path);
      return null;
    }
    case 'v4a-update': {
      const { path, moveTo, chunks } = edit;
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (moveTo !== null && !isSafePath(moveTo)) {
        return { code: 'unsafe', path: moveTo };
      }
      if (!tree.has(path)) return { code: 'missing', path };
      if (moveTo !== null && tree.has(moveTo)) {
        return { code: 'exists', path: moveTo };
      }
      const next = applyV4aChunks(tree.get(path) as string, chunks, strict);
      if (next === null) return { code: 'no-match', path };
      if (moveTo !== null) {
        tree.delete(path);
        tree.set(moveTo, next);
        moves.push({ old: path, new: moveTo });
      } else {
        tree.set(path, next);
      }
      return null;
    }
    case 'json-create': {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (tree.has(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, edit.fileText);
      return null;
    }
    case 'json-str-replace': {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
      const text = tree.get(edit.path) as string;
      if (parseFile(text).brk === '\r\n') {
        const normText = text.replace(/\r\n/g, '\n');
        const normOld = edit.oldStr.replace(/\r\n/g, '\n');
        const normNew = edit.newStr.replace(/\r\n/g, '\n');
        const n = countOccurrences(normText, normOld);
        if (n === 0) return { code: 'no-match', path: edit.path };
        if (n > 1) return { code: 'ambiguous', path: edit.path };
        const at = normText.indexOf(normOld);
        const replaced =
          normText.slice(0, at) + normNew + normText.slice(at + normOld.length);
        tree.set(edit.path, replaced.replace(/\n/g, '\r\n'));
      } else {
        const n = countOccurrences(text, edit.oldStr);
        if (n === 0) return { code: 'no-match', path: edit.path };
        if (n > 1) return { code: 'ambiguous', path: edit.path };
        const at = text.indexOf(edit.oldStr);
        tree.set(
          edit.path,
          text.slice(0, at) + edit.newStr + text.slice(at + edit.oldStr.length),
        );
      }
      return null;
    }
    case 'json-insert': {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!tree.has(edit.path)) return { code: 'missing', path: edit.path };
      const cur = parseFile(tree.get(edit.path) as string);
      if (edit.insertLine < 0 || edit.insertLine > cur.lines.length) {
        return { code: 'no-match', path: edit.path };
      }
      const ins = splitNewStr(edit.newStr);
      const lines = [
        ...cur.lines.slice(0, edit.insertLine),
        ...ins,
        ...cur.lines.slice(edit.insertLine),
      ];
      tree.set(edit.path, serializeFile({ lines, brk: cur.brk, ends: cur.ends }));
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The tree on disk (SPEC.md section 2 and 10)
// ---------------------------------------------------------------------------

function snapshotTree(): Map<string, string> {
  const out = new Map<string, string>();
  const root = process.cwd();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        try {
          out.set(relative(root, p).split(sep).join('/'), readFileSync(p, 'utf8'));
        } catch {
          // An unreadable file is left out of the tree.
        }
      }
    }
  };
  walk(root);
  return out;
}

function writeTree(before: Map<string, string>, after: Map<string, string>): void {
  const root = process.cwd();
  // Deletions first, so a file can make way for a directory of the same name.
  for (const p of before.keys()) {
    if (!after.has(p)) {
      try {
        unlinkSync(join(root, ...p.split('/')));
      } catch {
        // Nothing to do: the file is already gone.
      }
    }
  }
  for (const [p, text] of after) {
    if (before.get(p) === text) continue;
    const f = join(root, ...p.split('/'));
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text, 'utf8');
    } catch {
      // A path the tree cannot hold (a file where a directory stands):
      // the specification names no outcome for it.
    }
  }
}

/** The exit-0 report: one line per changed path in byte order, then the
 *  `ok:` line. A successful move prints as one `R` line. */
function computeOutput(
  before: Map<string, string>,
  after: Map<string, string>,
  moves: Move[],
): string[] {
  const rMoves = moves.filter(
    (m) =>
      before.has(m.old) &&
      !after.has(m.old) &&
      !before.has(m.new) &&
      after.has(m.new),
  );
  const rOld = new Set(rMoves.map((m) => m.old));
  const rNew = new Set(rMoves.map((m) => m.new));
  const lines: { key: string; text: string }[] = [];
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(p);
    const a = after.get(p);
    if (b === a) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    if (b === undefined) lines.push({ key: p, text: `A ${p}` });
    else if (a === undefined) lines.push({ key: p, text: `D ${p}` });
    else lines.push({ key: p, text: `M ${p}` });
  }
  for (const m of rMoves) {
    lines.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
  }
  lines.sort((x, y) =>
    Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')),
  );
  const n = lines.length;
  lines.push({
    key: '',
    text: n === 1 ? 'ok: 1 file' : `ok: ${n} files`,
  });
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Invocation (SPEC.md section 1)
// ---------------------------------------------------------------------------

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function exit2(line: string): number {
  process.stdout.write(`${line}\n`);
  return 2;
}

function main(): number {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let positional = 0;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!endOpts && a === '--') {
      endOpts = true;
      i += 1;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return exit2('error: usage');
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return exit2('error: usage');
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return exit2('error: usage');
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return exit2('error: usage');
        format = v;
      } else {
        return exit2('error: usage');
      }
      i += 1;
      continue;
    }
    positional += 1;
    if (positional > 1) return exit2('error: usage');
    patch = a;
    i += 1;
  }

  let patchText: string;
  if (patch === null || patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patch, 'utf8');
    } catch {
      return exit2('error: no-patch');
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt = format ?? 'auto';
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return exit2('error: format');
    fmt = detected;
  }
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseError) return exit2(`error: parse ${err.line}`);
    throw err;
  }
  if (edits.length === 0) return exit2('error: parse 1');

  const before = snapshotTree();
  const tree = new Map(before);
  const failures: EditFailure[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const failure = applyEdit(tree, edit, strict, moves);
    if (failure !== null) failures.push(failure);
  }
  if (failures.length > 0) {
    const outLines = failures.map((f) => `error: ${f.code} ${f.path}`);
    outLines.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(outLines.join('\n') + '\n');
    return 1;
  }
  const outLines = computeOutput(before, tree, moves);
  if (!check) writeTree(before, tree);
  process.stdout.write(outLines.join('\n') + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).then(
    () => undefined,
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  process.exitCode = main();
}
