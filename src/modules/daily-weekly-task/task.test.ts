import {beforeAll, describe, it} from "vitest";
import {dailyweeklytask} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr} from "../../infra/tb";
import {
    collect_daily_weekly_task_records,
    collect_reward_errors,
    DailyWeeklyTaskRecord,
    ERROR_SOURCE_TASK_EXCEL,
    format_daily_weekly_task_error,
    format_period_type,
} from "./records";

// 每日任务用 D 前缀、每周任务用 W 前缀，后缀是从 1 开始的业务序号。
const TASK_CODE_PATTERN = /^([DW])([1-9][0-9]*)$/u;
const PERIOD_TYPE_BY_CODE_PREFIX: Readonly<Record<string, dailyweeklytask.PeriodType>> = {
    D: dailyweeklytask.PeriodType.daily,
    W: dailyweeklytask.PeriodType.weekly,
};
// W8 是预留占位编号，导出即视为误配；D15 是任务中心必须存在的兜底任务条。
const FORBIDDEN_TASK_CODE = "W8";
const REQUIRED_TASK_CODE = "D15";

const to_error = (record: DailyWeeklyTaskRecord, field_name: string, detail: string): string =>
    format_daily_weekly_task_error(ERROR_SOURCE_TASK_EXCEL, record.source_location, field_name, `code=${record.code}, ${detail}`);

const collect_empty_table_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.length > 0 ? [] : [`excel=${ERROR_SOURCE_TASK_EXCEL}, reason=任务表不能为空`];

const collect_code_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const matched = TASK_CODE_PATTERN.exec(record.code ?? "");
        if (!matched) {
            return [to_error(record, "code", "reason=业务编号必须是 D 或 W 加正整数，例如 D1、W7")];
        }

        const expected_period_type = PERIOD_TYPE_BY_CODE_PREFIX[matched[1]];
        if (record.period_type !== expected_period_type) {
            return [to_error(
                record,
                "periodType",
                `periodType=${format_period_type(record.period_type)}, reason=业务编号前缀必须与周期一致，应为 ${format_period_type(expected_period_type)}`,
            )];
        }

        return [];
    });

const collect_forbidden_code_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records
        .filter((record) => record.code === FORBIDDEN_TASK_CODE)
        .map((record) => to_error(record, "code", `reason=${FORBIDDEN_TASK_CODE} 是预留占位编号，不允许配置`));

const collect_required_code_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.some((record) => record.code === REQUIRED_TASK_CODE)
        ? []
        : [`excel=${ERROR_SOURCE_TASK_EXCEL}, reason=${REQUIRED_TASK_CODE} 必须配置`];

const collect_task_id_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> => {
    const code_by_task_id = new Map<number, string>();
    return records.flatMap((record) => {
        const errors: string[] = [];
        if (record.task_id <= 0) {
            errors.push(to_error(record, "taskId", `taskId=${record.task_id}, reason=taskId 必须大于 0`));
        }

        const duplicated_code = code_by_task_id.get(record.task_id);
        if (duplicated_code !== undefined) {
            errors.push(to_error(
                record,
                "taskId",
                `taskId=${record.task_id}, reason=taskId 与 code=${duplicated_code} 重复，会导致领奖凭证冲突`,
            ));
        }
        code_by_task_id.set(record.task_id, record.code);

        return errors;
    });
};

const collect_numeric_field_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        if (record.active_score <= 0) {
            errors.push(to_error(record, "activeScore", `activeScore=${record.active_score}, reason=活跃分必须大于 0`));
        }
        if (record.sort <= 0) {
            errors.push(to_error(record, "sort", `sort=${record.sort}, reason=展示序号必须大于 0`));
        }

        return errors;
    });

const collect_open_mode_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records
        .filter((record) => dailyweeklytask.OpenMode[record.open_mode] === undefined)
        .map((record) => to_error(record, "openMode", `openMode=${record.open_mode}, reason=非法的关联玩法开放策略`));

const collect_open_system_id_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const seen_ids = new Set<string>();
        return (record.open_system_ids ?? []).flatMap((system_open_id) => {
            const errors: string[] = [];
            if (String(system_open_id ?? "").trim() === "") {
                errors.push(to_error(record, "openSystemIds", "reason=关联玩法开放条目不能为空"));
            }
            if (seen_ids.has(system_open_id)) {
                errors.push(to_error(record, "openSystemIds", `openSystemId=${system_open_id}, reason=关联玩法开放条目重复`));
            }
            seen_ids.add(system_open_id);

            return errors;
        });
    });

const collect_task_reward_errors = (records: ReadonlyArray<DailyWeeklyTaskRecord>): ReadonlyArray<string> =>
    records.flatMap((record) =>
        collect_reward_errors(ERROR_SOURCE_TASK_EXCEL, record.source_location, `code=${record.code}`, record.reward ?? [])
    );

describe("日周任务表配置校验", () => {
    let records: ReadonlyArray<DailyWeeklyTaskRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_daily_weekly_task_records();
    });

    it("should 任务表不能为空", () => {
        assert_no_errors("日周任务表内容缺失：", collect_empty_table_errors(records));
    });

    it("should 业务编号合法且与周期一致", () => {
        assert_no_errors("日周任务业务编号非法：", [
            ...collect_code_errors(records),
            ...collect_forbidden_code_errors(records),
            ...collect_required_code_errors(records),
        ]);
    });

    it("should taskId 大于 0 且全表唯一", () => {
        assert_no_errors("日周任务 taskId 非法：", collect_task_id_errors(records));
    });

    it("should 活跃分与展示序号大于 0", () => {
        assert_no_errors("日周任务数值字段非法：", collect_numeric_field_errors(records));
    });

    it("should 关联玩法开放策略与开放条目合法", () => {
        assert_no_errors("日周任务关联玩法配置非法：", [
            ...collect_open_mode_errors(records),
            ...collect_open_system_id_errors(records),
        ]);
    });

    it("should 任务奖励合法", () => {
        assert_no_errors("日周任务奖励非法：", collect_task_reward_errors(records));
    });
});
