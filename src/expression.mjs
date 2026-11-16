const LEAF_OPERATORS = new Set(['eq', 'contains']);
const BOOLEAN_OPERATORS = new Set(['and', 'or']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidExpression(expression) {
  if (expression === null) return true;
  if (!isObject(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length !== 1) return false;
  const [operator] = keys;
  const argument = expression[operator];
  if (BOOLEAN_OPERATORS.has(operator)) {
    return Array.isArray(argument) && argument.length > 0 && argument.every(isValidExpression);
  }
  if (operator === 'not') return isValidExpression(argument);
  if (LEAF_OPERATORS.has(operator)) {
    return Array.isArray(argument) && argument.length === 2 && typeof argument[0] === 'string';
  }
  return false;
}

export function isSupported(expression, capabilities) {
  if (expression === null) return true;
  if (!isValidExpression(expression)) return false;
  const [operator] = Object.keys(expression);
  const argument = expression[operator];
  if (operator === 'and') return argument.every(child => isSupported(child, capabilities));
  if (operator === 'or') {
    return capabilities.supportsOr && argument.every(child => isSupported(child, capabilities));
  }
  if (operator === 'not') {
    return capabilities.operators.includes('not') && isSupported(argument, capabilities);
  }
  return capabilities.operators.includes(operator) && capabilities.fields.includes(argument[0]);
}

export function canonicalExpression(expression) {
  if (Array.isArray(expression)) return `[${expression.map(canonicalExpression).join(',')}]`;
  if (isObject(expression)) {
    return `{${Object.keys(expression).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalExpression(expression[key])}`).join(',')}}`;
  }
  return JSON.stringify(expression);
}

function unique(expressions) {
  const seen = new Set();
  const output = [];
  for (const expression of expressions) {
    const key = canonicalExpression(expression);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(expression);
  }
  return output;
}

function combineAnd(parts) {
  const kept = parts.filter(part => part !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const operands = [];
  for (const part of kept) {
    if (isObject(part) && Object.keys(part).length === 1 && Array.isArray(part.and)) operands.push(...part.and);
    else operands.push(part);
  }
  return {and: operands};
}

// A single query that is a superset of expression, for bounded fallbacks.
function broadQuery(expression, capabilities) {
  if (expression === null || !isValidExpression(expression)) return null;
  if (isSupported(expression, capabilities)) return expression;
  const [operator] = Object.keys(expression);
  if (operator === 'and') return combineAnd(expression.and.map(child => broadQuery(child, capabilities)));
  return null;
}

function split(expression, capabilities, maximum) {
  if (expression === null) return [null];
  if (!isValidExpression(expression)) return [null];
  if (isSupported(expression, capabilities)) return [expression];

  const [operator] = Object.keys(expression);
  const argument = expression[operator];
  if (operator === 'or') {
    const parts = [];
    for (const child of argument) parts.push(...split(child, capabilities, maximum));
    // An unrestricted query already covers every disjunct.
    if (parts.includes(null)) return [null];
    const queries = unique(parts);
    return queries.length > maximum ? [null] : queries;
  }
  if (operator === 'and') {
    let combinations = [null];
    for (const child of argument) {
      const options = split(child, capabilities, maximum);
      const next = [];
      for (const left of combinations) {
        for (const right of options) next.push(combineAnd([left, right]));
      }
      combinations = unique(next);
      if (combinations.length > maximum) {
        // Cross products are only dropped as a whole; a weaker single query
        // still returns a superset of the original conjunction.
        return unique([combineAnd(argument.map(item => broadQuery(item, capabilities)))]);
      }
    }
    return combinations.length > 0 ? combinations : [null];
  }
  // An unsupported negation or leaf is left to local review.
  return [null];
}

/**
 * Produce source-executable queries whose union is a superset of `expression`.
 * Every query is valid for the declared capabilities; unsupported parts are
 * deliberately left out and must be re-checked locally.
 */
export function planQueries(expression, capabilities, {maximumQueries = 16} = {}) {
  const queries = unique(split(expression, capabilities, maximumQueries));
  return queries.length > maximumQueries ? [null] : queries;
}

const nfc = text => String(text).normalize('NFC').toLocaleLowerCase('und');

function triState(expression, fields, unknownFields) {
  if (expression === null) return true;
  if (!isValidExpression(expression)) {
    unknownFields.add('*');
    return undefined;
  }
  const [operator] = Object.keys(expression);
  const argument = expression[operator];
  if (operator === 'and') {
    let unknown = false;
    for (const child of argument) {
      const value = triState(child, fields, unknownFields);
      if (value === false) return false;
      if (value === undefined) unknown = true;
    }
    return unknown ? undefined : true;
  }
  if (operator === 'or') {
    let unknown = false;
    for (const child of argument) {
      const value = triState(child, fields, unknownFields);
      if (value === true) return true;
      if (value === undefined) unknown = true;
    }
    return unknown ? undefined : false;
  }
  if (operator === 'not') {
    const value = triState(argument, fields, unknownFields);
    return value === undefined ? undefined : !value;
  }
  const [field, expected] = argument;
  if (!Object.hasOwn(fields, field)) {
    unknownFields.add(field);
    return undefined;
  }
  const value = fields[field];
  if (operator === 'eq') return value === expected;
  return typeof value === 'string' && nfc(value).includes(nfc(expected));
}

/**
 * Evaluate the full business predicate locally. A missing field is unknown,
 * never a failed condition.
 */
export function evaluateExpression(expression, fields) {
  const unknown = new Set();
  const value = triState(expression, isObject(fields) ? fields : {}, unknown);
  return {
    status: value === true ? 'match' : value === false ? 'mismatch' : 'unknown',
    unknownFields: [...unknown],
  };
}
