# 五交易所 Funding Top20 Google Chat 推送设计

## 1. 背景与目标

将现有 Binance 单交易所 Funding Top20 监控扩展为五交易所聚合监控。服务聚合 Binance、OKX、Hyperliquid、Bybit、Bitget 的稳定币本位线性永续合约，按同一基础币种的“下一次 Funding 年化 APR”计算跨交易所等权平均，筛选 Top20，再逐个平台展示下一次 Funding 与过去 7 日平均 Funding。

本服务继续部署在现有服务器，由 PM2 守护 Node.js 进程，并通过 Google Chat Incoming Webhook 向“投行 - Trading 策略监控”群发送一条包含两张 Top10 卡片的消息。不生成图片，不使用 GCS，不要求服务器具备公网域名或 HTTPS。

## 2. 已确认的业务口径

### 2.1 交易所范围

- Binance（卡片简称 `Bn`）。
- OKX。
- Hyperliquid（卡片简称 `Hyper`）。
- Bybit。
- Bitget。

Binance、OKX、Bybit、Bitget 只纳入正常交易的 USDT 本位线性永续合约。Hyperliquid 纳入主 Perp DEX 中正常交易的加密资产永续合约；虽然其保证金和结算资产为 USDC，Funding 是无量纲比例，经过周期标准化后可与其他平台比较。

不纳入币本位、反向、交割、期权、现货、预测市场、TradFi 永续或 Hyperliquid HIP-3 第三方 Perp DEX。

### 2.2 暂不设置流动性门槛

第一版不按成交量、持仓量、市值或上线天数筛选，也不把这些指标作为权重。后续如出现低流动性资产长期占榜，可单独增加流动性门槛或成交量/OI 权重，不在本次范围内。

### 2.3 币种归一

跨交易所聚合使用规范化基础资产 ID，而不是直接比较交易对字符串：

- 优先使用交易所公开合约元数据中的基础资产字段。
- 去除交易所格式差异，例如 `BTCUSDT`、`BTC-USDT-SWAP`、Hyperliquid `BTC` 统一为 `BTC`。
- `1000PEPE`、`1000SHIB`、`1MBABYDOGE` 等倍率合约不得通过简单字符串截断自动合并；使用受测试保护的显式别名表映射到相同经济标的。
- 无法可靠归一的合约保留平台原始资产 ID，不与可能相似的其他资产合并。
- 每个平台同一规范化资产最多保留一个市场；优先 USDT 线性永续，禁止把同一平台的 USDT 与 USDC 合约重复计权。

### 2.4 Top20 入选与等权规则

对每个规范化资产执行以下步骤：

1. 取得各平台当前预估的下一次 Funding、下一次结算时间和该合约实际 Funding 周期。
2. 将每个平台的下一次 Funding 换算为同口径 APR。
3. 仅对有完整有效数据的平台进行等权平均。
4. 一个资产至少需要覆盖 2 个交易所才具备跨平台代表性；只在 1 个交易所上市的资产不进入主榜。
5. 若覆盖平台数为 `n`，每个平台权重均为 `1/n`。缺失平台显示 `--`，不以 0 代替，也不占权重。
6. 按综合下一次 Funding APR 从高到低排序，取 Top20。
7. 综合 APR 相同时，先按覆盖交易所数量从多到少，再按规范化资产 ID 字典序排序，保证结果稳定。
8. 使用有符号值排序，不把负 Funding 取绝对值。若正 Funding 资产不足 20 个，榜单尾部可出现较低或为负的资产。

“下一次 Funding”是结算前的当前预估值，可能在实际结算前继续变化；卡片必须明确标注“预估”。

### 2.5 备选聚合方案及选择

本次选择 **有效平台等权平均**：容易解释，不依赖额外的成交量/OI 数据，并符合当前“暂无体量要求”的约束。

未选择的方案：

- **成交量或 OI 加权**：更接近资金容量，但会增加数据依赖、口径差异和故障面，留作后续版本。
- **必须五个平台全部上市**：可比性最强，但会过度缩小资产池并排除大量有意义的机会。
- **五个平台固定各 20%，缺失按 0**：会把“未上市”错误解释为“Funding 为 0”，禁止使用。

## 3. 统计公式

所有 Funding 原始值以小数表示，不是百分数。计算过程使用十进制定点库，展示时才四舍五入。

### 3.1 下一次 Funding APR

对交易所 `e`：

```text
nextApr[e] = nextFundingRate[e] × (24 ÷ intervalHours[e]) × 365
```

例如 `0.01%/8h` 的 APR 为 `0.0001 × 3 × 365 = 10.95%`；Hyperliquid 的 1 小时 Funding 使用 `intervalHours = 1`。

### 3.2 跨交易所综合 APR

设该资产有 `n` 个有效平台：

```text
compositeNextApr = sum(nextApr[e]) ÷ n
```

禁止直接平均不同结算周期的原始 Funding Rate。

### 3.3 过去 7 日平均 Funding

7 日指标只使用实际已结算 Funding，不使用当前预估值：

```text
funding7dSum[e] = trailing window 内已结算 Funding 之和
coverageDays[e] = 有效历史覆盖天数，最大为 7
avgDaily7d[e] = funding7dSum[e] ÷ coverageDays[e]
apr7d[e] = avgDaily7d[e] × 365
```

完整历史窗口为 `(asOf - 7d, asOf]`。正常覆盖 7 天时，`apr7d = funding7dSum × 365 ÷ 7`。新上线或历史不足 7 天时，按实际覆盖天数计算并标记 `*`；若无法建立至少一个完整 Funding 周期的历史，7日均显示 `--`。

7 日平均 Funding 不参与 Top20 主排序，仅用于判断当前高 Funding 是否具有持续性。

### 3.4 展示精度

- Funding：保留 4 位百分数，例如 `+0.0125%`。
- APR：保留 2 位百分数，例如 `+13.69%`。
- 正数显示 `+`，负数保留 `-`。
- 下一次 Funding 同时显示实际周期，例如 `/1h`、`/4h`、`/8h`。
- 7日均统一显示为 `%/日`，避免不同平台结算周期造成误读。

## 4. 外部数据源

全部使用各交易所官方公共只读接口，不需要交易 API Key。

### 4.1 Binance

- 合约全集：`GET /fapi/v1/exchangeInfo`。
- 当前 Funding 与下次结算时间：`GET /fapi/v1/premiumIndex`。
- 周期调整：`GET /fapi/v1/fundingInfo`，未返回的合约默认 8 小时。
- 已结算历史：`GET /fapi/v1/fundingRate`。

参考：[Binance USDⓈ-M Market Data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-history)

### 4.2 OKX

- 合约全集：`GET /api/v5/public/instruments?instType=SWAP`。
- 当前预估 Funding、当前/下次结算时间：`GET /api/v5/public/funding-rate?instId=...`。
- 已结算历史：`GET /api/v5/public/funding-rate-history?instId=...`，使用已实现的实际费率字段。
- Funding 周期由当前结算时间和下一次结算时间推导并校验；OKX 可能将部分合约从 8 小时调整为 6、4、2 或 1 小时。

参考：[OKX API Public Data](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate)

### 4.3 Hyperliquid

- 合约全集与当前 Funding：`POST https://api.hyperliquid.xyz/info`，`type = metaAndAssetCtxs`。
- 已结算历史：同一 Info endpoint，`type = fundingHistory`。
- 主 Perp DEX Funding 固定每小时结算，`intervalHours = 1`。

参考：[Hyperliquid Perpetual Info Endpoints](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[Hyperliquid Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

### 4.4 Bybit

- 合约全集和状态：`GET /v5/market/instruments-info?category=linear`，完整处理游标分页并只保留 USDT 结算永续。
- 当前 Funding、下次结算时间和周期：`GET /v5/market/tickers?category=linear`。
- 已结算历史：`GET /v5/market/funding/history`。

参考：[Bybit Tickers](https://bybit-exchange.github.io/docs/v5/market/tickers)、[Bybit Funding History](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate)

### 4.5 Bitget

- 合约全集：`GET /api/v2/mix/market/contracts?productType=usdt-futures`。
- 当前 Funding、周期和下次结算时间：官方 Current Funding Rate 接口。
- 已结算历史：`GET /api/v2/mix/market/history-fund-rate`。

参考：[Bitget Current Funding Rate](https://www.bitget.com/api-doc/uta/public/Get-Current-Funding-Rate)、[Bitget Historical Funding Rates](https://www.bitget.com/api-doc/classic/contract/market/Get-History-Funding-Rate)

## 5. 系统架构

现有调度、Google Chat、状态文件和跨进程锁保持不变；将 Binance 专用数据层扩展为交易所无关的适配器架构。

### 5.1 核心组件

1. **Exchange Adapter Interface**：统一定义市场发现、当前 Funding 快照和 7 日历史读取接口。
2. **Binance / OKX / Hyperliquid / Bybit / Bitget Adapter**：分别处理 URL、分页、限流、字段校验、错误映射和平台周期。
3. **Asset Normalizer**：根据元数据与显式别名表生成规范化资产 ID，阻止错误合并和同平台重复计权。
4. **Composite Aggregator**：标准化 APR、执行覆盖规则、等权平均和稳定排序。
5. **History Aggregator**：仅为最终 Top20 拉取和计算各平台 7 日已结算 Funding。
6. **Chat Card Builder**：构建两张 Top10 多平台卡片与纯文本 fallback。
7. **Job Orchestrator**：并发协调五个平台，同时保持完整性校验、幂等状态与发送事务。

### 5.2 数据流

```text
定时 / 手动触发
      ↓
并发读取五个平台的市场元数据与当前 Funding
      ↓
规范化资产 ID、周期和下一次 Funding APR
      ↓
过滤覆盖不足 2 个平台的资产
      ↓
计算等权综合 APR，稳定排序并选 Top20
      ↓
只为 Top20 并发读取各平台 7 日已结算历史
      ↓
构建两张 Top10 卡片并校验消息大小
      ↓
Google Chat 返回 2xx 后提交成功时间槽
```

先排名后读取历史可把最昂贵的逐合约历史请求限制在最多 `20 × 5` 个市场内。每个适配器使用独立并发队列和速率限制器，不以无限 `Promise.all` 冲击交易所接口。

## 6. 数据完整性与故障策略

### 6.1 平台级失败

五个平台均属于本榜单的核心数据源。任一平台的市场全集或当前 Funding 全量抓取失败、分页停滞、响应结构异常或明显覆盖不完整时，本轮整体失败，不允许静默删除整个平台后重新计算榜单，否则等权口径会在不同推送之间漂移。

### 6.2 资产级缺失

- 某资产未在某平台上市：正常缺失，显示 `--`，不占权重。
- 某资产已上市但当前 Funding 数据缺失或非法：该平台对该资产视为无效，并记录结构化告警。
- 有效当前数据不足 2 个平台：资产不进入候选榜。
- 入选后某个平台的 7 日历史失败：为避免发送不完整表格，本轮失败；“未上市”不属于失败。
- 新上线导致不足 7 日：按实际覆盖计算并显示 `*`，不属于失败。

### 6.3 请求策略

- 单次交易所请求默认超时 10 秒。
- 网络错误、HTTP 429 和 HTTP 5xx 最多重试 3 次，采用指数退避、随机抖动并遵循 `Retry-After`。
- 参数错误、认证错误和响应 Schema 错误不盲目重试。
- 所有分页必须去重并验证游标推进；停滞时失败，不发送可能缺数据的榜单。
- 日志不得输出 Google Chat Webhook 或未来可能配置的交易所凭据。

## 7. Google Chat 展示

继续使用一条 Webhook 消息和两张卡片：

- 卡片 1：排名 `#1–10`。
- 卡片 2：排名 `#11–20`。

每个资产使用一个紧凑的纵向文本块，避免在手机端强制显示六列宽表：

```text
#1 BTC｜综合预估 APR +12.35%｜覆盖 5/5
Bn      下次 +0.0100%/8h (+10.95%)｜7日均 +0.0240%/日 (+8.76%)
OKX     下次 +0.0120%/8h (+13.14%)｜7日均 +0.0260%/日 (+9.49%)
Hyper   下次 +0.0015%/1h (+13.14%)｜7日均 +0.0230%/日 (+8.40%)
Bybit   下次 +0.0090%/8h (+9.86%) ｜7日均 +0.0220%/日 (+8.03%)
Bitget  下次 +0.0135%/8h (+14.78%)｜7日均 +0.0250%/日 (+9.13%)
```

显示规则：

- 正 Funding 红色，负 Funding 绿色，0 使用默认颜色。
- 缺失平台显示 `下次 --｜7日均 --`。
- `*` 表示不足 7 日历史。
- 卡片顶部说明“按五交易所有效下一次 Funding APR 等权平均排序”。
- 卡片底部说明“正 Funding 表示多头支付空头；下一次为当前预估；括号内为 APR”。
- 整个 JSON 消息必须小于 Google Chat 32,000 字节；超限时构建失败，禁止静默截断或丢弃平台。

## 8. 调度、部署与安全

保持现有运行方式：

- Node.js 24 LTS、TypeScript。
- PM2 `fork` 模式、`instances: 1`。
- 北京时间 `00:05`、`08:05`、`16:05`，Cron 为 `5 0,8,16 * * *`。
- 服务器启动后仅补执行最近 30 分钟内尚未成功的时间槽。
- 使用现有进程内 single-flight、跨进程锁、原子状态文件和 Google Chat 2xx 后提交机制。
- 保留 `dry-run`、普通单次推送和显式 `--force` 推送命令。
- 正式运行仍只需要 `GOOGLE_CHAT_WEBHOOK_URL`、绝对路径 `STATE_FILE` 和 `TZ=Asia/Shanghai`。
- 五个平台市场数据均为公共只读接口，不增加 API Key，不开放服务器入站端口。

## 9. 可观测性

每轮增加以下结构化日志：

- 五个平台各自市场数、有效当前 Funding 数、请求数、分页数、重试数和耗时。
- 规范化前后资产数、显式别名命中数、冲突数。
- 覆盖 `2/5`、`3/5`、`4/5`、`5/5` 的候选资产数。
- Top20 的综合 APR、覆盖数以及各平台缺失原因，但不输出完整外部响应。
- 每个平台 Top20 历史请求数、记录数、覆盖天数和阶段耗时。
- Google Chat 消息字节数、推送结果和时间槽状态。

## 10. 测试策略

### 10.1 适配器测试

- 五个平台正常响应、空响应、非法数字、Schema 变化、分页和限流重试。
- Binance 与 OKX 动态 Funding 周期、Hyperliquid 1 小时周期、Bybit/Bitget 返回周期。
- 各平台合约状态和 USDT 线性永续过滤。
- 历史窗口边界、去重、分页游标推进和实际结算记录解析。

### 10.2 聚合测试

- 1h、2h、4h、6h、8h Funding 的 APR 标准化。
- 2–5 个有效平台的等权平均与缺失权重重归一。
- 单平台资产排除、覆盖数并列排序和确定性 Top20。
- 同平台重复市场不会重复计权。
- 显式倍率资产别名及错误合并防护。
- 7日完整历史、新上线部分历史和不足一个周期。
- 十进制精度、正负号和四舍五入。

### 10.3 卡片与作业测试

- 两张 Top10 卡片完整包含 20 个资产和 5 个交易所位置。
- 缺失值、部分历史标记、正负颜色和中文说明。
- 31,999 字节允许发送，32,000 字节拒绝发送。
- 任一平台全量失败时不发送；正常未上市不会触发全局失败。
- 只为入选 Top20 请求 7 日历史。
- Webhook 2xx 后才写状态，超时不自动重复 POST。
- 保留现有调度、防重复、跨进程锁、补发和 E2E 测试。

## 11. 验收标准

- 每天北京时间 `00:05`、`08:05`、`16:05` 自动运行。
- 五个平台均成功提供本轮市场全集与当前 Funding 后才生成榜单。
- 同一基础币种正确跨平台归一，单个平台对一个资产只计一次。
- 一个资产至少覆盖 2 个平台；缺失平台不计为 0。
- Top20 严格按有效平台下一次 Funding APR 等权平均降序。
- 每个入选资产展示综合 APR、覆盖数以及五个平台的下一次 Funding、周期、APR、7日均和7日 APR。
- Google Chat 一条消息包含两张 Top10 卡片，手机端无需横向滚动即可阅读。
- 无成交量/OI 门槛，不需要交易所 API Key、图片、GCS、公网域名或新 HTTPS 服务。
- 数据不完整、平台故障或消息超限时不发送误导性榜单。
- 现有 PM2、调度、幂等、锁、补发和安全能力保持有效。

## 12. 非目标

- 不执行交易或 Funding 套利。
- 不按成交量、持仓量、市值加权或过滤。
- 不提供独立的负 Funding Top20、24h 累计榜或绝对值榜。
- 不接入 Binance/OKX/Bybit/Bitget 的 USDC 重复市场、币本位或交割合约。
- 不接入 Hyperliquid HIP-3 第三方 Perp DEX。
- 不建设网页后台、数据库、历史报表、图片服务或云存储。
