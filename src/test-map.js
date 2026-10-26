// Test map: which Autonomous tests/plans to run for which changed files.
//
// File format (YAML subset, or the equivalent JSON array):
//
//   - name: Checkout             # optional, used in logs
//     paths: ["src/checkout/**", "!**/*.md"]
//     tests: [<test-id>, <test-id>]
//   - paths:
//       - "src/**"
//     plans:
//       - <plan-id>
//
// Only this shape is supported: a list of entries whose values are strings or
// lists of strings (inline [a, b] or block "- a"). Anything else is an error,
// so typos fail loudly instead of silently running nothing.

const KEYS = new Set(['name', 'paths', 'tests', 'plans']);

export function parseTestMap(text, source = 'test-map') {
  const trimmed = text.trim();
  const entries = trimmed.startsWith('[') ? parseJson(trimmed, source) : parseYamlSubset(text, source);
  return entries.map((entry, i) => validateEntry(entry, `${source} entry ${i + 1}`));
}

function parseJson(text, source) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(data)) throw new Error(`${source}: expected a list of entries`);
  return data;
}

function parseYamlSubset(text, source) {
  const entries = [];
  let entry;
  let entryIndent;
  let listKey; // key whose block list items we are reading
  let listIndent;

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const where = `${source} line ${i + 1}`;
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (!line.trim() || line.trim() === '---') return;
    const indent = line.length - line.trimStart().length;
    let body = line.trim();

    // Block list item belonging to the current key.
    if (listKey && body.startsWith('- ') && indent > entryIndent && (listIndent === undefined || indent === listIndent)) {
      listIndent = indent;
      entry[listKey].push(parseScalar(body.slice(2).trim(), where));
      return;
    }
    if (listKey && entry[listKey].length === 0) throw new Error(`${where}: expected a list under "${listKey}"`);
    listKey = undefined;
    listIndent = undefined;

    if (body.startsWith('- ') || body === '-') {
      if (entryIndent === undefined) entryIndent = indent;
      if (indent !== entryIndent) throw new Error(`${where}: unexpected indentation`);
      entry = {};
      entries.push(entry);
      body = body.slice(1).trim();
      if (!body) return;
    } else if (!entry) {
      throw new Error(`${where}: expected a list of entries starting with "- "`);
    } else if (indent <= entryIndent) {
      throw new Error(`${where}: unexpected indentation`);
    }

    const match = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) throw new Error(`${where}: expected "key: value", got "${body}"`);
    const [, key, value] = match;
    if (!KEYS.has(key)) throw new Error(`${where}: unknown key "${key}" (allowed: ${[...KEYS].join(', ')})`);
    if (key in entry) throw new Error(`${where}: duplicate key "${key}"`);
    if (value === '') {
      entry[key] = [];
      listKey = key;
    } else if (value.startsWith('[')) {
      entry[key] = parseInlineList(value, where);
    } else {
      entry[key] = parseScalar(value, where);
    }
  });
  if (listKey && entry[listKey].length === 0) throw new Error(`${source}: expected a list under "${listKey}"`);
  return entries;
}

function stripComment(line) {
  let quote;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseInlineList(value, where) {
  if (!value.endsWith(']')) throw new Error(`${where}: unterminated list`);
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = '';
  let quote;
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = undefined;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ',') {
      items.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (quote) throw new Error(`${where}: unterminated quote`);
  items.push(current);
  return items.map((item) => parseScalar(item.trim(), where));
}

function parseScalar(value, where) {
  if (!value) throw new Error(`${where}: empty value`);
  const q = value[0];
  if (q === '"' || q === "'") {
    if (value.length < 2 || value.at(-1) !== q) throw new Error(`${where}: unterminated quote`);
    return value.slice(1, -1);
  }
  if (/^[[\]{}&*|>]/.test(value)) throw new Error(`${where}: unsupported YAML syntax "${value}"`);
  return value;
}

function validateEntry(entry, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where}: expected an object`);
  for (const key of Object.keys(entry)) {
    if (!KEYS.has(key)) throw new Error(`${where}: unknown key "${key}" (allowed: ${[...KEYS].join(', ')})`);
  }
  const list = (key) => {
    const v = entry[key] ?? [];
    const arr = Array.isArray(v) ? v : [v];
    if (!arr.every((s) => typeof s === 'string' && s.trim())) throw new Error(`${where}: "${key}" must be a list of non-empty strings`);
    return arr.map((s) => s.trim());
  };
  const paths = list('paths');
  const tests = list('tests');
  const plans = list('plans');
  if (paths.length === 0) throw new Error(`${where}: "paths" is required`);
  if (!paths.some((p) => !p.startsWith('!'))) throw new Error(`${where}: "paths" needs at least one pattern that is not an exclusion`);
  if (tests.length === 0 && plans.length === 0) throw new Error(`${where}: needs "tests" and/or "plans"`);
  if (entry.name !== undefined && typeof entry.name !== 'string') throw new Error(`${where}: "name" must be a string`);
  return { name: entry.name, paths, tests, plans, matchers: paths.map(compilePattern) };
}

// An entry matches when any changed file matches one of its patterns and no
// "!" pattern after that.
export function matchTestMap(entries, changedFiles) {
  const matched = [];
  for (const entry of entries) {
    const files = changedFiles.filter((file) => fileMatches(entry.matchers, file));
    if (files.length) matched.push({ entry, files });
  }
  return matched;
}

function fileMatches(matchers, file) {
  let result = false;
  for (const m of matchers) {
    if (m.negated ? result : !result) {
      if (m.regex.test(file)) result = !m.negated;
    }
  }
  return result;
}

// Glob rules (as in .gitignore / CODEOWNERS):
//   **  any number of directories   *  anything except "/"   ?  one character
//   {a,b}  alternatives   [abc]  character class   leading "/" anchors to the repo root
//   A pattern without "/" matches the file name at any depth ("*.md").
//   A pattern ending in "/" matches everything under that directory.
// Dot files and dot directories (e.g. .github/) are matched like any other.
export function compilePattern(pattern) {
  let negated = false;
  let p = pattern;
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }
  if (p.endsWith('/')) p += '**';
  const anchored = p.includes('/') && !p.startsWith('**/');
  p = p.replace(/^\//, '');
  const source = globToRegex(p);
  const regex = new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
  return { pattern, negated, regex };
}

function globToRegex(glob) {
  let out = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
          continue;
        }
        out += '[^/]*';
        i += 1;
        continue;
      }
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      braces++;
      out += '(?:';
    } else if (c === '}' && braces) {
      braces--;
      out += ')';
    } else if (c === ',' && braces) {
      out += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { out += '\\['; continue; }
      let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      out += `[${cls}]`;
      i = end;
    } else {
      out += c.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
  }
  if (braces) throw new Error(`Invalid pattern "${glob}": unclosed "{"`);
  return out;
}
