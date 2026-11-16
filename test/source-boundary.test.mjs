import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';

// Independent local test source. It replays declared capabilities/search
// answers and records the raw requests, so the collector can be exercised
// without reading the shipped fixtures.
async function startTestSource({request, sources = {}, capabilitiesStatus = 200}) {
  const requests = [];
  const server = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const path = new URL(incoming.url, 'http://localhost').pathname;
    requests.push({method: incoming.method, path, body: text});
    if (path === '/request') {
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(request));
      return;
    }
    const sourcePath = path.replace(/\/(capabilities|search)$/, '');
    const source = sources[sourcePath];
    if (!source) { response.writeHead(404).end('未声明'); return; }
    if (path.endsWith('/capabilities')) {
      const status = source.capabilitiesStatus ?? capabilitiesStatus;
      if (status !== 200) { response.writeHead(status).end('能力不可用'); return; }
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(source.capabilities));
      return;
    }
    const index = requests.filter(item => item.method === 'POST' && item.path === path).length - 1;
    const answer = typeof source.search === 'function'
      ? source.search(JSON.parse(text), index) : source.search;
    if (answer && answer.status) { response.writeHead(answer.status).end('来源拒绝'); return; }
    response.writeHead(200, {'content-type': 'application/json'})
      .end(JSON.stringify(answer && answer.body ? answer.body : answer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => structuredClone(requests),
    searches: (path) => requests
      .filter(item => item.method === 'POST' && (!path || item.path === path))
      .map(item => ({path: item.path, ...JSON.parse(item.body)})),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function localMatch(expression, fields) {
  if (expression === null) return true;
  if ('and' in expression) return expression.and.every(child => localMatch(child, fields));
  if ('or' in expression) return expression.or.some(child => localMatch(child, fields));
  if ('not' in expression) return !localMatch(expression.not, fields);
  const [operator] = Object.keys(expression);
  const [field, expected] = expression[operator];
  if (!(field in fields)) return false;
  if (operator === 'eq') return fields[field] === expected;
  return String(fields[field]).normalize('NFC').toLowerCase().includes(String(expected).normalize('NFC').toLowerCase());
}

async function withSource(setup, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'source-boundary-'));
  const source = await startTestSource(setup);
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    await handler({result, source, archive});
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

const capabilities = {
  fields: ['title', 'summary'], operators: ['contains'], supportsOr: false,
  limit: 10, nextSupported: true,
};
const orCondition = {or: [{contains: ['title', '检修']}, {contains: ['summary', '检修']}]};
const orRequest = {expr: orCondition, sources: ['/source/a']};

test('分页逐页取尽，后续查询从空游标开始', async () => {
  const items = Array.from({length: 5}, (_, index) => ({id: String(index), fields: {title: `桥梁检修${index}`}}));
  await withSource({
    request: {expr: {contains: ['title', '检修']}, sources: ['/source/a']},
    sources: {
      '/source/a': {
        capabilities: {fields: ['title'], operators: ['contains'], supportsOr: false, limit: 2, nextSupported: true},
        search: ({expr, cursor}) => {
          const matched = items.filter(item => localMatch(expr, item.fields));
          const offset = cursor === null ? 0 : Number(cursor);
          const more = matched.length > offset + 2;
          return {items: matched.slice(offset, offset + 2), next: more ? String(offset + 2) : null, truncated: false};
        },
      },
    },
  }, ({result, source}) => {
    assert.equal(result.records.length, 5);
    assert.equal(result.complete, true);
    assert.equal(result.records[0].coverage, 'exhaustive');
    assert.equal(result.issues.length, 0);
    assert.deepEqual(source.searches().map(item => item.cursor), [null, '2', '4']);
  });
});

test('来源自报不穷尽时不再翻页，也不宣布范围完成', async () => {
  await withSource({
    request: orRequest,
    sources: {
      '/source/a': {
        capabilities,
        search: () => ({items: [{id: '1', fields: {title: '桥梁检修'}}], next: '1', truncated: true}),
      },
    },
  }, ({result, source}) => {
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].coverage, 'partial');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'query-truncated'));
    assert.equal(source.searches().length, 2, '每个拆分查询只取一页且不复用游标');
    assert.deepEqual(source.searches().map(item => item.cursor), [null, null]);
  });
});

test('未知字段保持未判定，不被当作条件为假', async () => {
  const condition = {and: [{contains: ['title', '桥梁']}, {eq: ['status', 'published']}]};
  const items = [
    {id: 'unknown', fields: {title: '桥梁检修'}},
    {id: 'known-bad', fields: {title: '桥梁检修', status: 'draft'}},
    {id: 'known-good', fields: {title: '桥梁检修', status: 'published'}},
  ];
  await withSource({
    request: {expr: condition, sources: ['/source/a']},
    sources: {
      '/source/a': {
        capabilities: {fields: ['title'], operators: ['contains'], supportsOr: false, limit: 10, nextSupported: true},
        // The source only promised title; it returns every locally matching title
        // and the collector must decide `status` itself.
        search: ({expr}) => ({
          items: items.filter(item => localMatch(expr, {title: item.fields.title})),
          next: null, truncated: false,
        }),
      },
    },
  }, ({result, source}) => {
    const byId = new Map(result.records.map(record => [record.sourceId, record]));
    assert.equal(byId.has('known-bad'), false, '本地已知不匹配的资料不属于领取范围');
    assert.equal(byId.get('unknown').predicateStatus, 'unknown');
    assert.deepEqual(byId.get('unknown').missingFields, ['status']);
    assert.equal(byId.get('known-good').predicateStatus, 'match');
    assert.equal(result.records.length, 2);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'predicate-unknown'));
    assert.deepEqual(source.searches()[0].expr, {contains: ['title', '桥梁']});
    assert.deepEqual(byId.get('unknown').executedConditions, [
      {condition: {contains: ['title', '桥梁']}, executedBySource: true, executedBySources: ['/source/a']},
      {condition: {eq: ['status', 'published']}, executedBySource: false, executedBySources: []},
    ]);
  });
});

test('OR拆分为单条件查询，重复命中保留全部执行条件', async () => {
  const items = [
    {id: 'both', fields: {title: '桥梁检修', summary: '检修计划'}},
    {id: 'title-only', fields: {title: '桥梁检修', summary: '日程'}},
    {id: 'none', fields: {title: '其他', summary: '无关'}},
  ];
  await withSource({
    request: orRequest,
    sources: {
      '/source/a': {
        capabilities,
        search: ({expr}) => ({items: items.filter(item => localMatch(expr, item.fields)), next: null, truncated: false}),
      },
    },
  }, ({result, source}) => {
    assert.deepEqual(source.searches().map(item => item.expr), orCondition.or);
    assert.equal(result.records.length, 2);
    const both = result.records.find(record => record.sourceId === 'both');
    const titleOnly = result.records.find(record => record.sourceId === 'title-only');
    assert.deepEqual(both.queryIndexes, [0, 1]);
    assert.equal(both.coverage, 'exhaustive');
    assert.deepEqual(both.executedConditions.map(item => item.executedBySource), [true, true]);
    assert.deepEqual(both.executedConditions.map(item => item.executedBySources), [['/source/a'], ['/source/a']]);
    assert.deepEqual(titleOnly.queryIndexes, [0]);
    assert.deepEqual(titleOnly.executedConditions.map(item => item.executedBySource), [true, false]);
    assert.deepEqual(titleOnly.sources[0].executedConditions.map(item => item.executedBySource), [true, false]);
    assert.equal(result.complete, true);
  });
});

test('跨来源只按明确globalId合并，同本地标识不合并', async () => {
  const shared = {id: 'local', globalId: 'G-1', fields: {title: '桥梁检修'}};
  await withSource({
    request: {expr: {contains: ['title', '检修']}, sources: ['/source/a', '/source/b']},
    sources: {
      '/source/a': {capabilities, search: {items: [shared], next: null, truncated: false}},
      '/source/b': {
        capabilities,
        search: {
          items: [
            {id: 'other', globalId: 'G-1', fields: {title: '桥梁检修'}},
            {id: 'local', fields: {title: '桥梁检修'}},
          ],
          next: null, truncated: false,
        },
      },
    },
  }, ({result}) => {
    assert.equal(result.records.length, 2);
    const merged = result.records.find(record => record.id === 'global:G-1');
    assert.ok(merged);
    assert.deepEqual(merged.sources.map(entry => entry.source).sort(), ['/source/a', '/source/b']);
    assert.deepEqual(merged.sources.map(entry => entry.sourceId).sort(), ['local', 'other']);
    const separate = result.records.find(record => record.id === '/source/b#local');
    assert.ok(separate, '同本地标识但无globalId的资料保持独立');
    assert.equal(separate.globalId, null);
  });
});

test('空的有效结果是完整结果，不是缺口', async () => {
  await withSource({
    request: orRequest,
    sources: {'/source/a': {capabilities, search: {items: [], next: null, truncated: false}}},
  }, ({result}) => {
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, true);
    assert.deepEqual(result.issues, []);
    assert.ok(result.evidenceCount > 0);
  });
});

test('单个来源不可用保留其他来源的安全结果并留下缺口', async () => {
  await withSource({
    request: {expr: {contains: ['title', '检修']}, sources: ['/source/a', '/source/b']},
    sources: {
      '/source/a': {capabilities, search: {status: 503}},
      '/source/b': {
        capabilities,
        search: {items: [{id: 'ok', fields: {title: '桥梁检修'}}], next: null, truncated: false},
      },
    },
  }, ({result, archive}) => {
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].sourceId, 'ok');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'query-rejected' && issue.source === '/source/a'));
    assert.ok(archive.snapshot().issues.some(issue => issue.code === 'query-rejected'));
  });
});

test('能力接口不可用时不猜测字段与运算', async () => {
  await withSource({
    request: orRequest,
    sources: {'/source/a': {capabilities: {}, capabilitiesStatus: 500, search: {status: 500}}},
  }, ({result, source}) => {
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'capabilities-unavailable'));
    assert.equal(source.searches().length, 0);
  });
});

test('无过滤领取不伪造条件，字段缺失仍如实标记', async () => {
  await withSource({
    request: {expr: null, sources: ['/source/a']},
    sources: {
      '/source/a': {
        capabilities: {fields: [], operators: [], supportsOr: false, limit: 10, nextSupported: false},
        search: ({expr}) => ({
          items: expr === null ? [{id: 'raw', fields: {summary: '资料'}}] : [],
          next: null, truncated: false,
        }),
      },
    },
  }, ({result, source}) => {
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].predicateStatus, 'match');
    assert.equal(result.records[0].coverage, 'exhaustive');
    assert.equal(result.complete, true);
    assert.equal(source.searches()[0].expr, null);
  });
});

test('能力之外的条件先扩大查询再本地淘汰误收结果', async () => {
  const condition = {and: [{contains: ['title', '桥梁']}, {not: {eq: ['status', 'draft']}}]};
  const items = [
    {id: 'keep', title: '桥梁检修', status: 'published'},
    {id: 'drop', title: '桥梁草稿', status: 'draft'},
  ];
  await withSource({
    request: {expr: condition, sources: ['/source/a']},
    sources: {
      '/source/a': {
        capabilities: {fields: ['title'], operators: ['contains'], supportsOr: false, limit: 10, nextSupported: true},
        search: ({expr}) => ({
          items: items.filter(item => localMatch(expr, {title: item.title}))
            .map(item => ({id: item.id, fields: {title: item.title, status: item.status}})),
          next: null, truncated: false,
        }),
      },
    },
  }, ({result, source}) => {
    assert.deepEqual(source.searches().map(item => item.expr), [{contains: ['title', '桥梁']}]);
    // The source cannot execute `not`, so the broad query is sent and the
    // locally visible draft is discarded by full-condition review.
    assert.equal(result.records.some(record => record.sourceId === 'drop'), false);
    assert.equal(result.records.some(record => record.sourceId === 'keep'), true);
    assert.equal(result.records[0].predicateStatus, 'match');
    assert.equal(result.complete, true);
    assert.deepEqual(result.records[0].executedConditions.map(item => item.executedBySource), [true, false]);
  });
});

test('组合爆炸时退回有界宽查询而不是无限遍历', async () => {
  const branch = index => ({or: [
    {contains: ['title', `甲${index}`]},
    {contains: ['summary', `乙${index}`]},
    {contains: ['title', `丙${index}`]},
  ]});
  const condition = {and: [branch(1), branch(2), branch(3), branch(4)]};
  await withSource({
    request: {expr: condition, sources: ['/source/a']},
    sources: {'/source/a': {capabilities, search: {items: [], next: null, truncated: false}}},
  }, ({result, source}) => {
    assert.equal(source.searches().length, 1);
    assert.equal(source.searches()[0].expr, null);
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, true);
  });
});

test('游标原地重复时停止翻页并留下缺口', async () => {
  await withSource({
    request: {expr: {contains: ['title', '检修']}, sources: ['/source/a']},
    sources: {
      '/source/a': {
        capabilities: {fields: ['title'], operators: ['contains'], supportsOr: false, limit: 1, nextSupported: true},
        search: () => ({items: [{id: 'same', fields: {title: '桥梁检修'}}], next: '0', truncated: false}),
      },
    },
  }, ({result, source}) => {
    assert.equal(source.searches().length, 2, '第二次遇到相同游标后不再请求');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'pagination-loop'));
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].coverage, 'partial');
  });
});

test('支持OR的来源用单次查询执行完整条件', async () => {
  const items = [{id: 'one', fields: {title: '桥梁', summary: '检修计划'}}];
  await withSource({
    request: orRequest,
    sources: {
      '/source/a': {
        capabilities: {...capabilities, supportsOr: true},
        search: ({expr}) => ({items: items.filter(item => localMatch(expr, item.fields)), next: null, truncated: false}),
      },
    },
  }, ({result, source}) => {
    assert.equal(source.searches().length, 1);
    assert.deepEqual(source.searches()[0].expr, orCondition);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0].executedConditions.map(item => item.executedBySource), [true, true]);
    assert.equal(result.complete, true);
  });
});

test('globalId相同而字段冲突时保留双方来源并标记待复核', async () => {
  await withSource({
    request: {expr: {contains: ['title', '检修']}, sources: ['/source/a', '/source/b']},
    sources: {
      '/source/a': {capabilities, search: {items: [{id: 'a', globalId: 'G', fields: {title: '桥梁检修'}}], next: null, truncated: false}},
      '/source/b': {capabilities, search: {items: [{id: 'b', globalId: 'G', fields: {title: '桥梁大修'}}], next: null, truncated: false}},
    },
  }, ({result}) => {
    assert.equal(result.records.length, 1);
    const [record] = result.records;
    assert.deepEqual(record.sources.map(entry => entry.source), ['/source/a', '/source/b']);
    assert.deepEqual(record.conflictingFields, ['title']);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'field-conflict'));
  });
});

test('缺失字段由另一来源补齐后仍按完整条件复核', async () => {
  await withSource({
    request: {expr: {and: [{contains: ['title', '桥梁']}, {eq: ['status', 'published']}]}, sources: ['/source/a', '/source/b']},
    sources: {
      '/source/a': {capabilities, search: {items: [{id: 'a', globalId: 'G', fields: {title: '桥梁检修'}}], next: null, truncated: false}},
      '/source/b': {capabilities, search: {items: [{id: 'b', globalId: 'G', fields: {status: 'published'}}], next: null, truncated: false}},
    },
  }, ({result}) => {
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].fields.status, 'published');
    assert.equal(result.records[0].predicateStatus, 'match');
    assert.deepEqual(result.records[0].sources.map(entry => entry.source), ['/source/a', '/source/b']);
    assert.equal(result.complete, true);
  });
});
