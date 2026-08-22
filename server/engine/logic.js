const MAX_VARIABLES = 5;

const WORD_OPERATORS = new Map([
  ['and', 'AND'], ['or', 'OR'], ['not', 'NOT'], ['implies', 'IMPLIES'], ['iff', 'IFF'],
  ['true', 'TRUE'], ['false', 'FALSE'],
]);

const SYMBOL_OPERATORS = [
  ['<->', 'IFF'], ['↔', 'IFF'], ['→', 'IMPLIES'], ['->', 'IMPLIES'],
  ['&&', 'AND'], ['∧', 'AND'], ['||', 'OR'], ['∨', 'OR'], ['!', 'NOT'], ['¬', 'NOT'],
  ['(', 'LPAREN'], [')', 'RPAREN'],
];

export const LOGIC_LIMITS = Object.freeze({ maxVariables: MAX_VARIABLES, maxRows: 2 ** MAX_VARIABLES });

export const FALLACY_EXPLANATIONS = Object.freeze({
  'affirming the consequent': 'The result happening does not prove that this particular cause happened.',
  'denying the antecedent': 'One possible cause failing does not prove that the result cannot happen another way.',
  'affirming a disjunct': 'One option being true does not by itself prove the other option is false unless the choice was stated as exclusive.',
  'undistributed middle': 'The premises never connect the whole shared group strongly enough to link the other two groups.',
  'illicit major': 'The conclusion makes a claim about the whole major group that the premises never established.',
  'illicit minor': 'The conclusion makes a claim about the whole minor group that the premises never established.',
  'existential fallacy': 'The conclusion says something exists even though the premises never established that anything in those groups exists.',
});

function error(code, message, position = null) {
  return { error: { code, message, ...(position == null ? {} : { position }) } };
}

function isWordChar(char) { return /[\p{L}\p{N}_]/u.test(char || ''); }

export function tokenizeFormula(sourceInput) {
  const source = String(sourceInput ?? '').normalize('NFC');
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/u.test(source[index])) { index += 1; continue; }
    let matched = false;
    for (const [symbol, type] of SYMBOL_OPERATORS) {
      if (!source.startsWith(symbol, index)) continue;
      tokens.push({ type, text: symbol, start: index, end: index + symbol.length });
      index += symbol.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const rest = source.slice(index);
    const word = rest.match(/^[\p{L}_][\p{L}\p{N}_]*/u)?.[0];
    if (word) {
      const lower = word.toLocaleLowerCase();
      const type = WORD_OPERATORS.get(lower) || 'VAR';
      tokens.push({ type, text: word, value: type === 'VAR' ? word : undefined, start: index, end: index + word.length });
      index += word.length;
      continue;
    }
    if (isWordChar(source[index])) return error('LOGIC_TOKEN', `cannot read logical token at position ${index}`, index);
    return error('LOGIC_TOKEN', `unexpected character "${source[index]}" at position ${index}`, index);
  }
  tokens.push({ type: 'EOF', text: '', start: source.length, end: source.length });
  return { tokens };
}

const PRECEDENCE = Object.freeze({ IFF: 10, IMPLIES: 20, OR: 30, AND: 40 });

export function parseFormula(source) {
  const tokenized = tokenizeFormula(source);
  if (tokenized.error) return tokenized;
  const tokens = tokenized.tokens;
  let cursor = 0;
  const peek = () => tokens[cursor];
  const consume = () => tokens[cursor++];

  function parsePrefix() {
    const token = consume();
    if (token.type === 'VAR') return { type: 'var', name: token.value, start: token.start, end: token.end };
    if (token.type === 'TRUE' || token.type === 'FALSE') return { type: 'literal', value: token.type === 'TRUE', start: token.start, end: token.end };
    if (token.type === 'NOT') {
      const child = parseExpression(50);
      if (child.error) return child;
      return { type: 'not', child, start: token.start, end: child.end };
    }
    if (token.type === 'LPAREN') {
      const inner = parseExpression(0);
      if (inner.error) return inner;
      const close = consume();
      if (close.type !== 'RPAREN') return error('LOGIC_PAREN', `expected ")" at position ${close.start}`, close.start);
      return { ...inner, grouped: true, start: token.start, end: close.end };
    }
    return error('LOGIC_EXPECTED_EXPRESSION', `expected a proposition at position ${token.start}`, token.start);
  }

  function parseExpression(minBindingPower = 0) {
    let left = parsePrefix();
    if (left.error) return left;
    while (true) {
      const token = peek();
      const precedence = PRECEDENCE[token.type];
      if (precedence == null || precedence <= minBindingPower) break;
      consume();
      // Implication is right-associative; the others are left-associative.
      const rightBinding = token.type === 'IMPLIES' ? precedence - 1 : precedence;
      const right = parseExpression(rightBinding);
      if (right.error) return right;
      const type = token.type === 'AND' ? 'and' : token.type === 'OR' ? 'or' : token.type === 'IMPLIES' ? 'implies' : 'iff';
      left = { type, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  const ast = parseExpression(0);
  if (ast.error) return ast;
  if (peek().type !== 'EOF') return error('LOGIC_TRAILING', `unexpected token "${peek().text}" at position ${peek().start}`, peek().start);
  return { ast };
}

function evaluateAst(node, assignment) {
  switch (node.type) {
    case 'var': return Boolean(assignment[node.name]);
    case 'literal': return node.value;
    case 'not': return !evaluateAst(node.child, assignment);
    case 'and': return evaluateAst(node.left, assignment) && evaluateAst(node.right, assignment);
    case 'or': return evaluateAst(node.left, assignment) || evaluateAst(node.right, assignment);
    case 'implies': return !evaluateAst(node.left, assignment) || evaluateAst(node.right, assignment);
    case 'iff': return evaluateAst(node.left, assignment) === evaluateAst(node.right, assignment);
    default: throw Object.assign(new Error(`unknown logical AST node ${node.type}`), { code: 'LOGIC_AST' });
  }
}

function variablesIn(ast) {
  const seen = new Set();
  const ordered = [];
  function visit(node) {
    if (node.type === 'var') {
      if (!seen.has(node.name)) { seen.add(node.name); ordered.push(node.name); }
      return;
    }
    if (node.child) visit(node.child);
    if (node.left) visit(node.left);
    if (node.right) visit(node.right);
  }
  visit(ast);
  return ordered;
}

function stripGroup(node) {
  if (!node) return node;
  const { grouped, ...copy } = node;
  return copy;
}

function sameAst(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'var') return a.name === b.name;
  if (a.type === 'literal') return a.value === b.value;
  if (a.type === 'not') return sameAst(a.child, b.child);
  if (['and','or','implies','iff'].includes(a.type)) return sameAst(a.left, b.left) && sameAst(a.right, b.right);
  return false;
}

function conjunctionParts(node) {
  return node?.type === 'and' ? [node.left, node.right] : [node];
}

function detectFallacy(ast) {
  if (ast.type !== 'implies') return null;
  const premises = conjunctionParts(ast.left);
  if (premises.length !== 2) return null;
  for (let implicationIndex = 0; implicationIndex < 2; implicationIndex += 1) {
    const conditional = stripGroup(premises[implicationIndex]);
    const other = stripGroup(premises[1 - implicationIndex]);
    if (conditional?.type === 'implies') {
      if (sameAst(other, conditional.right) && sameAst(ast.right, conditional.left)) return 'affirming the consequent';
      if (other?.type === 'not' && ast.right?.type === 'not'
          && sameAst(other.child, conditional.left) && sameAst(ast.right.child, conditional.right)) return 'denying the antecedent';
    }
    if (conditional?.type === 'or') {
      const conclusion = ast.right;
      if (sameAst(other, conditional.left) && conclusion?.type === 'not' && sameAst(conclusion.child, conditional.right)) return 'affirming a disjunct';
      if (sameAst(other, conditional.right) && conclusion?.type === 'not' && sameAst(conclusion.child, conditional.left)) return 'affirming a disjunct';
    }
  }
  return null;
}

function renderAssignment(assignment, variables) {
  return variables.map(name => `${name}=${assignment[name] ? 'true' : 'false'}`).join(', ');
}

export function analyse(formula) {
  const parsed = parseFormula(formula);
  if (parsed.error) return parsed;
  const variables = variablesIn(parsed.ast);
  if (variables.length > MAX_VARIABLES) {
    return error('LOGIC_VARIABLE_LIMIT', `more than five variables: found ${variables.length}; exhaustive proof is limited to five`);
  }
  const rows = 2 ** variables.length;
  const table = [];
  for (let index = 0; index < rows; index += 1) {
    const assignment = {};
    for (let variableIndex = 0; variableIndex < variables.length; variableIndex += 1) {
      const bit = variables.length - variableIndex - 1;
      assignment[variables[variableIndex]] = Boolean((index >> bit) & 1);
    }
    table.push({ values: assignment, result: evaluateAst(parsed.ast, assignment) });
  }
  const valid = table.every(row => row.result);
  const satisfiable = table.some(row => row.result);
  const counterexampleRow = valid ? null : table.find(row => !row.result);
  const fallacy = valid ? null : detectFallacy(parsed.ast);
  const steps = [
    `Parsed ${variables.length} variable${variables.length === 1 ? '' : 's'}: ${variables.join(', ') || 'none'}.`,
    `Evaluated all ${rows} possible truth assignment${rows === 1 ? '' : 's'}.`,
    valid ? 'Every row is true, so the formula is valid.' : `A false row exists: ${renderAssignment(counterexampleRow.values, variables)}.`,
  ];
  if (fallacy) steps.push(`${fallacy}: ${FALLACY_EXPLANATIONS[fallacy]}`);
  return {
    valid,
    satisfiable,
    variables,
    table,
    ...(counterexampleRow ? { counterexample: structuredClone(counterexampleRow) } : {}),
    ...(fallacy ? { fallacy, fallacyExplanation: FALLACY_EXPLANATIONS[fallacy] } : {}),
    ast: parsed.ast,
    steps,
  };
}

export function evaluate(formula, assignment) {
  const parsed = parseFormula(formula);
  if (parsed.error) return parsed;
  const variables = variablesIn(parsed.ast);
  const missing = variables.filter(name => !(name in (assignment || {})));
  if (missing.length) return error('LOGIC_ASSIGNMENT', `missing truth value for ${missing.join(', ')}`);
  const value = evaluateAst(parsed.ast, assignment || {});
  return { value, variables, steps: [`Evaluated the formula with ${renderAssignment(assignment || {}, variables)}: ${value ? 'true' : 'false'}.`] };
}
