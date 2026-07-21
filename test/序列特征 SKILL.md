---
name: sequence-feature-engineering
description: 把任意"行为/记录流水"构造成定长多通道序列特征的通用方法论与可套用 SQL 骨架。适用于账单序列、征信序列、还款/扣款序列、查询序列等，产出物是"一个实体一组等长数组"，可跨场景复用于 A卡/B卡评分、人群识别/分层、渠道前筛、流失预警等。当用户要把流水/明细/JSON 报告做成序列特征、要喂给 transformer/RNN/序列模型、要构造定长数组、要做 COLLECT_LIST padding、或评审一份序列特征 SQL 时使用。触发词：序列特征、序列建模、定长序列、账单序列、征信序列、行为序列、padding、COLLECT_LIST、explode、event_rank、seq_length、多通道序列、时间序列特征、序列embedding、自监督预训练、对比学习、序列折叠、超长序列、检索式截取、HMM似然特征、合流事件流、AB卡、人群识别、渠道前筛、用户行为DNA。
---

# 序列特征 Skill（通用序列特征工程）

把任意"按时间发生的行为/记录流水"——借据、扣款、还款、账单、征信查询、账户、申请——构造成**「一个实体一组等长多通道数组」**的可入模序列特征。

核心价值：**序列是与下游任务无关的"行为 DNA"，一次构造、跨场景复用**。同一套序列表，换个"消费方式"（序列模型 / 聚类 / 规则）就能服务 A卡/B卡评分、人群识别与分层、渠道前筛、流失/逾期预警等多种场景。

## 何时启用

- 用户有流水/明细表或 JSON 报告（账单、还款、扣款、征信、申请、埋点），想做成**序列**喂给 transformer / LSTM / GRU / 序列聚类 / autoencoder。
- 用户在问「怎么把这些记录拼成定长数组」「padding 怎么做」「COLLECT_LIST 顺序为什么乱」「序列特征怎么防泄露」。
- 用户给一份序列特征 SQL（含 `explode` / `ROW_NUMBER` / `COLLECT_LIST`）让你评审正确性与覆盖度。
- 用户要把已有序列特征**迁移到新场景**（如从 B 卡迁到渠道前筛 / 人群分层）。

不要用于：纯标量聚合特征体系设计（那是 `[[loan-behavior-mining]]` 借还款行为挖掘 skill 的主场）、序列模型本身的网络结构调参、纯在线特征服务架构。本 skill 聚焦**离线序列样本的构造与规约**，与 `[[loan-behavior-mining]]` 互补：后者给"该挖哪些行为维度"，本 skill 给"怎么把它们排成序列"。

---

## 核心方法论：序列特征五要素

任何一条序列特征都由 5 个正交要素确定，缺一不可：

```
序列特征 = 事件源(event) × 锚点(anchor t) × 实体粒度(entity) × 排序(order) × 多通道(channels)
          并统一 padding 成 长度 L 的等长数组
```

### 1. 事件源 event —— 一条"事件"是什么

| 形态 | 一条事件 = | 例（来自参考 SQL） | 技术手段 |
|---|---|---|---|
| 表型 row | 数仓一行 | bill: 一笔借据 / 一条扣款流水 | 直接 `ROW_NUMBER` |
| JSON 型 | 嵌套数组一个元素 | credit: 一条征信查询 / 一个贷款账户 | `lateral view explode(from_json(...))` 先打平 |
| 时间桶型 bucket | 一个时间格（月/周）聚合后的复合事件 | credit: 5 年还款按月聚合成"月级表现" | explode → `group by 月` → 对"月"排序 |

> 时间桶型很关键：高频事件（每日扣款、逐月账单）若逐条拉序列会太长且不等距，**先按月/周聚合成等距时间格**，再把"格子"排成序列，模型更易学。参考 `rpy_5yr_monthly_agg`。

### 2. 锚点 anchor t —— 序列只能看 t 之前

- bill: 快照日 `snapshot_pday`；credit: 申请日 `dt`。
- 所有 `days_ago` / `months_ago` / `days_since_last` 相对 t 计算。
- **铁律：任何事件时间必须 < t，跨过 t = 把未来/Y 偷进特征**，上线 KS 暴跌。
- JSON 快照本身也要卡时点：credit 用 `a.dt >= b.pday` 取报告 + `rn=1` 取最近一份，正是防"用了申请之后才更新的征信"。

### 3. 实体粒度 entity —— 数组的 partition key

- 决定"一个样本对应一组序列"。bill: `cust_no`（用户级）；credit: `user_no + dt + appl_no`（一次申请级）。
- **entity 是后续所有 `PARTITION BY` / `DISTRIBUTE BY` / `GROUP BY` / join 的 key**，多字段联合主键时每一步都要带全，漏 key → 笛卡尔错配。

### 4. 排序 order —— 必须固定且写进文档

```
DESC（最近在前）  ← recency 优先；B卡/行为评分/前筛常用；pos=1 = 最近一次
ASC（时间正序）   ← 适合 RNN/transformer 学"演化轨迹"；pos=1 = 最早一次
```

参考 SQL 里三种都有：借款/扣款序列 `loan_date DESC`（最近在前）、查询序列 `serialNo ASC`、还款月序列 `perf_month DESC`、借款账户序列 `open_date DESC`。**同一张表内不同序列方向可以不同，但必须逐个注释清楚**，否则下游对齐错位。

### 5. 多通道 channels —— 每个事件并行带 N 个特征

同一序列的每个 position 上挂多个并行数组 = **多变量时间序列**。通道类型对齐借还款行为算子，但落到"单事件"层：

| 通道类型 | 说明 | 例 |
|---|---|---|
| 数值原值 | 金额/额度/期数/余额 | `loan_amt` `credit_limit` `balance` |
| 间隔 / recency | 让模型感知时间疏密 | `days_since_last_borrow` `days_ago` `months_ago` |
| 类型编码 | 文本类别 → 整数 code（`CASE WHEN`） | `settle_pattern` `overdue_level` `deduct_type` `biz_type` |
| 布尔标 | 0/1 事件标记 | `is_success` `is_fail` `is_early_repay` `is_settled` |
| 比例 / 衍生 | 单事件级派生比率 | `repay_completion_rate` `single_usage_ratio` `normal_ratio` |

> **必带间隔通道**：定长数组丢掉了事件间真实时间间隔，必须用 `days_ago/days_since_last/months_ago` 把"时间疏密"作为通道补回，否则模型看不到"是密集借款还是偶尔借一次"。
>
> **编码方式按基数选**：低基数类别（`overdue_level`/`rpy_type`/`settle_pattern`）→ `CASE WHEN` 整数 code 即可；高基数字段（商户/对手方/机构 id）→ **保留原始 id 交给下游做 embedding**，别硬编码成有序整数（会引入伪序数关系）；连续金额可**分桶**（`amount_bucket`）再 embedding，比原值更稳——HEN / BST / LBSF 的通行做法。

---

## 可直接套用的 SQL 骨架（五段式管道）

两份参考 SQL 本质是同一条流水线。下面是抽象后的可复用骨架（Spark SQL）：

```sql
WITH
-- ── Stage 0 锚定：确定实体 + 锚点 t ──────────────────────────────
base AS (
    SELECT <entity_keys>, <anchor_t> AS t /*, 源数据指针(表/JSON)*/
    FROM <source> WHERE <锚点过滤，保证只取 t 之前>
),

-- ── Stage 1 造事件：一行一事件 + 逐事件衍生通道 ────────────────────
-- 表型：直接选行；JSON 型：lateral view explode(from_json(...));
-- 时间桶型：再 group by 时间格聚合
events AS (
    SELECT
        <entity_keys>,
        DATEDIFF(t, event_time) AS days_ago,          -- 间隔通道（必带）
        <numeric channels>,                            -- 数值原值
        CASE WHEN ... THEN .. END AS <type_code>,      -- 类型编码
        CASE WHEN ... THEN 1 ELSE 0 END AS <bool_flag>,-- 布尔标
        <ratio channels>,
        ROW_NUMBER() OVER (
            PARTITION BY <entity_keys>
            ORDER BY event_time DESC   -- ← 排序方向：DESC最近在前 / ASC时间正序
        ) AS event_rank
    FROM <events_source>
    WHERE event_time < t                               -- 泄露闸门
),

-- ── Stage 2 截断：保留前 L 个事件 ────────────────────────────────
events_topL AS (
    SELECT * FROM events WHERE event_rank <= 30        -- L = seq_length
),

-- ── Stage 3 定长 padding：位置模板 × 实体，LEFT JOIN 补齐 ──────────
seq_L AS ( SELECT EXPLODE(ARRAY(1,2,...,30)) AS pos ),  -- 1..L
entity_positions AS (
    SELECT b.<entity_keys>, s.pos FROM base b CROSS JOIN seq_L s
),
padded AS (
    SELECT
        p.<entity_keys>, p.pos,
        COALESCE(e.<channel>, 0)  AS <channel>,        -- 数值/布尔补 0
        COALESCE(e.days_ago, -1)  AS days_ago          -- 时间类可补 -1 区分"无事件"
    FROM entity_positions p
    LEFT JOIN events_topL e
        ON p.<entity_keys> = e.<entity_keys> AND p.pos = e.event_rank
),

-- ── Stage 4 聚合成数组：排序后 COLLECT_LIST ──────────────────────
arrays AS (
    SELECT
        <entity_keys>,
        COLLECT_LIST(<channel_1>) AS seq_<channel_1>,
        COLLECT_LIST(days_ago)    AS seq_days_ago
        -- ... 每个通道一个数组
    FROM (
        SELECT * FROM padded
        DISTRIBUTE BY <entity_keys>   -- ⚠️ 必须：保证同实体落同 reducer
        SORT BY <entity_keys>, pos    -- ⚠️ 必须：保证数组按 pos 有序
    ) sorted
    GROUP BY <entity_keys>
)
SELECT b.*, a.* FROM base b LEFT JOIN arrays a USING (<entity_keys>);
```

**最隐蔽也最致命的一步是 Stage 4**：`COLLECT_LIST` 在 Spark 中**不保证顺序**，必须先 `DISTRIBUTE BY entity SORT BY entity, pos` 再聚合，否则每个用户的数组顺序随机错乱、通道间还会错位对不齐。两份参考 SQL 每个数组 CTE 都这么写，不是可选项。

---

## padding 规约

- 数值 / 计数 / 布尔类缺失补 `0`；时间类（`days_ago`/`months_ago`）补 `-1` 哨兵，区分"无此事件"与"间隔恰好为 0"。
- 长度 L **全表统一**（参考用 30）。L 由"活跃实体的行为长度"定：太短砍掉高活跃用户尾部，太长全是稀疏 padding 噪声。
- **位置模板用 `EXPLODE(ARRAY(1..L))` 固定生成**，再 `CROSS JOIN` 全体实体——保证零事件的实体也产出全 padding 的等长数组（不会在 LEFT JOIN 后变成空）。

---

## 三种事件源形态速查

| 形态 | 触发特征 | 关键写法 | 参考 CTE |
|---|---|---|---|
| 表型 | 数仓明细表，一行一事件 | 直接 `ROW_NUMBER` over 行 | `borrow_sequence_*` `deduct_sequence_*` |
| JSON 型 | HBase/报文，嵌套数组 | `lateral view explode(FROM_JSON(GET_JSON_OBJECT(...)))` 打平后再 rank | `query_records` `loan_accounts` `credit_agreements` |
| 时间桶型 | 高频事件，需等距 | explode → `group by 月` 聚合 → 对"月"`ROW_NUMBER` | `rpy_5yr_monthly_agg` → `rpy_5yr_ranked` |

> 同一份数据可同时产多条序列（参考 credit 一份征信报告产出查询序列 / 还款月序列 / 借款账户序列三条），通过**复用同一个 explode 结果**避免重复打平（参考 `rpy_5yr_exploded` 同时喂序列和标量逾期聚合）。

---

## 多源事件：并行多序列 vs 单一合流事件流

把多种事件（借款/扣款/还款/查询/申请）组织成序列有两条路线，取舍要先想清楚：

- **并行多序列（参考 SQL 现状）**：每个事件源各成一条序列、各自 padding。简单、可解释、各序列可用不同 L 与排序方向；**缺点**：模型看不到"借款后 3 天扣款失败"这类**跨序列时序耦合**。
- **单一合流事件流（Ant UBS / HEN 路线）**：所有事件按时间合并成一条流，加 `event_type` 通道区分类型，token = `[event_type_emb, amount_bucket, partner_id, time_gap]`。能学跨类型时序依赖，是**自监督预训练 embedding（见下）的标准输入**；**代价**：要统一异构字段、padding 更复杂、可解释性下降。
- **选择**：树模型 / 强可解释优先 → 并行多序列；端到端序列模型 / 预训练 embedding → 合流事件流。两者可并存（树模型用并行序列摘要，深度侧用合流流）。

---

## 序列的四种产出形态（决定怎么喂下游，也是跨场景复用的关键）

定长数组只是"半成品"。同一套序列可按四种形态消费，按"有无 Y / 时效 / 算力 / 可解释要求"选：

| 产出形态 | 做法 | 适用 | 代表 |
|---|---|---|---|
| ① 原始定长数组 | 直接喂端到端序列模型（Transformer/GRU），位置 + 字段 embedding | 有 Y、算力足、追上限 | BST / FinLangNet |
| ② 序列摘要统计量 | 在序列上算 趋势斜率 / 波动率 / EMA / 最大回撤 / 连续逾期 streak / 间隔分位数，落成**标量**拼树模型 | 要可解释、要快、与现有 XGBoost/评分卡对齐 | 经典 FE；DeRisk 对照 |
| ③ 生成模型似然特征 | 对序列拟合 HMM，用 `logP(seq\|good) − logP(seq\|bad)` 当**标量**特征 | 想要"序列整体异常度"单值信号，老派但稳 | Multi-perspective HMM（PR-AUC +15%）|
| ④ 自监督预训练 embedding | 无标签预训练序列 encoder（对比 / 掩码 / 师生），产出 client 向量 | **跨场景复用的核心**：无 Y 人群识别、冷启动、多任务共享底座 | CoLES / BYB |

要点：
- **④ 才是"一次构造、跨场景复用"真正落地的方式**——预训练一次出 embedding，A卡/B卡/人群识别/渠道前筛都拿同一向量，不必每场景重训序列模型。BYB 线上两个逾期任务 KS +2.7%/+7.1%，CoLES 证明无标签 embedding 下游分类超基线。
- **②③ 让序列无缝进现有树模型/评分卡体系**，不必推翻 XGBoost。多数团队从 ② 起步，再逐步上 ①④。
- 四种可叠加：① 的中间 embedding 也能抽出来当 ② 的标量用。

---

## 超长序列：top-L 截断之外的三条路

骨架 Stage 2 的 top-L 截断简单，但会砍掉高活跃用户尾部、丢长期信号。当实体行为很长（消费/支付逐笔可达数千上万条）时：

| 思路 | 做法 | 代表 |
|---|---|---|
| 时间桶聚合 | 先按月/周把高频事件压成等距格再排序（即"时间桶型"事件源）| 参考 5 年还款月序列 |
| 序列折叠分组 | 按某字段（商户/对手方/产品）把长序列折叠成组，组内多字段编码 + 聚合，再学组间关系 | LBSF（腾讯微信）|
| 检索式截取 | 用目标/候选作 query，先粗筛（GSU）出相关子序列、再精排（ESU），长度可达数万 | SIM（阿里）|

经验：先时间桶聚合压一遍，仍太长再上折叠/检索。账单/扣款序列按产品或对手方折叠通常立竿见影。

---

## 跨场景复用（本 skill 的核心主张）

序列表只构造一次，下游按场景换"消费方式"。**锚点/实体/排序的口径在所有场景间必须一致**，否则离线训练与各场景上线漂移。

| 场景 | 怎么消费序列 | 锚点/样本注意 |
|---|---|---|
| A 卡 / B 卡评分 | 序列 → 序列模型出 embedding → 拼接树模型/打分 | 锚点 = 申请/支用时点；严防跨锚点泄露；多 Y 评估 |
| 人群识别 / 分层 | 序列 → 无监督（序列聚类 / autoencoder embedding） | 无 Y，但锚点一致性仍要保证；可不截断 Y 时点 |
| 渠道前筛 | 轻量序列（短 L / 精简通道）→ 前置规则或粗排 | 时效高，L 可缩短、通道精简；用前筛时点已可得的源 |
| 流失 / 逾期预警 | 序列 → 时序模型预测未来 N 期 | 锚点滚动；窗口不能含观察期表现 |

迁移清单：① 确认新场景锚点是否变（申请日 vs 当前日 vs 前筛触达日）；② 确认源数据在新锚点时点是否可得（前筛常拿不到征信，要降级到内部账单序列）；③ L 与通道可按时效裁剪；④ 序列构造管道本身几乎不动。

---

## 命名规范（建议）

```
数组列：    seq_{域}_{含义key}              例：seq_rpy_overdue_ratio
单事件通道：{域}_{子类}_{含义key}            例：loan_deduct_success_rate
```

域前缀对齐业务：`borrow/draw`（借款）`deduct`（扣款）`repay/rpy`（还款）`query`（征信查询）`loan`（账户）`credit`（授信）。要点：① 数组列统一 `seq_` 前缀或 `_seq` 后缀，一眼区分序列 vs 标量；② 含义 key 用全小写描述语义，禁拼音首字母缩写；③ 排序方向写进列注释（`pos=1=最近` / `pos=1=最早`）。

---

## 验证 / 自查 checklist

1. **等长校验**：抽样 `SIZE(seq_xxx)` 是否恒等于 L；零事件实体是否也产出全 padding 数组。
2. **顺序校验**：抽几个实体把 `pos=1` 对回原表，确认真的是约定的"最近/最早"——`COLLECT_LIST` 漏排序的乱序 bug 只能这样抓。
3. **通道对齐**：同一序列的多个数组，同 pos 是否来自同一事件（漏 `DISTRIBUTE BY/SORT BY` 会错位）。
4. **泄露自查**：所有事件时间 `< t`；`days_ago/months_ago >= 0`；JSON 报告快照 `pday <= dt` 且取 `rn=1` 最近一份。
5. **时间感**：是否带了 `days_ago/间隔` 通道——否则模型看不到时间疏密。
6. **实体唯一**：一个样本是否唯一一组序列（多字段主键 join 是否带全 key）。
7. **截断偏差**：top-L 砍掉的长尾占比、活跃实体真实行为长度分布，评估 L 是否够。
8. **padding 区分**：缺失 vs 真实 0 是否需要 -1 哨兵区分（尤其金额/天数）。
9. **产出形态匹配**：先确定是喂端到端模型（①）还是出统计量（②）/似然（③）/预训练 embedding（④）——形态不同，校验口径和可解释性要求都不同。
10. **预训练语料时点**：若走 ④，自监督预训练语料与 embedding 快照同样**不能跨锚点 t**，且打分时 embedding 版本要与训练一致。

---

## 关键陷阱

- **`COLLECT_LIST` 不排序 → 数组乱序 + 通道错位**：必须 `DISTRIBUTE BY entity SORT BY entity, pos`。最常见、最难发现。
- **等长丢失真实时间间隔**：等长数组抹平了事件间隔，必加 `days_ago`/`days_since_last` 通道。
- **JSON 快照时点错配**：用 `dt >= pday` + `rn=1` 卡最近且不晚于锚点的报告，否则混入未来信息。
- **类型字段当数值喂**：文本类别先 `CASE WHEN` 编码成 code（或下游 embedding），别让模型误读伪序数关系。
- **L 取值失衡**：太短砍高活跃尾部，太长全是稀疏 padding 噪声——按活跃实体行为长度分位数定。
- **锚点跨场景不一致**：训练用申请日、前筛上线用触达日，源数据可得性与口径都变 → 线上线下漂移。
- **多字段实体 join 漏 key**：credit 同时按 `user_no+dt+appl_no`，任一步漏 key 即笛卡尔错配 / 重复。
- **高频事件不分桶**：逐日扣款逐条拉序列既长又不等距，应先按月/周聚合成时间桶。
- **只会 top-L 截断**：超长序列别只硬截断，否则丢长期信号、砍掉活跃尾部——考虑时间桶 / 折叠（LBSF）/ 检索（SIM）。
- **高基数字段编成有序整数**：商户/机构 id 当 `CASE WHEN` 序数喂模型会引入伪序关系，应走 embedding 或分桶。
- **预训练 embedding 时点泄露**：自监督语料 / embedding 快照晚于锚点 t 等于偷未来——和原始特征一样要卡 t。

---

## 工作流（用户场景 → 你应该怎么帮）

**场景 A：帮我把这些流水/报告做成序列特征**
1. 先确认五要素：事件源（表型/JSON型/时间桶型）、锚点 t、实体粒度、排序方向、L。
2. 定**产出形态**（①原始数组/②统计量/③似然/④预训练 embedding）——这决定了组织方式（并行多序列 vs 合流事件流）与下游怎么接。
3. 列通道清单（数值/间隔/类型编码/布尔/比例，对齐 `[[loan-behavior-mining]]` 的行为维度），高基数字段留 id、连续金额分桶。
4. 套五段式 SQL 骨架逐 CTE 填充；序列过长先时间桶/折叠/检索。
5. 强调 Stage 4 排序 + 泄露闸门 + 间隔通道，给出验证 checklist。

**场景 B：评审一份序列特征 SQL**
1. 先查 `COLLECT_LIST` 前有没有 `DISTRIBUTE BY + SORT BY`（头号 bug）。
2. 查泄露闸门（事件时间 < 锚点、JSON 快照 rn=1 且 ≤ dt）。
3. 查 padding（等长、缺失补值、零事件实体覆盖）、通道是否带时间间隔、实体 join key 是否带全。
4. 对照五要素是否都明确且注释清楚（尤其排序方向）。

**场景 C：给具体字段问怎么做序列**
1. 判断事件源形态 → 选对应骨架变体。
2. 套五要素，给 5-10 个通道候选 + 业务直觉。
3. 提醒命名规范与排序注释。

**场景 D：把现有序列迁移到新场景（AB卡→人群/前筛）**
1. 对照"跨场景复用"表，先定新锚点与源可得性。
2. 裁剪 L / 通道以适配时效。
3. 序列构造管道复用，只换下游消费方式与样本/锚点。

---

## 参考输出格式

序列特征清单建议表头：

```
| 序号 | seq列名 | 域 | 事件源形态 | 锚点 | 实体粒度 | 排序方向(pos=1含义) | 通道类型 | L | 含义 | 数据源 |
```

序列特征工程交付物建议结构：

```
0_说明(五要素定义)  1_事件源与锚点  2_通道清单  3_SQL(五段式)
4_padding与等长校验  5_泄露自查      6_跨场景复用说明
```

—— 把"借据/账单/征信报告"换成任意"按时间发生的记录流水"，本管道与规约即可平移到新业务，与 `[[loan-behavior-mining]]` 配套使用：先按四维度笛卡尔积选维度，再用本 skill 排成序列。

---

## 延伸阅读（仓库 `papers/`）

方法论各环节的论文出处，详见 `papers/README.html`：

- **多通道月度序列 + 多 horizon 预测**：FinLangNet（滴滴）— 对应"产出形态①" + 多 Y
- **事件序列定义 + 自监督预训练 embedding**：BYB（蚂蚁）、CoLES — 对应"产出形态④""合流事件流"
- **合流事件流 + 层次化可解释**：HEN（阿里）— 对应"多源合流""高基数字段 embedding"
- **序列似然标量特征**：Multi-perspective HMM — 对应"产出形态③"
- **超长序列折叠 / 检索**：LBSF（腾讯）、SIM（阿里）— 对应"超长序列三条路"
- **Transformer 吃行为序列的基础架构**：BST（阿里）— 对应"产出形态①"
- **tabular + 序列信贷风险工程基线**：DeRisk — 对应"产出形态②"的对照
