import {beforeAll, describe, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr} from "../../infra/tb";
import {
    collect_daily_weekly_task_const_record,
    DailyWeeklyTaskConstRecord,
    ERROR_SOURCE_CONST_EXCEL,
    format_daily_weekly_task_error,
} from "./records";

const collect_const_errors = (record: DailyWeeklyTaskConstRecord): ReadonlyArray<string> => {
    const errors: string[] = [];
    if (record.id <= 0) {
        errors.push(format_daily_weekly_task_error(
            ERROR_SOURCE_CONST_EXCEL,
            record.source_location,
            "id",
            `id=${record.id}, reason=常量表主键必须大于 0`,
        ));
    }
    if (String(record.system_open_id ?? "").trim() === "") {
        errors.push(format_daily_weekly_task_error(
            ERROR_SOURCE_CONST_EXCEL,
            record.source_location,
            "systemOpenId",
            "reason=任务中心开放条目 systemOpenId 不能为空",
        ));
    }

    return errors;
};

describe("日周任务常量配置校验", () => {
    let record: DailyWeeklyTaskConstRecord;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        record = collect_daily_weekly_task_const_record();
    });

    it("should 常量表主键与开放条目合法", () => {
        assert_no_errors("日周任务常量表存在非法字段：", collect_const_errors(record));
    });
});
