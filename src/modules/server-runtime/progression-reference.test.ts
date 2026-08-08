import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type MainInstanceRecord = Readonly<{
    id: number;
    next_stage: number;
    group: number;
    battle_group: string;
}>;

type ChapterRewardRecord = Readonly<{
    id: number;
}>;

type XianShiZhengTaoInstanceRecord = Readonly<{
    id: number;
    stages: ReadonlyArray<number>;
    advanced_stages: ReadonlyArray<number>;
    challenge_stage: number;
}>;

type XianShiZhengTaoStageRecord = Readonly<{
    id: number;
    battle_group: string;
}>;

type TowerLayerRecord = Readonly<{
    tower_id: number;
    layer_id: number;
    is_reward_box: number | undefined;
    battle_group: string | undefined;
}>;

const error = (table: string, id: string | number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const collect_battle_group_reference_errors = (
    table: string,
    id: string | number,
    field: string,
    battle_group: string | undefined,
    battle_group_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const battle_group_id = String(battle_group ?? "").trim();
    return battle_group_ids.has(battle_group_id)
        ? []
        : [error(
            table,
            id,
            field,
            `battleGroup=${battle_group_id || "<empty>"} 不存在于 TbBattleGroup，服务端无法按 fightId 构造 PvE 敌方快照`,
        )];
};

const collect_main_instance_reference_errors = (
    records: ReadonlyArray<MainInstanceRecord>,
    battle_group_ids: ReadonlySet<string>,
    global_map_group_ids: ReadonlySet<number>,
): ReadonlyArray<string> => {
    const stages_by_id = new Map(records.map((record) => [record.id, record]));

    return records.flatMap((record) => {
        const next_stage = stages_by_id.get(record.next_stage);
        return [
            ...(record.next_stage === 0 || next_stage !== undefined
                ? []
                : [error(
                    "TbMainInstance",
                    record.id,
                    "nextStage",
                    `nextStage=${record.next_stage} 不存在于 TbMainInstance，胜利后会把玩家推进到无法查询的关卡`,
                )]),
            ...(next_stage === undefined || next_stage.group <= record.group || global_map_group_ids.has(next_stage.group)
                ? []
                : [error(
                    "TbMainInstance",
                    next_stage.id,
                    "group",
                    `group=${next_stage.group} 不存在于 TbMainInstanceGlobalMap，从 stage=${record.id} 跨区域后清雾奖励无法查询`,
                )]),
            ...collect_battle_group_reference_errors(
                "TbMainInstance",
                record.id,
                "battleGroup",
                record.battle_group,
                battle_group_ids,
            ),
        ];
    });
};

const collect_chapter_reward_reference_errors = (
    records: ReadonlyArray<ChapterRewardRecord>,
    main_instance_ids: ReadonlySet<number>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        main_instance_ids.has(record.id)
            ? []
            : [error(
                "TbChapterReward",
                record.id,
                "id",
                "同 ID 不存在于 TbMainInstance，addChapter 永远不会把该章节奖励置为可领取",
            )]
    );

const collect_xianshizhengtao_reference_errors = (
    instances: ReadonlyArray<XianShiZhengTaoInstanceRecord>,
    stages: ReadonlyArray<XianShiZhengTaoStageRecord>,
    battle_group_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const stage_ids = new Set(stages.map((stage) => stage.id));
    const errors = instances.flatMap((instance) => [
        ...instance.stages.flatMap((stage, index) =>
            stage_ids.has(stage)
                ? []
                : [error(
                    "TbXianShiZhengTaoInstance",
                    instance.id,
                    `stage[${index}]`,
                    `stage=${stage} 不存在于 TbXianShiZhengTaoStage，胜利结算无法查询固定奖励`,
                )]
        ),
        ...instance.advanced_stages.flatMap((stage, index) =>
            stage_ids.has(stage)
                ? []
                : [error(
                    "TbXianShiZhengTaoInstance",
                    instance.id,
                    `advancedStage[${index}]`,
                    `stage=${stage} 不存在于 TbXianShiZhengTaoStage，进阶胜利结算无法查询固定奖励`,
                )]
        ),
        ...(instance.challenge_stage === 0 || stage_ids.has(instance.challenge_stage)
            ? []
            : [error(
                "TbXianShiZhengTaoInstance",
                instance.id,
                "challengeStage",
                `stage=${instance.challenge_stage} 不存在于 TbXianShiZhengTaoStage，挑战胜利结算无法查询固定奖励`,
            )]),
    ]);

    stages.forEach((stage) => {
        errors.push(...collect_battle_group_reference_errors(
            "TbXianShiZhengTaoStage",
            stage.id,
            "battleGroup",
            stage.battle_group,
            battle_group_ids,
        ));
    });

    return errors;
};

const collect_tower_battle_group_errors = (
    layers: ReadonlyArray<TowerLayerRecord>,
    battle_group_ids: ReadonlySet<string>,
): ReadonlyArray<string> =>
    layers.flatMap((layer) =>
        layer.is_reward_box === 1
            ? []
            : collect_battle_group_reference_errors(
                "TbTowerLevel",
                `${layer.tower_id}.config[${layer.layer_id}]`,
                "battleGroup",
                layer.battle_group,
                battle_group_ids,
            )
    );

const collect_current_main_instance_records = (): ReadonlyArray<MainInstanceRecord> =>
    tb.TbMainInstance.getDataList().map((record) => ({
        id: record.id,
        next_stage: record.nextStage,
        group: record.group,
        battle_group: record.battleGroup,
    }));

const collect_current_xianshizhengtao_instances = (): ReadonlyArray<XianShiZhengTaoInstanceRecord> =>
    tb.TbXianShiZhengTaoInstance.getDataList().map((record) => ({
        id: record.id,
        stages: record.stage,
        advanced_stages: record.advancedStage,
        challenge_stage: record.challengeStage,
    }));

const collect_current_xianshizhengtao_stages = (): ReadonlyArray<XianShiZhengTaoStageRecord> =>
    tb.TbXianShiZhengTaoStage.getDataList().map((record) => ({
        id: record.id,
        battle_group: record.battleGroup,
    }));

const collect_current_tower_layers = (): ReadonlyArray<TowerLayerRecord> =>
    tb.TbTowerLevel.getDataList().flatMap((tower) =>
        Array.from(tower.config.entries()).map(([layer_id, layer]) => ({
            tower_id: tower.id,
            layer_id,
            is_reward_box: layer.isRewardBox,
            battle_group: layer.battleGroup,
        }))
    );

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("服务端核心进度与关卡引用 collector", () => {
    it("合成坏数据一次收集主线、章节、限时征讨与爬塔引用错误", () => {
        const battle_group_ids = new Set(["known-battle"]);
        const main_records: ReadonlyArray<MainInstanceRecord> = [
            {id: 1, next_stage: 2, group: 1, battle_group: "missing-main-battle"},
            {id: 2, next_stage: 99, group: 7, battle_group: "known-battle"},
        ];
        const errors = [
            ...collect_main_instance_reference_errors(main_records, battle_group_ids, new Set()),
            ...collect_chapter_reward_reference_errors([{id: 9}], new Set(main_records.map((record) => record.id))),
            ...collect_xianshizhengtao_reference_errors(
                [{id: 20, stages: [11, 12], advanced_stages: [13], challenge_stage: 14}],
                [{id: 11, battle_group: "missing-xszt-battle"}],
                battle_group_ids,
            ),
            ...collect_tower_battle_group_errors([
                {tower_id: 1, layer_id: 1, is_reward_box: undefined, battle_group: "missing-tower-battle"},
                {tower_id: 1, layer_id: 2, is_reward_box: 1, battle_group: undefined},
                {tower_id: 1, layer_id: 3, is_reward_box: undefined, battle_group: "known-battle"},
            ], battle_group_ids),
        ];

        expect_structured_errors(errors);
        expect(errors).toHaveLength(9);
        [
            "nextStage=99 不存在",
            "group=7 不存在",
            "missing-main-battle",
            "addChapter 永远不会",
            "stage=12 不存在",
            "stage=13 不存在",
            "stage=14 不存在",
            "missing-xszt-battle",
            "missing-tower-battle",
        ].forEach((fragment) => {
            expect(errors.some((message) => message.includes(fragment))).toBe(true);
        });
    });
});

describe("服务端核心进度与关卡引用", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("当前配置满足主线、章节、限时征讨与爬塔的服务端引用契约", () => {
        const main_records = collect_current_main_instance_records();
        const battle_group_ids = new Set(tb.TbBattleGroup.getDataMap().keys());
        const errors = [
            ...collect_main_instance_reference_errors(
                main_records,
                battle_group_ids,
                new Set(tb.TbMainInstanceGlobalMap.getDataMap().keys()),
            ),
            ...collect_chapter_reward_reference_errors(
                tb.TbChapterReward.getDataList(),
                new Set(main_records.map((record) => record.id)),
            ),
            ...collect_xianshizhengtao_reference_errors(
                collect_current_xianshizhengtao_instances(),
                collect_current_xianshizhengtao_stages(),
                battle_group_ids,
            ),
            ...collect_tower_battle_group_errors(collect_current_tower_layers(), battle_group_ids),
        ];

        assert_no_errors("存在服务端核心进度或关卡引用非法配置：", errors);
    });
});
