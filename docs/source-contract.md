# 来源与既有应用契约

## 新来源

GET /request 返回expr(AST：and/or/not/eq/contains)、sources。GET <source>/capabilities返回fields、operators、supportsOr、limit、nextSupported。POST <source>/search JSON为{expr,cursor可空}，不支持的运算返回422，不能偷偷忽略；响应items、next、truncated，记录有id和fields。每来源id只在该来源稳定，跨来源去重仅按明确globalId；文本contains按本地约定NFC后大小写无关子串。字段缺失为unknown。输出source、sourceId、globalId、predicateStatus(match/unknown)、coverage(exhaustive/partial)、executedQueries；局部复核不得把未知变成不匹配。 expr=null表示无过滤领取；来源先执行受支持的expr再应用limit。cursor是本地来源不透明游标，不应在不同查询间复用；示例服务用十进制偏移编码，但调用方不得依赖该实现。来源返回truncated=true意味着该次查询不穷尽，即便没有next也不能宣布完成。

实现补充：不支持的 `or` 拆为各分支单独查询，不支持的条件不下发；本地对完整条件做三值复核，已知不匹配的资料不进入结果，未知字段保留并记入 issue。每条结果带 `sources`（来源/来源内标识/该来源覆盖）与 `executedConditions`（条件是否由来源执行及执行来源）；跨来源合并只按 `globalId`，字段冲突保留首次取值、列出 `conflictingFields` 并令 `complete=false`。单查询拆分数与页数均有上限；游标重复、越出声明能力或返回不可解析内容时停止并留下缺口。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。
