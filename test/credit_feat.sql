set spark.sql.shuffle.partitions = 1000;
set spark.sql.autoBroadcastJoinThreshold=10240000; 
set spark.sql.statistics.fallBackToHdfs=true;

INSERT OVERWRITE TABLE fin_dw_fk.dwt_loan_acard_seq_feat_all_v1 PARTITION (ym)


with label as (
    select
        appl_no, user_no, cust_no, date_appl_submit, date_finished,
        appl_amt, is_reject, risk_price, mob1d30, mob2d30,mob3d30,
        if(is_qzx = '全资信',1,0) as is_qzx,
        is_reject,is_app_xcx,
        DATE(date_appl_submit)                        as datestr,
        DATE_FORMAT(date_appl_submit, 'yyyyMMdd')     as dt,
        DATE_FORMAT(date_appl_submit, 'yyyyMM')       as ym
        
    
    from fin_dm_data_ai.dm_acard_sample_qzx_with_label_final
    where 
      pday = '20260330'
      and DATE_FORMAT(date_appl_submit, 'yyyyMM') = DATE_FORMAT(ADD_MONTHS(FROM_UNIXTIME(UNIX_TIMESTAMP('${yesterday_p}', 'yyyyMMdd')), -1), 'yyyyMM')
),

-- 征信查询记录号 (MD5 hash 关联 HBase rowkey)
tmp_record_no as (
    select pday, user_no, md5(record_no) as record_no, actual_intf_type
    from 
    fin_dw.dwd_capcredit_cr_query_info_pdi
    -- dp_data_db.lt_table_dwd_capcredit_cr_query_info_pdi
    where pday between   CONCAT(DATE_FORMAT(ADD_MONTHS(FROM_UNIXTIME(UNIX_TIMESTAMP('${yesterday_p}', 'yyyyMMdd')), -1), 'yyyyMM'), '01')  and DATE_FORMAT(LAST_DAY(ADD_MONTHS(FROM_UNIXTIME(UNIX_TIMESTAMP('${yesterday_p}', 'yyyyMMdd')), -1)), 'yyyyMMdd')
      and actual_intf_type = 'FuZhouPbocScore'
    group by 1,2,3,4
),

-- HBase 原始征信报告
ul as (
    select rowkey, value as cf1_value, date_format(pday, 'yyyyMMdd') as pday
    from 
    hdp_credit.prd_hbase_jr_crs_fu_zhou_credit_report_raw_data
    -- dp_data_db.lt_table_prd_hbase_jr_crs_fu_zhou_credit_report_raw_data
    where pday between   CONCAT(DATE_FORMAT(ADD_MONTHS(FROM_UNIXTIME(UNIX_TIMESTAMP('${yesterday_p}', 'yyyyMMdd')), -1), 'yyyy-MM'), '-01')  and  DATE_FORMAT(LAST_DAY(ADD_MONTHS(FROM_UNIXTIME(UNIX_TIMESTAMP('${yesterday_p}', 'yyyyMMdd')), -1)), 'yyyy-MM-dd')
),

-- 关联: rowkey = md5(record_no) → cf1_value
third_info as (
    select ul.cf1_value, ul.pday, b.user_no, b.actual_intf_type
    from ul
    inner join tmp_record_no b on ul.rowkey = b.record_no
),

-- 每个用户取最近一份征信报告 (rn=1)
user_info as (
    select
        a.appl_no,a.dt, a.ym, a.user_no, a.mob1d30,a.mob2d30, a.mob3d30,a.is_qzx,
        b.cf1_value, b.actual_intf_type,a.is_reject,a.is_app_xcx,
        ROW_NUMBER() OVER (PARTITION BY a.user_no, a.dt,a.appl_no ORDER BY b.pday DESC) AS rn
    from label a
    left join third_info b on a.user_no = b.user_no and a.dt >= b.pday
),

base as (
    select * from user_info where rn = 1
),


-- #############################################################################
-- B. 序列生成器 (固定长度30)
-- #############################################################################

seq_30 as (
    select pos
    from (
        select EXPLODE(ARRAY(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30)) as pos
    ) t
),

user_seq_positions as (
    select au.user_no, au.cust_no, au.appl_no, au.datestr, au.dt, s.pos
    from label au
    cross join seq_30 s
),


-- #############################################################################
-- C1. 征信查询摘要 (直接取JSON, 8个标量)
-- #############################################################################

query_summary as (
    select
        b.user_no, b.dt,b.appl_no,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.orgSum1')           AS INT) as orgSum1,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.orgSum2')           AS INT) as orgSum2,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.recordSum1')        AS INT) as recordSum1,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.recordSum2')        AS INT) as recordSum2,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.recordSum3')        AS INT) as recordSum3,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.towYearRecordSum1') AS INT) as towYearRecordSum1,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.towYearRecordSum2') AS INT) as towYearRecordSum2,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordSummaryInfo.queryRecordSummaryInfo.towYearRecordSum3') AS INT) as towYearRecordSum3
    from base b
    where b.cf1_value is not null
),


-- #############################################################################
-- C2. 征信查询明细 (queryRecordList → explode → 聚合 + 序列)
--     queryReason: 01=贷后管理 02=贷款审批 03=信用卡审批 08=担保 16=融资 18=账户审核
-- #############################################################################

query_records as (
    select
        b.user_no, b.dt,appl_no,
        cast(q.queryOrgTypeNew as int)  as org_type,
        cast(q.queryReason as int)      as query_reason_int,
        q.queryReason                   as query_reason,
        DATEDIFF(TO_DATE(b.dt, 'yyyyMMdd'), TO_DATE(q.queryDate, 'yyyy.MM.dd')) as days_ago,
        ROW_NUMBER() OVER (PARTITION BY b.user_no, b.dt,b.appl_no ORDER BY cast(q.serialNo as int) ASC) AS event_rank
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.queryRecordList'), 'array<struct<queryDate:string,queryOrgTypeNew:string,queryReason:string,serialNo:string>>')) t as q
    where b.cf1_value is not null
),

query_feats as (
    select
        user_no, dt,appl_no,
        count(*)                                                              as query_cnt_total,
        sum(if(days_ago <= 30,  1, 0))                                        as query_cnt_1m,
        sum(if(days_ago <= 90,  1, 0))                                        as query_cnt_3m,
        sum(if(days_ago <= 180, 1, 0))                                        as query_cnt_6m,
        sum(if(query_reason in ('02','03','16') and days_ago <= 3,   1, 0))   as loan_query_3d,
        sum(if(query_reason in ('02','03','16') and days_ago <= 7,   1, 0))   as loan_query_7d,
        sum(if(query_reason in ('02','03','16') and days_ago <= 30,  1, 0))   as loan_query_1m,
        sum(if(query_reason in ('02','03','16') and days_ago <= 90,  1, 0))   as loan_query_3m,
        sum(if(query_reason in ('02','03','16') and days_ago <= 180, 1, 0))   as loan_query_6m
    from query_records
    group by user_no, dt,appl_no
),

query_records_with_padding as (
    select
        usp.user_no, usp.dt, usp.pos,usp.appl_no,
        coalesce(bs.org_type, 0)          as org_type,
        coalesce(bs.query_reason_int, 0)  as query_reason_int,
        coalesce(bs.days_ago, 0)          as days_ago
    from user_seq_positions usp
    left join query_records bs
        on usp.user_no = bs.user_no
        and usp.dt = bs.dt
        and usp.pos = bs.event_rank
        and usp.appl_no = bs.appl_no
),

query_records_array as (
    select
        user_no, dt,appl_no,
        COLLECT_LIST(org_type)          as query_org_type_seq,
        COLLECT_LIST(query_reason_int)  as query_reason_int_seq,
        COLLECT_LIST(days_ago)          as days_ago_seq
    from (
        select * from query_records_with_padding
        distribute by user_no, dt,appl_no
        sort by user_no, dt,appl_no, pos
    ) sorted
    group by user_no, dt,appl_no
),


-- #############################################################################
-- D. 授信协议 (creditAgreementInfo, 单次 explode)
--    同时供 credit_feats 和 loan_with_agreement (M3) 使用
-- #############################################################################

credit_agreements as (
    select
        b.user_no, b.dt,b.appl_no,
        cab.creditAgreementBaseInfo.agreementCode                               as agreement_no,
        REGEXP_REPLACE(cab.creditAgreementBaseInfo.bizManagerOrg, '".*', '')     as org_type,
        cab.creditAgreementBaseInfo.creditLimitPurpose                           as credit_purpose,
        CAST(cab.creditAgreementBaseInfo.creditLimit AS DOUBLE)                  as sx_limit,
        CAST(cab.creditAgreementBaseInfo.usedLimit   AS DOUBLE)                  as sx_used_limit,
        DATEDIFF(
            TO_DATE(cab.creditAgreementBaseInfo.endDate, 'yyyy.MM.dd'),
            TO_DATE(cab.creditAgreementBaseInfo.effectiveDate, 'yyyy.MM.dd')
        ) as sx_duration_days,
        TO_DATE(cab.creditAgreementBaseInfo.effectiveDate, 'yyyy.MM.dd')         as effective_date,
        TO_DATE(cab.creditAgreementBaseInfo.endDate, 'yyyy.MM.dd')               as end_date
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.creditAgreementInfo'), 'array<struct<creditAgreementBaseInfo:struct<agreementCode:string,effectiveDate:string,endDate:string,bizManagerOrg:string,creditLimitPurpose:string,creditLimit:string,usedLimit:string,currency:string>>>')) t as cab
    where b.cf1_value is not null
),

credit_feats as (
    select
        user_no, dt,appl_no,
        count(*)                                                                                       as credit_cnt,
        sum(sx_limit)                                                                                  as total_sx_limit,
        max(sx_limit)                                                                                  as max_sx_limit,
        sum(sx_used_limit)                                                                             as total_sx_used,
        sum(if(sx_limit > 0, sx_used_limit, null)) / nullif(sum(if(sx_limit > 0, sx_limit, null)), 0) as usage_ratio,
        sum(if(DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), effective_date) <= 90, 1, 0))                         as new_credit_cnt_3m
    from credit_agreements
    group by user_no, dt,appl_no
),


-- #############################################################################
-- E. 贷款账户明细 + 聚合 (loanAccountInfoList, 单次 explode)
--    同时供 loan_feats 和 loan_with_agreement (M3) 使用
--    包含 creditAgreementNo 用于关联授信协议
-- #############################################################################

loan_accounts as (
    select
        b.user_no, b.dt,b.appl_no,
        -- 关联键
        lac.loanAccountBaseInfo.creditAgreementNo                                as agreement_no,
        -- 基础信息
        REGEXP_REPLACE(lac.loanAccountBaseInfo.bizManagerOrg, '".*', '')          as org_type,
        lac.loanAccountBaseInfo.accountType                                       as account_type,
        lac.loanAccountBaseInfo.jointlyFlag                                       as jointly_flag,
        lac.loanAccountBaseInfo.rpyType                                           as rpy_type,
        lac.loanAccountBaseInfo.bizType                                           as biz_type,
        lac.loanAccountBaseInfo.guaranteeType                                     as guarantee_type,
        lac.loanAccountBaseInfo.rpyFrequency                                      as rpy_freq,
        CAST(lac.loanAccountBaseInfo.rpyTerm AS INT)                              as rpy_term,
        CAST(lac.loanAccountBaseInfo.creditLimit AS DOUBLE)                       as credit_limit,
        CAST(lac.loanAccountBaseInfo.loanAmount AS DOUBLE)                        as loan_amount,
        TO_DATE(lac.loanAccountBaseInfo.openDate, 'yyyy.MM.dd')                   as open_date,
        TO_DATE(lac.loanAccountBaseInfo.endDate, 'yyyy.MM.dd')                    as end_date,
        -- 最近1月表现
        lac.last1MonthPerformanceInfo.class5State                                 as class5_state,
        CAST(lac.last1MonthPerformanceInfo.balance AS DOUBLE)                     as balance,
        CAST(lac.last1MonthPerformanceInfo.actualRpyAmount AS DOUBLE)             as actual_rpy_amount,
        CAST(lac.last1MonthPerformanceInfo.billingAmount AS DOUBLE)               as billing_amount,
        CAST(lac.last1MonthPerformanceInfo.currOverdueAmountSum AS DOUBLE)        as curr_overdue_amount,
        CAST(lac.last1MonthPerformanceInfo.currOverdueCyc AS INT)                 as curr_overdue_cyc,
        CAST(lac.last1MonthPerformanceInfo.overdue31To60Amount AS DOUBLE)         as overdue_31_60,
        CAST(lac.last1MonthPerformanceInfo.overdue61To90Amount AS DOUBLE)         as overdue_61_90,
        CAST(lac.last1MonthPerformanceInfo.overdue91To180Amount AS DOUBLE)        as overdue_91_180,
        CAST(lac.last1MonthPerformanceInfo.overdue180UnpaidBalance AS DOUBLE)     as overdue_180_plus,
        CAST(lac.last1MonthPerformanceInfo.residueRpyTerm AS INT)                 as residue_rpy_term,
        -- 最终表现
        lac.lastPerformanceInfo.accountState                                      as account_state,
        TO_DATE(lac.lastPerformanceInfo.closeDate, 'yyyy.MM.dd')                  as close_date,
        TO_DATE(lac.lastPerformanceInfo.lastRpyDate, 'yyyy.MM.dd')                as last_rpy_date
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.loanAccountInfoList'), 'array<struct<loanAccountBaseInfo:struct<creditAgreementNo:string,bizManagerOrg:string,accountType:string,bizType:string,guaranteeType:string,rpyFrequency:string,creditLimit:string,loanAmount:string,currency:string,openDate:string,endDate:string,jointlyFlag:string,rpyType:string,rpyTerm:string>,lastPerformanceInfo:struct<accountState:string,closeDate:string,lastRpyDate:string>,last1MonthPerformanceInfo:struct<class5State:string,balance:string,actualRpyAmount:string,billingAmount:string,currOverdueAmountSum:string,currOverdueCyc:string,billingDate:string,residueRpyTerm:string,overdue31To60Amount:string,overdue61To90Amount:string,overdue91To180Amount:string,overdue180UnpaidBalance:string>>>')) t as lac
    where b.cf1_value is not null
      and lac.loanAccountBaseInfo.accountType is not null
),

loan_feats as (
    select user_no, dt,appl_no,

        -- 1. 基础统计
        count(*)                                                                    as loan_cnt,
        sum(credit_limit)                                                           as total_credit_limit,
        sum(loan_amount)                                                            as total_loan_amount,
        sum(balance)                                                                as total_balance,
        sum(billing_amount)                                                         as total_billing_amount,
        sum(actual_rpy_amount)                                                      as total_actual_rpy,
        sum(curr_overdue_amount)                                                    as total_curr_overdue,
        max(curr_overdue_cyc)                                                       as max_overdue_cyc,
        sum(coalesce(overdue_31_60,0) + coalesce(overdue_61_90,0)
            + coalesce(overdue_91_180,0) + coalesce(overdue_180_plus,0))            as total_overdue_by_bucket,

        -- 2. 共借 & 担保 (2=抵押 3=信用 4=保证 5=质押 9=其他)
        sum(if(jointly_flag = '1', 1, 0))          as jointly_loan_cnt,
        sum(if(guarantee_type = '3', 1, 0))        as guarantee_credit_cnt,
        sum(if(guarantee_type = '4', 1, 0))        as guarantee_guarantor_cnt,
        sum(if(guarantee_type = '2', 1, 0))        as guarantee_collateral_cnt,
        sum(if(guarantee_type = '5', 1, 0))        as guarantee_pledge_cnt,
        sum(if(guarantee_type = '9', 1, 0))        as guarantee_other_cnt,

        -- 3. 账龄
        max(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date))                            as max_acct_age_days,
        min(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date))                            as min_acct_age_days,
        avg(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date))                            as avg_acct_age_days,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 90,  1, 0))           as new_acct_3m,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 180, 1, 0))           as new_acct_6m,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 365, 1, 0))           as new_acct_12m,

        -- 4. 还款类型 (1x=等额 2x=等本 3x=按期还息 90=一次性)
        sum(if(rpy_type like '1%', 1, 0))          as rpy_type_equal_payment_cnt,
        sum(if(rpy_type like '2%', 1, 0))          as rpy_type_equal_principal_cnt,
        sum(if(rpy_type like '3%', 1, 0))          as rpy_type_periodic_cnt,
        sum(if(rpy_type = '90',    1, 0))          as rpy_type_lumpsum_cnt,
        sum(if(rpy_type is null,   1, 0))          as rpy_type_null_cnt,

        -- 5. 期限结构
        max(rpy_term)                               as max_rpy_term,
        min(rpy_term)                               as min_rpy_term,
        avg(rpy_term)                               as avg_rpy_term,
        sum(if(rpy_term <= 6,  1, 0))               as short_term_cnt,
        sum(if(rpy_term between 7 and 24, 1, 0))    as mid_term_cnt,
        sum(if(rpy_term > 24, 1, 0))                as long_term_cnt,

        -- 6. 机构分布
        count(distinct org_type)                     as org_type_cnt,
        sum(if(org_type like '%银行%',     1, 0))    as org_bank_cnt,
        sum(if(org_type like '%消费金融%', 1, 0))    as org_consumer_fin_cnt,
        sum(if(org_type like '%小额贷款%', 1, 0))    as org_microloan_cnt,

        -- 7. 业务类型 (91=其他个人 81=消费 41=信用卡 21=住房 11=经营 82=消费分期)
        sum(if(biz_type = '91', 1, 0))              as biz_91_cnt,
        sum(if(biz_type = '81', 1, 0))              as biz_81_cnt,
        sum(if(biz_type = '99', 1, 0))              as biz_99_cnt,
        sum(if(biz_type = '21', 1, 0))              as biz_21_cnt,
        sum(if(biz_type = '11', 1, 0))              as biz_11_cnt,
        sum(if(biz_type = '41', 1, 0))              as biz_41_cnt,
        sum(if(biz_type = '82', 1, 0))              as biz_82_cnt,
        sum(if(biz_type not in ('91','81','99','21','11','41','82'), 1, 0)) as biz_other_cnt,

        -- 8. 负债结构 & 集中度
        max(loan_amount) / nullif(sum(loan_amount), 0)   as max_loan_concentration,
        max(balance)     / nullif(sum(balance), 0)        as max_balance_concentration,
        sum(balance)     / nullif(sum(loan_amount), 0)    as balance_to_loan_ratio,
        sum(if(balance > 0, 1, 0))                        as has_balance_cnt,
        sum(if(balance > 0, 1, 0)) / count(*)             as has_balance_ratio,

        -- 9. 还款行为
        sum(actual_rpy_amount) / nullif(sum(billing_amount), 0)                   as rpy_to_billing_ratio,
        sum(if(actual_rpy_amount >= billing_amount and billing_amount > 0, 1, 0)) as full_rpy_acct_cnt,
        sum(if(actual_rpy_amount <  billing_amount and billing_amount > 0, 1, 0)) as under_rpy_acct_cnt,

        -- 10. 逾期深度
        sum(if(curr_overdue_cyc > 0, 1, 0))             as has_overdue_cyc_cnt,
        sum(if(curr_overdue_cyc is not null, 1, 0))      as has_overdue_cyc_reported_cnt,
        sum(if(curr_overdue_cyc >= 1, 1, 0))             as overdue_1plus_cnt,
        sum(if(curr_overdue_cyc >= 3, 1, 0))             as overdue_3plus_cnt,
        sum(if(curr_overdue_cyc >= 6, 1, 0))             as overdue_6plus_cnt,
        sum(if(overdue_180_plus > 0,  1, 0))             as overdue_180plus_acct_cnt,

        -- 11. 五级分类 (实际值: 正常/null)
        sum(if(class5_state = '正常', 1, 0))             as class5_normal_cnt,
        sum(if(class5_state is null,  1, 0))             as class5_null_cnt,

        -- 12. 新开户负债金额
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 90,  loan_amount, 0)) as new_loan_amt_3m,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 180, loan_amount, 0)) as new_loan_amt_6m,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 90,  balance, 0))     as new_balance_3m,
        sum(if(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), open_date) <= 180, balance, 0))     as new_balance_6m,

        -- 13. 账户状态 (1=活跃 3=结清 4=转出 6=呆账)
        sum(if(account_state = '1', 1, 0))               as acct_active_cnt,
        sum(if(account_state = '3', 1, 0))               as acct_closed_cnt,
        sum(if(account_state = '4', 1, 0))               as acct_transferred_cnt,
        sum(if(account_state = '6', 1, 0))               as acct_bad_debt_cnt,

        -- 14. 剩余期数压力
        sum(residue_rpy_term)                                        as sum_remaining_terms,
        max(residue_rpy_term)                                        as max_remaining_terms,
        avg(residue_rpy_term)                                        as avg_remaining_terms,
        sum(coalesce(balance,0) * coalesce(residue_rpy_term, 0))     as weighted_balance_by_term,
        sum(balance) / nullif(sum(residue_rpy_term), 0)              as approx_monthly_payment,

        -- 15. 最近还款
        min(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), last_rpy_date))         as days_since_last_rpy_min,
        max(DATEDIFF(TO_DATE(dt,'yyyyMMdd'), last_rpy_date))         as days_since_last_rpy_max,

        -- 16. 合同到期压力 (仅活跃账户)
        sum(if(account_state = '1' and DATEDIFF(end_date, TO_DATE(dt,'yyyyMMdd')) between 0 and 180, 1, 0)) as maturing_6m_cnt,
        sum(if(account_state = '1' and DATEDIFF(end_date, TO_DATE(dt,'yyyyMMdd')) between 0 and 365, 1, 0)) as maturing_12m_cnt,

        -- 17. 活跃账户专项
        sum(if(account_state = '1', balance, 0))                     as active_total_balance,
        sum(if(account_state = '1', loan_amount, 0))                 as active_total_loan_amount,
        sum(if(account_state = '1' and class5_state != '正常', 1, 0))
            / nullif(sum(if(account_state = '1', 1, 0)), 0)         as active_non_normal_ratio,
        sum(if(account_state = '3', 1, 0)) / nullif(count(*), 0)    as closed_acct_ratio,
        sum(if(account_state = '6', balance, 0))                     as bad_debt_balance

    from loan_accounts
    group by user_no, dt,appl_no
),


-- #############################################################################
-- F. 5年还款序列 (last5YearHisPerformanceInfo → 按月聚合 → 长度30)
--    rpyState 实际值: N=正常, *=未知, C=结清, #=未知
--    overdueAmountSum: 逾期金额 (rpy_state无数字编码, 用金额判断逾期)
-- #############################################################################

rpy_5yr_exploded as (
    select
        b.user_no, b.dt,b.appl_no,
        perf.month      as perf_month,
        perf.rpyState   as rpy_state,
        CAST(perf.overdueAmountSum AS DOUBLE) as overdue_amount
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.loanAccountInfoList'), 'array<struct<last5YearHisPerformanceInfo:array<struct<month:string,rpyState:string,overdueAmountSum:string>>>>')) t as lac
    lateral view explode(lac.last5YearHisPerformanceInfo) t2 as perf
    where b.cf1_value is not null
      and perf.month is not null
),

rpy_5yr_monthly_agg as (
    select
        user_no, dt, perf_month,appl_no,
        -- 距申请日的月数
        MONTHS_BETWEEN(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(concat(perf_month, '01'), 'yyyyMMdd')) as months_ago,
        count(*)                            as acct_cnt,
        sum(if(rpy_state = 'N', 1, 0))     as cnt_N,
        sum(if(rpy_state = '*', 1, 0))     as cnt_star,
        sum(if(rpy_state = 'C', 1, 0))     as cnt_C,
        sum(if(rpy_state = '#', 1, 0))     as cnt_hash,
        sum(if(rpy_state = 'N', 1, 0)) / count(*) as normal_ratio,
        sum(if(rpy_state = 'C', 1, 0)) / count(*) as close_ratio,
        sum(coalesce(overdue_amount, 0))        as sum_overdue_amount,
        max(coalesce(overdue_amount, 0))        as max_overdue_amount,
        sum(if(overdue_amount > 0, 1, 0))       as overdue_acct_cnt,
        sum(if(overdue_amount > 0, 1, 0)) / count(*) as overdue_ratio
    from rpy_5yr_exploded
    group by user_no, dt, appl_no,perf_month
),

rpy_5yr_ranked as (
    select *,
        ROW_NUMBER() OVER (PARTITION BY user_no, dt,appl_no ORDER BY perf_month DESC) as month_rank
    from rpy_5yr_monthly_agg
),

rpy_5yr_with_padding as (
    select
        usp.user_no, usp.dt, usp.appl_no,usp.pos,
        coalesce(cast(r.months_ago as int), -1)    as months_ago,
        coalesce(r.acct_cnt,            0)         as acct_cnt,
        coalesce(r.cnt_N,               0)         as cnt_N,
        coalesce(r.cnt_star,            0)         as cnt_star,
        coalesce(r.cnt_C,               0)         as cnt_C,
        coalesce(r.cnt_hash,            0)         as cnt_hash,
        round(coalesce(r.normal_ratio,  0), 4)     as normal_ratio,
        round(coalesce(r.close_ratio,   0), 4)     as close_ratio,
        coalesce(r.sum_overdue_amount,  0)         as sum_overdue_amount,
        coalesce(r.max_overdue_amount,  0)         as max_overdue_amount,
        coalesce(r.overdue_acct_cnt,    0)         as overdue_acct_cnt,
        round(coalesce(r.overdue_ratio, 0), 4)     as overdue_ratio
    from user_seq_positions usp
    left join rpy_5yr_ranked r
        on usp.user_no = r.user_no
        and usp.dt = r.dt
        and usp.appl_no = r.appl_no
        and usp.pos = r.month_rank
),

rpy_5yr_seq as (
    select
        user_no, dt,appl_no,
        COLLECT_LIST(months_ago)         as seq_rpy_months_ago,
        COLLECT_LIST(acct_cnt)           as seq_rpy_acct_cnt,
        COLLECT_LIST(cnt_N)              as seq_rpy_cnt_N,
        COLLECT_LIST(cnt_star)           as seq_rpy_cnt_star,
        COLLECT_LIST(cnt_C)              as seq_rpy_cnt_C,
        COLLECT_LIST(cnt_hash)           as seq_rpy_cnt_hash,
        COLLECT_LIST(normal_ratio)       as seq_rpy_normal_ratio,
        COLLECT_LIST(close_ratio)        as seq_rpy_close_ratio,
        COLLECT_LIST(sum_overdue_amount) as seq_rpy_sum_overdue_amt,
        COLLECT_LIST(max_overdue_amount) as seq_rpy_max_overdue_amt,
        COLLECT_LIST(overdue_acct_cnt)   as seq_rpy_overdue_acct_cnt,
        COLLECT_LIST(overdue_ratio)      as seq_rpy_overdue_ratio
    from (
        select * from rpy_5yr_with_padding
        distribute by user_no, dt,appl_no
        sort by user_no, dt, appl_no,pos
    ) sorted
    group by user_no, dt,appl_no
),


-- #############################################################################
-- G. 5年逾期历史聚合 (复用 rpy_5yr_exploded, 无需重复 explode)
-- #############################################################################

overdue_feats as (
    select
        user_no, dt,appl_no,
        count(*)                                    as total_perf_months,
        sum(if(overdue_amount > 0, 1, 0))           as overdue_months_cnt,
        max(overdue_amount)                          as max_overdue_amount,
        sum(coalesce(overdue_amount, 0))             as total_overdue_5yr,
        sum(if(rpy_state not in ('N','C','/','*','#') and rpy_state is not null and rpy_state != '', 1, 0)) as bad_rpy_months_5yr,
        max(if(perf_month >= DATE_FORMAT(ADD_MONTHS(TO_DATE(dt,'yyyyMMdd'), -12), 'yyyy.MM'), overdue_amount, 0)) as max_overdue_amt_12m,
        sum(if(perf_month >= DATE_FORMAT(ADD_MONTHS(TO_DATE(dt,'yyyyMMdd'), -6), 'yyyy.MM') and overdue_amount > 0, 1, 0)) as overdue_cnt_6m
    from rpy_5yr_exploded
    group by user_no, dt,appl_no
),


-- #############################################################################
-- H. 信贷交易摘要 + 提示 (creditTransactionInfoSummaryInfo)
-- #############################################################################

credit_tips_records as (
    select
        b.user_no, b.dt,appl_no,
        tip.bizType                    as biz_type,
        tip.bizSubclass                as biz_subclass,
        CAST(tip.accountCount AS INT)  as account_count,
        tip.firstOpenMonth             as first_open_month
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.creditLoanTradeTipsInfo'), 'array<struct<bizType:string,bizSubclass:string,accountCount:string,firstOpenMonth:string>>')) t as tip
    where b.cf1_value is not null
),

credit_tips_feats as (
    select user_no, dt, appl_no,
        sum(if(biz_type = '1', coalesce(account_count, 0), 0))      as tips_loan_account_cnt,
        sum(if(biz_type = '2', coalesce(account_count, 0), 0))      as tips_card_account_cnt,
        sum(if(biz_type = '9', coalesce(account_count, 0), 0))      as tips_other_account_cnt,
        sum(coalesce(account_count, 0))                              as tips_total_account_cnt,
        sum(if(biz_subclass = '11', coalesce(account_count, 0), 0)) as tips_11_cnt,
        sum(if(biz_subclass = '12', coalesce(account_count, 0), 0)) as tips_12_cnt,
        sum(if(biz_subclass = '19', coalesce(account_count, 0), 0)) as tips_19_cnt,
        sum(if(biz_subclass = '21', coalesce(account_count, 0), 0)) as tips_21_cnt,
        sum(if(biz_subclass = '22', coalesce(account_count, 0), 0)) as tips_22_cnt,
        min(first_open_month)                                        as tips_first_open_month,
        DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(concat(min(first_open_month), '.01'), 'yyyy.MM.dd')) as credit_history_days,
        count(distinct biz_type)                                     as tips_biz_type_cnt,
        count(distinct biz_subclass)                                 as tips_biz_subclass_cnt
    from credit_tips_records
    group by user_no, dt, appl_no
),

credit_txn_summary as (
    select
        b.user_no, b.dt,appl_no,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.cyclicalLoanAccountInfo.accountCount')              AS INT)    as cyclic_account_cnt,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.cyclicalLoanAccountInfo.balance')                   AS DOUBLE) as cyclic_balance,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.cyclicalLoanAccountInfo.creditLimit')               AS DOUBLE) as cyclic_credit_limit,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.cyclicalLoanAccountInfo.latest6MonthUsedAvgAmount') AS DOUBLE) as cyclic_6m_avg_used,
        CAST(GET_JSON_OBJECT(b.cf1_value, '$.creditTransactionInfoSummaryInfo.cyclicalLoanAccountInfo.managerOrgCount')           AS INT)    as cyclic_manager_org_cnt
    from base b
    where b.cf1_value is not null
),

credit_txn_feats as (
    select
        a.user_no, a.dt,a.appl_no,
        coalesce(a.cyclic_account_cnt,     0)                                as cyclic_account_cnt,
        coalesce(a.cyclic_balance,         0)                                as cyclic_balance,
        coalesce(a.cyclic_credit_limit,    0)                                as cyclic_credit_limit,
        coalesce(a.cyclic_6m_avg_used,     0)                                as cyclic_6m_avg_used,
        coalesce(a.cyclic_manager_org_cnt, 0)                                as cyclic_manager_org_cnt,
        a.cyclic_balance / nullif(a.cyclic_credit_limit, 0)                  as cyclic_usage_ratio,
        a.cyclic_6m_avg_used / nullif(a.cyclic_credit_limit, 0)              as cyclic_6m_usage_intensity,
        coalesce(b.tips_loan_account_cnt,  0)                                as tips_loan_account_cnt,
        coalesce(b.tips_card_account_cnt,  0)                                as tips_card_account_cnt,
        coalesce(b.tips_other_account_cnt, 0)                                as tips_other_account_cnt,
        coalesce(b.tips_total_account_cnt, 0)                                as tips_total_account_cnt,
        coalesce(b.tips_11_cnt,            0)                                as tips_11_cnt,
        coalesce(b.tips_12_cnt,            0)                                as tips_12_cnt,
        coalesce(b.tips_19_cnt,            0)                                as tips_19_cnt,
        coalesce(b.tips_21_cnt,            0)                                as tips_21_cnt,
        coalesce(b.tips_22_cnt,            0)                                as tips_22_cnt,
        coalesce(b.tips_biz_type_cnt,      0)                                as tips_biz_type_cnt,
        coalesce(b.tips_biz_subclass_cnt,  0)                                as tips_biz_subclass_cnt,
        DATEDIFF(TO_DATE(a.dt, 'yyyyMMdd'), TO_DATE(concat(b.tips_first_open_month, '.01'), 'yyyy.MM.dd')) as credit_history_days,
        MONTHS_BETWEEN(TO_DATE(a.dt, 'yyyyMMdd'), TO_DATE(concat(b.tips_first_open_month, '.01'), 'yyyy.MM.dd')) as credit_history_months,
        a.cyclic_account_cnt / nullif(b.tips_total_account_cnt, 0)           as cyclic_account_ratio,
        a.cyclic_manager_org_cnt / nullif(a.cyclic_account_cnt, 0)           as cyclic_org_per_account
    from credit_txn_summary a
    left join credit_tips_feats b on a.user_no = b.user_no and a.dt = b.dt and a.appl_no = b.appl_no
),


-- #############################################################################
-- I. 个人身份信息 (identityInfo)
-- #############################################################################

identity_base as (
    select
        b.user_no, b.dt,appl_no,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.birthday')    as birthday,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.eduDegree')   as edu_degree,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.eduLevel')    as edu_level,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.gender')      as gender,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.maritalState') as marital_state,
        GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.identityBaseInfo.workStatus')  as work_status
    from base b
    where b.cf1_value is not null
),

identity_feats as (
    select
        user_no, dt, appl_no,
        DATE_FORMAT(TO_DATE(birthday,'yyyy.MM.dd'), 'yyyyMMdd')  birthday,
        FLOOR(DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(birthday, 'yyyy.MM.dd')) / 365.25) as age,
        MONTH(TO_DATE(birthday, 'yyyy.MM.dd'))  as birth_month,
        gender,
        case marital_state when '10' then 1 when '20' then 2 when '--' then 0 else 0 end as marital_state_num,
        case work_status when '13' then 1 when '17' then 2 when '90' then 3 else 0 end as work_status_num,
        case edu_level when '20' then 1 when '60' then 2 when '91' then 3 when '--' then 0 else 0 end as edu_level_num,
        case edu_degree when '5' then 1 else 0 end as edu_degree_num
    from identity_base
),


-- #############################################################################
-- J. 手机号信息 (identityInfo.mobileList)
-- #############################################################################

mobile_records as (
    select
        b.user_no, b.dt,appl_no,
        mob.mobileNo as mobile_no,
        mob.getTime  as get_time
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.identityInfo.mobileList'), 'array<struct<mobileNo:string,getTime:string>>')) t as mob
    where b.cf1_value is not null
),

mobile_feats as (
    select user_no, dt, appl_no,
        count(*)                  as mobile_cnt,
        count(distinct mobile_no) as mobile_distinct_cnt,
        DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(min(get_time), 'yyyy.MM.dd')) as mobile_earliest_days,
        DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(max(get_time), 'yyyy.MM.dd')) as mobile_latest_days
    from mobile_records
    group by user_no, dt, appl_no
),


-- #############################################################################
-- K. 居住信息 (residenceInfoList)
--    residenceType: 1=自置, 11=按揭, 5=其他, null=缺失
-- #############################################################################

residence_records as (
    select
        b.user_no, b.dt,b.appl_no,
        res.residenceType as residence_type,
        res.getTime       as get_time
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.residenceInfoList'), 'array<struct<residenceType:string,getTime:string>>')) t as res
    where b.cf1_value is not null
),

residence_feats as (
    select user_no, dt, appl_no,
        count(*)                       as residence_cnt,
        count(distinct residence_type) as residence_type_cnt,
        DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(max(get_time), 'yyyy.MM.dd')) as residence_latest_days,
        sum(if(residence_type = '1',   1, 0)) as residence_self_cnt,
        sum(if(residence_type = '11',  1, 0)) as residence_mortgage_cnt,
        sum(if(residence_type = '5',   1, 0)) as residence_other_cnt,
        sum(if(residence_type is null, 1, 0)) as residence_null_cnt
    from residence_records
    group by user_no, dt, appl_no
),


-- #############################################################################
-- L. 职业信息 (professionalInfoList)
--    companyNature: 40=私企, null=缺失
--    duty: 1, 3, null | industry: O, D, --
-- #############################################################################

professional_records as (
    select
        b.user_no, b.dt,b.appl_no,
        prof.companyNature as company_nature,
        prof.duty          as duty,
        prof.industry      as industry,
        prof.getTime       as get_time,
        ROW_NUMBER() OVER (PARTITION BY b.user_no, b.dt,b.appl_no ORDER BY prof.getTime DESC) as rn
    from base b
    lateral view explode(FROM_JSON(GET_JSON_OBJECT(b.cf1_value, '$.professionalInfoList'), 'array<struct<companyNature:string,duty:string,industry:string,getTime:string>>')) t as prof
    where b.cf1_value is not null
),

professional_feats as (
    select user_no, dt, appl_no,
        max(if(rn = 1, company_nature, null)) as latest_company_nature,
        max(if(rn = 1, duty, null))           as latest_duty,
        max(if(rn = 1, industry, null))       as latest_industry,
        max(if(rn = 1, get_time, null))       as latest_prof_time,
        DATEDIFF(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(max(if(rn = 1, get_time, null)), 'yyyy-MM-dd')) as latest_prof_days,
        count(*)                       as prof_record_cnt,
        count(distinct company_nature) as prof_nature_cnt,
        count(distinct industry)       as prof_industry_cnt,
        sum(if(company_nature = '40', 1, 0))   as nature_private_cnt,
        sum(if(company_nature is null, 1, 0))  as nature_null_cnt
    from professional_records
    group by user_no, dt, appl_no
),


-- #############################################################################
-- M. 借款序列 (loan_accounts LEFT JOIN credit_agreements)
--    通过 agreement_no 关联, 按 openDate DESC 排序, 固定长度30,最新的靠前
--    复用 E(loan_accounts) 和 D(credit_agreements), 无需重复 explode
-- #############################################################################

loan_with_agreement as (
    select
        l.user_no, l.dt, l.appl_no, l.open_date,
        l.account_type, l.biz_type, l.guarantee_type, l.rpy_type, l.rpy_term,l.rpy_freq,
        l.org_type, l.account_state, l.balance, l.curr_overdue_amount,
        l.residue_rpy_term, l.class5_state,
        l.credit_limit as loan_credit_limit, l.loan_amount, l.end_date as loan_end_date,
        a.sx_limit, a.sx_used_limit, a.credit_purpose,
        a.effective_date as sx_effective_date, a.end_date as sx_end_date,
        coalesce(l.loan_amount, l.credit_limit)                                  as amount,
        DATEDIFF(TO_DATE(l.dt, 'yyyyMMdd'), l.open_date)                         as acct_age_days,
        DATEDIFF(l.end_date, TO_DATE(l.dt, 'yyyyMMdd'))                          as remaining_days,
        l.balance / nullif(coalesce(a.sx_limit, l.credit_limit), 0)              as single_usage_ratio,

        -- MONTHS_BETWEEN(TO_DATE(dt, 'yyyyMMdd'), TO_DATE(concat(perf_month, '01'), 'yyyyMMdd')) as months_ago,
        ROW_NUMBER() OVER (PARTITION BY l.user_no, l.dt, l.appl_no ORDER BY l.open_date DESC) as loan_rank
    from loan_accounts l
    left join credit_agreements a
        on l.user_no = a.user_no
        and l.dt = a.dt
        and l.appl_no = a.appl_no
        and l.agreement_no = a.agreement_no
),

loan_seq_with_padding as (
    select
        usp.user_no, usp.dt, usp.appl_no, usp.pos,
        coalesce(r.amount,              0) as amount,
        coalesce(r.loan_amount,         0) as loan_amount,
        coalesce(r.loan_credit_limit,   0) as loan_credit_limit,
        coalesce(r.balance,             0) as balance,
        coalesce(r.curr_overdue_amount, 0) as curr_overdue_amount,
        coalesce(r.sx_limit,            0) as sx_limit,
        coalesce(r.sx_used_limit,       0) as sx_used_limit,
        coalesce(r.rpy_term,            0) as rpy_term,
        coalesce(r.residue_rpy_term,    0) as residue_rpy_term,
        coalesce(r.acct_age_days,       0) as acct_age_days,
        coalesce(r.remaining_days,      0) as remaining_days,
        round(coalesce(r.single_usage_ratio, 0), 4) as single_usage_ratio,
        coalesce(cast(r.biz_type as int),       0) as biz_type,
        coalesce(cast(r.guarantee_type as int),  0) as guarantee_type,
        coalesce(cast(r.account_state as int),   0) as account_state,
        coalesce(cast(r.rpy_type as int),        0) as rpy_type,
        coalesce(cast(r.rpy_freq as int),        0) as rpy_freq,
        coalesce(cast(r.credit_purpose as int),        0) as credit_purpose,

        if(r.class5_state = '正常', 1, 0)           as is_normal
    from user_seq_positions usp
    left join loan_with_agreement r
        on usp.user_no = r.user_no
        and usp.dt = r.dt
        and usp.appl_no = r.appl_no
        and usp.pos = r.loan_rank
),

loan_seq_array as (
    select
        user_no, dt, appl_no,
        COLLECT_LIST(amount)              as seq_loan_amount,
        COLLECT_LIST(loan_amount)         as seq_loan_raw_amount,
        COLLECT_LIST(loan_credit_limit)   as seq_loan_credit_limit,
        COLLECT_LIST(balance)             as seq_loan_balance,
        COLLECT_LIST(curr_overdue_amount) as seq_loan_curr_overdue,
        COLLECT_LIST(sx_limit)            as seq_loan_sx_limit,
        COLLECT_LIST(sx_used_limit)       as seq_loan_sx_used,
        COLLECT_LIST(rpy_term)            as seq_loan_rpy_term,
        COLLECT_LIST(residue_rpy_term)    as seq_loan_residue_term,
        COLLECT_LIST(acct_age_days)       as seq_loan_acct_age,
        COLLECT_LIST(remaining_days)      as seq_loan_remaining_days,
        COLLECT_LIST(single_usage_ratio)  as seq_loan_usage_ratio,
        COLLECT_LIST(biz_type)            as seq_loan_biz_type,
        COLLECT_LIST(guarantee_type)      as seq_loan_guarantee_type,
        COLLECT_LIST(account_state)       as seq_loan_account_state,
        COLLECT_LIST(rpy_type)            as seq_loan_rpy_type,
        COLLECT_LIST(rpy_freq)            as seq_loan_rpy_freq,
        COLLECT_LIST(credit_purpose)            as seq_loan_credit_purpose,

        COLLECT_LIST(is_normal)           as seq_loan_is_normal
    from (
        select * from loan_seq_with_padding
        distribute by user_no, dt, appl_no
        sort by user_no, dt, appl_no, pos
    ) sorted
    group by user_no, dt, appl_no
)


-- #############################################################################
-- 最终输出: 标量特征 + 序列特征
-- #############################################################################

select
    b.appl_no,
    b.dt,
    b.user_no,
    b.is_qzx,
    b.is_reject,
    b.is_app_xcx,
    b.mob1d30,
    b.mob2d30,
    b.mob3d30,

     -- I. 个人身份信息 (7)
     coalesce(idf.birthday,                0) as birthday,
    coalesce(idf.age,                0) as age,
    coalesce(idf.birth_month,        0) as birth_month,
    idf.gender,
    coalesce(idf.marital_state_num,  0) as marital_state_num,
    coalesce(idf.work_status_num,    0) as work_status_num,
    coalesce(idf.edu_level_num,      0) as edu_level_num,
    coalesce(idf.edu_degree_num,     0) as edu_degree_num,

    -- C1. 征信查询摘要 (8)
    coalesce(qs.orgSum1,           0) as orgSum1,
    coalesce(qs.orgSum2,           0) as orgSum2,
    coalesce(qs.recordSum1,        0) as recordSum1,
    coalesce(qs.recordSum2,        0) as recordSum2,
    coalesce(qs.recordSum3,        0) as recordSum3,
    coalesce(qs.towYearRecordSum1, 0) as towYearRecordSum1,
    coalesce(qs.towYearRecordSum2, 0) as towYearRecordSum2,
    coalesce(qs.towYearRecordSum3, 0) as towYearRecordSum3,

    -- C2a. 征信查询聚合 (9)
    coalesce(qf.query_cnt_total, 0) as query_cnt_total,
    coalesce(qf.query_cnt_1m,    0) as query_cnt_1m,
    coalesce(qf.query_cnt_3m,    0) as query_cnt_3m,
    coalesce(qf.query_cnt_6m,    0) as query_cnt_6m,
    coalesce(qf.loan_query_3d,   0) as loan_query_3d,
    coalesce(qf.loan_query_7d,   0) as loan_query_7d,
    coalesce(qf.loan_query_1m,   0) as loan_query_1m,
    coalesce(qf.loan_query_3m,   0) as loan_query_3m,
    coalesce(qf.loan_query_6m,   0) as loan_query_6m,

    -- D. 授信协议 (6)
    coalesce(cf.credit_cnt,        0) as credit_cnt,
    coalesce(cf.total_sx_limit,    0) as total_sx_limit,
    coalesce(cf.max_sx_limit,      0) as max_sx_limit,
    coalesce(cf.total_sx_used,     0) as total_sx_used,
    round(cf.usage_ratio,          4) as usage_ratio,
    coalesce(cf.new_credit_cnt_3m, 0) as new_credit_cnt_3m,

    -- E. 贷款账户聚合 (70+)
    coalesce(lf.loan_cnt,                0) as loan_cnt,
    coalesce(lf.total_credit_limit,      0) as total_credit_limit,
    coalesce(lf.total_loan_amount,       0) as total_loan_amount,
    coalesce(lf.total_balance,           0) as total_balance,
    coalesce(lf.total_billing_amount,    0) as total_billing_amount,
    coalesce(lf.total_actual_rpy,        0) as total_actual_rpy,
    coalesce(lf.total_curr_overdue,      0) as total_curr_overdue,
    coalesce(lf.max_overdue_cyc,         0) as max_overdue_cyc,
    coalesce(lf.total_overdue_by_bucket, 0) as total_overdue_by_bucket,
    coalesce(lf.jointly_loan_cnt,          0) as jointly_loan_cnt,
    coalesce(lf.guarantee_credit_cnt,      0) as guarantee_credit_cnt,
    coalesce(lf.guarantee_guarantor_cnt,   0) as guarantee_guarantor_cnt,
    coalesce(lf.guarantee_collateral_cnt,  0) as guarantee_collateral_cnt,
    coalesce(lf.guarantee_pledge_cnt,      0) as guarantee_pledge_cnt,
    coalesce(lf.guarantee_other_cnt,       0) as guarantee_other_cnt,
    coalesce(lf.max_acct_age_days,  0) as max_acct_age_days,
    coalesce(lf.min_acct_age_days,  0) as min_acct_age_days,
    round(lf.avg_acct_age_days,     2) as avg_acct_age_days,
    coalesce(lf.new_acct_3m,        0) as new_acct_3m,
    coalesce(lf.new_acct_6m,        0) as new_acct_6m,
    coalesce(lf.new_acct_12m,       0) as new_acct_12m,
    coalesce(lf.rpy_type_equal_payment_cnt,   0) as rpy_type_equal_payment_cnt,
    coalesce(lf.rpy_type_equal_principal_cnt, 0) as rpy_type_equal_principal_cnt,
    coalesce(lf.rpy_type_periodic_cnt,        0) as rpy_type_periodic_cnt,
    coalesce(lf.rpy_type_lumpsum_cnt,         0) as rpy_type_lumpsum_cnt,
    coalesce(lf.rpy_type_null_cnt,            0) as rpy_type_null_cnt,
    coalesce(lf.max_rpy_term,    0) as max_rpy_term,
    coalesce(lf.min_rpy_term,    0) as min_rpy_term,
    round(lf.avg_rpy_term,       2) as avg_rpy_term,
    coalesce(lf.short_term_cnt,  0) as short_term_cnt,
    coalesce(lf.mid_term_cnt,    0) as mid_term_cnt,
    coalesce(lf.long_term_cnt,   0) as long_term_cnt,
    coalesce(lf.org_type_cnt,         0) as org_type_cnt,
    coalesce(lf.org_bank_cnt,         0) as org_bank_cnt,
    coalesce(lf.org_consumer_fin_cnt, 0) as org_consumer_fin_cnt,
    coalesce(lf.org_microloan_cnt,    0) as org_microloan_cnt,
    coalesce(lf.biz_91_cnt, 0) as biz_91_cnt,
    coalesce(lf.biz_81_cnt, 0) as biz_81_cnt,
    coalesce(lf.biz_99_cnt, 0) as biz_99_cnt,
    coalesce(lf.biz_21_cnt, 0) as biz_21_cnt,
    coalesce(lf.biz_11_cnt, 0) as biz_11_cnt,
    coalesce(lf.biz_41_cnt, 0) as biz_41_cnt,
    coalesce(lf.biz_82_cnt, 0) as biz_82_cnt,
    coalesce(lf.biz_other_cnt, 0) as biz_other_cnt,
    round(lf.max_loan_concentration,    4) as max_loan_concentration,
    round(lf.max_balance_concentration, 4) as max_balance_concentration,
    round(lf.balance_to_loan_ratio,     4) as balance_to_loan_ratio,
    coalesce(lf.has_balance_cnt,        0) as has_balance_cnt,
    round(lf.has_balance_ratio,         4) as has_balance_ratio,
    round(lf.rpy_to_billing_ratio,      4) as rpy_to_billing_ratio,
    coalesce(lf.full_rpy_acct_cnt,      0) as full_rpy_acct_cnt,
    coalesce(lf.under_rpy_acct_cnt,     0) as under_rpy_acct_cnt,
    coalesce(lf.has_overdue_cyc_cnt,          0) as has_overdue_cyc_cnt,
    coalesce(lf.has_overdue_cyc_reported_cnt, 0) as has_overdue_cyc_reported_cnt,
    coalesce(lf.overdue_1plus_cnt,            0) as overdue_1plus_cnt,
    coalesce(lf.overdue_3plus_cnt,            0) as overdue_3plus_cnt,
    coalesce(lf.overdue_6plus_cnt,            0) as overdue_6plus_cnt,
    coalesce(lf.overdue_180plus_acct_cnt,     0) as overdue_180plus_acct_cnt,
    coalesce(lf.class5_normal_cnt, 0) as class5_normal_cnt,
    coalesce(lf.class5_null_cnt,   0) as class5_null_cnt,
    coalesce(lf.new_loan_amt_3m,  0) as new_loan_amt_3m,
    coalesce(lf.new_loan_amt_6m,  0) as new_loan_amt_6m,
    coalesce(lf.new_balance_3m,   0) as new_balance_3m,
    coalesce(lf.new_balance_6m,   0) as new_balance_6m,
    coalesce(lf.acct_active_cnt,      0) as acct_active_cnt,
    coalesce(lf.acct_closed_cnt,      0) as acct_closed_cnt,
    coalesce(lf.acct_transferred_cnt, 0) as acct_transferred_cnt,
    coalesce(lf.acct_bad_debt_cnt,    0) as acct_bad_debt_cnt,
    coalesce(lf.sum_remaining_terms,      0) as sum_remaining_terms,
    coalesce(lf.max_remaining_terms,      0) as max_remaining_terms,
    round(lf.avg_remaining_terms,         2) as avg_remaining_terms,
    coalesce(lf.weighted_balance_by_term, 0) as weighted_balance_by_term,
    round(lf.approx_monthly_payment,      2) as approx_monthly_payment,
    coalesce(lf.days_since_last_rpy_min, 0) as days_since_last_rpy_min,
    coalesce(lf.days_since_last_rpy_max, 0) as days_since_last_rpy_max,
    coalesce(lf.maturing_6m_cnt,  0) as maturing_6m_cnt,
    coalesce(lf.maturing_12m_cnt, 0) as maturing_12m_cnt,
    coalesce(lf.active_total_balance,     0) as active_total_balance,
    coalesce(lf.active_total_loan_amount, 0) as active_total_loan_amount,
    round(lf.active_non_normal_ratio,     4) as active_non_normal_ratio,
    round(lf.closed_acct_ratio,           4) as closed_acct_ratio,
    coalesce(lf.bad_debt_balance,         0) as bad_debt_balance,

    -- G. 5年逾期历史聚合 (7)
    coalesce(of2.total_perf_months,   0) as total_perf_months,
    coalesce(of2.overdue_months_cnt,  0) as overdue_months_cnt,
    coalesce(of2.max_overdue_amount,  0) as max_overdue_amount,
    coalesce(of2.total_overdue_5yr,   0) as total_overdue_5yr,
    coalesce(of2.bad_rpy_months_5yr,  0) as bad_rpy_months_5yr,
    coalesce(of2.max_overdue_amt_12m, 0) as max_overdue_amt_12m,
    coalesce(of2.overdue_cnt_6m,      0) as overdue_cnt_6m,

    -- H. 信贷交易摘要 + 提示 (22)
    coalesce(ctf.cyclic_account_cnt,      0)    as cyclic_account_cnt,
    coalesce(ctf.cyclic_balance,          0)    as cyclic_balance,
    coalesce(ctf.cyclic_credit_limit,     0)    as cyclic_credit_limit,
    coalesce(ctf.cyclic_6m_avg_used,      0)    as cyclic_6m_avg_used,
    coalesce(ctf.cyclic_manager_org_cnt,  0)    as cyclic_manager_org_cnt,
    round(ctf.cyclic_usage_ratio,         4)    as cyclic_usage_ratio,
    round(ctf.cyclic_6m_usage_intensity,  4)    as cyclic_6m_usage_intensity,
    coalesce(ctf.tips_loan_account_cnt,   0)    as tips_loan_account_cnt,
    coalesce(ctf.tips_card_account_cnt,   0)    as tips_card_account_cnt,
    coalesce(ctf.tips_other_account_cnt,  0)    as tips_other_account_cnt,
    coalesce(ctf.tips_total_account_cnt,  0)    as tips_total_account_cnt,
    coalesce(ctf.tips_11_cnt,             0)    as tips_11_cnt,
    coalesce(ctf.tips_12_cnt,             0)    as tips_12_cnt,
    coalesce(ctf.tips_19_cnt,             0)    as tips_19_cnt,
    coalesce(ctf.tips_21_cnt,             0)    as tips_21_cnt,
    coalesce(ctf.tips_22_cnt,             0)    as tips_22_cnt,
    coalesce(ctf.tips_biz_type_cnt,       0)    as tips_biz_type_cnt,
    coalesce(ctf.tips_biz_subclass_cnt,   0)    as tips_biz_subclass_cnt,
    coalesce(ctf.credit_history_days,     0)    as credit_history_days,
    round(ctf.credit_history_months,      1)    as credit_history_months,
    round(ctf.cyclic_account_ratio,       4)    as cyclic_account_ratio,
    round(ctf.cyclic_org_per_account,     4)    as cyclic_org_per_account,



    -- J. 手机号信息 (4)
    coalesce(mf.mobile_cnt,          0) as mobile_cnt,
    coalesce(mf.mobile_distinct_cnt, 0) as mobile_distinct_cnt,
    coalesce(mf.mobile_earliest_days,0) as mobile_earliest_days,
    coalesce(mf.mobile_latest_days,  0) as mobile_latest_days,

    -- K. 居住信息 (7)
    coalesce(rsf.residence_cnt,         0) as residence_cnt,
    coalesce(rsf.residence_type_cnt,    0) as residence_type_cnt,
    coalesce(rsf.residence_latest_days, 0) as residence_latest_days,
    coalesce(rsf.residence_self_cnt,    0) as residence_self_cnt,
    coalesce(rsf.residence_mortgage_cnt,0) as residence_mortgage_cnt,
    coalesce(rsf.residence_other_cnt,   0) as residence_other_cnt,
    coalesce(rsf.residence_null_cnt,    0) as residence_null_cnt,

    -- L. 职业信息 (10)
    prf.latest_company_nature,
    prf.latest_duty,
    prf.latest_industry,
    coalesce(prf.latest_prof_days,   0) as latest_prof_days,
    coalesce(prf.prof_record_cnt,    0) as prof_record_cnt,
    coalesce(prf.prof_nature_cnt,    0) as prof_nature_cnt,
    coalesce(prf.prof_industry_cnt,  0) as prof_industry_cnt,
    coalesce(prf.nature_private_cnt, 0) as nature_private_cnt,
    coalesce(prf.nature_null_cnt,    0) as nature_null_cnt,

    -- =========================================================================
    -- 序列特征区 (全部集中在最后, 3组序列各长度30)
    -- =========================================================================

    -- C2b. 查询序列 (按serialNo升序)
    qra.query_org_type_seq,
    qra.query_reason_int_seq,
    qra.days_ago_seq,

    -- F. 还款序列 (按月份倒序, pos=1=最近)
    rs.seq_rpy_months_ago,
    rs.seq_rpy_cnt_N,
    rs.seq_rpy_cnt_star,
    rs.seq_rpy_cnt_C,
    rs.seq_rpy_cnt_hash,
    rs.seq_rpy_normal_ratio,
    rs.seq_rpy_close_ratio,
    rs.seq_rpy_sum_overdue_amt,
    rs.seq_rpy_max_overdue_amt,
    rs.seq_rpy_overdue_acct_cnt,
    rs.seq_rpy_overdue_ratio,

    -- M. 借款序列 (按openDate升序, pos=1=最早)
    lsa.seq_loan_amount,
    lsa.seq_loan_raw_amount,
    lsa.seq_loan_credit_limit,
    lsa.seq_loan_balance,
    lsa.seq_loan_curr_overdue,
    lsa.seq_loan_sx_limit,
    lsa.seq_loan_sx_used,
    lsa.seq_loan_rpy_term,
    lsa.seq_loan_residue_term,
    lsa.seq_loan_acct_age,
    lsa.seq_loan_remaining_days,
    lsa.seq_loan_usage_ratio,
    lsa.seq_loan_biz_type,
    lsa.seq_loan_guarantee_type,
    lsa.seq_loan_account_state,
    lsa.seq_loan_rpy_type,
    lsa.seq_loan_rpy_freq,
    lsa.seq_loan_credit_purpose,
    lsa.seq_loan_is_normal,

    b.ym

from base b
left join query_summary       qs  on b.user_no = qs.user_no  and b.dt = qs.dt and b.appl_no = qs.appl_no
left join query_feats         qf  on b.user_no = qf.user_no  and b.dt = qf.dt and b.appl_no = qf.appl_no
left join query_records_array qra on b.user_no = qra.user_no and b.dt = qra.dt and b.appl_no = qra.appl_no
left join credit_feats        cf  on b.user_no = cf.user_no  and b.dt = cf.dt and b.appl_no = cf.appl_no
left join loan_feats          lf  on b.user_no = lf.user_no  and b.dt = lf.dt and b.appl_no = lf.appl_no
left join rpy_5yr_seq         rs  on b.user_no = rs.user_no  and b.dt = rs.dt and b.appl_no = rs.appl_no
left join overdue_feats       of2 on b.user_no = of2.user_no and b.dt = of2.dt and b.appl_no = of2.appl_no
left join credit_txn_feats    ctf on b.user_no = ctf.user_no and b.dt = ctf.dt and b.appl_no = ctf.appl_no
left join identity_feats      idf on b.user_no = idf.user_no and b.dt = idf.dt and b.appl_no = idf.appl_no
left join mobile_feats        mf  on b.user_no = mf.user_no  and b.dt = mf.dt and b.appl_no = mf.appl_no
left join residence_feats     rsf on b.user_no = rsf.user_no and b.dt = rsf.dt and b.appl_no = rsf.appl_no
left join professional_feats  prf on b.user_no = prf.user_no and b.dt = prf.dt and b.appl_no = prf.appl_no
left join loan_seq_array      lsa on b.user_no = lsa.user_no and b.dt = lsa.dt and b.appl_no = lsa.appl_no ;
