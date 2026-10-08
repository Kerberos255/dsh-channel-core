// Tool-call detail summaries for channel progress lines.
// Only a short, scrubbed fragment of the caller's arguments ever reaches a chat surface.

const SECRET = /(\b(?:token|password|passwd|secret|api[_-]?key|apikey|authorization|bearer|credential|cookie)\b\s*[:=]?\s*)(\S+)/gi;
const LONG = /\b(?![A-Za-z0-9+/_=-]*[\\/])[A-Za-z0-9+/_=-]{48,}={0,2}\b/g;
const LIMIT = 120;

const text = value => (typeof value === 'string' ? value.trim() : '');
const first = (args, keys) => {
  for (const key of keys) { const value = text(args?.[key]); if (value) return value; }
  return '';
};
const basename = value => String(value ?? '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
const shortUrl = value => {
  try { const url = new URL(value); return url.host + (url.pathname === '/' ? '' : url.pathname); } catch { return value; }
};

/** Collapse to one short line and mask anything that looks like a credential. */
export function scrubDetail(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(SECRET, (_match, prefix) => prefix + '***')
    .replace(LONG, '***')
    .trim()
    .slice(0, LIMIT);
}

/** A one-line summary of what a tool call is aimed at; empty when nothing safe stands out. */
export function toolDetail(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const tool = text(name);
  if (['pwsh', 'bash', 'exec', 'shell'].includes(tool)) return scrubDetail(first(args, ['command', 'cmd', 'script']));
  if (['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'str_replace_editor'].includes(tool)) return scrubDetail(basename(first(args, ['path', 'file_path', 'filePath', 'filename', 'target'])));
  if (tool === 'grep') return scrubDetail([first(args, ['pattern', 'query']), basename(first(args, ['path', 'glob']))].filter(Boolean).join(' · '));
  if (tool === 'glob') return scrubDetail(first(args, ['pattern']));
  if (tool === 'web_search') return scrubDetail(first(args, ['query']) || (Array.isArray(args.queries) ? text(args.queries[0]) : ''));
  if (tool === 'web_fetch') return scrubDetail(shortUrl(first(args, ['url'])));
  if (tool === 'run_code') return scrubDetail(first(args, ['language', 'description']));
  if (tool === 'subagent') return scrubDetail(first(args, ['description']));
  if (['job_output', 'job_kill', 'job_list'].includes(tool)) return scrubDetail(first(args, ['job_id', 'id']));
  if (tool === 'skill') return scrubDetail(first(args, ['name']));
  if (tool === 'schedule_create' || tool === 'schedule_update') return scrubDetail(first(args, ['title', 'id']));
  if (tool === 'present') return Array.isArray(args.files) ? args.files.length + ' 个文件' : '';
  if (tool.startsWith('browser_')) return scrubDetail(first(args, ['url', 'ref', 'selector']));
  if (tool.startsWith('desktop_')) return scrubDetail(first(args, ['process', 'handle', 'title', 'ref']));
  return scrubDetail(first(args, ['url', 'ref', 'name', 'title', 'query', 'pattern', 'path', 'id', 'description']));
}
