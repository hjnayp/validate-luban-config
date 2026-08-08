import {beforeAll, describe, it} from "vitest";
import {dailyweeklytask} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr} from "../../infra/tb";
import {
    collect_daily_weekly_active_chest_records,
    collect_reward_errors,
    DailyWeeklyActiveChestRecord,
    ERROR_SOURCE_CHEST_EXCEL,
    format_daily_weekly_task_error,
    format_period_type,
} from "./records";

const to_error = (record: DailyWeeklyActiveChestRecord, field_name: string, detail: string): string =>
    format_daily_weekly_task_error(
        ERROR_SOURCE_CHEST_EXCEL,
        record.source_location,
        field_name,
        `chestId=${record.chest_id}, ${detail}`,
    );

const group_by_period = (
    records: ReadonlyArray<DailyWeeklyActiveChestRecord>,
): ReadonlyMap<dailyweeklytask.PeriodType, ReadonlyArray<DailyWeeklyActiveChestRecord>> =>
    records.reduce((grouped, record) => {
        grouped.set(record.period_type, [...(grouped.get(record.period_type) ?? []), record]);
        return grouped;
    }, new Map<dailyweeklytask.PeriodType, ReadonlyArray<DailyWeeklyActiveChestRecord>>());

const collect_empty_table_errors = (records: ReadonlyArray<DailyWeeklyActiveChestRecord>): ReadonlyArray<string> =>
    records.length > 0 ? [] : [`excel=${ERROR_SOURCE_CHEST_EXCEL}, reason=活跃宝箱表不能为空`];

const collect_field_errors = (records: ReadonlyArray<DailyWeeklyActiveChestRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        if (dailyweeklytask.PeriodType[record.period_type] === undefined) {
            errors.push(to_error(record, "periodType", `periodType=${record.period_type}, reason=非法的周期类型`));
        }
        if (record.chest_id <= 0) {
            errors.push(to_error(record, "chestId", "reason=宝箱 ID 必须大于 0"));
        }
        if (record.threshold <= 0) {
            errors.push(to_error(record, "threshold", `threshold=${record.threshold}, reason=达档活跃分必须大于 0`));
        }
        if (record.sort <= 0) {
            errors.push(to_error(record, "sort", `sort=${record.sort}, reason=展示序号必须大于 0`));
        }

        return errors;
    });

/** 服务端按 sort、chestId 稳定排序；同周期档位必须按该实际顺序递增。 */
const collect_threshold_order_errors = (records: ReadonlyArray<DailyWeeklyActiveChestRecord>): ReadonlyArray<string> =>
    Array.from(group_by_period(records).values()).flatMap((period_records) => {
        const sorted_records = [...period_records].sort((left, right) =>
            left.sort !== right.sort ? left.sort - right.sort : left.chest_id - right.chest_id
        );

        return sorted_records.flatMap((record, index) => {
            if (index <= 0) {
                return [];
            }

            const previous = sorted_records[index - 1];
            if (record.threshold > previous.threshold) {
                return [];
            }

            return [to_error(
                record,
                "threshold",
                `periodType=${format_period_type(record.period_type)}, threshold=${record.threshold}, reason=达档活跃分必须随 sort 严格递增，上一档 chestId=${previous.chest_id} threshold=${previous.threshold}`,
            )];
        });
    });

const collect_chest_reward_errors = (records: ReadonlyArray<DailyWeeklyActiveChestRecord>): ReadonlyArray<string> =>
    records.flatMap((record) =>
        collect_reward_errors(
            ERROR_SOURCE_CHEST_EXCEL,
            record.source_location,
            `chestId=${record.chest_id}`,
            record.reward ?? [],
        )
    );

describe("日周任务活跃宝箱配置校验", () => {
    let records: ReadonlyArray<DailyWeeklyActiveChestRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_daily_weekly_active_chest_records();
    });

    it("should 活跃宝箱表不能为空", () => {
        assert_no_errors("日周活跃宝箱表内容缺失：", collect_empty_table_errors(records));
    });

    it("should 宝箱字段取值合法", () => {
        assert_no_errors("日周活跃宝箱字段非法：", collect_field_errors(records));
    });

    it("should 同周期达档活跃分随 sort 严格递增", () => {
        assert_no_errors("日周活跃宝箱档位顺序非法：", collect_threshold_order_errors(records));
    });

    it("should 宝箱奖励合法", () => {
        assert_no_errors("日周活跃宝箱奖励非法：", collect_chest_reward_errors(records));
    });
});
