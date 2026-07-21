set spark.sql.shuffle.partitions = 1000;
set spark.sql.autoBroadcastJoinThreshold=10240000; 
set spark.sql.statistics.fallBackToHdfs=true;

INSERT OVERWRITE TABLE fin_dw_fk.dwt_loan_lastime_v1 PARTITION (recall_dt)

WITH  params AS (
        SELECT
        TO_DATE('${yesterday_p}', 'yyyyMMdd') AS run_date_dt, -- '20260112'
        date_sub(TO_DATE('${yesterday_p}', 'yyyyMMdd'),366)  AS lookback_start_date, --   '2025-01-11' 
        replace(date_sub(TO_DATE('${yesterday_p}', 'yyyyMMdd'),1),'-','') AS snapshot_pday, --  '20260111' 
        replace(date_sub(TO_DATE('${yesterday_p}', 'yyyyMMdd'),2),'-','') AS sample_dt, --  '20260110' 
        date_sub(TO_DATE('${yesterday_p}', 'yyyyMMdd'),2) AS sample_date,  -- '2026-01-10'  
        30 AS seq_length
),

users as (
 select cust_no 
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda
    WHERE pday = (SELECT snapshot_pday FROM params)
    AND replace(date(time_loan),'-','') = pday
    AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
    group by 1
)
,

base_loans AS (
    SELECT
        a.cust_no,
        loan_no,
        time_loan,
        DATE(time_loan) AS loan_date,
        loan_amt,
        term,
        product_code,
        date_settle,
        loan_bal,
        HOUR(time_loan) AS borrow_hour,
        CASE WHEN DAYOFWEEK(time_loan) IN (1, 7) THEN 1 ELSE 0 END AS is_weekend,
        CASE 
            WHEN DAY(time_loan) <= 10 THEN 1
            WHEN DAY(time_loan) <= 20 THEN 2
            ELSE 3
        END AS month_period,
        if(cast(loan_bal as int) = 0, 1, 0) as is_settled,
        if(date_settle is not null and datediff(date_end, date_settle) >= 0, datediff(date_end, date_settle), 0) as anticipate_settle_days,
        if(date_settle is not null and datediff(date_end, date_settle) < 0, datediff(date_end, date_settle), 0) as late_settle_days,
        CAST(seq_no AS int) AS seq_no,
        over_due_days,
        over_due_status,
        prin_amt
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda a 
    INNER JOIN users b ON b.cust_no = a.cust_no
    WHERE pday = (SELECT sample_dt FROM params)
      AND date(time_loan) >= (SELECT lookback_start_date FROM params)
      AND date(time_loan) <= (SELECT sample_date FROM params)
      AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
),

deduct_records AS (
    SELECT
        a.cust_no, loan_no, date_tran, TO_DATE(date_tran)  AS deduct_date,
        time_tran_succ, trans_amt, tran_status, rpy_type, product_code
    FROM fin_dw_fk.dwt_trade_repay_j_ice_assist_a a 
    INNER JOIN users b ON b.cust_no = a.cust_no
    WHERE TO_DATE(date_tran) >= (SELECT lookback_start_date FROM params)
      AND TO_DATE(date_tran) <= (SELECT sample_date FROM params)
      AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
),

credit_monthly_snapshot_raw AS (
    SELECT 
        cust_no,
        pday,
        TO_DATE(pday, 'yyyyMMdd') AS snapshot_date,
        credit_amt,
        new_credit_amt,
        date_temp_amt_effective,
        date_temp_amt_expire,
        temp_amt,
        used_amt,
        ROW_NUMBER() OVER(PARTITION BY cust_no, pday ORDER BY date_created DESC) AS rnk
    FROM (
        SELECT 
            a.cust_no, pday,
            CASE WHEN TO_DATE(date_end) >= pday OR date_end IS NULL THEN credit_amt ELSE 0 END AS credit_amt,
            CASE WHEN TO_DATE(date_end) >= pday OR date_end IS NULL THEN new_credit_amt ELSE 0 END AS new_credit_amt,
            CASE WHEN TO_DATE(date_end) >= pday OR date_end IS NULL THEN date_temp_amt_effective ELSE NULL END AS date_temp_amt_effective,
            CASE WHEN TO_DATE(date_end) >= pday OR date_end IS NULL THEN date_temp_amt_expire ELSE NULL END AS date_temp_amt_expire,
            CASE WHEN TO_DATE(date_end) >= pday OR date_end IS NULL THEN temp_amt ELSE 0 END AS temp_amt,
            used_amt, date_created
        FROM fin_dw.dwd_contract_base_fzzx_info_pda a 
        INNER JOIN users b ON b.cust_no = a.cust_no
        WHERE pday >= DATE_FORMAT((SELECT lookback_start_date FROM params), 'yyyyMMdd')
          AND pday <= (SELECT sample_dt FROM params)
          AND product_code = '360BIG' 
          AND amt_type = 'C'
        
        UNION ALL
        
        SELECT 
            a.cust_no, pday, credit_amt, new_credit_amt,
            date_temp_amt_effective, date_temp_amt_expire, temp_amt,
            used_amt, date_created
        FROM fin_dw.dwd_contract_base_fzzx_info_pda a 
        INNER JOIN users b ON b.cust_no = a.cust_no
        WHERE pday >= DATE_FORMAT((SELECT lookback_start_date FROM params), 'yyyyMMdd')
          AND pday <= (SELECT sample_dt FROM params)
          AND product_code IN ('360JIETIAO','360YINGJI','360PLUS','360SME') 
          AND amt_type = 'C'
    ) merged
),

credit_monthly_snapshot AS (
    SELECT 
        cust_no,
        pday,
        snapshot_date,
        SUM(CASE 
            WHEN new_credit_amt IS NOT NULL THEN new_credit_amt 
            ELSE (CASE 
                    WHEN REPLACE(date_temp_amt_effective,'-','') <= pday 
                         AND REPLACE(date_temp_amt_expire,'-','') >= pday 
                    THEN COALESCE(temp_amt,0) 
                    ELSE 0 
                  END) + COALESCE(credit_amt,0) 
        END) AS credit_limit,
        SUM(used_amt) AS used_amt
    FROM credit_monthly_snapshot_raw
    WHERE rnk = 1
    GROUP BY cust_no, pday, snapshot_date
),

loan_with_credit AS (
    SELECT
        bl.*,
        COALESCE(cms.credit_limit, 0) AS credit_limit,
        COALESCE(cms.used_amt, 0) AS credit_used_amt_snapshot
    FROM base_loans bl
    LEFT JOIN credit_monthly_snapshot cms 
        ON bl.cust_no = cms.cust_no 
        AND DATE_FORMAT(bl.loan_date, 'yyyyMMdd') = cms.pday
),


loan_deduct_summary AS (
    SELECT
        loan_no, cust_no,
        
        -- 原有特征
        SUM(CASE WHEN tran_status = '03' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS deduct_success_rate,
        SUM(CASE WHEN tran_status = '04' THEN 1 ELSE 0 END) AS deduct_fail_count,
        
        -- ⭐ NEW: 提前还款比例（ES + RP）
        SUM(CASE WHEN rpy_type IN ('ES', 'RP') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS early_repay_ratio,
        
        -- ⭐ NEW: 主动还款比例（ES + RP + OD，排除自动批扣BT）
        SUM(CASE WHEN rpy_type IN ('ES', 'RP', 'OD') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS active_repay_ratio
        
    FROM deduct_records
    GROUP BY loan_no, cust_no
),

borrow_sequence_with_features_asc AS (
    SELECT
        lwau.cust_no,
        lwau.loan_date as loan_date,
        lwau.loan_amt,
        lwau.term,
        lwau.borrow_hour,
        
        DATEDIFF(
            lwau.loan_date,
            LAG(lwau.loan_date) OVER (PARTITION BY lwau.cust_no ORDER BY lwau.loan_date ASC)
        ) AS days_since_last_borrow,
        
        lwau.credit_limit AS credit_limit_at_borrow,
        
        lwau.over_due_days AS overdue_days,
        
        CASE 
            WHEN lwau.over_due_days <= 7 THEN 1
            WHEN lwau.over_due_days <= 30 THEN 2
            WHEN lwau.over_due_days <= 60 THEN 3
            WHEN lwau.over_due_days <= 90 THEN 4
            WHEN lwau.over_due_days > 90 THEN 5
            ELSE 0
        END AS overdue_level,
        
        CASE 
            WHEN lwau.over_due_days > 0 THEN lwau.loan_bal 
            ELSE 0 
        END AS overdue_amount,
        
        CASE 
            WHEN lwau.prin_amt > 0 THEN round((lwau.prin_amt - lwau.loan_bal) / lwau.prin_amt,4)
            ELSE 0
        END AS repay_completion_rate,
        
        CASE 
            WHEN lwau.over_due_days > 30 THEN 1
            WHEN lwau.over_due_days > 0 THEN 2
            WHEN lwau.date_settle IS NOT NULL AND lwau.date_settle != '' 
                 AND TO_DATE(lwau.date_settle) < lwau.loan_date THEN 3
            WHEN lwau.date_settle IS NULL OR lwau.date_settle = '' THEN 0
            ELSE 4
        END AS settle_pattern,
        
        COALESCE(lds.deduct_success_rate, 0) AS deduct_success_rate,
        
        -- ⭐ NEW: 提前还款次数占比
        COALESCE(lds.early_repay_ratio, 0) AS early_repay_ratio,
        
        -- ⭐ NEW: 主动还款次数占比
        COALESCE(lds.active_repay_ratio, 0) AS active_repay_ratio,
        
        lwau.is_settled,
        lwau.anticipate_settle_days,
        lwau.late_settle_days,
        lwau.seq_no,
        
        CASE 
            WHEN lwau.over_due_status IS NOT NULL AND lwau.over_due_status != '' 
            THEN lwau.prin_amt / lwau.term * CAST(REGEXP_EXTRACT(lwau.over_due_status, '[0-9]+', 0) AS INT)
            ELSE 0
        END AS overdue_amount_effective
        
    FROM loan_with_credit lwau
    LEFT JOIN loan_deduct_summary lds ON lwau.loan_no = lds.loan_no
),

borrow_sequence_top30 AS (
    SELECT *
    FROM
    (
            SELECT
            *,
            ROW_NUMBER() OVER (PARTITION BY cust_no ORDER BY loan_date DESC) AS event_rank
            FROM borrow_sequence_with_features_asc
    ) where event_rank <= (SELECT seq_length FROM params)
),


deduct_sequence_with_features AS (
    SELECT
        dr.cust_no,
        dr.deduct_date,
        dr.trans_amt,
        CASE WHEN dr.tran_status = '03' THEN 1 ELSE 0 END AS is_success,
        CASE WHEN dr.tran_status = '04' THEN 1 ELSE 0 END AS is_fail,
        
        CASE 
            WHEN dr.rpy_type = 'ES' THEN 1
            WHEN dr.rpy_type = 'BT' THEN 2
            WHEN dr.rpy_type = 'OD' THEN 3
            WHEN dr.rpy_type = 'RP' THEN 4
            ELSE 0
        END AS deduct_type,
        
        -- ⭐ NEW: 是否提前还款（ES或RP）
        CASE WHEN dr.rpy_type IN ('ES', 'RP') THEN 1 ELSE 0 END AS is_early_repay,
        
        -- ⭐ NEW: 是否主动还款（非BT批扣）
        CASE WHEN dr.rpy_type IN ('ES', 'RP', 'OD') THEN 1 ELSE 0 END AS is_active_repay,
        
        ROW_NUMBER() OVER (PARTITION BY dr.cust_no ORDER BY dr.deduct_date DESC) AS event_rank
    FROM deduct_records dr
),

deduct_sequence_top30 AS (
    SELECT * FROM deduct_sequence_with_features
    WHERE event_rank <= (SELECT seq_length FROM params)
),

seq_30 AS (
    SELECT pos
    FROM (
        SELECT EXPLODE(ARRAY(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30)) AS pos
    ) t
),

user_seq_positions AS (
    SELECT 
        au.cust_no,
        s.pos
    FROM users au
    CROSS JOIN seq_30 s
),

borrow_with_padding AS (
    SELECT
        usp.cust_no,
        usp.pos,
        COALESCE(DATE_FORMAT(bs.loan_date, 'yyyyMMdd'), 0) AS loan_date,
        COALESCE(bs.loan_amt, 0) AS loan_amt,
        COALESCE(bs.term, 0) AS loan_term,
        COALESCE(bs.borrow_hour, 0) AS loan_hour,
        COALESCE(bs.days_since_last_borrow, 0) AS days_since_last,
        COALESCE(bs.credit_limit_at_borrow, 0) AS credit_limit,
        COALESCE(bs.overdue_days, 0) AS overdue_days,
        COALESCE(bs.overdue_level, 0) AS overdue_level,
        COALESCE(bs.overdue_amount, 0) AS overdue_amount,
        COALESCE(bs.repay_completion_rate, 0) AS repay_completion,
        COALESCE(bs.settle_pattern, 0) AS settle_pattern,
        COALESCE(bs.deduct_success_rate, 0) AS loan_deduct_success_rate,
        COALESCE(bs.early_repay_ratio, 0) AS early_repay_ratio,
        COALESCE(bs.active_repay_ratio, 0) AS active_repay_ratio,
        COALESCE(bs.is_settled, 0) AS is_settled,
        COALESCE(bs.anticipate_settle_days, 0) AS anticipate_settle_days,
        COALESCE(bs.late_settle_days, 0) AS late_settle_days,
        COALESCE(bs.seq_no, 0) AS seq_no,
        COALESCE(bs.overdue_amount_effective, 0) AS overdue_amount_effective
    FROM user_seq_positions usp
    LEFT JOIN borrow_sequence_top30 bs 
        ON usp.cust_no = bs.cust_no 
        AND usp.pos = bs.event_rank
),

borrow_arrays AS (
    SELECT
        cust_no,
        COLLECT_LIST(loan_date) AS loan_date_seq,
        COLLECT_LIST(loan_amt) AS loan_amt_seq,
        COLLECT_LIST(loan_term) AS loan_term_seq,
        COLLECT_LIST(loan_hour) AS loan_hour_seq,
        COLLECT_LIST(days_since_last) AS days_since_last_seq,
        -- COLLECT_LIST(credit_usage) AS credit_usage_seq,
        COLLECT_LIST(credit_limit) AS credit_limit_seq,
        -- COLLECT_LIST(outstanding_count) AS outstanding_count_seq,
        COLLECT_LIST(overdue_days) AS overdue_days_seq,
        COLLECT_LIST(overdue_level) AS overdue_level_seq,
        COLLECT_LIST(overdue_amount) AS overdue_amount_seq,
        COLLECT_LIST(repay_completion) AS repay_completion_seq,
        COLLECT_LIST(settle_pattern) AS settle_pattern_seq,
        COLLECT_LIST(loan_deduct_success_rate) AS loan_deduct_success_rate_seq,
        COLLECT_LIST(early_repay_ratio) AS early_repay_ratio_seq,
        COLLECT_LIST(active_repay_ratio) AS active_repay_ratio_seq,
        COLLECT_LIST(is_settled) AS is_settled_seq,
        COLLECT_LIST(anticipate_settle_days) AS anticipate_settle_days_seq,
        COLLECT_LIST(late_settle_days) AS late_settle_days_seq,
        COLLECT_LIST(seq_no) AS seq_no_seq,
        COLLECT_LIST(overdue_amount_effective) AS overdue_amount_effective_seq
    FROM (
        SELECT *
        FROM borrow_with_padding
        DISTRIBUTE BY cust_no
        SORT BY cust_no, pos
    ) sorted
    GROUP BY cust_no
),

deduct_with_padding AS (
    SELECT
        usp.cust_no,
        usp.pos,
        COALESCE(DATE_FORMAT(ds.deduct_date, 'yyyyMMdd'), '0') AS deduct_date,
        COALESCE(ds.trans_amt, 0) AS deduct_amount,
        COALESCE(ds.is_success, 0) AS is_success,
        COALESCE(ds.is_fail, 0) AS is_fail,
        COALESCE(ds.deduct_type, 0) AS deduct_type,
        COALESCE(ds.is_early_repay, 0) AS is_early_repay,
        COALESCE(ds.is_active_repay, 0) AS is_active_repay
    FROM user_seq_positions usp
    LEFT JOIN deduct_sequence_top30 ds 
        ON usp.cust_no = ds.cust_no 
        AND usp.pos = ds.event_rank
),

deduct_arrays AS (
    SELECT
        cust_no,
        COLLECT_LIST(deduct_date) AS deduct_date_seq,
        COLLECT_LIST(deduct_amount) AS deduct_amount_seq,
        COLLECT_LIST(is_success) AS deduct_is_success_seq,
        COLLECT_LIST(is_fail) AS deduct_is_fail_seq,
        COLLECT_LIST(deduct_type) AS deduct_type_seq,
        COLLECT_LIST(is_early_repay) AS is_early_repay_seq,
        COLLECT_LIST(is_active_repay) AS is_active_repay_seq
    FROM (
        SELECT *
        FROM deduct_with_padding
        DISTRIBUTE BY cust_no
        SORT BY cust_no, pos
    ) sorted
    GROUP BY cust_no
)

SELECT
    au.cust_no,
    ba.loan_date_seq,
    ba.loan_amt_seq,
    ba.loan_term_seq,
    ba.loan_hour_seq,
    ba.days_since_last_seq,
    ba.credit_limit_seq,
    ba.overdue_days_seq,
    ba.overdue_level_seq,
    ba.overdue_amount_seq,
    ba.repay_completion_seq,
    ba.settle_pattern_seq,
    ba.loan_deduct_success_rate_seq,
    ba.early_repay_ratio_seq,       
    ba.active_repay_ratio_seq,     
    ba.is_settled_seq,
    ba.anticipate_settle_days_seq,
    ba.late_settle_days_seq,
    ba.seq_no_seq,
    ba.overdue_amount_effective_seq,
    da.deduct_date_seq,
    da.deduct_amount_seq,
    da.deduct_is_success_seq,
    da.deduct_is_fail_seq,
    da.deduct_type_seq,
    da.is_early_repay_seq,           
    da.is_active_repay_seq,         
    
   (SELECT snapshot_pday FROM params) AS recall_dt
    
FROM users au
LEFT JOIN borrow_arrays ba ON au.cust_no = ba.cust_no
LEFT JOIN deduct_arrays da ON au.cust_no = da.cust_no