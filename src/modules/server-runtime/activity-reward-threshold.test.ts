import {beforeAll, describe, expect, it} from "vitest";
import {activity} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

const INT32_MAX = 2_147_483_647;

type DailyRewardEntry = Readonly<{
    day: number;
    reward_id: string;
}>;

type DailyRewardLevel = Readonly<{
    amount: number;
    grand_reward_id: string;
    grand_required_days: number;
    entries: ReadonlyArray<DailyRewardEntry>;
}>;

type DailyRewardRecord = Readonly<{
    table: string;
    id: number;
    levels_field: "entries" | "levels";
    levels: ReadonlyArray<DailyRewardLevel>;
}>;

type SumRewardLevel = Readonly<{
    level: number;
    need_amount: number;
}>;

type SumRewardRecord = Readonly<{
    table: string;
    id: number;
    rewards: ReadonlyArray<SumRewardLevel>;
}>;

type ActivitySubRecord = Readonly<{
    sub_activity_id: number;
    template_type: number;
    template_sub_type: number;
}>;

const format_error = (table: string, id: number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const is_positive_int32 = (value: number): boolean =>
    Number.isSafeInteger(value) && value > 0 && value <= INT32_MAX;

const collect_daily_reward_errors = (
    records: ReadonlyArray<DailyRewardRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        const seen_amounts = new Set<number>();
        const reward_id_paths = new Map<string, string>();

        const collect_reward_id = (reward_id: string, field: string): void => {
            if (reward_id === "") {
                errors.push(format_error(record.table, record.id, field, "rewardId 不能为空，否则领取状态会共用空字符串 key"));
                return;
            }

            const previous_field = reward_id_paths.get(reward_id);
            if (previous_field !== undefined) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    field,
                    `rewardId=${reward_id} 与 ${previous_field} 重复，精确查找和 ClaimedRewardIds 会映射到同一奖励`,
                ));
                return;
            }
            reward_id_paths.set(reward_id, field);
        };

        record.levels.forEach((level, level_index) => {
            const level_field = `${record.levels_field}[${level_index}]`;
            const valid_amount = is_positive_int32(level.amount);
            if (!valid_amount) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${level_field}.amount`,
                    `amount=${level.amount} 必须是 1..${INT32_MAX} 的安全整数（单位：元）`,
                ));
            }
            else {
                if (seen_amounts.has(level.amount)) {
                    errors.push(format_error(
                        record.table,
                        record.id,
                        `${level_field}.amount`,
                        `amount=${level.amount} 重复，QualifiedDays 和 TodayQualifiedAmounts 会覆盖同一档位`,
                    ));
                }
                seen_amounts.add(level.amount);
            }

            if (!is_positive_int32(level.grand_required_days)) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${level_field}.grandRequiredDays`,
                    `grandRequiredDays=${level.grand_required_days} 必须是 1..${INT32_MAX} 的安全整数`,
                ));
            }
            collect_reward_id(level.grand_reward_id, `${level_field}.grandRewardId`);

            const seen_days = new Set<number>();
            level.entries.forEach((entry, entry_index) => {
                const entry_field = `${level_field}.entries[${entry_index}]`;
                const valid_day = is_positive_int32(entry.day);
                if (!valid_day) {
                    errors.push(format_error(
                        record.table,
                        record.id,
                        `${entry_field}.day`,
                        `day=${entry.day} 必须是 1..${INT32_MAX} 的安全整数`,
                    ));
                }
                else {
                    if (seen_days.has(entry.day)) {
                        errors.push(format_error(
                            record.table,
                            record.id,
                            `${entry_field}.day`,
                            `day=${entry.day} 在同一金额档位内重复`,
                        ));
                    }
                    seen_days.add(entry.day);
                }

                collect_reward_id(entry.reward_id, `${entry_field}.rewardId`);
            });
        });

        return errors;
    });

const collect_sum_reward_errors = (
    records: ReadonlyArray<SumRewardRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        const seen_levels = new Set<number>();

        record.rewards.forEach((reward, index) => {
            const reward_field = `rewards[${index}]`;
            const valid_level = is_positive_int32(reward.level);
            if (!valid_level) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${reward_field}.level`,
                    `level=${reward.level} 必须是 1..${INT32_MAX} 的安全整数`,
                ));
            }
            else {
                if (seen_levels.has(reward.level)) {
                    errors.push(format_error(
                        record.table,
                        record.id,
                        `${reward_field}.level`,
                        `level=${reward.level} 重复，ClaimedLevels 与精确领取会映射到同一档位`,
                    ));
                }
                seen_levels.add(reward.level);
            }

            const valid_need_amount = is_positive_int32(reward.need_amount);
            if (!valid_need_amount) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${reward_field}.needAmount`,
                    `needAmount=${reward.need_amount} 必须是 1..${INT32_MAX} 的安全整数（单位：元；服务端按 ×100 与分比较）`,
                ));
            }
        });

        return errors;
    });

const collect_activity_leaf_reference_errors = (
    daily_ids: ReadonlySet<number>,
    sum_ids: ReadonlySet<number>,
    activity_subs: ReadonlyArray<ActivitySubRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const activity_sub_by_id = new Map(activity_subs.map((record) => [record.sub_activity_id, record]));
    const expected_tables: ReadonlyArray<Readonly<{
        table: string;
        ids: ReadonlySet<number>;
        template_type: activity.ActivityTemplateType;
    }>> = [
        {table: "TbActChargeDaily", ids: daily_ids, template_type: activity.ActivityTemplateType.charge_daily},
        {table: "TbActChargeSum", ids: sum_ids, template_type: activity.ActivityTemplateType.charge_sum},
    ];

    expected_tables.forEach((expected) => {
        expected.ids.forEach((id) => {
            const activity_sub = activity_sub_by_id.get(id);
            if (activity_sub === undefined) {
                errors.push(format_error(
                    expected.table,
                    id,
                    "subActivityId",
                    `TbActivitySub 缺少 subActivityId=${id}，活动容器不会路由到该奖励配置`,
                ));
                return;
            }
            if (activity_sub.template_type !== expected.template_type) {
                errors.push(format_error(
                    expected.table,
                    id,
                    "subActivityId",
                    `TbActivitySub.templateType=${activity_sub.template_type}，期望 ${expected.template_type}，会路由到错误模板`,
                ));
            }
        });
    });

    activity_subs.forEach((activity_sub) => {
        let expected_table: string | undefined;
        let expected_ids: ReadonlySet<number> | undefined;
        if (activity_sub.template_type === activity.ActivityTemplateType.charge_daily) {
            expected_table = "TbActChargeDaily";
            expected_ids = daily_ids;
        }
        else if (activity_sub.template_type === activity.ActivityTemplateType.charge_sum) {
            expected_table = "TbActChargeSum";
            expected_ids = sum_ids;
        }
        else {
            return;
        }

        if (activity_sub.template_sub_type !== 0) {
            errors.push(format_error(
                "TbActivitySub",
                activity_sub.sub_activity_id,
                "templateSubType",
                `templateSubType=${activity_sub.template_sub_type}，${expected_table} 仅注册 SubTypeNone=0`,
            ));
        }
        if (!expected_ids.has(activity_sub.sub_activity_id)) {
            errors.push(format_error(
                "TbActivitySub",
                activity_sub.sub_activity_id,
                "subActivityId",
                `${expected_table} 缺少同 ID 配置，领取与关闭结算的精确查询会失败`,
            ));
        }
    });

    return errors;
};

const collect_current_daily_records = (): ReadonlyArray<DailyRewardRecord> => [
    ...tb.TbActChargeDaily.getDataList().map((record) => ({
        table: "TbActChargeDaily",
        id: record.subActivityId,
        levels_field: "levels" as const,
        levels: record.levels.map((level) => ({
            amount: level.amount,
            grand_reward_id: level.grandRewardId,
            grand_required_days: level.grandRequiredDays,
            entries: level.entries.map((entry) => ({day: entry.day, reward_id: entry.rewardId})),
        })),
    })),
    ...tb.TbDailyQualifiedRecharge.getDataList().map((record) => ({
        table: "TbDailyQualifiedRecharge",
        id: record.activityId,
        levels_field: "entries" as const,
        levels: record.entries.map((level) => ({
            amount: level.amount,
            grand_reward_id: level.grandRewardId,
            grand_required_days: level.grandRequiredDays,
            entries: level.entries.map((entry) => ({day: entry.day, reward_id: entry.rewardId})),
        })),
    })),
];

const collect_current_sum_records = (): ReadonlyArray<SumRewardRecord> => [
    ...tb.TbActChargeSum.getDataList().map((record) => ({
        table: "TbActChargeSum",
        id: record.subActivityId,
        rewards: record.rewards.map((reward) => ({level: reward.level, need_amount: reward.needAmount})),
    })),
    ...tb.TbMultiDayRecharge.getDataList().map((record) => ({
        table: "TbMultiDayRecharge",
        id: record.activityId,
        rewards: record.rewards.map((reward) => ({level: reward.level, need_amount: reward.needAmount})),
    })),
];

const collect_current_activity_subs = (): ReadonlyArray<ActivitySubRecord> =>
    tb.TbActivitySub.getDataList().map((record) => ({
        sub_activity_id: record.subActivityId,
        template_type: record.templateType,
        template_sub_type: record.templateSubType,
    }));

describe("服务端活动奖励档位与领取映射配置校验", () => {
    let daily_records: ReadonlyArray<DailyRewardRecord>;
    let sum_records: ReadonlyArray<SumRewardRecord>;
    let activity_subs: ReadonlyArray<ActivitySubRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        daily_records = collect_current_daily_records();
        sum_records = collect_current_sum_records();
        activity_subs = collect_current_activity_subs();
    });

    it("should 汇总覆盖、不可达与重复领取映射错误", () => {
        const invalid_daily: ReadonlyArray<DailyRewardRecord> = [{
            table: "SyntheticDaily",
            id: 1,
            levels_field: "levels",
            levels: [
                {
                    amount: 20,
                    grand_reward_id: "shared",
                    grand_required_days: 1,
                    entries: [
                        {day: 2, reward_id: "day-2"},
                        {day: 1, reward_id: "shared"},
                        {day: 1, reward_id: "day-2"},
                    ],
                },
                {
                    amount: 10,
                    grand_reward_id: "",
                    grand_required_days: 0,
                    entries: [{day: 0, reward_id: ""}],
                },
                {
                    amount: 10,
                    grand_reward_id: "day-2",
                    grand_required_days: 1.5,
                    entries: [{day: 1, reward_id: "unique"}],
                },
            ],
        }];
        const invalid_sum: ReadonlyArray<SumRewardRecord> = [{
            table: "SyntheticSum",
            id: 2,
            rewards: [
                {level: 1, need_amount: 100},
                {level: 1, need_amount: 50},
                {level: 0, need_amount: 0},
                {level: 4.5, need_amount: Number.MAX_SAFE_INTEGER + 1},
            ],
        }];
        const invalid_activity_subs: ReadonlyArray<ActivitySubRecord> = [
            {
                sub_activity_id: 1,
                template_type: activity.ActivityTemplateType.charge_daily,
                template_sub_type: 1,
            },
            {
                sub_activity_id: 3,
                template_type: activity.ActivityTemplateType.charge_sum,
                template_sub_type: 0,
            },
        ];

        const errors = [
            ...collect_daily_reward_errors(invalid_daily),
            ...collect_sum_reward_errors(invalid_sum),
            ...collect_activity_leaf_reference_errors(
                new Set([1]),
                new Set([2]),
                invalid_activity_subs,
            ),
        ];
        const report = errors.join("\n");

        expect(errors).toHaveLength(18);
        expect(report).toContain("QualifiedDays 和 TodayQualifiedAmounts 会覆盖同一档位");
        expect(report).toContain("精确查找和 ClaimedRewardIds 会映射到同一奖励");
        expect(report).toContain("ClaimedLevels 与精确领取会映射到同一档位");
        expect(report).toContain("必须是 1..2147483647 的安全整数");
        expect(report).toContain("仅注册 SubTypeNone=0");
        expect(report).toContain("精确查询会失败");
        errors.forEach((message) => expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u));
    });

    it("should 当前新旧充值活动奖励档位与路由引用均满足服务端契约", () => {
        const daily_ids = new Set(
            tb.TbActChargeDaily.getDataList().map((record) => record.subActivityId),
        );
        const sum_ids = new Set(
            tb.TbActChargeSum.getDataList().map((record) => record.subActivityId),
        );
        const errors = [
            ...collect_daily_reward_errors(daily_records),
            ...collect_sum_reward_errors(sum_records),
            ...collect_activity_leaf_reference_errors(daily_ids, sum_ids, activity_subs),
        ];

        assert_no_errors("存在会覆盖、不可达或错误映射的服务端活动奖励档位：", errors);
    });
});
