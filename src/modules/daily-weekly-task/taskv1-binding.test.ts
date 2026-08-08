import {beforeAll, describe, it} from "vitest";
import {resolve} from "node:path";
import {taskv1} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {
    build_excel_row_index_by_composite_key,
    ExcelRowLocation,
    format_excel_error_source,
    make_excel_row_key,
} from "../../infra/excel_source";
import {cfg_mgr, tb} from "../../infra/tb";
import {collect_daily_weekly_task_records, DailyWeeklyTaskRecord} from "./records";

const ERROR_SOURCE_TASKV1_EXCEL = "任务详情@R-任务系统.xlsx";
const TASKV1_EXCEL_PATH = resolve(process.cwd(), "..", "..", "config", "配置表", "R-任务系统.xlsx");
// 任务详情把 config 数组展开成多行，taskId 只写在首行，子任务行继承它。
const TASKV1_HEADER_ROWS = [1, 4];
const TASKV1_DATA_START_ROW = 7;

// taskType 是裸 int：0 统计累加、1 更新类向上、2 更新类向下。
const MIN_TASK_TYPE = 0;
const MAX_TASK_TYPE = 2;

/**
 * 日周任务只在当前周期内累计，禁止 inheritTaskId 回填历史进度，
 * 否则玩法中途开放时会直接补满进度。
 */
const FORBIDDEN_INHERIT_TASK_ID = 0;

type SpecialTaskShape = Readonly<{
    event_type: taskv1.EventType;
    condition_key: taskv1.ConditionType;
    condition_value: number;
    target_count: number;
}>;

// 这两条任务的达成口径写死在玩法里，taskv1 侧改动会静默改变玩法语义。
const SPECIAL_TASK_SHAPE_BY_CODE: Readonly<Record<string, SpecialTaskShape>> = {
    W5: {
        event_type: taskv1.EventType.fightstart,
        condition_key: taskv1.ConditionType.fighttype,
        condition_value: 3,
        target_count: 1,
    },
    W6: {
        event_type: taskv1.EventType.subitem,
        condition_key: taskv1.ConditionType.itemid,
        condition_value: 100487,
        target_count: 20,
    },
};

type TaskV1BindingRecord = Readonly<{
    code: string;
    task_id: number;
    taskv1_config: taskv1.Taskv1 | undefined;
    sub_task_locations: ReadonlyMap<number, ExcelRowLocation>;
}>;

const collect_binding_records = (
    task_records: ReadonlyArray<DailyWeeklyTaskRecord>,
    row_index_by_task_and_sub_task_id: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<TaskV1BindingRecord> =>
    task_records.map((task_record) => {
        const taskv1_config = tb.TbTaskv1.get(task_record.task_id);
        const sub_task_locations = new Map<number, ExcelRowLocation>();
        (taskv1_config?.config ?? []).forEach((sub_task) => {
            const location = row_index_by_task_and_sub_task_id.get(
                make_excel_row_key(task_record.task_id, sub_task.subTaskId),
            );
            if (location) {
                sub_task_locations.set(sub_task.subTaskId, location);
            }
        });

        return {
            code: task_record.code,
            task_id: task_record.task_id,
            taskv1_config,
            sub_task_locations,
        };
    });

const to_task_error = (record: TaskV1BindingRecord, field_name: string, detail: string): string =>
    `${format_excel_error_source(ERROR_SOURCE_TASKV1_EXCEL, undefined, {field_name})}, code=${record.code}, taskId=${record.task_id}, ${detail}`;

const to_sub_task_error = (
    record: TaskV1BindingRecord,
    sub_task_id: number,
    field_name: string,
    detail: string,
): string => {
    const location = record.sub_task_locations.get(sub_task_id);
    return `${format_excel_error_source(ERROR_SOURCE_TASKV1_EXCEL, location, {cell_header: field_name, field_name})}, code=${record.code}, taskId=${record.task_id}, subTaskId=${sub_task_id}, ${detail}`;
};

const collect_task_source_errors = (records: ReadonlyArray<TaskV1BindingRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        if (!record.taskv1_config) {
            return [to_task_error(record, "taskId", "reason=taskv1 中找不到对应任务")];
        }
        if (record.taskv1_config.taskSource !== taskv1.TaskSource.dailyweeklytask) {
            return [to_task_error(
                record,
                "taskSource",
                `taskSource=${taskv1.TaskSource[record.taskv1_config.taskSource] ?? record.taskv1_config.taskSource}, reason=日周任务的 taskSource 必须是 dailyweeklytask`,
            )];
        }
        if (record.taskv1_config.config.length <= 0) {
            return [to_task_error(record, "config", "reason=日周任务至少要配置一条子任务")];
        }

        return [];
    });

const collect_sub_task_errors = (records: ReadonlyArray<TaskV1BindingRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const seen_sub_task_ids = new Set<number>();
        return (record.taskv1_config?.config ?? []).flatMap((sub_task) => {
            const errors: string[] = [];
            if (sub_task.subTaskId <= 0) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "subTaskId", "reason=子任务 ID 必须大于 0"));
            }
            if (seen_sub_task_ids.has(sub_task.subTaskId)) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "subTaskId", "reason=同一任务下子任务 ID 重复"));
            }
            seen_sub_task_ids.add(sub_task.subTaskId);

            if (sub_task.eventType <= 0) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "eventType", `eventType=${sub_task.eventType}, reason=非法的监听事件类型`));
            }
            if (sub_task.taskType < MIN_TASK_TYPE || sub_task.taskType > MAX_TASK_TYPE) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "taskType", `taskType=${sub_task.taskType}, reason=任务类型只能是 ${MIN_TASK_TYPE}-${MAX_TASK_TYPE}`));
            }
            if (sub_task.targetCount <= 0) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "targetCount", `targetCount=${sub_task.targetCount}, reason=目标次数必须大于 0`));
            }
            if (sub_task.inheritTaskId !== FORBIDDEN_INHERIT_TASK_ID) {
                errors.push(to_sub_task_error(record, sub_task.subTaskId, "inheritTaskId", `inheritTaskId=${sub_task.inheritTaskId}, reason=日周任务禁止继承历史进度`));
            }

            return [...errors, ...collect_condition_errors(record, sub_task)];
        });
    });

const collect_condition_errors = (
    record: TaskV1BindingRecord,
    sub_task: taskv1.SubTaskBean,
): ReadonlyArray<string> =>
    sub_task.conditions.flatMap((condition) => {
        if (condition.conditionKey > 0 && taskv1.OperateType[condition.operateType] !== undefined) {
            return [];
        }

        return [to_sub_task_error(
            record,
            sub_task.subTaskId,
            "conditions",
            `conditionKey=${condition.conditionKey}, operateType=${condition.operateType}, reason=非法的任务条件`,
        )];
    });

const collect_special_task_errors = (records: ReadonlyArray<TaskV1BindingRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const expected_shape = SPECIAL_TASK_SHAPE_BY_CODE[record.code];
        if (!expected_shape || !record.taskv1_config) {
            return [];
        }

        const sub_tasks = record.taskv1_config.config;
        if (sub_tasks.length !== 1) {
            return [to_task_error(record, "config", `subTaskCount=${sub_tasks.length}, reason=该任务只允许配置一条子任务`)];
        }

        const sub_task = sub_tasks[0];
        const errors: string[] = [];
        if (sub_task.eventType !== expected_shape.event_type) {
            errors.push(to_sub_task_error(
                record,
                sub_task.subTaskId,
                "eventType",
                `eventType=${taskv1.EventType[sub_task.eventType] ?? sub_task.eventType}, reason=该任务的监听事件必须是 ${taskv1.EventType[expected_shape.event_type]}`,
            ));
        }
        if (sub_task.targetCount !== expected_shape.target_count) {
            errors.push(to_sub_task_error(
                record,
                sub_task.subTaskId,
                "targetCount",
                `targetCount=${sub_task.targetCount}, reason=该任务的目标次数必须是 ${expected_shape.target_count}`,
            ));
        }
        if (sub_task.conditions.length !== 1) {
            errors.push(to_sub_task_error(
                record,
                sub_task.subTaskId,
                "conditions",
                `conditionCount=${sub_task.conditions.length}, reason=该任务只允许配置一个条件`,
            ));
            return errors;
        }

        const condition = sub_task.conditions[0];
        const matched = condition.conditionKey === expected_shape.condition_key
            && condition.operateType === taskv1.OperateType._3
            && condition.conditionVal === expected_shape.condition_value;
        if (!matched) {
            errors.push(to_sub_task_error(
                record,
                sub_task.subTaskId,
                "conditions",
                `conditionKey=${condition.conditionKey}, operateType=${condition.operateType}, conditionVal=${condition.conditionVal}, reason=该任务的条件必须是 ${taskv1.ConditionType[expected_shape.condition_key]} 等于 ${expected_shape.condition_value}`,
            ));
        }

        return errors;
    });

describe("日周任务与 taskv1 绑定校验", () => {
    let records: ReadonlyArray<TaskV1BindingRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        const row_index_by_task_and_sub_task_id = build_excel_row_index_by_composite_key({
            excel_path: TASKV1_EXCEL_PATH,
            sheet_name: "任务详情",
            parent_key_column_name: "taskId",
            child_key_column_name: "subTaskId",
            header_rows: TASKV1_HEADER_ROWS,
            data_start_row: TASKV1_DATA_START_ROW,
            inherit_parent_key_from_previous_row: true,
        });
        records = collect_binding_records(collect_daily_weekly_task_records(), row_index_by_task_and_sub_task_id);
    });

    it("should 每条日周任务都绑定 dailyweeklytask 来源的 taskv1 任务", () => {
        assert_no_errors("日周任务的 taskv1 绑定非法：", collect_task_source_errors(records));
    });

    it("should 子任务字段合法且不继承历史进度", () => {
        assert_no_errors("日周任务的 taskv1 子任务非法：", collect_sub_task_errors(records));
    });

    it("should 玩法口径写死的任务与 taskv1 完全一致", () => {
        assert_no_errors("日周任务的 taskv1 玩法口径不一致：", collect_special_task_errors(records));
    });
});
