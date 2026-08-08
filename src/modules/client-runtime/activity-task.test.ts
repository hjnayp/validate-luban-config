import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type ActivityTaskEntryRecord = Readonly<{
    row_id: number;
    task_id: number;
}>;

type ActivityTaskRecord = Readonly<{
    sub_activity_id: number;
    tasks: ReadonlyArray<ActivityTaskEntryRecord>;
}>;

const format_error = (
    sub_activity_id: number,
    row_id: number,
    field: string,
    reason: string,
): string =>
    `table=TbActTask, activity=${sub_activity_id}, rowId=${row_id}, field=${field}, reason=${reason}`;

const collect_activity_task_errors = (
    records: ReadonlyArray<ActivityTaskRecord>,
    taskv1_config_size_by_id: ReadonlyMap<number, number>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const seen_row_ids = new Set<number>();
        return record.tasks.flatMap((task) => {
            const errors: string[] = [];
            if (seen_row_ids.has(task.row_id)) {
                errors.push(format_error(
                    record.sub_activity_id,
                    task.row_id,
                    "tasks.rowId",
                    "同一活动配置中的 rowId 必须唯一，否则客户端查找与领奖请求无法区分任务行",
                ));
            }
            seen_row_ids.add(task.row_id);

            const config_size = taskv1_config_size_by_id.get(task.task_id);
            if (config_size === undefined) {
                errors.push(format_error(
                    record.sub_activity_id,
                    task.row_id,
                    "tasks.taskId",
                    `taskId=${task.task_id} 在 TbTaskv1 中不存在`,
                ));
            }
            else if (config_size === 0) {
                errors.push(format_error(
                    record.sub_activity_id,
                    task.row_id,
                    "tasks.taskId",
                    `taskId=${task.task_id} 对应的 TbTaskv1.config[0] 不可用`,
                ));
            }

            return errors;
        });
    });

const collect_activity_task_records = (): ReadonlyArray<ActivityTaskRecord> =>
    tb.TbActTask.getDataList().map((config) => ({
        sub_activity_id: config.subActivityId,
        tasks: config.tasks.map((task) => ({
            row_id: task.rowId,
            task_id: task.taskId,
        })),
    }));

const collect_taskv1_config_sizes = (): ReadonlyMap<number, number> =>
    new Map(tb.TbTaskv1.getDataList().map((config) => [config.taskId, config.config.length]));

describe("客户端活动任务配置消费契约校验", () => {
    let records: ReadonlyArray<ActivityTaskRecord>;
    let taskv1_config_size_by_id: ReadonlyMap<number, number>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_activity_task_records();
        taskv1_config_size_by_id = collect_taskv1_config_sizes();
    });

    it("should 合成坏数据能一次报告重复行、缺失任务与不可用首配置", () => {
        const invalid_records: ReadonlyArray<ActivityTaskRecord> = [
            {
                sub_activity_id: 9101,
                tasks: [
                    {row_id: 1, task_id: 101},
                    {row_id: 1, task_id: 102},
                    {row_id: 2, task_id: 103},
                    {row_id: 3, task_id: 999},
                ],
            },
            // rowId 只需在各自 subActivityId 内唯一；请求载荷同时携带 subActivityId。
            {sub_activity_id: 9102, tasks: [{row_id: 1, task_id: 101}]},
        ];
        const config_sizes = new Map<number, number>([
            [101, 1],
            [102, 1],
            [103, 0],
        ]);

        const errors = collect_activity_task_errors(invalid_records, config_sizes);
        const report = errors.join("\n");

        expect(errors).toHaveLength(3);
        expect(report).toContain("table=TbActTask, activity=9101, rowId=1, field=tasks.rowId");
        expect(report).toContain("activity=9101, rowId=2, field=tasks.taskId, reason=taskId=103 对应的 TbTaskv1.config[0] 不可用");
        expect(report).toContain("activity=9101, rowId=3, field=tasks.taskId, reason=taskId=999 在 TbTaskv1 中不存在");
    });

    it("should 当前配置满足客户端活动任务的真实消费契约", () => {
        assert_no_errors(
            "存在客户端活动任务配置消费错误：",
            collect_activity_task_errors(records, taskv1_config_size_by_id),
        );
    });
});
