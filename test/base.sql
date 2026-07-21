INSERT OVERWRITE TABLE fin_dw_fk.dwt_loan_lastime_v1 PARTITION (recall_dt)

WITH 
users as (
 select cust_no 
    FROM fin_dw_fk.dwt_trade_loan_j_ice_assist_pda
    WHERE pday = '{$yesterday_p}'
    AND replace(date(time_loan),'-','') = pday
    AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
    group by 1
)
,

base_loans AS ( -- 借款
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
    WHERE pday ='{$yesterday_p}'
      AND date(time_loan) >=  ...
      AND date(time_loan) <= ...
      AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
),

deduct_records AS ( -- 扣款
    SELECT
        a.cust_no, loan_no, date_tran, TO_DATE(date_tran)  AS deduct_date,
        time_tran_succ, trans_amt, tran_status, rpy_type, product_code
    FROM fin_dw_fk.dwt_trade_repay_j_ice_assist_a a 
    INNER JOIN users b ON b.cust_no = a.cust_no
    WHERE TO_DATE(date_tran) >= (SELECT lookback_start_date FROM params)
      AND TO_DATE(date_tran) <= (SELECT sample_date FROM params)
      AND product_code IN ('360JIETIAO', '360JINXIAO', '360BIG', '360YINGJI')
)