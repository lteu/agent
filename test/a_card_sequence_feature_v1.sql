-- ================================================================
-- A 卡场景 · 借款序列特征 v1
-- 说明：基于用户历史借据流水，构造定长多通道序列特征（L=30）
-- 适用：A卡评分（申请评分），锚点 = 本次支用日
-- 排序方向：time_loan DESC（pos=1 = 最近一次历史借款）
-- 产出形态：原始定长数组（可喂序列模型 / 接统计量 / embedding）
-- 
-- 五要素速览：
--   事件源  | 锚点 t   | 实体粒度  | 排序方向      | L
--   表型    | time_loan | cust_no   | DESC(最近在前) | 30
-- ================================================================

WITH

-- ── Step 0: 锚定 · 确定实体（本次支用的用户）与锚点 t ─────────────
users AS (
    SELECT cust_no
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda
    WHERE pday = '{$yesterday_p}'
      AND REPLACE(DATE(time_loan), '-', '') = pday
      AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
    GROUP BY 1
),

-- ── Step 1: 造事件 + 逐事件衍生通道 ──────────────────────────────
-- 注意：这里是该用户 *本次支用之前* 的所有历史借据
-- 用 base_loans 自关联取历史记录，锚点 = 本次 time_loan
events AS (
    SELECT
        a.cust_no,
        a.time_loan AS anchor_time,                        -- 锚点 t（本次支用时间）
        e.loan_no,
        e.time_loan AS event_time,
        DATEDIFF(a.time_loan, e.time_loan) AS days_ago,    -- 间隔通道：距锚点多少天
        e.loan_amt,                                        -- 数值：借款金额
        e.term,                                            -- 数值：期数
        CASE WHEN DAYOFWEEK(e.time_loan) IN (1, 7) THEN 1 ELSE 0 END AS is_weekend,  -- 布尔：是否周末
        CASE 
            WHEN DAY(e.time_loan) <= 10 THEN 1
            WHEN DAY(e.time_loan) <= 20 THEN 2
            ELSE 3
        END AS month_period,                                -- 类型编码：月初/月中/月末
        IF(CAST(e.loan_bal AS INT) = 0, 1, 0) AS is_settled,  -- 布尔：是否已结清
        IF(e.date_settle IS NOT NULL 
           AND DATEDIFF(e.date_end, e.date_settle) >= 0, 
           DATEDIFF(e.date_end, e.date_settle), 0) AS anticipate_settle_days,  -- 数值：提前结清天数
        IF(e.date_settle IS NOT NULL 
           AND DATEDIFF(e.date_end, e.date_settle) < 0, 
           DATEDIFF(e.date_end, e.date_settle), 0) AS late_settle_days,        -- 数值：逾期结清天数
        e.over_due_days,                                   -- 数值：逾期天数
        CAST(e.over_due_status AS INT) AS over_due_status, -- 类型编码：逾期状态
        CAST(e.seq_no AS INT) AS seq_no,
        ROW_NUMBER() OVER (
            PARTITION BY a.cust_no, a.time_loan
            ORDER BY e.time_loan DESC                      -- 最近在前，pos=1 = 最近一次历史借款
        ) AS event_rank
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda a
    INNER JOIN users u ON u.cust_no = a.cust_no
    -- 关联同一用户的历史借据（排除本次支用本身）
    INNER JOIN fin_dw_fk.dwt_trade_loan_j_ice_assist_pda e
        ON e.cust_no = a.cust_no
        AND e.time_loan < a.time_loan                      -- ⚠️ 泄露闸门：只取本次之前
        AND e.product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
    WHERE a.pday = '{$yesterday_p}'
      AND REPLACE(DATE(a.time_loan), '-', '') = a.pday
      AND a.product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
),

-- ── Step 2: 截断 · 保留前 L=30 个事件 ─────────────────────────
events_topL AS (
    SELECT * FROM events WHERE event_rank <= 30
),

-- ── Step 3: 定长 padding · 1..30 位置模板 × 实体 LEFT JOIN ──────
seq_L AS (
    SELECT EXPLODE(ARRAY(1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                         11,12,13,14,15,16,17,18,19,20,
                         21,22,23,24,25,26,27,28,29,30)) AS pos
),

entity_positions AS (
    SELECT DISTINCT a.cust_no, a.time_loan AS anchor_time, s.pos
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda a
    INNER JOIN users u ON u.cust_no = a.cust_no
    CROSS JOIN seq_L s
    WHERE a.pday = '{$yesterday_p}'
      AND REPLACE(DATE(a.time_loan), '-', '') = a.pday
      AND a.product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
),

padded AS (
    SELECT
        p.cust_no,
        p.anchor_time,
        p.pos,
        -- 数值/布尔类缺失补 0；时间间隔类补 -1 区分"无事件"
        COALESCE(e.days_ago, -1)                AS days_ago,
        COALESCE(e.loan_amt, 0)                 AS loan_amt,
        COALESCE(e.term, 0)                     AS term,
        COALESCE(e.is_weekend, 0)               AS is_weekend,
        COALESCE(e.month_period, 0)             AS month_period,
        COALESCE(e.is_settled, 0)               AS is_settled,
        COALESCE(e.anticipate_settle_days, 0)   AS anticipate_settle_days,
        COALESCE(e.late_settle_days, 0)         AS late_settle_days,
        COALESCE(e.over_due_days, 0)            AS over_due_days,
        COALESCE(e.over_due_status, 0)          AS over_due_status
    FROM entity_positions p
    LEFT JOIN events_topL e
        ON p.cust_no = e.cust_no
        AND p.anchor_time = e.anchor_time
        AND p.pos = e.event_rank
),

-- ── Step 4: 聚合为定长数组 · 每个通道一条 COLLECT_LIST ──────────
arrays AS (
    SELECT
        cust_no,
        anchor_time,
        COLLECT_LIST(days_ago)              AS seq_days_ago,
        COLLECT_LIST(loan_amt)              AS seq_loan_amt,
        COLLECT_LIST(term)                  AS seq_term,
        COLLECT_LIST(is_weekend)            AS seq_is_weekend,
        COLLECT_LIST(month_period)          AS seq_month_period,
        COLLECT_LIST(is_settled)            AS seq_is_settled,
        COLLECT_LIST(anticipate_settle_days) AS seq_anticipate_settle_days,
        COLLECT_LIST(late_settle_days)      AS seq_late_settle_days,
        COLLECT_LIST(over_due_days)         AS seq_over_due_days,
        COLLECT_LIST(over_due_status)       AS seq_over_due_status
    FROM (
        SELECT *
        FROM padded
        DISTRIBUTE BY cust_no, anchor_time   -- ⚠️ 保证同实体落同 reducer
        SORT BY cust_no, anchor_time, pos    -- ⚠️ 保证数组按 pos 有序！
    ) sorted
    GROUP BY cust_no, anchor_time
)

-- ── Step 5: 产出最终序列表（含数组） ────────────────────────────
INSERT OVERWRITE TABLE fin_dw_fk.dwt_a_card_seq_features_v1 PARTITION (recall_dt)
SELECT
    a.cust_no,
    a.time_loan                     AS anchor_time,
    a.loan_no,
    a.loan_amt                      AS current_loan_amt,
    a.term                          AS current_term,
    a.product_code,
    -- 10 个序列通道数组
    arr.seq_days_ago,
    arr.seq_loan_amt,
    arr.seq_term,
    arr.seq_is_weekend,
    arr.seq_month_period,
    arr.seq_is_settled,
    arr.seq_anticipate_settle_days,
    arr.seq_late_settle_days,
    arr.seq_over_due_days,
    arr.seq_over_due_status,
    -- 序列元信息
    SIZE(arr.seq_days_ago)          AS seq_length,          -- 恒等于 30
    CAST('{$yesterday_p}' AS STRING) AS recall_dt
FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda a
INNER JOIN users u ON u.cust_no = a.cust_no
LEFT JOIN arrays arr
    ON arr.cust_no = a.cust_no
    AND arr.anchor_time = a.time_loan
WHERE a.pday = '{$yesterday_p}'
  AND REPLACE(DATE(a.time_loan), '-', '') = a.pday
  AND a.product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI');
