# EFF 特征完整目录

> 共 366 个特征，其中 82 个精确匹配，284 个规则推理

---

## 301快照_内部_画像(基础)_客户信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilebase_cust_age` | 年龄 | ~ |

## 301快照_内部_画像(通讯录及关系网)_小网变量输入项  (11个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_socialbook_callhasedurate2` | 通话关系关联有学历用户占比_2层 | ✓ |
| `credit_inner_profilesocial_socialbook_calllevel2citycnt2` | 通话关联二线城市用户数_2层 | ~ |
| `credit_inner_profilesocial_socialbook_callpassedusersp18avgcreditamt2` | 通话关联18期授信通过用户平均授信金额_2层 | ~ |
| `credit_inner_profilesocial_socialbook_calllowqualityusersrate2` | 通话关联低质量用户占比_2层 | ~ |
| `credit_inner_profilesocial_socialbook_callavgage1` | 通话关联平均年龄_1层 | ~ |
| `credit_inner_profilesocial_socialbook_callpassedusersavgcreditamt2` | 通话关联授信通过用户平均授信金额_2层 | ~ |
| `credit_inner_profilesocial_socialbook_callappluserscntin30day2` | 近30天通话关联App用户数_2层 | ~ |
| `credit_inner_profilesocial_socialbook_callhasflightrate2` | 通话关系关联有航旅用户占比_2层 | ✓ |
| `credit_inner_profilesocial_socialbook_callhasedurate1` | 通话关联有学历用户占比_1层 | ~ |
| `credit_inner_profilesocial_socialbook_callwifiuserrate2` | 通话关联WiFi用户占比_2层 | ~ |
| `credit_inner_profilesocial_socialbook_callpassedusersp36avgcreditamt2` | 通话关联36期授信通过用户平均授信金额_2层 | ~ |

## 301快照_内部_画像(通讯录及关系网)_用户关系网信息  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_userrelationinfo_relationfinish1num` | 设备通讯录备注的完件客户数 | ✓ |
| `credit_inner_profilesocial_userrelationinfo_finishmaxnotmgm` | 最高非MGM完件用户 | ~ |
| `credit_inner_profilesocial_userrelationinfo_suspectedgamblecountd2` | 疑似赌博 | ~ |

## 301快照_内部_画像(通讯录及关系网)_通讯录敏感词反匹配  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_contactmatchedblack_othercontactreverseremarkcount` | 其他联系人反向备注数 | ~ |

## 301快照_内部_画像(通讯录及关系网)_通讯录特征输入项加工  (2个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_contactbooklistprocessor_ratiocontactxn` | 通讯录中移动号占比 | ~ |
| `credit_inner_profilesocial_contactbooklistprocessor_ratiocontactzj` | 通讯录中座机号占比 | ✓ |

## 301快照_内部_画像(通讯录及关系网)_通话记录  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_callrecord_calledtimeslatestonemonth` | 最近第一月被叫次数 | ✓ |
| `credit_inner_profilesocial_callrecord_mobilenoamountlatestonemonth` | 最近一月通话手机号码数 | ✓ |
| `credit_inner_profilesocial_callrecord_contact1calledtimes` | 被叫次数 | ~ |

## 301快照_内部_画像(通讯录及关系网)_通话记录_电话黄页  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_profilesocial_callrordyellowpage_late180dnocnt` | 近180天不重复电话号码数 | ~ |

## 301快照_内部_设备_申请位置信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_device_applyposition_ipcity` | IP所在城市 | ~ |

## 301快照_内部_设备_设备信息_申请  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `credit_inner_device_applydevice_spaceallunitg` | 总空间(G) | ~ |

## 701快照_内部_画像(基础)_临时额度信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_temporaryamtinfo_temporaryamt` | 临时额度 | ~ |

## 701快照_内部_画像(基础)_借款信息  (5个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_draw_drawhisrjnum` | 历史拒绝借款数 | ~ |
| `draw_inner_profilebase_draw_drawamt` | 借款金额 | ~ |
| `draw_inner_profilebase_draw_drawterm` | 借款期数 | ~ |
| `draw_inner_profilebase_draw_loginnum` | 登录次数 | ~ |
| `draw_inner_profilebase_draw_drawsuccnum` | 历史成功借款数 | ~ |

## 701快照_内部_画像(基础)_借款列表比率  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_drawlistratio_notsettleloanamtratio` | 未结清借据金额占比 | ~ |

## 701快照_内部_画像(基础)_借款失败详情  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_detailofloanfailure_rejectcnt24hour` | 24小时内拒绝次数 | ~ |

## 701快照_内部_画像(基础)_学生标签  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_studentflag_studentflageducationapp` | 教育app学生标记 | ~ |

## 701快照_内部_画像(基础)_客户信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_cust_age` | 年龄 | ✓ |

## 701快照_内部_画像(基础)_客户申请历史  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_custapplyhistory_loanamtclear` | 历史结清贷款金额 | ~ |

## 701快照_内部_画像(基础)_客户贷款列表结果  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_custloanlistresult_amtloan24hour` | 距离当前借款24小时内借款成功且放款成功借据的借款金额(实时） | ✓ |

## 701快照_内部_画像(基础)_征信授信信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_zxapcreditinfo_zxcreditapvrj` | 征信授信拒绝 | ~ |

## 701快照_内部_画像(基础)_贷前历史信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_preloanhistoryinfo_historyoverduesettleloantermnum13` | 历史逾期后结清期数1-3 | ~ |

## 701快照_内部_画像(基础)_贷后信息  (12个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilebase_postloan_usableamt` | 可用额度 | ~ |
| `draw_inner_profilebase_postloan_quotausage` | 额度使用率 | ✓ |
| `draw_inner_profilebase_postloan_jtoccupyamt` | 借条占用金额 | ~ |
| `draw_inner_profilebase_postloan_drawfailtimes` | 借款失败次数 | ~ |
| `draw_inner_profilebase_postloan_repaytimes` | 还款次数 | ~ |
| `draw_inner_profilebase_postloan_beforedraw100dsettleduesumterm` | 距离当前借款前100天内到期结清总期数 | ✓ |
| `draw_inner_profilebase_postloan_longtimeunmovedays` | 长期未变动天数 | ~ |
| `draw_inner_profilebase_postloan_creditamt` | 授信额度 | ~ |
| `draw_inner_profilebase_postloan_usedamt` | 已用额度(本产品) | ~ |
| `draw_inner_profilebase_postloan_mob` | 贷龄(月) | ~ |
| `draw_inner_profilebase_postloan_usedamtall` | 已用额度(全产品) | ~ |
| `draw_inner_profilebase_postloan_alltranfailcnt` | 全部交易失败次数 | ~ |

## 701快照_内部_画像(通讯录及关系网)_关联信息  (8个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_relation_ammatchcmmaxoverdueday` | 申请手机号匹配存量联系人最大逾期天数 | ~ |
| `draw_inner_profilesocial_relation_cmmatchamrecordnum` | 存量联系人匹配申请手机号记录数 | ~ |
| `draw_inner_profilesocial_relation_cmmatchbmoverdueamount` | 存量联系人匹配B端逾期金额 | ~ |
| `draw_inner_profilesocial_relation_ammatchcmoverdueamount` | 申请手机号匹配存量联系人逾期金额 | ~ |
| `draw_inner_profilesocial_relation_cmmatchcmoverdueday` | 存量联系人匹配存量联系人逾期天数 | ~ |
| `draw_inner_profilesocial_relation_ammatchcmrecordnum` | 申请手机号匹配存量联系人手机号记录数 | ✓ |
| `draw_inner_profilesocial_relation_bigommatchbmoverdueday` | 大O系统匹配B端最大逾期天数 | ~ |
| `draw_inner_profilesocial_relation_cmmatchcmoverdueamount` | 存量联系人匹配存量联系人逾期金额 | ~ |

## 701快照_内部_画像(通讯录及关系网)_反向通讯录身份校验  (2个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_revcontactverify_otherrvscontactcntnamelast` | 其他联系人反备注数-含姓氏 | ~ |
| `draw_inner_profilesocial_revcontactverify_otherrvscontactcnttot` | 其他联系人反备注总数 | ~ |

## 701快照_内部_画像(通讯录及关系网)_客户通话记录联系人关联关系  (5个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_custcallcontactrelative_callrecordrelatecontrolcallcount` | 通话记录关联被管控用户通话次数 | ~ |
| `draw_inner_profilesocial_custcallcontactrelative_contactrecordrelatecontrolusercount` | 通讯录关联被管控用户数 | ~ |
| `draw_inner_profilesocial_custcallcontactrelative_contactrecordrelatehistorydef90moreusercount` | 通讯录关联历史最大逾期90+天用户数 | ✓ |
| `draw_inner_profilesocial_custcallcontactrelative_callrecordrelatereject12mcallcount` | 通话记录关联近12月拒绝用户通话次数 | ~ |
| `draw_inner_profilesocial_custcallcontactrelative_callrecordrelatereject12musercount` | 通话记录关联近12月拒绝用户数 | ~ |

## 701快照_内部_画像(通讯录及关系网)_用户关系网信息  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_userrelationinfo_pyramidsalecountd2` | 传销 | ~ |

## 701快照_内部_画像(通讯录及关系网)_通讯录  (2个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_contact_maxsameparagraphcount` | 最大同号段联系人数 | ~ |
| `draw_inner_profilesocial_contact_contactnum` | 通讯录电话数量 | ✓ |

## 701快照_内部_画像(通讯录及关系网)_通讯录敏感词反匹配  (2个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_contactmatchedblack_othercontactreverseremarkcount` | 其他联系人反向备注数 | ~ |
| `draw_inner_profilesocial_contactmatchedblack_urgentcontactreverseremarkcount` | 紧急联系人反向备注数 | ~ |

## 701快照_内部_画像(通讯录及关系网)_通话记录  (5个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_callrecord_calledtimeslatestweek` | 近一周被叫次数 | ✓ |
| `draw_inner_profilesocial_callrecord_calledtimeslatestonemonth` | 最近第一月被叫次数 | ✓ |
| `draw_inner_profilesocial_callrecord_latest30dayhadcontractscalltimes` | 近30天通话记录中有通讯录电话的通话次数 | ✓ |
| `draw_inner_profilesocial_callrecord_mobilenoamountlatestonemonth` | 手机号码数 | ~ |
| `draw_inner_profilesocial_callrecord_mobilenocallmostlatestonemonth` | 最近一个月通话次数最多的手机号通话次数 | ✓ |

## 701快照_内部_画像(通讯录及关系网)_通话记录_电话黄页  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_profilesocial_callrordyellowpage_agentvalidoutperiodsumin90dyp` | 90天内有效代理商外呼时长 | ~ |

## 701快照_内部_设备_app分类新  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_device_appclassnew_goodhabitnum` | 良好习惯app数 | ~ |
| `draw_inner_device_appclassnew_chuxingbadnum` | 出行类高风险app数 | ~ |
| `draw_inner_device_appclassnew_deltahabitnum` | 习惯变化app数 | ~ |

## 701快照_内部_设备_app按类型衍生  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_device_app_appnumnewinstall1m` | appnumnewinstall1m | ~ |

## 701快照_内部_设备_app最近安装  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_device_applast_findjoblast120day` | 近120天求职app数 | ~ |
| `draw_inner_device_applast_findjoblast90day` | 近90天求职app数 | ~ |
| `draw_inner_device_applast_datingappnum` | 交友app数 | ~ |

## 701快照_内部_设备_借款位置信息  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_device_drawposition_lbsrelateusernum` | LBS关联用户数 | ~ |
| `draw_inner_device_drawposition_lbslongitude` | GPS经度 | ~ |
| `draw_inner_device_drawposition_lbslatitude` | GPS纬度 | ~ |

## 701快照_内部_设备_设备信息（借款）(deviceInfo)  (4个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `draw_inner_device_drawdevice_spaceallunitg` | 总空间_单位G | ✓ |
| `draw_inner_device_drawdevice_timeintervalshippingtoapply` | 收货到申请时间间隔 | ~ |
| `draw_inner_device_drawdevice_spaceusedunitg` | 已使用空间_单位G | ✓ |
| `draw_inner_device_drawdevice_contactoverlapradio` | 通讯录重叠比率 | ~ |

## 离线_内外部_行为比对  (1个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_innerouter_jtvspboc_creditamt_creditamtcompare_12m` | 近12月借条vs央行征信额度比对 | ~ |

## 离线_内部_App_APP指数  (11个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_app_appindex_avg5_jr_wovd1_180gt7d` | 180gt7d | ~ |
| `offline_inner_app_appindex_max_jr_wovd6_360gt30d` | 360gt30d | ~ |
| `offline_inner_app_appindex_max6_r_wovd1_360gt30d` | 360gt30d | ~ |
| `offline_inner_app_appindex_max6_r_wovd1_180gt7d` | 180gt7d | ~ |
| `offline_inner_app_appindex_avg4_jr_wovd1_360gt30d` | 360gt30d | ~ |
| `offline_inner_app_appindex_max6_r_wovd3_180gt30d` | 180gt30d | ~ |
| `offline_inner_app_appindex_max6_jr_wovd1_360gt30d` | 360gt30d | ~ |
| `offline_inner_app_appindex_avg5_r_wovd1_180gt30d` | 180gt30d | ~ |
| `offline_inner_app_appindex_avg4_jr_wovd1_180gt7d` | 180天窗口期安装数量1千-1万首逾7+借条产品平均风险指数 | ✓ |
| `offline_inner_app_appindex_avg4_r_wovd1_180gt7d` | 180天窗口期安装数量1千-1万首逾7+平均风险指数 | ✓ |
| `offline_inner_app_appindex_max6_jr_wovd3_180gt30d` | 180gt30d | ~ |

## 离线_内部_app_appindex2期  (18个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_app_appindex2_avg_flag_w180d_ovdgt3d_ascrank_top2000ratio` | 180天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w180d_ovdgt3d_ascrank_top1500ratio` | 180天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_appr_final_amt_ascrank_top1000ratio` | 授信户授信金额均值正序1000的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt3d_ascrank_top2000ratio` | 90天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_appr_final_amt_ascrank_top2000ratio` | 授信户授信金额均值正序2000的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_appr_final_amt_descrank_top1000ratio` | 授信户授信金额均值倒序1000的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt3d_descrank_top2000ratio` | 90天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_appr_final_amt_descrank_top500ratio` | 授信户授信金额均值倒序500的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_appr_final_amt_ascrank_top1500ratio` | 授信户授信金额均值正序1500的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_appr_final_amt_descrank_top1500ratio` | 授信户授信金额均值倒序1500的app占比 | ✓ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt3d_ascrank_top1500ratio` | 90天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt3d_ascrank_top1000ratio` | 90天窗口逾期>3天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt15d_ascrank_top1500ratio` | 90天窗口逾期>15天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt15d_ascrank_top2000ratio` | 90天窗口逾期>15天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w180d_ovdgt7d_descrank_top1500ratio` | 180天窗口逾期>7天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w90d_ovdgt30d_ascrank_top2000ratio` | 90天窗口逾期>30天 | ~ |
| `offline_inner_app_appindex2_avg_flag_w180d_ovdgt15d_ascrank_top2000cnt` | 180天窗口逾期>15天 | ~ |
| `offline_inner_app_appindex2_avg_appr_final_amt_descrank_top2000ratio` | 授信户授信金额均值倒序 | ~ |

## 离线_内部_位置_LBS地理信息  (10个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_location_lbs_nearyear_q2_distance_m` | 近一年活动距离中位数(米) | ~ |
| `offline_inner_location_lbs_nearyear_q2_lag_distance_m` | 近一年相邻两次距离差中位数(米) | ~ |
| `offline_inner_location_lbs_nearyear_max_visit_city_num_ratio` | 近一年最大访问城市数占比 | ~ |
| `offline_inner_location_lbs_nearyear_q3_distance_m` | 近一年活动距离75分位(米) | ~ |
| `offline_inner_location_lbs_nearyear_q1_distance_m` | 近一年活动距离25分位(米) | ~ |
| `offline_inner_location_lbs_nearyear_max_visit_area_num_ratio` | 近一年最大活动区域数占比 | ~ |
| `offline_inner_location_lbs_near6m_q2_lag_distance_m` | 近6个月相邻两次距离差中位数(米) | ~ |
| `offline_inner_location_lbs_nearyear_q3_lag_distance_m` | 近一年相邻两次距离差75分位(米) | ~ |
| `offline_inner_location_lbs_near6m_max_visit_area_num_ratio` | 近6个月最大活动区域数占比 | ~ |
| `offline_inner_location_lbs_near6m_q2_distance_m` | 近6个月活动距离中位数(米) | ~ |

## 离线_内部_借条贷中行为_novip还款  (5个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_noviprepay_before1mpayfailedamtratio` | 近1月扣款失败金额占比[失败金额/(失败金额+成功金额)] | ✓ |
| `offline_inner_jtbeh_noviprepay_before6mo6mpaysucamt` | 近6月/前6月novip扣款成功金额 | ~ |
| `offline_inner_jtbeh_noviprepay_before6mo6mpayfailedamt` | 近6月/前6月novip扣款失败金额 | ~ |
| `offline_inner_jtbeh_noviprepay_before3mo12mrpytypesucodnum` | 近3月/近12月提前一次性结清成功次数 | ~ |
| `offline_inner_jtbeh_noviprepay_before1mpayfailedratio` | 近1月novip扣款失败占比 | ~ |

## 离线_内部_借条贷中行为_借据粒度单笔额度使用率  (31个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m12mcredituseratetotalavgratio` | 近1月单笔发起后的平均总额度使用率/近12月单笔发起后的平均总额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw3m12mcredituseratetotalavgratio` | 近3月单笔发起后的平均总额度使用率/近12月单笔发起后的平均总额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcredituseratetotalavg` | 历史单笔发起后的平均总额度使用率（(draw_amt+NVL(nosettlebeforedraw,0))/new_credit_amt） | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m12mcreditriskuseratetotalavgratio` | 近1月单笔发起后的平均总风控额度使用率/近12月单笔发起后的平均总风控额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc6m12mcredituseratetotalavgratio` | 近6月/近12月成功单笔平均总额度使用率比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc1m12mcredituseratetotalavgratio` | 近1月单笔成功发起后的平均总额度使用率/近12月单笔成功发起后的平均总额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcredituseratetotal0910cntratio` | 历史单笔发起后的总额度使用率在(0.9,1.0]的笔数占比 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m6mcredituseratetotalmaxratio` | 近1月/近6月单笔最大总额度使用率比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc3mcredituseratetotalmin` | 近3月成功单笔最小总额度使用率 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m12mcreditriskuserateavgratio` | 近1月单笔发起时的平均剩余风控额度使用率/近12月单笔发起时的平均剩余风控额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcredituseratetotal0204cntratio` | 历史单笔发起后的总额度使用率在(0.2,0.4]的笔数占比 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucccredituseratetotalavg` | 历史单笔成功发起后的平均总额度使用率（(draw_amt+NVL(nosettlebeforedraw,0))/new_credit_amt） | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcreditriskuseratetotalavg` | 历史单笔发起后的平均总风控额度使用率（(draw_amt+NVL(nosettlebeforedraw,0))/new_credit_amt） | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucccreditriskuseratetotalavg` | 历史成功单笔平均总风控额度使用率 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcreditriskuseratetotal0204cntratio` | 历史单笔发起后的总风控额度使用率在(0.2,0.4]的笔数占比 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m6mcreditriskuseratetotalmaxratio` | 近1月/近6月单笔最大总风控额度使用率比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m12mcreditriskuseratetotalmaxratio` | 近1月单笔发起后的最大总风控额度使用率/近12月单笔发起后的最大总风控额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m6mcreditriskuseratemaxratio` | 近1月/近6月单笔最大剩余风控额度使用率比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucccreditriskuseratetotal0204cntratio` | 历史成功单笔总风控额度使用率在(0.2,0.4]占比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc1m12mcreditriskuseratetotalavgratio` | 近1月单笔成功发起后的平均总风控额度使用率/近12月单笔成功发起后的平均总风控额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc6mcredituseratetotalmin` | 近6月成功单笔最小总额度使用率 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw3m12mcreditriskuserateavgratio` | 近3月单笔发起时的平均剩余风控额度使用率/近12月单笔发起时的平均剩余风控额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucccredituseratetotal0002cnt` | 历史成功单笔总额度使用率在[0,0.2]笔数 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1mo12mcredituserateavg` | 近1月/近12月单笔平均剩余额度使用率 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1mcreditriskuseratetotalmin` | 近1月单笔最小总风控额度使用率 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcredituseratetotal0002cnt` | 历史单笔总额度使用率在[0,0.2]笔数 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucc12mcredituseratetotal0204cnt` | 近12月成功单笔总额度使用率在(0.2,0.4]笔数 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawsucccredituseratetotal0204cntratio` | 历史成功单笔总额度使用率在(0.2,0.4]占比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw1m6mcredituseratetotalavgratio` | 近1月单笔发起后的平均总额度使用率/近6月单笔发起后的平均总额度使用率 | ✓ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedraw6mcreditriskuserateavgratio` | 近6月单笔平均剩余风控额度使用率比 | ~ |
| `offline_inner_jtbeh_creditamtusedrateloan_beforedrawcredituserate0910cntratio` | 历史单笔发起时的剩余额度使用率在(0.9,1.0]的笔数占比 | ✓ |

## 离线_内部_借条贷中行为_借款  (35个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_draw_beforedraw1mdrawamtrateall` | 近1月借款金额总和/初始授信额度 | ✓ |
| `offline_inner_jtbeh_draw_lastrjdrawdiff` | 最近一次拒绝到借款间隔天数 | ~ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawterm12amtall` | 前3月12期借款金额(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawterm3cntall` | 前1月3期借款次数(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawterm12amtall` | 前6月12期借款金额(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawamtrateall` | 近3月内累计借款金额使用率=3月内累计借款金额/初始授信金额 | ✓ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawtermavgweightedall` | 前3月加权平均借款期数(全产品) | ~ |
| `offline_inner_jtbeh_draw_drawhour1318amtratioall` | 13-18点借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawterm12amtall` | 前1月12期借款金额(全产品) | ~ |
| `offline_inner_jtbeh_draw_lastrjdrawdiffmob` | 最近一次拒绝到借款贷龄差 | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawamtcum` | 前1月累计借款金额 | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawterm12amt` | 前6月12期借款金额 | ~ |
| `offline_inner_jtbeh_draw_drawterm3cntratioall` | 3期借款次数占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawamtrate` | 近一个月内的成功借款总金额/初始授信金额 | ✓ |
| `offline_inner_jtbeh_draw_drawhour0712amtratioall` | 7-12点借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_successratebeforedraw` | 历史申请成功率 | ~ |
| `offline_inner_jtbeh_draw_drawterm12cntall` | 12期借款次数(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawterm12amtratioall` | 前6月12期借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawterm12amt` | 前3月12期借款金额 | ~ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawnightamtsumsall` | 前3月夜间借款金额总和(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawamtappr10cnt` | 前1月借款金额>授信额度100%笔数 | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawterm3cntall` | 前6月3期借款次数(全产品) | ~ |
| `offline_inner_jtbeh_draw_firstdrawuserateall` | 借款 | ~ |
| `offline_inner_jtbeh_draw_firstsuccdraw30drawamtall` | 首次成功借款后30天借款金额(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawtermavgall` | 前6月平均借款期数(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawhour0712amtratioall` | 前6月7-12点借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_drawhour1923amtratioall` | 19-23点借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw3mdrawamtrate` | 前3月借款金额/授信额度 | ~ |
| `offline_inner_jtbeh_draw_beforedraw6mdrawhour1923amtratioall` | 前6月19-23点借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_beforedraw1mdrawamtmax` | 前1月最大单笔借款金额 | ~ |
| `offline_inner_jtbeh_draw_drawhour0003amtall` | 凌晨0-3点借款金额(全产品) | ~ |
| `offline_inner_jtbeh_draw_drawterm1amtratio` | 1期借款金额占比 | ~ |
| `offline_inner_jtbeh_draw_drawterm3amtratioall` | 3期借款金额占比(全产品) | ~ |
| `offline_inner_jtbeh_draw_firstdrawapplyfinisheddaysdiffall` | 首次借款距授信通过天数(全产品) | ~ |
| `offline_inner_jtbeh_draw_drawterm6amt` | 6期借款金额 | ~ |

## 离线_内部_借条贷中行为_用户粒度额度使用率  (17个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_creditamtusedrate_trendavgcreditamtusedrateallproduct1mo12m` | 近1月/近12月均值额度使用率趋势_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_trendavgcreditamtusedrateallproduct1mo6m` | 近1个月较近6个月均值额度使用率趋势(1m/6m)_全产品 | ✓ |
| `offline_inner_jtbeh_creditamtusedrate_trendavgcreditamtusedrate360jietiao1mo12m` | 近1月/近12月均值额度使用率趋势_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_stdcreditamtusedrateallproduct3m` | 近3月额度使用率标准差_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_mincreditamtusedrate360jietiao1m` | 近1个月额度使用率最小值_360借条 | ✓ |
| `offline_inner_jtbeh_creditamtusedrate_mincreditamtusedrateallproduct1m` | 近1个月额度使用率最小值_全产品 | ✓ |
| `offline_inner_jtbeh_creditamtusedrate_cntscreditamtusedrateallproductbelow100percentmonthshis` | 历史额度使用率<100%月份数_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_mincreditamtusedrateallproduct3m` | 近3个月额度使用率最小值_全产品 | ✓ |
| `offline_inner_jtbeh_creditamtusedrate_cntscreditamtusedrateallproductbelow90percentmonthshis` | 历史额度使用率<90%月份数_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_trendmincreditamtusedrateallproduct1mo12m` | 近1月/近12月最小额度使用率趋势_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_cntscreditamtusedrate360jietiaobelow90percentmonthshis` | 历史额度使用率<90%月份数_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_ratiocreditamtusedrate360jietiaobetween2040percentmonthshis` | 历史额度使用率在20-40%月份占比_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_cntscreditamtusedrate360jietiaobelow100percentmonthshis` | 历史额度使用率<100%月份数_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_stdcreditamtusedrateallproduct12m` | 近12月额度使用率标准差_全产品 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_trendmincreditamtusedrate360jietiao1mo12m` | 近1月/近12月最小额度使用率趋势_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_maxcreditamtusedrate360jietiaohis` | 历史最大额度使用率_360借条 | ~ |
| `offline_inner_jtbeh_creditamtusedrate_mincreditamtusedrate360jietiao12m` | 近12个月额度使用率最小值_360借条 | ✓ |

## 离线_内部_借条贷中行为_负债  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_debt_futuremaxsinglemonthrepayamtovercredit` | 未来单月最大还款金额/授信额度 | ~ |
| `offline_inner_jtbeh_debt_before12mloandueamt` | 近12月贷款到期金额 | ~ |
| `offline_inner_jtbeh_debt_futuremaxsinglemonthrepayamt` | 未来单月最大还款金额 | ~ |

## 离线_内部_借条贷中行为_还款  (38个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_repay_before3mloansettleloanratio` | 近3月放款借据_整笔结清借据数/近3月放款借据数 | ✓ |
| `offline_inner_jtbeh_repay_before12mloansettletermprinamtratio` | 近12月放款且有结清期次对应本金和/近12月放款借据本金和 | ✓ |
| `offline_inner_jtbeh_repay_before12mpaysucamt` | 近12月扣款成功金额 | ~ |
| `offline_inner_jtbeh_repay_beforedraw12mallloansettleamt` | 前12个月整笔结清借据的总金额 | ✓ |
| `offline_inner_jtbeh_repay_lastpresettletermdiff` | 最近一次提前还款时间间隔 | ✓ |
| `offline_inner_jtbeh_repay_beforedraw6mallloansettleamt` | 前6月全部整笔结清金额 | ~ |
| `offline_inner_jtbeh_repay_before12mloannooverduetermprinamtratio` | 近12月_未逾期_借据_期次 | ~ |
| `offline_inner_jtbeh_repay_before1mo6mrpytypesucesnum` | 近1月/近6月提前结清成功次数 | ~ |
| `offline_inner_jtbeh_repay_before1mpayfailedamtratio` | 近1月扣款失败金额占比 | ~ |
| `offline_inner_jtbeh_repay_before3mloannooverduetermprinamtratio` | 近3月放款且未逾期结清期次期次对应本金和/近3月放款借据本金和 | ✓ |
| `offline_inner_jtbeh_repay_beforedraw3msettleapplydiffavg` | 前3月结清后申请间隔平均天数 | ~ |
| `offline_inner_jtbeh_repay_before12mloansettletermloanratio` | 近12月放款借据_结清期次数/借据期次数 | ~ |
| `offline_inner_jtbeh_repay_before3mloannooverduetermratio` | 近3月放款未逾期结清期次占比 | ~ |
| `offline_inner_jtbeh_repay_before1mrpytypesucesratio` | 近1月提前结清成功次数占比 | ~ |
| `offline_inner_jtbeh_repay_before3mloansettleprinamtratio` | 近3月放款整笔结清本金/放款本金 | ~ |
| `offline_inner_jtbeh_repay_before1mo12mpayfailedamt` | 近1月/近12月扣款失败金额 | ~ |
| `offline_inner_jtbeh_repay_before3mo12mrpytypesucodnum` | 近3月/近12月提前一次性结清成功次数 | ~ |
| `offline_inner_jtbeh_repay_before12mloannooverduetermnum` | 近12月放款未逾期结清期次数 | ~ |
| `offline_inner_jtbeh_repay_before12mpresettledaysmin` | 近12月提前结清最少天数 | ~ |
| `offline_inner_jtbeh_repay_before1mloansettletermloanratio` | 近1月放款借据_结清期次数/借据期次数 | ~ |
| `offline_inner_jtbeh_repay_creditamtbeforedraw` | 借款前授信额度 | ~ |
| `offline_inner_jtbeh_repay_beforedraw1mo6mloansettlepredaysavg` | 前1月/前6月提前结清平均天数比 | ~ |
| `offline_inner_jtbeh_repay_beforedraw6mto6mallloansettleamttrend` | 近6月/前6月整笔结清金额趋势 | ~ |
| `offline_inner_jtbeh_repay_before6mloannooverduetermratio` | 近6月放款且未逾期结清期次期次和/近6月放款借据期次和 | ✓ |
| `offline_inner_jtbeh_repay_beforedraw12msettleloanplansumdays` | 前12个月未逾期整笔结清借据名义资金占用天数差(datediff(date_end,date_inst)) | ✓ |
| `offline_inner_jtbeh_repay_before3mloansettletermprinamtratio` | 近3月放款且有结清期次对应本金和/近3月放款借据本金和 | ✓ |
| `offline_inner_jtbeh_repay_allloanduepresettleamtallloandueratio` | 历史全部提前结清金额/全部到期金额 | ~ |
| `offline_inner_jtbeh_repay_before3mpartial12mloannooverduetermnumtrend` | 近3月/近12月放款未逾期结清期次数趋势 | ~ |
| `offline_inner_jtbeh_repay_before3mpayfailedratio` | 近3月扣款失败次数占比 | ~ |
| `offline_inner_jtbeh_repay_beforedraw1mpartial12msettleprinamttrend` | 前1月/近12月结清本金趋势 | ~ |
| `offline_inner_jtbeh_repay_before6mpaychannelsucbatratio` | 近6月渠道BAT扣款成功占比 | ~ |
| `offline_inner_jtbeh_repay_before12mpayfailedratio` | 近12月扣款失败次数占比 | ~ |
| `offline_inner_jtbeh_repay_before12mloansettleprinamtratio` | 近12月放款借据_整笔结清借款本金和/近12月放款借款本金和 | ✓ |
| `offline_inner_jtbeh_repay_beforedraw1mallloansettleamt` | 前1月全部整笔结清金额 | ~ |
| `offline_inner_jtbeh_repay_beforedrawloansettlepredaysmin` | 历史提前结清最少天数 | ~ |
| `offline_inner_jtbeh_repay_beforedraw12mloansettlepredaysavg` | 前12月提前结清平均天数 | ~ |
| `offline_inner_jtbeh_repay_beforedraw12mallloanduesettleamt` | 前12个月整笔按时结清借据的总金额 | ✓ |
| `offline_inner_jtbeh_repay_before6mrpytypesucesratio` | 近6月提前结清成功次数占比 | ~ |

## 离线_内部_借条贷中行为_逾期  (15个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbeh_overdue_beforedraw6moverdue2daysamt` | 前6月逾期>2天金额 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue3daysamt` | 历史逾期>3天金额 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue1daysprinamtratio` | 历史逾期>1天本金占比 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue0daysdiffavg` | 历史逾期0天间隔均值 | ~ |
| `offline_inner_jtbeh_overdue_before6mphonestatetotalnumself` | 近6月手机状态总次数(自身) | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue0daysamt` | 历史逾期0天金额 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue2daysamt` | 历史逾期>2天金额 | ~ |
| `offline_inner_jtbeh_overdue_beforedraw3moverdue1daysamt` | 前3个月内期次到期（date_due）的逾期天数大于1天的逾期本金 | ✓ |
| `offline_inner_jtbeh_overdue_allloanoverduesettleprinamt` | 历史全部逾期后结清本金 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue1daysamt` | 历史逾期>1天金额 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue1daysdiffavg` | 历史逾期>1天间隔均值 | ~ |
| `offline_inner_jtbeh_overdue_beforedraw6moverdue3dtermratio` | 前6月逾期>3天期次占比 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverduemaxdatediff` | 历史最大逾期日期间隔 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue0daysdiffmax` | 历史逾期0天间隔最大值 | ~ |
| `offline_inner_jtbeh_overdue_beforedrawoverdue4daysamt` | 历史逾期>4天金额 | ~ |

## 离线_内部_借条贷中行为专项衍生_借款  (11个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_jtbehtopic_draw_drawcntsratio_noon_his` | 中午借款次数占比_历史 | ~ |
| `offline_inner_jtbehtopic_draw_drawamt_15d` | 借款金额_近15天 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratio_noon_his` | 中午(饭点)借款金额占比_历史 | ✓ |
| `offline_inner_jtbehtopic_draw_drawamttrend_earlymorning_1m_o_12m` | 凌晨借款金额趋势_近1月/近12月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratiotrend_afternoon_6m_o_12m` | 下午借款金额占比趋势_近6月/近12月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratiotrend_earlymorning0to3_1m_o_3m` | 凌晨0-3点借款金额占比趋势_近1月/近3月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratiotrend_earlymorning_3m_o_6m` | 凌晨借款金额占比趋势_近3月/近6月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratio_evening_12m` | 晚上借款金额占比_近12个月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratio_afternoon_12m` | 下午借款金额占比_近12个月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratio_earlymorning_12m` | 凌晨0-6点借款金额占比_近12个月 | ~ |
| `offline_inner_jtbehtopic_draw_drawamtratio_natrualmonthstartorend_his` | 月初月末借款金额占比_历史 | ~ |

## 离线_内部_埋点_借款  (19个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_maidian_multidim_loan_loan_calc_cnt_12m` | 借款试算-次数-近12月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_cnt_1m_o_3m` | 借款校验失败-次数-近1月/近3月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_calc_days_12m` | 借款试算-天数-近12月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_trialfail_cnt_12m` | 借款试算失败-次数-近12月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_cnt_2m_o_6m` | 借款校验失败-次数-近2月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_calc_cnt_6m_o_6m` | 借款试算-次数-近6月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_cnt_1m_o_6m` | 借款校验失败-次数-近1月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_enter_cnt_1m_o_6m` | 进入借款页面_埋点次数_近1m/近6m | ✓ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_days_1m_o_6m` | 借款校验失败-天数-近1月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_repaytermchoice_days_2m` | 选择还款期次-天数-近2月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_cnt_12m` | 借款校验失败-次数-近12月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_repaytermchoice_days_6m` | 选择还款期次-天数-近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_calc_days_6m_o_6m` | 借款试算-天数-近6月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_calc_days_6m` | 借款试算-天数-近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_calc_cnt_6m` | 借款试算-次数-近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_enter_cnt_2m_o_6m` | 进入借款页面_埋点次数_近2m/近6m | ✓ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_days_12m` | 借款校验失败-天数-近12月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_checkfail_cnt_3m_o_6m` | 借款校验失败-次数-近3月/近6月 | ~ |
| `offline_inner_maidian_multidim_loan_loan_trialfail_cnt_6m` | 借款试算失败-次数-近6月 | ~ |

## 离线_内部_埋点_区分事件的操作事件信息  (3个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_maidian_useropteventactivities_before7dloantrailsubmitcnt` | before7dloantrailsubmitcnt | ~ |
| `offline_inner_maidian_useropteventactivities_before3mloantrailsubmitdays` | before3mloantrailsubmitdays | ~ |
| `offline_inner_maidian_useropteventactivities_before3mloantrailsucc360pcnt` | before3mloantrailsucc360pcnt | ~ |

## 离线_内部_埋点_用户粘性  (7个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_maidian_multidim_stickiness_vip_refund_days_12m` | VIP退款-天数-近12月 | ~ |
| `offline_inner_maidian_multidim_stickiness_vip_apply_days_12m` | VIP申请-天数-近12月 | ~ |
| `offline_inner_maidian_multidim_stickiness_login_api_cnt_1m_o_6m` | API登录-次数-近1月/近6月 | ~ |
| `offline_inner_maidian_multidim_stickiness_login_app_cnt_1m_o_3m` | APP登陆_埋点次数_近1m/近3m | ✓ |
| `offline_inner_maidian_multidim_stickiness_login_app_days_3m` | APP登录-天数-近3月 | ~ |
| `offline_inner_maidian_multidim_stickiness_vip_refund_cnt_12m` | VIP退款-次数-近12月 | ~ |
| `offline_inner_maidian_multidim_stickiness_login_api_cnt_2m_o_6m` | API登录-次数-近2月/近6月 | ~ |

## 离线_内部_埋点_还款  (15个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_maidian_multidim_repay_normal_loanenter_cnt_1m_o_6m` | 进入借款页-次数-近1月/近6月 | ~ |
| `offline_inner_maidian_multidim_repay_prepay_refundtriala_days_1m_o_2m` | 还款试算-天数-近1月/近2月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_checkentranc_days_6m_o_6m` | 进入校验页-天数-近6月/近6月 | ~ |
| `offline_inner_maidian_multidim_repay_overdue_checkoverdueenter_days_2m_o_6m` | 逾期还款新-进入逾期主页-天数-近2月比近6月 | ✓ |
| `offline_inner_maidian_multidim_repay_normal_normalprepaypageiniti_cnt_2m` | 发起还款(提前/当期)-次数-近2月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_refundsubmit_cnt_2m` | 提交还款-次数-近2月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_refundsubmit_cnt_4m` | 账单还款新-提交还款完成-次数-近4月 | ✓ |
| `offline_inner_maidian_multidim_repay_normal_refundsubmit_cnt_6m_o_6m` | 提交还款-次数-近6月/近6月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_refundsubmit_days_6m_o_6m` | 提交还款-天数-近6月/近6月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_loanenter_cnt_2m_o_2m` | 账单还款-进入借款-次数-近2月比前2月 | ✓ |
| `offline_inner_maidian_multidim_repay_normal_enterloanrecord_cnt_2m_o_2m` | 进入还款记录-次数-近2月/近2月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_enterloandetailsa_cnt_12m` | 进入借款详情页-次数-近12月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_refundsubmit_days_2m_o_2m` | 提交还款-天数-近2月/近2月 | ~ |
| `offline_inner_maidian_multidim_repay_normal_loanenter_cnt_1m_o_3m` | 账单还款-进入借款-次数-近1月比近3月 | ✓ |
| `offline_inner_maidian_multidim_repay_normal_loanenter_cnt_2m_o_6m` | 账单还款-进入借款-次数-近2月比近6月 | ✓ |

## 离线_内部_设备_app按类型衍生  (15个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_device_app_recruitmentapp_o_allapp_ratio` | 招聘App | ~ |
| `offline_inner_device_app_recruitmentapp_o_allbusinessaffairsapp_ratio` | 招聘App | ~ |
| `offline_inner_device_app_videosapp_o_allapp_ratio` | 视频App | ~ |
| `offline_inner_device_app_audiovisualeditingapp_o_allapp_ratio` | 影音编辑App | ~ |
| `offline_inner_device_app_officesoftwareapp_o_allapp_ratio` | 办公软件App-安装占比(分母:在统计范围内的App个数) | ✓ |
| `offline_inner_device_app_audiovisualeditingapp_o_allphotoeditingandenhancementapp_ratio` | 影音编辑App-安装占比(分母:拍摄美化App安装个数) | ✓ |
| `offline_inner_device_app_bankingapp_o_allapp_ratio` | 银行App | ~ |
| `offline_inner_deivce_app_communistsapp_cnts` | 党员相关app数量 | ✓ |
| `offline_inner_device_app_tourismaccommodationapp_o_allapp_ratio` | 旅游住宿App | ~ |
| `offline_inner_device_app_inputmethodapp_o_allpracticaltoolsapp_ratio` | 输入法App | ~ |
| `offline_inner_device_app_automotiveinformationapp_o_allapp_ratio` | 汽车资讯App | ~ |
| `offline_inner_device_app_carmaintenanceapp_o_allapp_ratio` | 汽车保养App | ~ |
| `offline_inner_device_app_toolsapp_o_allpracticaltoolsapp_ratio` | 实用工具App | ~ |
| `offline_inner_device_app_chattingapp_o_allapp_ratio` | 社交聊天App | ~ |
| `offline_inner_device_app_loansapp_o_allapp_ratio` | 贷款App-安装占比(分母:在统计范围内的App个数) | ✓ |

## 离线_内部_设备_通讯录备注衍生  (18个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_device_contactbeizhu_mobile_prop_goodword` | 备注中包含低风险词类关键字联系人占比 | ✓ |
| `offline_inner_device_contactbeizhu_contact_prop_tizhinei` | 在他人备注中包含体制内工作类关键字占比 | ✓ |
| `offline_inner_device_contactbeizhu_mobile_prop_house` | 联系人 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_badword` | 高风险词 | ~ |
| `offline_inner_device_contactbeizhu_mobile_sum_goodword` | 低风险词 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_zhangbei` | 长辈类 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_pingbei` | 平辈类 | ~ |
| `offline_inner_device_contactbeizhu_mobile_sum_tizhinei` | 体制内工作 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_wanbei` | 联系人 | ~ |
| `offline_inner_device_contactbeizhu_contact_prop_lingshou` | 在他人备注中包含零售类关键字占比 | ✓ |
| `offline_inner_device_contactbeizhu_mobile_prop_friend` | 联系人 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_tizhiwai` | 体制外 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_tizhinei` | 备注中包含体制内工作类关键字联系人占比 | ✓ |
| `offline_inner_device_contactbeizhu_mobile_prop_network` | 水电网络类 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_citylevels4low` | 四线及以下城市 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_lingshou` | 零售类 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_dongbu` | 联系人 | ~ |
| `offline_inner_device_contactbeizhu_mobile_prop_pe` | 联系人 | ~ |

## 离线_内部_设备_通讯录多头衍生  (4个)

| 特征英文名 | 特征含义 | 来源 |
|-----------|---------|------|
| `offline_inner_device_contactmultiappl_seqingdubobaoli_ratio` | 色情赌博暴力相关 | ~ |
| `offline_inner_device_contactmultiappl_jiedaiminganci_ratio` | 借贷名词相关 | ~ |
| `offline_inner_device_contactmultiappl_daikuan_ratio` | 跟贷款有关人数占比 | ✓ |
| `offline_inner_device_contactmultiappl_dubo_ratio` | 跟赌博有关人数占比 | ✓ |

---

## 分类汇总

| 特征分类 | 特征数 | 精确 | 推理 |
|---------|--------|------|------|
| 301快照_内部_画像(基础)_客户信息 | 1 | 0 | 1 |
| 301快照_内部_画像(通讯录及关系网)_小网变量输入项 | 11 | 2 | 9 |
| 301快照_内部_画像(通讯录及关系网)_用户关系网信息 | 3 | 1 | 2 |
| 301快照_内部_画像(通讯录及关系网)_通讯录敏感词反匹配 | 1 | 0 | 1 |
| 301快照_内部_画像(通讯录及关系网)_通讯录特征输入项加工 | 2 | 1 | 1 |
| 301快照_内部_画像(通讯录及关系网)_通话记录 | 3 | 2 | 1 |
| 301快照_内部_画像(通讯录及关系网)_通话记录_电话黄页 | 1 | 0 | 1 |
| 301快照_内部_设备_申请位置信息 | 1 | 0 | 1 |
| 301快照_内部_设备_设备信息_申请 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_临时额度信息 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_借款信息 | 5 | 0 | 5 |
| 701快照_内部_画像(基础)_借款列表比率 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_借款失败详情 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_学生标签 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_客户信息 | 1 | 1 | 0 |
| 701快照_内部_画像(基础)_客户申请历史 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_客户贷款列表结果 | 1 | 1 | 0 |
| 701快照_内部_画像(基础)_征信授信信息 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_贷前历史信息 | 1 | 0 | 1 |
| 701快照_内部_画像(基础)_贷后信息 | 12 | 2 | 10 |
| 701快照_内部_画像(通讯录及关系网)_关联信息 | 8 | 1 | 7 |
| 701快照_内部_画像(通讯录及关系网)_反向通讯录身份校验 | 2 | 0 | 2 |
| 701快照_内部_画像(通讯录及关系网)_客户通话记录联系人关联关系 | 5 | 1 | 4 |
| 701快照_内部_画像(通讯录及关系网)_用户关系网信息 | 1 | 0 | 1 |
| 701快照_内部_画像(通讯录及关系网)_通讯录 | 2 | 1 | 1 |
| 701快照_内部_画像(通讯录及关系网)_通讯录敏感词反匹配 | 2 | 0 | 2 |
| 701快照_内部_画像(通讯录及关系网)_通话记录 | 5 | 4 | 1 |
| 701快照_内部_画像(通讯录及关系网)_通话记录_电话黄页 | 1 | 0 | 1 |
| 701快照_内部_设备_app分类新 | 3 | 0 | 3 |
| 701快照_内部_设备_app按类型衍生 | 1 | 0 | 1 |
| 701快照_内部_设备_app最近安装 | 3 | 0 | 3 |
| 701快照_内部_设备_借款位置信息 | 3 | 0 | 3 |
| 701快照_内部_设备_设备信息（借款）(deviceInfo) | 4 | 2 | 2 |
| 离线_内外部_行为比对 | 1 | 0 | 1 |
| 离线_内部_App_APP指数 | 11 | 2 | 9 |
| 离线_内部_app_appindex2期 | 18 | 6 | 12 |
| 离线_内部_位置_LBS地理信息 | 10 | 0 | 10 |
| 离线_内部_借条贷中行为_novip还款 | 5 | 1 | 4 |
| 离线_内部_借条贷中行为_借据粒度单笔额度使用率 | 31 | 16 | 15 |
| 离线_内部_借条贷中行为_借款 | 35 | 3 | 32 |
| 离线_内部_借条贷中行为_用户粒度额度使用率 | 17 | 5 | 12 |
| 离线_内部_借条贷中行为_负债 | 3 | 0 | 3 |
| 离线_内部_借条贷中行为_还款 | 38 | 10 | 28 |
| 离线_内部_借条贷中行为_逾期 | 15 | 1 | 14 |
| 离线_内部_借条贷中行为专项衍生_借款 | 11 | 1 | 10 |
| 离线_内部_埋点_借款 | 19 | 2 | 17 |
| 离线_内部_埋点_区分事件的操作事件信息 | 3 | 0 | 3 |
| 离线_内部_埋点_用户粘性 | 7 | 1 | 6 |
| 离线_内部_埋点_还款 | 15 | 5 | 10 |
| 离线_内部_设备_app按类型衍生 | 15 | 4 | 11 |
| 离线_内部_设备_通讯录备注衍生 | 18 | 4 | 14 |
| 离线_内部_设备_通讯录多头衍生 | 4 | 2 | 2 |