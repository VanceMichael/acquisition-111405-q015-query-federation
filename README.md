# 异构目录搜索的等价查询与覆盖采集

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查，以及按统一条件从多家异构来源领取资料。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是基线回归加新增的边界验证：既有摘要通路、原文摘要检查、本地来源响应、CLI 在独立进程中的真实领取、重复导入和持久归档检查，以及 `test/source-boundary.test.mjs` 中分页、截断、未知字段、跨来源合并、局部复核与有界遍历等用例。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。交付时执行 `npm run verify:complete`，让基线与新来源验收同时通过。

```sh
npm run verify:complete
npm run demo:feature
```

`npm run demo:feature` 从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `unsupported-or`。单次命令应在90秒内结束，不使用真实客户数据。

## 领取方式

`collect({baseUrl, archive, mode: 'source'})` 先从 `/request` 取得统一条件与来源清单，再逐来源读取 `/capabilities`，据此安排实际查询：

- 来源声明支持的条件（字段、运算符、`and`/`or`/`not`）才下发；不支持的 `or` 会拆成单条件查询分别执行，不支持的条件不发送。
- 无法下发但需要解释的条件（如另字段的 `eq`、`not`）由本地按三值逻辑复核：字段缺失为 `unknown`，既不算命中也不算不命中。
- 每条资料记录 `sources`（在哪些来源、以哪个来源内标识命中）与 `executedConditions`（各条件是否由来源执行、由哪些来源执行）；跨来源只按明确的 `globalId` 合并。
- `coverage` 只有在对应查询真正取尽时才为 `exhaustive`；来源 `truncated=true`、无翻页能力、错误或游标异常都会留下 issue 并令 `complete=false`。空的有效结果仍是完整结果。

## 容器

```sh
docker build -t acquisition-query-federation:local .
docker run --rm --network none acquisition-query-federation:local
docker run --rm --network none acquisition-query-federation:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令运行测试与摘要导入演示。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式要保留。
- `src/expression.mjs` 负责表达式校验、能力匹配、查询拆分与本地三值复核。
- `src/source.mjs` 负责逐来源查询、翻页、跨来源归并与覆盖/执行情况汇总。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
