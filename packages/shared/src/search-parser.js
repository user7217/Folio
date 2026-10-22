

const VALID_TYPES = new Set(['article', 'pdf', 'epub', 'feed']);
const VALID_STATES = new Set(['unread', 'read', 'favorite', 'archived']);
const FILTER_FIELDS = new Set(['tag', 'collection', 'domain', 'type', 'is', 'before', 'after']);

function tokenizeQuery(input) {
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;

    const start = i;
    if (input[i] === '"' || (input[i] === '-' && input[i + 1] === '"')) {
      const negPrefix = input[i] === '-';
      if (negPrefix) i++;
      i++; // skip opening quote
      let phrase = '';
      let closed = false;
      while (i < n) {
        if (input[i] === '\\' && i + 1 < n) {
          phrase += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          closed = true;
          i++;
          break;
        }
        phrase += input[i];
        i++;
      }
      if (!closed) {
        errors.push({
          position: start,
          token: input.slice(start),
          message: 'Unterminated quoted phrase',
        });
      } else {
        tokens.push({
          text: phrase,
          quoted: true,
          negated: negPrefix,
          pos: start,
        });
      }
      continue;
    }

    let word = '';
    while (i < n && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        // Quoted value inside filter like tag:"web dev"
        i++;
        let quotedVal = '';
        let closed = false;
        while (i < n) {
          if (input[i] === '\\' && i + 1 < n) {
            quotedVal += input[i + 1];
            i += 2;
            continue;
          }
          if (input[i] === '"') {
            closed = true;
            i++;
            break;
          }
          quotedVal += input[i];
          i++;
        }
        if (!closed) {
          errors.push({
            position: start,
            token: input.slice(start),
            message: 'Unterminated quote in filter value',
          });
        }
        word += quotedVal;
        continue;
      }
      word += input[i];
      i++;
    }
    if (word) {
      tokens.push({ text: word, quoted: false, pos: start });
    }
  }

  return { tokens, errors };
}

function parseAtom(tok, errors) {
  if (tok.quoted) {
    return {
      kind: 'term',
      value: tok.text.trim(),
      phrase: true,
      negated: Boolean(tok.negated),
    };
  }

  let raw = tok.text;
  let negated = false;
  if (raw.startsWith('-') && raw.length > 1) {
    negated = true;
    raw = raw.slice(1);
  }

  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    const field = raw.slice(0, colonIdx).toLowerCase();
    const val = raw.slice(colonIdx + 1).trim();
    if (!FILTER_FIELDS.has(field)) {
      errors.push({
        position: tok.pos,
        token: tok.text,
        message: `Unknown filter operator "${field}:"`,
      });
      return null;
    }
    if (!val) {
      errors.push({
        position: tok.pos,
        token: tok.text,
        message: `Missing value for operator "${field}:"`,
      });
      return null;
    }
    if (field === 'type' && !VALID_TYPES.has(val.toLowerCase())) {
      errors.push({
        position: tok.pos,
        token: tok.text,
        message: `Invalid type "${val}". Expected article, pdf, epub, or feed.`,
      });
      return null;
    }
    if (field === 'is' && !VALID_STATES.has(val.toLowerCase())) {
      errors.push({
        position: tok.pos,
        token: tok.text,
        message: `Invalid state "${val}". Expected unread, read, favorite, or archived.`,
      });
      return null;
    }
    if (field === 'before' || field === 'after') {
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/.test(val) || Number.isNaN(Date.parse(val))) {
        errors.push({
          position: tok.pos,
          token: tok.text,
          message: `Invalid ISO date "${val}" for "${field}:" operator`,
        });
        return null;
      }
    }

    return {
      kind: 'filter',
      field: field,
      value: field === 'type' || field === 'is' || field === 'domain' ? val.toLowerCase() : val,
      negated,
    };
  }

  return {
    kind: 'term',
    value: raw,
    phrase: false,
    negated,
  };
}

/**
 * Compiles an AST node into parameterized SQL (`$1, $2, ...`) so user input never enters SQL text directly.
 */
function compileAstToParameterizedSql(
  node,
  params
) {
  if (!node) return '1 = 1';

  const addParam = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (node.kind === 'and') {
    if (node.children.length === 0) return '1 = 1';
    const parts = node.children.map((c) => compileAstToParameterizedSql(c, params));
    return `(${parts.join(' AND ')})`;
  }

  if (node.kind === 'or') {
    const l = compileAstToParameterizedSql(node.left, params);
    const r = compileAstToParameterizedSql(node.right, params);
    return `(${l} OR ${r})`;
  }

  if (node.kind === 'term') {
    const p = addParam(node.value);
    const op = node.phrase ? 'phraseto_tsquery' : 'plainto_tsquery';
    const expr = `search_vector @@ ${op}('english', ${p})`;
    return node.negated ? `NOT (${expr})` : expr;
  }

  if (node.kind === 'filter') {
    const p = addParam(node.value);
    let expr = '';
    switch (node.field) {
      case 'tag':
        expr = `EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = items.id AND t.normalized_name = lower(${p}))`;
        break;
      case 'collection':
        expr = `EXISTS (SELECT 1 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE ci.item_id = items.id AND lower(c.name) = lower(${p}))`;
        break;
      case 'domain':
        expr = `items.domain = ${p}`;
        break;
      case 'type':
        expr = `items.content_type = ${p}`;
        break;
      case 'is':
        expr = `user_item_states.state_flag = ${p}`;
        break;
      case 'before':
        expr = `items.created_at < ${p}`;
        break;
      case 'after':
        expr = `items.created_at > ${p}`;
        break;
    }
    return node.negated ? `NOT (${expr})` : expr;
  }

  return '1 = 1';
}

/**
 * Parses a search query string into a validated AST + parameterized SQL representation.
 * Precedence: `OR` binds tighter than implicit `AND` (`a b OR c` => `AND(a, OR(b, c))`).
 */
export function parseSearchQuery(rawQuery) {
  const trimmed = (rawQuery || '').trim();
  if (!trimmed) {
    return {
      ok: true,
      ast: null,
      errors: [],
      compiledSql: { sql: '1 = 1', params: [] },
    };
  }

  const { tokens, errors } = tokenizeQuery(trimmed);
  if (errors.length > 0) {
    return { ok: false, ast: null, errors, compiledSql: { sql: '1 = 0', params: [] } };
  }

  const andChildren = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.quoted && tok.text === 'OR') {
      errors.push({
        position: tok.pos,
        token: tok.text,
        message: 'Unexpected OR operator without left operand',
      });
      i++;
      continue;
    }

    let leftNode = parseAtom(tok, errors);
    i++;

    // OR binds tighter than implicit AND: consume chain of `OR <atom>`
    while (i < tokens.length && !tokens[i].quoted && tokens[i].text === 'OR') {
      const orToken = tokens[i];
      i++; // consume OR
      if (i >= tokens.length || (!tokens[i].quoted && tokens[i].text === 'OR')) {
        errors.push({
          position: orToken.pos,
          token: 'OR',
          message: 'OR operator missing right operand',
        });
        break;
      }
      const rightNode = parseAtom(tokens[i], errors);
      i++;
      if (leftNode && rightNode) {
        leftNode = {
          kind: 'or',
          left: leftNode,
          right: rightNode,
        };
      }
    }

    if (leftNode) {
      andChildren.push(leftNode);
    }
  }

  if (errors.length > 0) {
    return { ok: false, ast: null, errors, compiledSql: { sql: '1 = 0', params: [] } };
  }

  const ast =
    andChildren.length === 0
      ? null
      : andChildren.length === 1
        ? andChildren[0]
        : { kind: 'and', children: andChildren };

  const params = [];
  const sql = compileAstToParameterizedSql(ast, params);

  return {
    ok: true,
    ast,
    errors: [],
    compiledSql: { sql, params },
  };
}
