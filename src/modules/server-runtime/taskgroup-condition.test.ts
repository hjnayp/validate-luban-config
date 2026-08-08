import { beforeAll, describe, it } from "vitest";
import { taskv1 } from "../../../gen/schema";
import { assert_no_errors } from "../../infra/assert";
import { cfg_mgr, tb } from "../../infra/tb";

const INT32_MAX = 2_147_483_647;
const TRIGGER_KEY_SYSTEM_ID = 1;
const TRIGGER_SYSTEM_OPEN = "system_open";

type TaskMemberRecord = Readonly<{
    task_id: number;
}>;

type TaskGroupRecord = Readonly<{
    group_id: number;
    trigger_type: string;
    trigger_params: ReadonlyMap<number, number>;
    tasks: ReadonlyArray<TaskMemberRecord>;
}>;

type TaskSystemRecord = Readonly<{
    system_id: number;
    groups: ReadonlyArray<TaskGroupRecord>;
}>;

type ConditionGroupRecord = Readonly<{
    id: number;
    unit_ids: ReadonlyArray<number>;
}>;

type ConditionUnitRecord = Readonly<{
    id: number;
    event_type: number;
    op: number;
    val: number;
}>;

const SUPPORTED_CONDITION_EVENT_TYPES: ReadonlySet<number> = new Set([
    taskv1.EventType.userlogin,
    taskv1.EventType.useruplevel,
    taskv1.EventType.finishstagemaininstance,
    taskv1.EventType.purchaseproduct,
    taskv1.EventType.tower,
    taskv1.EventType.buildingfogareadispelled,
]);

const format_error = (table: string, id: string | number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const is_positive_int32 = (value: number): boolean =>
    Number.isSafeInteger(value) && value > 0 && value <= INT32_MAX;

const collect_taskgroup_errors = (
    systems: ReadonlyArray<TaskSystemRecord>,
    task_ids: ReadonlySet<number>,
    system_open_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const task_owner_by_id = new Map<number, string>();

    systems.forEach((system) => {
        const group_ids = new Set<number>();
        system.groups.forEach((group) => {
            const group_record = `${system.system_id}.${group.group_id}`;
            if (group_ids.has(group.group_id)) {
                errors.push(format_error(
                    "TbTaskGroup",
                    group_record,
                    "groupId",
                    "同一 systemId 下 groupId 重复，GetGroup 只返回首个配置且领奖 key 冲突",
                ));
            }
            group_ids.add(group.group_id);

            const trigger_type = group.trigger_type || TRIGGER_SYSTEM_OPEN;
            if (trigger_type !== TRIGGER_SYSTEM_OPEN) {
                errors.push(format_error(
                    "TbTaskGroup",
                    group_record,
                    "triggerType",
                    `triggerType=${group.trigger_type || "<empty>"} 未注册 TriggerSource，BindTriggers 不会激活该组`,
                ));
            }
            else {
                const configured_system_open_id = group.trigger_params.get(TRIGGER_KEY_SYSTEM_ID);
                const effective_system_open_id = configured_system_open_id === undefined || configured_system_open_id === 0
                    ? system.system_id
                    : configured_system_open_id;
                if (!is_positive_int32(effective_system_open_id)) {
                    errors.push(format_error(
                        "TbTaskGroup",
                        group_record,
                        "triggerParams[1]",
                        `systemOpenId=${effective_system_open_id} 经服务端 int64→int32 后不能安全绑定系统开放回调`,
                    ));
                }
                else if (!system_open_ids.has(String(effective_system_open_id))) {
                    errors.push(format_error(
                        "TbTaskGroup",
                        group_record,
                        "triggerParams[1]",
                        `systemOpenId=${effective_system_open_id} 不存在于 TbSystemOpen，回调永远不会触发`,
                    ));
                }
            }

            if (group.tasks.length === 0) {
                errors.push(format_error(
                    "TbTaskGroup",
                    group_record,
                    "tasks",
                    "成员为空时激活不会创建 taskv1，allFinished 也恒为 false",
                ));
            }

            group.tasks.forEach((member, index) => {
                const field = `tasks[${index}].taskId`;
                if (!is_positive_int32(member.task_id)) {
                    errors.push(format_error(
                        "TbTaskGroup",
                        group_record,
                        field,
                        `taskId=${member.task_id} 不能注册 taskv1 完成回调`,
                    ));
                    return;
                }
                if (!task_ids.has(member.task_id)) {
                    errors.push(format_error(
                        "TbTaskGroup",
                        group_record,
                        field,
                        `taskId=${member.task_id} 不存在于 TbTaskv1，addGroupTask 会跳过且任务组停滞`,
                    ));
                }

                const owner = task_owner_by_id.get(member.task_id);
                if (owner !== undefined) {
                    errors.push(format_error(
                        "TbTaskGroup",
                        group_record,
                        field,
                        `taskId=${member.task_id} 已被 ${owner} 使用；完成回调按 taskId 单例注册，后注册错误被忽略`,
                    ));
                }
                else {
                    task_owner_by_id.set(member.task_id, `${group_record}.${field}`);
                }
            });
        });
    });

    return errors;
};

const collect_condition_errors = (
    groups: ReadonlyArray<ConditionGroupRecord>,
    units: ReadonlyArray<ConditionUnitRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const unit_ids = new Set(units.map((unit) => unit.id));
    const referenced_unit_ids = new Set(groups.flatMap((group) => group.unit_ids));
    const seen_group_ids = new Set<number>();
    const seen_unit_ids = new Set<number>();

    groups.forEach((group) => {
        if (group.id === 0) {
            errors.push(format_error(
                "TbConditionGroup",
                group.id,
                "id",
                "id=0 是 IsSatisfied 的无条件哨兵，配置内容永远不会被求值",
            ));
        }
        if (seen_group_ids.has(group.id)) {
            errors.push(format_error(
                "TbConditionGroup",
                group.id,
                "id",
                "id 重复会在服务端条件组 map 中相互覆盖",
            ));
        }
        seen_group_ids.add(group.id);
        group.unit_ids.forEach((unit_id, index) => {
            if (!unit_ids.has(unit_id)) {
                errors.push(format_error(
                    "TbConditionGroup",
                    group.id,
                    `listConditions[${index}]`,
                    `conditionUnitId=${unit_id} 不存在于 TbConditionUnit；BuildIndex 静默跳过且 evaluateUnit 恒为 false`,
                ));
            }
        });
    });

    units.forEach((unit) => {
        if (seen_unit_ids.has(unit.id)) {
            errors.push(format_error(
                "TbConditionUnit",
                unit.id,
                "id",
                "id 重复会在服务端条件单元 map 中相互覆盖",
            ));
        }
        seen_unit_ids.add(unit.id);
        if (!referenced_unit_ids.has(unit.id)) {
            return;
        }
        if (!SUPPORTED_CONDITION_EVENT_TYPES.has(unit.event_type)) {
            errors.push(format_error(
                "TbConditionUnit",
                unit.id,
                "eventType",
                `eventType=${unit.event_type} 没有注册状态 Fetcher，evaluateUnit 恒为 false`,
            ));
        }
        if (unit.event_type === taskv1.EventType.buildingfogareadispelled) {
            if (unit.op !== taskv1.OperateType._3) {
                errors.push(format_error(
                    "TbConditionUnit",
                    unit.id,
                    "op",
                    `迷雾条件 op=${unit.op} 不会进入服务端特殊求值分支，且 eventType=50 没有通用 Fetcher`,
                ));
            }
            if (!is_positive_int32(unit.val)) {
                errors.push(format_error(
                    "TbConditionUnit",
                    unit.id,
                    "val",
                    `迷雾区域 val=${unit.val} 转 int32 后无法通过正数与回转一致性检查，evaluateUnit 恒为 false`,
                ));
            }
        }
    });

    return errors;
};

const collect_current_task_systems = (): ReadonlyArray<TaskSystemRecord> =>
    tb.TbTaskGroup.getDataList().map((system) => ({
        system_id: system.systemId,
        groups: system.config.map((group) => ({
            group_id: group.groupId,
            trigger_type: group.triggerType,
            trigger_params: group.triggerParams,
            tasks: group.tasks.map((task) => ({task_id: task.taskId})),
        })),
    }));

const collect_current_condition_groups = (): ReadonlyArray<ConditionGroupRecord> =>
    tb.TbConditionGroup.getDataList().map((group) => ({
        id: group.id,
        unit_ids: group.listConditions,
    }));

const collect_current_condition_units = (): ReadonlyArray<ConditionUnitRecord> =>
    tb.TbConditionUnit.getDataList().map((unit) => ({
        id: unit.id,
        event_type: unit.eventType,
        op: unit.op,
        val: unit.val,
    }));

const verify_synthetic_errors = (
    errors: ReadonlyArray<string>,
    expected_fragments: ReadonlyArray<string>,
): ReadonlyArray<string> => [
    ...(errors.length === expected_fragments.length
        ? []
        : [format_error("SyntheticFixture", "taskgroup-condition", "errors", `实际错误数=${errors.length}，预期=${expected_fragments.length}`)]),
    ...errors.flatMap((message) =>
        /^table=.+, id=.+, field=.+, reason=.+$/u.test(message)
            ? []
            : [format_error("SyntheticFixture", "taskgroup-condition", "format", `错误格式非法=${message}`)]
    ),
    ...expected_fragments.flatMap((fragment) =>
        errors.some((message) => message.includes(fragment))
            ? []
            : [format_error("SyntheticFixture", "taskgroup-condition", "errors", `缺少预期错误片段=${fragment}`)]
    ),
];

describe("服务端任务组与通用条件配置 collector", () => {
    it("合成坏数据一次收集可达错误，并忽略未引用的 inert 条件单元", () => {
        const taskgroup_errors = collect_taskgroup_errors([
            {
                system_id: 1,
                groups: [
                    {group_id: 10, trigger_type: "event", trigger_params: new Map(), tasks: []},
                    {group_id: 10, trigger_type: "system_open", trigger_params: new Map([[1, 9999]]), tasks: [{task_id: 42}]},
                    {group_id: 11, trigger_type: "system_open", trigger_params: new Map([[1, 1008]]), tasks: [{task_id: 42}, {task_id: 99}, {task_id: 0}]},
                ],
            },
        ], new Set([42]), new Set(["1008"]));
        const condition_errors = collect_condition_errors([
            {id: 0, unit_ids: [1, 404]},
            {id: 10, unit_ids: [2]},
            {id: 10, unit_ids: []},
        ], [
            {id: 1, event_type: 999, op: taskv1.OperateType._3, val: 1},
            {id: 2, event_type: taskv1.EventType.buildingfogareadispelled, op: taskv1.OperateType._2, val: 0},
            {id: 2, event_type: taskv1.EventType.useruplevel, op: taskv1.OperateType._2, val: 1},
            {id: 3, event_type: taskv1.EventType.buildingfogareadispelled, op: taskv1.OperateType._2, val: 0},
        ]);
        const errors = [...taskgroup_errors, ...condition_errors];
        assert_no_errors("合成任务组与条件校验器未覆盖预期错误：", verify_synthetic_errors(errors, [
            "groupId 重复",
            "未注册 TriggerSource",
            "成员为空",
            "不存在于 TbSystemOpen",
            "不存在于 TbTaskv1",
            "完成回调按 taskId 单例注册",
            "不能注册 taskv1 完成回调",
            "id=0 是 IsSatisfied",
            "条件组 map 中相互覆盖",
            "不存在于 TbConditionUnit",
            "没有注册状态 Fetcher",
            "迷雾条件 op=",
            "回转一致性检查",
            "条件单元 map 中相互覆盖",
        ]));
    });
});

describe("服务端任务组与通用条件配置", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("当前配置满足任务组激活与条件求值的服务端运行契约", () => {
        const errors = [
            ...collect_taskgroup_errors(
                collect_current_task_systems(),
                new Set(tb.TbTaskv1.getDataMap().keys()),
                new Set(tb.TbSystemOpen.getDataMap().keys()),
            ),
            ...collect_condition_errors(
                collect_current_condition_groups(),
                collect_current_condition_units(),
            ),
        ];
        assert_no_errors("存在服务端无法安全激活或求值的任务组/条件配置：", errors);
    });
});
