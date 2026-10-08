/**
 * Discord renders no Markdown tables: a GFM pipe table reaches the reader as literal text with
 * visible pipes and dashes. This converts each table outside fenced code into an aligned
 * monospace code block, in place, so message count, ordering and surrounding prose stay
 * untouched. Equivalent to OpenClaw's `markdown.tables: code` mode.
 *
 * Limits: tables are recognised only at the top level of a message (optional leading spaces), a
 * pipe inside an inline code span still splits its cell, and a table larger than the transport's
 * chunk limit is still split by the chunker — each part keeps aligned columns on its own.
 */

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/** Split one table row on unescaped pipes, keeping `\|` as a literal pipe. */
function splitRow(line) {
  const trimmed = line.trim();
  const head = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const body = head.endsWith('|') && !head.endsWith('\\|') ? head.slice(0, -1) : head;
  const cells = [];
  let cell = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') { cell += '|'; index += 1; continue; }
    if (char === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const isDelimiterRow = cells => cells.length > 0 && cells.every(cell => DELIMITER_CELL.test(cell.replace(/\s+/g, '')));

/** Terminal columns a cell occupies: East Asian wide characters and emoji count as two. */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide = code === 0x2329 || code === 0x232a
      || (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Render a parsed table as an aligned table inside a code fence long enough for its content. */
function renderTable(header, rows) {
  const every = [header, ...rows];
  const widths = header.map((_, column) => Math.max(3, ...every.map(row => displayWidth(row[column] ?? ''))));
  const row = cells => `|${widths.map((width, column) => {
    const cell = cells[column] ?? '';
    return ` ${cell}${' '.repeat(width - displayWidth(cell))} |`;
  }).join('')}`;
  const divider = `|${widths.map(width => ` ${'-'.repeat(width)} |`).join('')}`;
  const body = [row(header), divider, ...rows.map(row)].join('\n');
  let fenceLength = 3;
  for (const run of body.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}\n${body}\n${fence}`;
}

/** Replace every top-level Markdown table with its aligned code-block form. */
export function convertMarkdownTables(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (!source.includes('|')) return source;
  const lines = source.split('\n');
  const out = [];
  let fence = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(FENCE_LINE)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      out.push(line);
      continue;
    }
    if (fence || !line.includes('|')) { out.push(line); continue; }
    const header = splitRow(line);
    const delimiter = index + 1 < lines.length ? splitRow(lines[index + 1]) : [];
    if (!header.some(cell => cell.length) || delimiter.length !== header.length || !isDelimiterRow(delimiter)) {
      out.push(line);
      continue;
    }
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim() !== '' && lines[cursor].includes('|')) {
      const cells = splitRow(lines[cursor]);
      rows.push(header.map((_, column) => cells[column] ?? ''));
      cursor += 1;
    }
    if (rows.length === 0) { out.push(line); continue; }
    out.push(renderTable(header, rows));
    index = cursor - 1;
  }
  return out.join('\n');
}
