import {
  canonicalExpression, evaluateExpression, isSupported, isValidExpression, planQueries,
} from './expression.mjs';

const MAXIMUM_QUERIES = 16;
const MAXIMUM_PAGES = 1000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapabilities(payload) {
  if (!isObject(payload)) throw new Error('来源能力不是对象');
  const {fields, operators, supportsOr, limit, nextSupported} = payload;
  if (!Array.isArray(fields) || !fields.every(field => typeof field === 'string' && field)) {
    throw new Error('来源字段声明无效');
  }
  if (!Array.isArray(operators) || !operators.every(operator => typeof operator === 'string')) {
    throw new Error('来源运算声明无效');
  }
  if (typeof supportsOr !== 'boolean' || typeof nextSupported !== 'boolean') {
    throw new Error('来源能力标志无效');
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error('来源分页上限无效');
  return {
    fields: [...new Set(fields)],
    operators: [...new Set(operators)],
    supportsOr,
    limit,
    nextSupported,
  };
}

export function normalizeRequest(payload) {
  if (!isObject(payload)) throw new Error('领取请求不是对象');
  const {expr, sources} = payload;
  if (expr !== null && !isValidExpression(expr)) throw new Error('领取条件不是可解释的表达式');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('领取请求没有来源');
  if (!sources.every(source => typeof source === 'string' && source)) throw new Error('来源位置无效');
  return {expr, sources: [...new Set(sources)]};
}

function flattenLeaves(expression, output = []) {
  if (expression === null) return output;
  const [operator] = Object.keys(expression);
  const argument = expression[operator];
  if (operator === 'and' || operator === 'or') argument.forEach(child => flattenLeaves(child, output));
  else if (operator === 'not') flattenLeaves(argument, output);
  else output.push(expression);
  return output;
}

function leafKey(expression) {
  return canonicalExpression(expression);
}

function mergeHit(hits, key, hit, onConflict) {
  const existing = hits.get(key);
  if (!existing) {
    hits.set(key, hit);
    return hit;
  }
  existing.sources.push(...hit.sources);
  existing.queryIndexes.push(...hit.queryIndexes);
  for (const [field, value] of Object.entries(hit.fields)) {
    if (!Object.hasOwn(existing.fields, field)) existing.fields[field] = value;
    else if (canonicalExpression(existing.fields[field]) !== canonicalExpression(value)) {
      if (!existing.conflicts.includes(field)) existing.conflicts.push(field);
      onConflict(field);
    }
  }
  return existing;
}

/**
 * Collect from one or more sources using a shared condition, pushing down only
 * the parts each source declares support for and re-checking the full
 * condition locally. Coverage is only exhaustive when no interpretation gap
 * remains.
 */
export async function collectFromSources({transport, expr, sources, issues}) {
  const executedQueries = [];
  const hits = new Map();
  let complete = true;

  function gap(code, message, source, extra = {}) {
    complete = false;
    issues.push({code, message, source, ...extra});
  }

  for (const source of sources) {
    let capabilities;
    try {
      const response = await transport.request(`${source}/capabilities`);
      if (!response.ok) {
        gap('capabilities-unavailable', `来源能力接口返回 ${response.status}`, source, {status: response.status});
        continue;
      }
      capabilities = normalizeCapabilities(response.json());
    } catch (error) {
      gap('capabilities-invalid', `来源能力无法确认：${error.message}`, source);
      continue;
    }

    const queries = planQueries(expr, capabilities, {maximumQueries: MAXIMUM_QUERIES});
    if (queries.length === 0) {
      gap('query-unplannable', '无法为来源安排可执行的查询', source);
      continue;
    }

    for (const query of queries) {
      if (!isSupported(query, capabilities)) {
        gap('query-unsupported', '安排的查询超出声明能力', source, {query});
        continue;
      }
      const descriptor = {
        source, expr: query, queryIndex: executedQueries.length,
        exhaustive: false, pages: 0, items: 0, truncated: false, error: null,
      };
      executedQueries.push(descriptor);
      let cursor = null;
      let pages = 0;
      const seenCursors = new Set();
      let done = false;
      while (!done) {
        if (pages >= MAXIMUM_PAGES) {
          descriptor.error = `超过单查询最大页数 ${MAXIMUM_PAGES}`;
          gap('pagination-limit', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        if (cursor !== null) seenCursors.add(cursor);
        let response;
        try {
          response = await transport.request(`${source}/search`, {
            method: 'POST',
            body: {expr: query, cursor},
          });
        } catch (error) {
          descriptor.error = `查询请求失败：${error.message}`;
          gap('query-failed', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        pages += 1;
        descriptor.pages = pages;
        if (!response.ok) {
          descriptor.error = `来源以 ${response.status} 拒绝查询`;
          gap('query-rejected', descriptor.error, source, {
            query, queryIndex: descriptor.queryIndex, status: response.status,
          });
          break;
        }
        let payload;
        try {
          payload = response.json();
        } catch (error) {
          descriptor.error = `查询响应无法解析：${error.message}`;
          gap('query-response-invalid', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        if (!isObject(payload) || !Array.isArray(payload.items)) {
          descriptor.error = '查询响应缺少资料条目';
          gap('query-response-invalid', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        descriptor.truncated = payload.truncated === true || descriptor.truncated;
        for (const item of payload.items) {
          if (!isObject(item) || typeof item.id !== 'string' || !item.id) {
            gap('item-invalid', '来源资料缺少稳定标识', source, {query, queryIndex: descriptor.queryIndex});
            continue;
          }
          if (!isObject(item.fields)) {
            gap('item-invalid', `资料 ${item.id} 的字段不是对象`, source, {
              sourceId: item.id, query, queryIndex: descriptor.queryIndex,
            });
            continue;
          }
          descriptor.items += 1;
          const key = item.globalId ? `global:${item.globalId}` : `${source}#${item.id}`;
          const hit = mergeHit(hits, key, {
            globalId: typeof item.globalId === 'string' && item.globalId ? item.globalId : null,
            fields: structuredClone(item.fields),
            raw: structuredClone(item),
            sources: [],
            queryIndexes: [],
            conflicts: [],
          }, field => {
            gap('field-conflict', `跨来源的同一资料在字段 ${field} 上不一致，保留首次取值并标记待复核`, source, {
              globalId: item.globalId, sourceId: item.id,
            });
          });
          if (!hit.sources.some(entry => entry.source === source && entry.sourceId === item.id)) {
            hit.sources.push({
              source, sourceId: item.id,
              globalId: hit.globalId,
              queryIndexes: [],
            });
          }
          const sourceEntry = hit.sources.find(entry => entry.source === source && entry.sourceId === item.id);
          if (!sourceEntry.queryIndexes.includes(descriptor.queryIndex)) {
            sourceEntry.queryIndexes.push(descriptor.queryIndex);
          }
          if (!hit.queryIndexes.includes(descriptor.queryIndex)) hit.queryIndexes.push(descriptor.queryIndex);
        }
        if (payload.truncated === true) {
          descriptor.error = '来源声明本次查询不穷尽';
          gap('query-truncated', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        if (payload.next === null || payload.next === undefined) {
          descriptor.exhaustive = true;
          done = true;
          break;
        }
        if (!capabilities.nextSupported) {
          descriptor.error = '来源返回后续游标但声明不支持翻页';
          gap('pagination-unsupported', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        if (typeof payload.next !== 'string' && typeof payload.next !== 'number') {
          descriptor.error = '来源返回了无法使用的游标';
          gap('pagination-invalid', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        const next = String(payload.next);
        if (seenCursors.has(next)) {
          descriptor.error = '来源游标重复，停止翻页';
          gap('pagination-loop', descriptor.error, source, {query, queryIndex: descriptor.queryIndex});
          break;
        }
        cursor = next;
      }
    }
  }

  const leaves = flattenLeaves(expr);
  const records = [];
  for (const hit of hits.values()) {
    const evaluation = evaluateExpression(expr, hit.fields);
    // A locally known non-match is outside the requested scope; unknown stays.
    if (evaluation.status === 'mismatch') continue;
    const sourceHits = hit.sources.map(entry => {
      const coverage = entry.queryIndexes.every(index => executedQueries[index]?.exhaustive)
        ? 'exhaustive' : 'partial';
      const executedLeaves = new Set();
      for (const index of entry.queryIndexes) {
        for (const leaf of flattenLeaves(executedQueries[index]?.expr ?? null)) {
          executedLeaves.add(leafKey(leaf));
        }
      }
      return {
        source: entry.source, sourceId: entry.sourceId, globalId: entry.globalId,
        coverage, queryIndexes: [...entry.queryIndexes],
        executedConditions: leaves.map(leaf => ({
          condition: structuredClone(leaf),
          executedBySource: executedLeaves.has(leafKey(leaf)),
        })),
      };
    });
    const coverage = sourceHits.every(entry => entry.coverage === 'exhaustive') ? 'exhaustive' : 'partial';
    if (evaluation.status === 'unknown') {
      complete = false;
      issues.push({
        code: 'predicate-unknown',
        message: '本地复核缺少字段，条件无法判定',
        source: sourceHits[0]?.source,
        sourceId: sourceHits[0]?.sourceId,
        missingFields: evaluation.unknownFields,
        queryIndexes: hit.queryIndexes,
      });
    }
    const executedConditions = leaves.map(leaf => {
      const key = leafKey(leaf);
      const executedBy = sourceHits
        .filter(entry => entry.executedConditions.some(item => leafKey(item.condition) === key && item.executedBySource))
        .map(entry => entry.source);
      return {
        condition: structuredClone(leaf),
        executedBySource: executedBy.length > 0,
        executedBySources: executedBy,
      };
    });
    const title = typeof hit.fields.title === 'string' ? hit.fields.title : undefined;
    const summary = typeof hit.fields.summary === 'string' ? hit.fields.summary : undefined;
    records.push({
      id: hit.globalId ? `global:${hit.globalId}` : `${sourceHits[0].source}#${sourceHits[0].sourceId}`,
      source: sourceHits[0].source,
      sourceId: sourceHits[0].sourceId,
      globalId: hit.globalId,
      ...(title !== undefined ? {title} : {}),
      ...(summary !== undefined ? {summary} : {}),
      fields: hit.fields,
      original: hit.raw,
      sources: sourceHits,
      matchedSources: sourceHits.map(entry => entry.source),
      predicateStatus: evaluation.status,
      coverage,
      executedConditions,
      queryIndexes: [...hit.queryIndexes],
      ...(evaluation.unknownFields.length ? {missingFields: evaluation.unknownFields} : {}),
      ...(hit.conflicts.length ? {conflictingFields: hit.conflicts} : {}),
    });
  }

  records.sort((left, right) => left.id.localeCompare(right.id));
  return {records, complete, issues, executedQueries};
}
