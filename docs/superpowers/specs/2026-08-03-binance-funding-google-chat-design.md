# 币安 Funding Top20 Google Chat 推送设计

## 1. 背景与目标

在“投行 - Trading 策略监控”Google Chat 群中，每 8 小时推送一次币安 USDT-M 永续合约 Funding Top20，帮助群成员及时发现过去 24 小时累计 Funding 较高的资产。

本服务部署在现有服务器，由 PM2 守护 Node.js 常驻进程。服务直接向 Google Chat Incoming Webhook 发送两张 Top10 卡片，不生成图片，不使用 GCS，不要求服务器具备公网域名或 HTTPS。

## 2. 已确认的业务口径

### 2.1 资产范围

- 交易所：Binance。
- 市场：USDⓈ-M Futures。
- 报价资产：USDT。
- 合约类型：`PERPETUAL`。
- 合约状态：`TRADING`。
- 不包含 USDC-M、COIN-M、交割合约和 TradFi 永续。

### 2.2 排名规则

- 主排序指标：过去 24 小时已结算 Funding 累计值。
- 排序方向：从高到低。
- 展示数量：Top20。
- 并列时依次按当前 Funding 从高到低、交易对名称字典序排序，保证结果稳定。
- 如果正 Funding 资产不足 20 个，继续展示值较低或为负的资产，仍保持降序。

### 2.3 展示字段

每个资产展示：

- 排名。
- 资产名称（使用 `exchangeInfo.baseAsset`，不通过字符串截断推导）。
- 交易所 `Binance`。
- 当前 Funding、实际 Funding 周期以及当前 APR。
- 过去 24 小时累计 Funding 及其 APR。
- 过去 7 日累计 Funding 及其 APR。

百分比格式：

- Funding 保留 4 位小数，例如 `0.0125%`。
- APR 保留 2 位小数，例如 `13.69%`。
- 负值保留负号。

### 2.4 年化公式

设 Funding 原始值均为小数而不是百分数：

- 当前 APR = `currentFundingRate × (24 ÷ intervalHours) × 365`。
- 24h APR = `funding24hSum × 365`。
- 7日 APR = `funding7dSum × (365 ÷ 7)`。

计算过程使用十进制定点库，展示时才执行四舍五入，避免二进制浮点误差影响排序和显示。

### 2.5 时间窗口

- 使用 Binance Server Time 作为本次计算的 `asOf` 时间。
- 24h 窗口为 `(asOf - 24h, asOf]`。
- 7日窗口为 `(asOf - 7d, asOf]`。
- 历史累计只纳入 `rateType = Regular` 的已结算记录。
- 新上线不足 7 日的资产使用可获得的全部记录累计，并在卡片底部说明“新上线资产的 7 日数据按可用历史累计”。

## 3. 外部数据源

全部使用 Binance 公共 REST API，无需 API Key：

- `GET /fapi/v1/time`：确定 Binance Server Time。
- `GET /fapi/v1/exchangeInfo`：确定有效 USDT-M 永续合约全集。
- `GET /fapi/v1/fundingRate`：获取过去 7 日已结算 Funding 历史。
- `GET /fapi/v1/premiumIndex`：获取全部合约最新 Funding。
- `GET /fapi/v1/fundingInfo`：获取存在 Funding 周期调整的合约；未出现在该接口结果中的合约使用默认 8 小时周期。

`fundingRate` 以 `limit=1000` 分页。下一页继续使用上一页最后一个 `fundingTime` 作为 `startTime`，并按 `symbol + fundingTime + rateType` 去重，避免同一结算时间处于分页边界时遗漏资产。若一页未推动游标且未产生新记录，任务以数据不完整失败，禁止发送可能错误的榜单。

参考：

- [Binance Funding Rate History](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-history)
- [Binance Funding Rate Info](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-info)
- [Binance Mark Price and Funding Rate](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#mark-price)

## 4. 系统架构

服务使用 Node.js 24 LTS 与 TypeScript，按单一职责拆分为以下组件：

1. **Scheduler**：注册北京时间定时任务、启动补发检查并阻止任务重叠。
2. **Binance Client**：访问 Binance 公共接口，负责超时、重试、分页和响应校验。
3. **Funding Aggregator**：过滤资产全集，构建 24h/7日窗口，累计 Funding，计算 APR 并稳定排序。
4. **Chat Card Builder**：把 Top20 转换成两张 Top10 `cardsV2` 卡片，并生成纯文本 fallback。
5. **Google Chat Client**：向 Incoming Webhook 发送消息，校验 HTTP 响应但绝不记录完整 Webhook URL。
6. **Run State Store**：原子保存最近成功时间槽，用于防重复和服务器重启补发。
7. **Job Orchestrator**：按固定顺序协调数据抓取、计算、构建、推送和状态提交。

数据流：

```text
node-cron / 手动执行
        ↓
读取 Binance Server Time 和合约全集
        ↓
抓取并校验 7 日 Funding 历史、最新费率和特殊周期
        ↓
计算 24h / 7日累计与 APR，稳定排序 Top20
        ↓
构建两张 Top10 Google Chat 卡片
        ↓
Webhook 返回 2xx 后写入成功时间槽
```

## 5. Google Chat 展示

一条 Webhook 消息包含：

- `text`：无卡片客户端或异常渲染时使用的简短 fallback。
- `cardsV2[0]`：排名 1–10。
- `cardsV2[1]`：排名 11–20。

每张卡片包含标题、统计时间、排序说明和 10 个资产行。每个资产行使用两列布局：左侧为排名、资产与交易所，右侧为当前、24h、7日 Funding 及 APR。在小屏设备上由 Google Chat 自动换行，不依赖五列固定宽度。

卡片底部说明：

- Funding 为正表示多头支付空头。
- 括号内为 APR 年化。
- 新上线资产的 7 日数据按可用历史累计。

构建完成后必须验证整个 JSON 消息小于 Google Chat 的 32,000 字节限制；超限属于构建错误，不发送截断卡片。

参考：

- [Google Chat card messages](https://developers.google.com/workspace/chat/messages-overview)
- [Google Chat columns](https://developers.google.com/workspace/chat/design-components-card-dialog#add_columns)

## 6. 调度与 PM2

- Node.js 进程由 PM2 以 `fork` 模式、`instances: 1` 运行。
- `node-cron` 表达式：`5 0,8,16 * * *`。
- 时区：`Asia/Shanghai`。
- 正常推送时间：北京时间 `00:05`、`08:05`、`16:05`。
- 每个时间槽格式为 `YYYY-MM-DDTHH`，例如 `2026-08-03T08`。
- 同一时间槽只有在 Google Chat 返回 2xx 后才记为成功。
- 进程启动时，如果距离最近一个已经到达的计划时间不超过 30 分钟且该时间槽尚未成功，则补执行一次。
- 使用进程内 single-flight 锁；上一轮仍在运行时，不启动新的轮次。
- 正式部署只运行一个调度实例；禁止使用 PM2 cluster 多实例。
- 提供一次性手动命令，用于 dry-run、Webhook 测试和正式补发。

状态文件保存在部署目录之外的持久路径，通过环境变量配置。写入时采用“临时文件 + 原子重命名”，避免进程异常导致状态损坏。

## 7. 配置与安全

必需配置：

- `GOOGLE_CHAT_WEBHOOK_URL`：目标 Google Chat Incoming Webhook。
- `TZ=Asia/Shanghai`。
- `STATE_FILE`：最近成功时间槽状态文件的绝对路径。

运行规则：

- Webhook URL 只通过环境变量或服务器密钥文件注入，不写入代码、日志或 Git。
- 日志仅输出脱敏后的 Webhook 主机信息。
- Binance 接口均为公共只读请求，不配置交易 API Key。
- 不创建公网服务，不监听 HTTP 端口，不开放新的服务器入站端口。
- 不使用 GCS、Google Cloud 项目或付费图片存储。

## 8. 错误处理

### 8.1 Binance 请求

- 单次请求超时 10 秒。
- 网络错误、HTTP 429 和 HTTP 5xx 最多重试 3 次。
- 重试采用指数退避并加入随机抖动；收到 `Retry-After` 时优先遵循该值。
- HTTP 4xx 参数错误和响应结构错误不盲目重试。
- 任一核心数据源最终失败、分页停滞或合约覆盖不完整时，不发送榜单。

### 8.2 Google Chat 请求

- 单次请求超时 15 秒。
- 明确收到非 2xx 时，本轮失败且不写成功状态。
- 超时属于结果不确定；为降低重复消息风险，当轮不自动重复 POST，由 PM2 日志告警并允许人工执行一次性补发。
- Webhook 发送失败不能再次通过同一 Webhook 告警，只记录结构化错误日志。

### 8.3 数据异常

- Top20 不足 20 个、当前费率缺失、非法数字或 Funding 周期非正数时，本轮失败。
- 每个榜单资产都必须同时存在合约元数据、当前费率和至少一条历史记录。
- 排名前后必须重新验证 24h 累计值保持非递增。

## 9. 可观测性

每次运行输出结构化日志：

- 时间槽与触发来源（cron、startup-catchup、manual）。
- Binance `asOf`。
- 有效合约数、历史记录数、分页次数和 Top20 数量。
- 数据抓取、计算、卡片构建、Webhook 请求各阶段耗时。
- 卡片 JSON 字节数。
- 成功、跳过、补发或失败状态及错误类别。

日志由 PM2 收集，可通过 `pm2 logs bn-funding` 查看。

## 10. 测试策略

### 10.1 单元测试

- USDT-M 永续合约过滤。
- 24h/7日窗口边界与 `Regular` 类型过滤。
- 1h、4h、8h 当前 APR 计算。
- 24h、7日累计 APR 计算与四舍五入。
- 稳定排序和 Top20 截取。
- 新资产不足 7 日的累计行为。
- Funding 历史同时间戳分页去重。
- Google Chat 两张 Top10 卡片快照与 32 KB 限制。
- 时间槽、防重复、single-flight 和 30 分钟补发。

### 10.2 集成测试

- 使用本地 HTTP mock 模拟 Binance 分页、429、5xx、超时和异常响应。
- 使用本地 Webhook mock 验证请求体、超时和状态提交顺序。
- 验证只有 Webhook 2xx 后才写成功时间槽。

### 10.3 上线验证

1. dry-run 获取真实 Binance 数据并在终端输出 Top20，不触发 Webhook。
2. 向测试 Google Chat Webhook 发送一次正式卡片。
3. 检查电脑端和手机端的两张 Top10 卡片。
4. 启动 PM2，验证只存在一个实例。
5. 手工执行一次相同时间槽，确认不会重复推送。

## 11. 验收标准

- 北京时间每天 `00:05`、`08:05`、`16:05` 自动运行。
- 榜单只包含正在交易的 Binance USDT-M 永续合约。
- Top20 严格按过去 24 小时累计 Funding 降序。
- 当前、24h、7日 Funding 与 APR 计算符合本设计公式。
- Google Chat 一条消息内展示两张 Top10 卡片，手机端可读。
- 不依赖图片、GCS、公网域名或新的 HTTPS 服务。
- 同一时间槽不会因进程重启或重复调度而重复发送。
- Binance 数据不完整时不会发送误导性榜单。
- Webhook 和其他敏感配置不会出现在仓库或日志中。

## 12. 非目标

- 不统计其他交易所。
- 不统计 USDC-M、COIN-M 或交割合约。
- 不生成 Funding 最低或绝对值 Top20。
- 不提供网页后台、交互查询、数据库或历史报表。
- 不发送图片或保存历史图片。
- 不执行任何交易操作。
