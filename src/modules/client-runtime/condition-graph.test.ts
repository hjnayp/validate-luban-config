import {beforeAll, describe, expect, it} from "vitest";
import {condition, taskv1} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type ConfigConditionRecord = Readonly<{
    table: "TbBuilding" | "TbBuildingProduce";
    id: string | number;
    field: string;
    condition: string;
}>;

type ConditionGroupReferenceRecord = Readonly<{
    table: "TbBuildingFogArea" | "TbAwakenEquipmentSkillLevel" | "TbAwakenTalent";
    id: string | number;
    field: string;
    group_id: number;
    consumer: "fog" | "awaken";
}>;

type ConditionGroupRecord = Readonly<{
    id: number;
    relation: number;
    unit_ids: ReadonlyArray<number>;
}>;

type ConditionUnitRecord = Readonly<{
    id: number;
    event_type: number;
    operate_type: number;
    value: number;
}>;

type SystemOpenRecord = Readonly<{
    id: string;
    main_tasks: ReadonlyArray<Readonly<{stage: string; task_index: number}>>;
    main_instances: ReadonlyArray<Readonly<{group_id: number; stage_id: number}>>;
    fog_area_ids: ReadonlyArray<number>;
}>;

type BuildingSystemOpenReference = Readonly<{
    building_id: number;
    system_open_id: string;
}>;

type FogAreaBuildingReference = Readonly<{
    area_id: number;
    building_id: number;
    index: number;
}>;

type OpenGraphRecords = Readonly<{
    system_opens: ReadonlyArray<SystemOpenRecord>;
    building_system_references: ReadonlyArray<BuildingSystemOpenReference>;
    fog_building_references: ReadonlyArray<FogAreaBuildingReference>;
}>;

const format_error = (
    table: string,
    id: string | number,
    field: string,
    reason: string,
): string => `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
    "=",
    "==",
    "!=",
    ">",
    "<",
    ">=",
    "<=",
]);

const collect_config_condition_errors = (
    records: ReadonlyArray<ConfigConditionRecord>,
    building_ids: ReadonlySet<number>,
    job_type_ids: ReadonlySet<number>,
    race_type_ids: ReadonlySet<number>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        const parts = record.condition.split(",");
        if (parts.length !== 3) {
            errors.push(format_error(
                record.table,
                record.id,
                record.field,
                `条件必须恰好包含 key,operator,target 三段，当前为 ${parts.length} 段`,
            ));
        }
        if (parts.length < 3) return errors;

        const [key, operator, target] = parts;
        const validate_numeric_comparison = (): void => {
            if (!COMPARISON_OPERATORS.has(operator)) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${record.field}.operator`,
                    `operator=${operator || "<empty>"} 不会被 ConditionService.createConditionEvaluator 识别`,
                ));
            }
            if (!Number.isFinite(Number(target))) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${record.field}.target`,
                    `target=${target || "<empty>"} 转为数字后不是有限值`,
                ));
            }
        };

        if (key === "miaoShenDianLv" || key === "userLevel") {
            validate_numeric_comparison();
            return errors;
        }

        if (key.startsWith("BuildingLv")) {
            validate_numeric_comparison();
            if (!key.startsWith("BuildingLv_") || key.length === "BuildingLv_".length) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${record.field}.key`,
                    "BuildingLv 条件必须在下划线后至少指定一个建筑ID",
                ));
                return errors;
            }

            key.slice("BuildingLv_".length).split("_").forEach((building_id_text) => {
                // 与客户端 ConditionService 的 Number.parseInt 完全一致；例如 "1x" 会稳定读取建筑 1。
                const building_id = Number.parseInt(building_id_text);
                if (!Number.isFinite(building_id)) {
                    errors.push(format_error(
                        record.table,
                        record.id,
                        `${record.field}.key`,
                        `BuildingLv 参数=${building_id_text || "<empty>"} 经 Number.parseInt 后不是有效建筑ID，客户端会读取无效房间`,
                    ));
                    return;
                }

                if (!building_ids.has(building_id)) {
                    errors.push(format_error(
                        record.table,
                        record.id,
                        `${record.field}.key`,
                        `BuildingLv 引用的 TbBuilding(${building_id}) 不存在`,
                    ));
                }
            });
            return errors;
        }

        if (key === "HeroJobUnLock" || key === "HeroRaceUnLock") {
            const target_id = Number(target);
            const target_ids = key === "HeroJobUnLock" ? job_type_ids : race_type_ids;
            const target_table = key === "HeroJobUnLock" ? "TbJobType" : "TbRaceType";
            if (!Number.isFinite(target_id) || !target_ids.has(target_id)) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${record.field}.target`,
                    `${key} 引用的 ${target_table}(${target || "<empty>"}) 不存在`,
                ));
            }
            return errors;
        }

        if (key === "UseItem") {
            if (target.trim().length === 0) {
                errors.push(format_error(
                    record.table,
                    record.id,
                    `${record.field}.target`,
                    "UseItem 必须提供非空 itemId，否则不会注册产物解锁目标",
                ));
            }
            return errors;
        }

        errors.push(format_error(
            record.table,
            record.id,
            `${record.field}.key`,
            `key=${key || "<empty>"} 没有 ConditionService 分支，客户端会按默认成功静默跳过条件`,
        ));
        return errors;
    });

const collect_condition_group_graph_errors = (
    references: ReadonlyArray<ConditionGroupReferenceRecord>,
    groups: ReadonlyArray<ConditionGroupRecord>,
    units: ReadonlyArray<ConditionUnitRecord>,
    main_instance_ids: ReadonlySet<number>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const groups_by_id = new Map(groups.map((group) => [group.id, group]));
    const units_by_id = new Map(units.map((unit) => [unit.id, unit]));
    const referenced_group_ids = new Set<number>();
    const fog_group_ids = new Set<number>();

    references.forEach((reference) => {
        if (!groups_by_id.has(reference.group_id)) {
            errors.push(format_error(
                reference.table,
                reference.id,
                reference.field,
                `conditionGroupId=${reference.group_id} 在 TbConditionGroup 中不存在`,
            ));
            return;
        }
        referenced_group_ids.add(reference.group_id);
        if (reference.consumer === "fog") fog_group_ids.add(reference.group_id);
    });

    const reported_fog_unit_ids = new Set<number>();
    referenced_group_ids.forEach((group_id) => {
        const group = groups_by_id.get(group_id)!;
        if (group.relation !== condition.ConditionRelation.And
            && group.relation !== condition.ConditionRelation.Or) {
            errors.push(format_error(
                "TbConditionGroup",
                group.id,
                "relation",
                `relation=${group.relation} 不是客户端可识别的 AND/OR 组合关系`,
            ));
        }

        group.unit_ids.forEach((unit_id, index) => {
            const unit = units_by_id.get(unit_id);
            if (unit == null) {
                errors.push(format_error(
                    "TbConditionGroup",
                    group.id,
                    `listConditions[${index}]`,
                    `conditionUnitId=${unit_id} 在 TbConditionUnit 中不存在`,
                ));
                return;
            }

            // BuildModel.getFogConditionUnitTip 对「主线关卡 >=」会精确读取 TbMainInstance.get(val)。
            if (fog_group_ids.has(group.id)
                && unit.event_type === taskv1.EventType.finishstagemaininstance
                && unit.operate_type === taskv1.OperateType._2
                && !main_instance_ids.has(unit.value)
                && !reported_fog_unit_ids.has(unit.id)) {
                reported_fog_unit_ids.add(unit.id);
                errors.push(format_error(
                    "TbConditionUnit",
                    unit.id,
                    "val",
                    `主城迷雾提示按 stageId=${unit.value} 精确读取 TbMainInstance，但该关卡不存在`,
                ));
            }
        });
    });

    return errors;
};

const collect_open_graph_errors = (
    records: OpenGraphRecords,
    system_open_ids: ReadonlySet<string>,
    main_task_ids: ReadonlySet<string>,
    main_instances_by_id: ReadonlyMap<number, Readonly<{group: number}>>,
    main_instance_group_ids: ReadonlySet<number>,
    fog_area_ids: ReadonlySet<number>,
    building_ids: ReadonlySet<number>,
): ReadonlyArray<string> => {
    const errors: string[] = [];

    records.system_opens.forEach((record) => {
        record.main_tasks.forEach(({stage}) => {
            if (!main_task_ids.has(stage)) {
                errors.push(format_error(
                    "TbSystemOpen",
                    record.id,
                    "mainTask",
                    `stage=${stage} 在 TbMainTask 中不存在，锁定文案精确查找会返回 undefined`,
                ));
            }
        });

        record.main_instances.forEach(({group_id, stage_id}) => {
            const stage = main_instances_by_id.get(stage_id);
            if (!main_instance_group_ids.has(group_id)) {
                errors.push(format_error(
                    "TbSystemOpen",
                    record.id,
                    "mainInstance.group",
                    `groupId=${group_id} 在 TbMainInstanceGlobalMap 中不存在`,
                ));
            }
            if (stage == null) {
                errors.push(format_error(
                    "TbSystemOpen",
                    record.id,
                    "mainInstance.stage",
                    `stageId=${stage_id} 在 TbMainInstance 中不存在，锁定文案精确查找会返回 undefined`,
                ));
            }
            else if (stage.group !== group_id) {
                errors.push(format_error(
                    "TbSystemOpen",
                    record.id,
                    "mainInstance",
                    `配置 groupId=${group_id}，但 TbMainInstance(${stage_id}).group=${stage.group}`,
                ));
            }
        });

        record.fog_area_ids.forEach((area_id, index) => {
            if (!fog_area_ids.has(area_id)) {
                errors.push(format_error(
                    "TbSystemOpen",
                    record.id,
                    `buildingfogareadispelled[${index}]`,
                    `areaId=${area_id} 在 TbBuildingFogArea 中不存在，客户端迷雾状态查找将一直为 undefined`,
                ));
            }
        });
    });

    records.building_system_references.forEach((reference) => {
        if (reference.system_open_id !== "" && !system_open_ids.has(reference.system_open_id)) {
            errors.push(format_error(
                "TbBuilding",
                reference.building_id,
                "systemOpenId",
                `systemOpenId=${reference.system_open_id} 在 TbSystemOpen 中不存在`,
            ));
        }
    });

    records.fog_building_references.forEach((reference) => {
        if (!building_ids.has(reference.building_id)) {
            errors.push(format_error(
                "TbBuildingFogArea",
                reference.area_id,
                `buildingIds[${reference.index}]`,
                `buildingId=${reference.building_id} 在 TbBuilding 中不存在`,
            ));
        }
    });

    return errors;
};

const collect_current_condition_records = (): ReadonlyArray<ConfigConditionRecord> => [
    ...tb.TbBuilding.getDataList().flatMap((building) =>
        Array.from(building.config.entries()).flatMap(([level, config]) =>
            config.upgradeCondition.map((configured_condition, index) => ({
                table: "TbBuilding" as const,
                id: building.id,
                field: `config[${level}].upgradeCondition[${index}]`,
                condition: configured_condition,
            }))
        )
    ),
    ...tb.TbBuildingProduce.getDataList().flatMap((building) =>
        Array.from(building.config.entries()).flatMap(([product_id, config]) =>
            config.produceCondition.map((configured_condition, index) => ({
                table: "TbBuildingProduce" as const,
                id: `${building.id}:${product_id}`,
                field: `config[${product_id}].produceCondition[${index}]`,
                condition: configured_condition,
            }))
        )
    ),
];

type AwakenEquipmentSkillConditionRecord = Readonly<{
    id: number;
    levels: ReadonlyMap<number, Readonly<{conditions: ReadonlyArray<number>}>>;
}>;

const collect_reachable_awaken_skill_condition_group_references = (
    skill_ids: ReadonlySet<number>,
    skills: ReadonlyArray<AwakenEquipmentSkillConditionRecord>,
): ReadonlyArray<ConditionGroupReferenceRecord> => skills
    .filter((skill) => skill_ids.has(skill.id))
    .flatMap((skill) =>
        Array.from(skill.levels.entries()).flatMap(([level, config]) =>
            config.conditions.map((group_id, index) => ({
                table: "TbAwakenEquipmentSkillLevel" as const,
                id: skill.id,
                field: `levels[${level}].conditions[${index}]`,
                group_id,
                consumer: "awaken" as const,
            }))
        )
    );

const collect_current_condition_group_references = (): ReadonlyArray<ConditionGroupReferenceRecord> => [
    ...tb.TbBuildingFogArea.getDataList().flatMap((area) =>
        area.conditions.map((group_id, index) => ({
            table: "TbBuildingFogArea" as const,
            id: area.id,
            field: `conditions[${index}]`,
            group_id,
            consumer: "fog" as const,
        }))
    ),
    ...collect_reachable_awaken_skill_condition_group_references(
        new Set(tb.TbAwakenEquipmentLevel.getDataList().flatMap((equipment) =>
            [equipment.skill1, equipment.skill2, equipment.skill3].filter((skill_id) => skill_id > 0)
        )),
        tb.TbAwakenEquipmentSkillLevel.getDataList(),
    ),
    ...tb.TbAwakenTalent.getDataList().flatMap((talent) =>
        talent.unlockCondition.map((group_id, index) => ({
            table: "TbAwakenTalent" as const,
            id: talent.id,
            field: `unlockCondition[${index}]`,
            group_id,
            consumer: "awaken" as const,
        }))
    ),
];

const collect_current_open_graph_records = (): OpenGraphRecords => ({
    system_opens: tb.TbSystemOpen.getDataList().map((config) => ({
        id: config.id,
        // 客户端只消费 firstEntry；多项本身由 feature-economy 的 cardinality 规则阻断。
        main_tasks: Array.from(config.mainTask.entries()).slice(0, 1).map(([stage, task_index]) => ({stage, task_index})),
        main_instances: Array.from(config.mainInstance.entries()).slice(0, 1).map(([group_id, stage_id]) => ({
            group_id,
            stage_id,
        })),
        fog_area_ids: config.buildingfogareadispelled,
    })),
    building_system_references: tb.TbBuilding.getDataList().map((building) => ({
        building_id: building.id,
        system_open_id: building.systemOpenId,
    })),
    fog_building_references: tb.TbBuildingFogArea.getDataList().flatMap((area) =>
        area.buildingIds.map((building_id, index) => ({area_id: area.id, building_id, index}))
    ),
});

const collect_current_config_errors = (): ReadonlyArray<string> => {
    const building_ids = new Set(tb.TbBuilding.getDataMap().keys());
    const condition_groups = tb.TbConditionGroup.getDataList().map((group) => ({
        id: group.id,
        relation: group.relation,
        unit_ids: group.listConditions,
    }));
    const condition_units = tb.TbConditionUnit.getDataList().map((unit) => ({
        id: unit.id,
        event_type: unit.eventType,
        operate_type: unit.op,
        value: unit.val,
    }));
    const main_instances_by_id = new Map(tb.TbMainInstance.getDataList().map((stage) => [
        stage.id,
        {group: stage.group},
    ]));

    return [
        ...collect_config_condition_errors(
            collect_current_condition_records(),
            building_ids,
            new Set(tb.TbJobType.getDataMap().keys()),
            new Set(tb.TbRaceType.getDataMap().keys()),
        ),
        ...collect_condition_group_graph_errors(
            collect_current_condition_group_references(),
            condition_groups,
            condition_units,
            new Set(main_instances_by_id.keys()),
        ),
        ...collect_open_graph_errors(
            collect_current_open_graph_records(),
            new Set(tb.TbSystemOpen.getDataMap().keys()),
            new Set(tb.TbMainTask.getDataMap().keys()),
            main_instances_by_id,
            new Set(tb.TbMainInstanceGlobalMap.getDataMap().keys()),
            new Set(tb.TbBuildingFogArea.getDataMap().keys()),
            building_ids,
        ),
    ];
};

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("客户端条件与开放图配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 合成条件字符串坏数据能完整识别静默跳过、无效比较与缺失引用", () => {
        const records: ReadonlyArray<ConfigConditionRecord> = [
            {table: "TbBuilding", id: 1, field: "badShape", condition: "userLevel,>=,1,ignored"},
            {table: "TbBuilding", id: 2, field: "unknown", condition: "Unknown,>=,1"},
            {table: "TbBuilding", id: 3, field: "numeric", condition: "userLevel,??,NaN"},
            {table: "TbBuilding", id: 4, field: "emptyBuilding", condition: "BuildingLv,>=,1"},
            {table: "TbBuilding", id: 5, field: "badBuilding", condition: "BuildingLv_1_bad,>=,1"},
            {table: "TbBuilding", id: 6, field: "missingBuilding", condition: "BuildingLv_99,>=,1"},
            {table: "TbBuildingProduce", id: "7:item", field: "job", condition: "HeroJobUnLock,==,99"},
            {table: "TbBuildingProduce", id: "8:item", field: "race", condition: "HeroRaceUnLock,==,99"},
            {table: "TbBuildingProduce", id: "9:item", field: "item", condition: "UseItem,==,"},
        ];

        const errors = collect_config_condition_errors(records, new Set([1]), new Set([1]), new Set([1]));

        expect_structured_errors(errors);
        expect(errors).toHaveLength(10);
        [
            "恰好包含 key,operator,target 三段",
            "默认成功静默跳过条件",
            "不会被 ConditionService.createConditionEvaluator 识别",
            "不是有限值",
            "至少指定一个建筑ID",
            "经 Number.parseInt 后不是有效建筑ID",
            "TbBuilding(99) 不存在",
            "TbJobType(99) 不存在",
            "TbRaceType(99) 不存在",
            "必须提供非空 itemId",
        ].forEach((fragment) => {
            expect(errors.some((message) => message.includes(fragment))).toBe(true);
        });
    });

    it("should 合成条件组坏数据能识别缺组、缺单元、非法组合和迷雾关卡精确查找", () => {
        const references: ReadonlyArray<ConditionGroupReferenceRecord> = [
            {table: "TbBuildingFogArea", id: 1, field: "conditions[0]", group_id: 1, consumer: "fog"},
            {table: "TbAwakenTalent", id: 2, field: "unlockCondition[0]", group_id: 999, consumer: "awaken"},
        ];
        const errors = collect_condition_group_graph_errors(
            references,
            [{id: 1, relation: 99, unit_ids: [10, 11]}],
            [{
                id: 10,
                event_type: taskv1.EventType.finishstagemaininstance,
                operate_type: taskv1.OperateType._2,
                value: 99,
            }],
            new Set([1]),
        );

        expect_structured_errors(errors);
        expect(errors).toHaveLength(4);
        expect(errors.join("\n")).toContain("在 TbConditionGroup 中不存在");
        expect(errors.join("\n")).toContain("不是客户端可识别的 AND/OR");
        expect(errors.join("\n")).toContain("在 TbConditionUnit 中不存在");
        expect(errors.join("\n")).toContain("精确读取 TbMainInstance");
    });

    it("should 仅收集装备实际引用的觉醒技能条件组", () => {
        const references = collect_reachable_awaken_skill_condition_group_references(
            new Set([1]),
            [
                {id: 1, levels: new Map([[1, {conditions: [10]}]])},
                {id: 2, levels: new Map([[1, {conditions: [20]}]])},
            ],
        );

        expect(references).toEqual([{
            table: "TbAwakenEquipmentSkillLevel",
            id: 1,
            field: "levels[1].conditions[0]",
            group_id: 10,
            consumer: "awaken",
        }]);
    });

    it("should 合成开放图坏数据能识别主线、迷雾与建筑 exact lookup 错误", () => {
        const records: OpenGraphRecords = {
            system_opens: [
                {
                    id: "task-missing",
                    main_tasks: [{stage: "S9", task_index: 1}],
                    main_instances: [],
                    fog_area_ids: [],
                },
                {
                    id: "instance-missing",
                    main_tasks: [],
                    main_instances: [{group_id: 9, stage_id: 99}],
                    fog_area_ids: [],
                },
                {
                    id: "instance-mismatch",
                    main_tasks: [],
                    main_instances: [{group_id: 1, stage_id: 20}],
                    fog_area_ids: [],
                },
                {
                    id: "fog-missing",
                    main_tasks: [],
                    main_instances: [],
                    fog_area_ids: [9],
                },
            ],
            building_system_references: [{building_id: 1, system_open_id: "missing-system"}],
            fog_building_references: [{area_id: 1, building_id: 99, index: 0}],
        };
        const errors = collect_open_graph_errors(
            records,
            new Set(["known-system"]),
            new Set(["S1"]),
            new Map([[20, {group: 2}]]),
            new Set([1, 2]),
            new Set([1]),
            new Set([1]),
        );

        expect_structured_errors(errors);
        expect(errors).toHaveLength(7);
        [
            "stage=S9 在 TbMainTask 中不存在",
            "groupId=9 在 TbMainInstanceGlobalMap 中不存在",
            "stageId=99 在 TbMainInstance 中不存在",
            "TbMainInstance(20).group=2",
            "areaId=9 在 TbBuildingFogArea 中不存在",
            "systemOpenId=missing-system 在 TbSystemOpen 中不存在",
            "buildingId=99 在 TbBuilding 中不存在",
        ].forEach((fragment) => {
            expect(errors.some((message) => message.includes(fragment))).toBe(true);
        });
    });

    it("should 当前配置满足客户端条件与开放图代码契约", () => {
        assert_no_errors("客户端条件与开放图配置非法：", collect_current_config_errors());
    });
});
