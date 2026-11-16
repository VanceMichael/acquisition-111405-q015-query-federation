import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {collectFromSources, normalizeRequest} from './source.mjs';

async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const response = await transport.request('/request');
  if (!response.ok) throw new Error(`领取请求失败：${response.status}`);
  let payload;
  try {
    payload = response.json();
  } catch (error) {
    throw new Error(`领取请求无法解析：${error.message}`);
  }
  const {expr, sources} = normalizeRequest(payload);

  const issues = [];
  const result = await collectFromSources({transport, expr, sources, issues});
  const records = structuredClone(result.records);
  await archive.commit({records, exchanges: transport.exchanges, issues: result.issues});
  return {
    records: result.records,
    complete: result.complete,
    issues: result.issues,
    evidenceCount: transport.exchanges.length,
    executedQueries: result.executedQueries,
  };
}

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  if (mode === 'source') return collectSource({baseUrl, archive});
  if (mode !== 'legacy') throw new Error('不支持的领取模式');
  const transport = createTransport(baseUrl);
  const response = await transport.request('/legacy');
  if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
  const records = [normalizeLegacy(response.json())];
  await archive.commit({records, exchanges: transport.exchanges});
  return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
}
