// Tool-call detail summaries for channel progress lines.
// Only a short, scrubbed fragment of the caller's arguments ever reaches a chat surface.

const SECRET = /(\b(?:token|password|passwd|secret|api[_-]?key|apikey|authorization|bearer|credential|cookie)\b\s*[:=]?\s*)(\S+)/gi;
const LONG = /\b(?![A-Za-z0-9+/_=-]*[\\/])[A-Za-z0-9+/_=-]{48,}={0,2}\b/g;
const LIMIT = 110;       // 上限：够放下一条完整 URL
const PROSE_LIMIT = 72;  // 中文说明与命令行用更短的上限

const text = value => (typeof value === 'string' ? value.trim() : Number.isFinite(value) ? String(value) : '');
const first = (args, keys) => {
  for (const key of keys) { const value = text(args?.[key]); if (value) return value; }
  return '';
};
const list = value => (Array.isArray(value) ? value : []);
const basename = value => String(value ?? '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
const quoted = value => { const value2 = text(value); return value2 ? '"' + value2 + '"' : ''; };
const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim();

/** 按词 / 路径边界截断：不从单词中间下刀，也不切开代理对。 */
export function cutDetail(value, limit = PROSE_LIMIT) {
  const source = String(value ?? '');
  if (source.length <= limit) return source;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(source[end - 1] ?? '')) end--;
  const head = source.slice(0, end);
  let boundary = -1;
  for (const character of [' ', '/', '\\', '·', ',', '，', '、', ':', '|', '=', '"', "'"]) boundary = Math.max(boundary, head.lastIndexOf(character));
  const cutAt = boundary >= Math.floor(end * 0.5) ? boundary : end;
  return head.slice(0, cutAt).replace(/[\s/\\·,，、:|="']+$/, '') + '…';
}

/** 完整显示 URL；只有超长时才省略中间路径，保留域名和末尾文件名。 */
export function urlDetail(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.length <= LIMIT) return raw;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);
    const tail = segments.slice(-2).join('/');
    const shortened = tail ? url.origin + '/…/' + tail : url.origin + '/…';
    return shortened.length <= LIMIT ? shortened : cutDetail(shortened, LIMIT);
  } catch { return cutDetail(raw, LIMIT); }
}

// 常见包装：pwsh -NoProfile -Command "…" / bash -c "…"
const WRAPPER = /^"?[^"]*?\b(?:pwsh|powershell|cmd|bash|sh|zsh)(?:\.exe)?"?\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+|-WindowStyle\s+\S+\s+|-ExecutionPolicy\s+\S+\s+|-File\s+)*-(?:Command|EncodedCommand|c)\s+/i;
// 无信息量的前置语句：$env:X='…';  [Console]::OutputEncoding=…;  $OutputEncoding=…;  cd …;
const LEADING = /^(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*"|\S+)\s*;?\s*|\[Console\]::[A-Za-z]+\s*=\s*\S+\s*;?\s*|\$\w*(?:Encoding|Preference)\s*=\s*\S+\s*;?\s*|Set-Location\s+\S+\s*;?\s*|cd\s+[^;|]+\s*;?\s*)+/;
// 真正的“那条命令”：外壳脚本里第一个有信息量的可执行名
const COMMAND = /(?:&\s*)?(?:[A-Za-z]:\\[^\s;|]*?\.exe|gh|git|node|npm|pnpm|npx|python|pip|curl|wget|rg|tar|robocopy|xcopy|msbuild|dsh|openclaw|Get-[A-Za-z]+|Set-[A-Za-z]+|New-[A-Za-z]+|Remove-[A-Za-z]+|Copy-[A-Za-z]+|Move-[A-Za-z]+|Rename-[A-Za-z]+|Add-[A-Za-z]+|Out-File|Test-Path|Test-Connection|Select-[A-Za-z]+|Where-Object|Sort-Object|Measure-Object|Start-Process|Stop-Process|Invoke-[A-Za-z]+|Write-[A-Za-z]+)\b/;
const CONTROL = /^(?:foreach|for|while|if|do|switch|try|function|&?\s*\{)/i;

/** 把原始命令折成一句能看懂的东西：剥包装、剥环境变量前置、跳到真正那条命令。 */
export function summarizeCommand(raw) {
  let source = String(raw ?? '').replace(/\r/g, '\n').trim();
  if (!source) return '';
  source = source.replace(WRAPPER, '').trim();
  if (source.length > 1 && source.startsWith('"') && source.endsWith('"')) source = source.slice(1, -1);
  source = source.replace(LEADING, '');
  if (CONTROL.test(source)) {
    const match = source.match(COMMAND);
    if (match) source = source.slice(match.index);
  }
  source = collapse(source).replace(/^&\s*/, '').replace(/[\s;|)}]+$/, '');
  // 管道后面多半是筛选细节，前面那句已经说明在干什么
  const pipe = source.indexOf(' | ');
  if (pipe >= 12) source = source.slice(0, pipe);
  return source;
}

/** Collapse to one short line and mask anything that looks like a credential. */
export function scrubDetail(value, limit = LIMIT) {
  const masked = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(SECRET, (_match, prefix) => prefix + '***')
    .replace(LONG, '***')
    .trim();
  return cutDetail(masked, limit);
}

const skillAction = { list: '列出', read: '读取', propose: '提交提案', revise: '修订' };

/** A one-line summary of what a tool call is aimed at; empty when nothing safe stands out. */
export function toolDetail(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const tool = text(name);
  const prose = value => scrubDetail(value, PROSE_LIMIT);
  const wide = value => scrubDetail(value, LIMIT);
  if (['pwsh', 'bash', 'exec', 'shell'].includes(tool)) {
    return prose(first(args, ['description']) || summarizeCommand(first(args, ['command', 'cmd', 'script'])));
  }
  if (['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'str_replace_editor'].includes(tool)) {
    const file = basename(first(args, ['path', 'file_path', 'filePath', 'filename', 'target']));
    if (!file) return '';
    const offset = Number.isSafeInteger(args.offset) ? args.offset : null;
    const limit = Number.isSafeInteger(args.limit) ? args.limit : null;
    return prose(file + (offset !== null ? ':' + offset + (limit !== null ? '-' + (offset + limit - 1) : '') : ''));
  }
  if (tool === 'grep') return prose([quoted(first(args, ['pattern', 'query'])), basename(first(args, ['path', 'glob']))].filter(Boolean).join(' · '));
  if (tool === 'glob') return prose(first(args, ['pattern']));
  if (tool === 'web_search') return prose(quoted(first(args, ['query']) || text(list(args.queries)[0])));
  if (tool === 'web_fetch') return wide(urlDetail(first(args, ['url'])));
  if (tool === 'run_code') return prose(first(args, ['description', 'language']));
  if (tool === 'subagent') return prose(first(args, ['description']));
  if (tool === 'send_message' || tool === 'interrupt_agent') { const id = first(args, ['agent_id']); return id ? prose('子代理 ' + id) : ''; }
  if (tool === 'list_agents') return '';
  if (tool === 'job_output' || tool === 'job_kill') { const id = first(args, ['job_id', 'id']); return id ? prose('作业 ' + id) : ''; }
  if (tool === 'job_list') return '';
  if (tool === 'skill') return prose(first(args, ['name']));
  if (tool === 'skill_workshop') {
    const action = skillAction[first(args, ['action'])] ?? first(args, ['action']);
    return prose([action, first(args, ['name'])].filter(Boolean).join(' · '));
  }
  if (['schedule_create', 'schedule_update', 'schedule_delete'].includes(tool)) return prose(first(args, ['title', 'id']));
  if (tool === 'schedule_list') return '';
  if (tool === 'todo_write') { const todos = list(args.todos); return todos.length ? prose(todos.length + ' 项') : ''; }
  if (tool === 'present') return Array.isArray(args.files) ? args.files.length + ' 个文件' : '';
  if (tool === 'memory_search' || tool === 'lcm_grep' || tool === 'lcm_expand_query') return prose(quoted(first(args, ['query'])));
  if (tool === 'memory_topics' || tool === 'status_health_check' || tool === 'load_workspace_dependencies') return '';
  if (tool === 'memory_dream') return prose(first(args, ['kind']));
  if (tool === 'lcm_expand') { const seq = first(args, ['seq', 'id']); return seq ? prose('事件 ' + seq) : ''; }
  if (tool === 'lcm_describe') { const seq = first(args, ['seq']); const id = first(args, ['id']); return prose(seq ? '事件 ' + seq : id ? '节点 ' + id : ''); }
  if (tool === 'ask_user_question') { const questions = list(args.questions); return questions.length ? prose(questions.length + ' 个问题') : ''; }
  if (tool === 'browser_navigate') return wide(urlDetail(first(args, ['url'])));
  if (tool === 'browser_snapshot') { const ref = first(args, ['ref']); return prose(ref ? '整页 · 元素 ' + ref : '整页'); }
  if (tool === 'browser_click') { const ref = first(args, ['ref']); return ref ? prose('元素 ' + ref + (args.double ? ' · 双击' : '')) : ''; }
  if (tool === 'browser_type') { const ref = first(args, ['ref']); return ref ? prose('元素 ' + ref + (args.submit ? ' · 并提交' : '')) : ''; }
  if (tool === 'browser_screenshot') { const ref = first(args, ['ref']); return prose(ref ? '元素 ' + ref : '当前页'); }
  if (tool.startsWith('browser_')) return prose(first(args, ['url', 'ref', 'selector']));
  if (tool === 'desktop_windows') return '';
  if (tool.startsWith('desktop_')) {
    const target = first(args, ['title', 'process', 'handle']) || first(args, ['ref']);
    return target ? prose(target) : '';
  }
  const fallback = first(args, ['url', 'ref', 'name', 'title', 'query', 'pattern', 'path', 'id', 'description']);
  return /^https?:\/\//i.test(fallback) ? wide(urlDetail(fallback)) : prose(fallback);
}
