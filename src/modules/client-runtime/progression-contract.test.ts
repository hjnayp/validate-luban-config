import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type ExactLookupRecord = Readonly<{
    table: string;
    id: string | number;
    field: string;
    exists: boolean;
    missing_reason: string;
}>;

type MinimumLengthRecord = Readonly<{
    table: string;
    id: string | number;
    field: string;
    actual_length: number;
    minimum_length: number;
    short_reason: string;
}>;

type ProgressionContractRecords = Readonly<{
    exact_lookups: ReadonlyArray<ExactLookupRecord>;
    minimum_lengths: ReadonlyArray<MinimumLengthRecord>;
}>;

const format_error = (
    table: string,
    id: string | number,
    field: string,
    reason: string,
): string => `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const collect_exact_lookup_errors = (
    records: ReadonlyArray<ExactLookupRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.exists
            ? []
            : [format_error(record.table, record.id, record.field, record.missing_reason)]
    );

const collect_minimum_length_errors = (
    records: ReadonlyArray<MinimumLengthRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.actual_length >= record.minimum_length
            ? []
            : [format_error(
                record.table,
                record.id,
                record.field,
                `${record.short_reason}，至少需要 ${record.minimum_length} 项，当前为 ${record.actual_length} 项`,
            )]
    );

const collect_progression_contract_errors = (
    records: ProgressionContractRecords,
): ReadonlyArray<string> => [
    ...collect_exact_lookup_errors(records.exact_lookups),
    ...collect_minimum_length_errors(records.minimum_lengths),
];

const collect_current_progression_contract_records = (): ProgressionContractRecords => {
    const exact_lookups: ExactLookupRecord[] = [];
    const minimum_lengths: MinimumLengthRecord[] = [];

    const hero_level_configs = tb.TbHeroLevelUp.getDataList();
    const hero_rank_keys = Array.from(new Set(hero_level_configs.map((config) => config.lvClass)));
    minimum_lengths.push({
        table: "TbHeroLevelUp",
        id: "all",
        field: "getDataList",
        actual_length: hero_level_configs.length,
        minimum_length: 1,
        short_reason: "HeroData.init 需要等级表建立阶级上限 Map",
    });
    exact_lookups.push({
        table: "TbHeroLevelUp",
        id: "all",
        field: "lvClass=1",
        exists: hero_rank_keys.includes(1),
        missing_reason: "HeroData 默认 heroRank=1，但等级表无法为该阶级建立等级上限",
    });

    tb.TbHero.getDataList().forEach((hero_config) => {
        const hero_id = hero_config.id;
        const attribute_config = tb.TbHeroAttribute.get(hero_id);
        const quality_base_config = tb.TbHeroQualityBase.get(hero_id);
        const quality_grow_config = tb.TbHeroQualityGrow.get(hero_id);
        const upgrade_class_config = tb.TbHeroUpgradeClass.get(hero_id);
        const level_battle_count_config = tb.TbHeroLvBattleCnt.get(hero_id);

        [
            ["TbHeroAttribute", attribute_config],
            ["TbHeroQualityBase", quality_base_config],
            ["TbHeroQualityGrow", quality_grow_config],
            ["TbHeroUpgradeClass", upgrade_class_config],
            ["TbHeroLvBattleCnt", level_battle_count_config],
        ].forEach(([table, config]) => {
            exact_lookups.push({
                table: String(table),
                id: hero_id,
                field: "id",
                exists: config != null,
                missing_reason: `TbHero(${hero_id}) 会在 HeroData 属性或兵力计算中按 heroId 直接读取此配套行`,
            });
        });

        if (upgrade_class_config != null) {
            hero_rank_keys.forEach((rank) => {
                exact_lookups.push({
                    table: "TbHeroUpgradeClass",
                    id: hero_id,
                    field: `config[${rank}]`,
                    exists: upgrade_class_config.config.has(rank),
                    missing_reason: `HeroData.buildAttribute 会按 heroRank=${rank} 精确读取，缺项会被静默当作 0 属性`,
                });
            });
        }

        if (quality_grow_config != null) {
            const required_qualities = new Set<string>([hero_config.initialQualification]);
            quality_base_config?.config.forEach((config) => {
                required_qualities.add(config.quality);
            });
            Array.from(required_qualities).forEach((quality) => {
                exact_lookups.push({
                    table: "TbHeroQualityGrow",
                    id: hero_id,
                    field: `config[${quality}]`,
                    exists: quality_grow_config.config.has(quality),
                    missing_reason: `HeroData.buildAttribute 会按品质 ${quality} 精确读取，缺项会被静默当作 0 成长`,
                });
            });
        }
    });

    minimum_lengths.push({
        table: "TbHeroConst",
        id: "const",
        field: "imgLevelBar",
        actual_length: tb.TbHeroConst.imgLevelBar.length,
        minimum_length: 2,
        short_reason: "英雄经验条固定读取背景图 [0] 与进度图 [1]",
    });
    Array.from(tb.TbHeroConst.uiDetailTab.keys()).forEach((tab) => {
        minimum_lengths.push({
            table: "TbHeroConst",
            id: "const",
            field: `uiDetailTabImgs[${tab}]`,
            actual_length: tb.TbHeroConst.uiDetailTabImgs.get(tab)?.length ?? 0,
            minimum_length: 2,
            short_reason: "英雄详情页签固定读取未选中图 [0] 与选中图 [1]",
        });
    });

    const main_instance_configs = tb.TbMainInstance.getDataList();
    minimum_lengths.push({
        table: "TbMainInstance",
        id: "all",
        field: "getDataList",
        actual_length: main_instance_configs.length,
        minimum_length: 1,
        short_reason: "PveModel 构造时会直接读取首个主线关卡 [0]",
    });

    const main_battle_group_ids = new Set<string>();
    main_instance_configs.forEach((instance_config) => {
        const battle_group = tb.TbBattleGroup.get(instance_config.battleGroup);
        exact_lookups.push({
            table: "TbMainInstance",
            id: instance_config.id,
            field: "battleGroup",
            exists: battle_group != null,
            missing_reason: `battleGroup=${instance_config.battleGroup} 在 TbBattleGroup 中不存在，主线开战无法构造敌方队伍`,
        });
        if (battle_group != null) main_battle_group_ids.add(battle_group.id);
    });

    const reachable_monster_ids = new Set<string>();
    Array.from(main_battle_group_ids).forEach((battle_group_id) => {
        const battle_group = tb.TbBattleGroup.get(battle_group_id)!;
        minimum_lengths.push({
            table: "TbBattleGroup",
            id: battle_group.id,
            field: "stages",
            actual_length: battle_group.stages.length,
            minimum_length: 1,
            short_reason: "主线开战固定从 stages[0] 构造首波敌方队伍",
        });

        battle_group.stages.forEach((stage) => {
            stage.monsters.forEach((monster_id) => {
                if (monster_id !== "" && monster_id !== "0") reachable_monster_ids.add(monster_id);
            });
        });
        Array.from(battle_group.mercenary.entries()).forEach(([position, monster_id]) => {
            if (monster_id === "" || monster_id === "0") return;

            const monster_exists = tb.TbMonster.get(monster_id) != null;
            exact_lookups.push({
                table: "TbBattleGroup",
                id: battle_group.id,
                field: `mercenary[${position}]`,
                exists: monster_exists,
                missing_reason: `佣兵 monsterId=${monster_id} 在 TbMonster 中不存在，客户端会静默跳过该位置`,
            });
            if (monster_exists) reachable_monster_ids.add(monster_id);
        });
    });

    Array.from(reachable_monster_ids).forEach((monster_id) => {
        // BattleGroup.stages.monsters -> TbMonster 已由服务端战斗规则统一校验；
        // 本文件仅继续检查存在配置的主线可达怪物在客户端构造 HeroData/SkillData 时的引用。
        const monster_config = tb.TbMonster.get(monster_id);
        if (monster_config == null) return;

        const hero_id = String(monster_config.heroId ?? "");
        exact_lookups.push({
            table: "TbMonster",
            id: monster_config.id,
            field: "heroId",
            exists: hero_id !== "" && tb.TbHero.get(hero_id) != null,
            missing_reason: `heroId=${hero_id || "<empty>"} 必须引用 TbHero；空值无法构造单位，缺失行会回退首个英雄`,
        });

        if (monster_config.atkSkill !== 0) {
            exact_lookups.push({
                table: "TbMonster",
                id: monster_config.id,
                field: "atkSkill",
                exists: tb.TbSkill.get(monster_config.atkSkill) != null,
                missing_reason: `atkSkill=${monster_config.atkSkill} 在 TbSkill 中不存在，普攻 SkillData 会构造失败`,
            });
        }
        monster_config.skillList.forEach((skill_id, index) => {
            if (skill_id === 0) return;

            exact_lookups.push({
                table: "TbMonster",
                id: monster_config.id,
                field: `skillList[${index}]`,
                exists: tb.TbSkill.get(skill_id) != null,
                missing_reason: `skillId=${skill_id} 在 TbSkill 中不存在，客户端会静默跳过该技能`,
            });
        });
    });

    tb.TbSkill.getDataList().forEach((skill_config) => {
        const next_skill_id = skill_config.args.get("next_skill");
        if (next_skill_id == null || next_skill_id === 0) return;

        exact_lookups.push({
            table: "TbSkill",
            id: skill_config.id,
            field: "args.next_skill",
            exists: tb.TbSkill.get(next_skill_id) != null,
            missing_reason: `next_skill=${next_skill_id} 在 TbSkill 中不存在，战斗 AI 的连锁技能会静默消失`,
        });
    });

    return {exact_lookups, minimum_lengths};
};

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("客户端英雄与主线关卡成长配置代码契约", () => {
    let current_records: ProgressionContractRecords;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        current_records = collect_current_progression_contract_records();
    });

    it("should 合成坏数据一次报告精确查找、技能引用与固定数组错误", () => {
        const invalid_records: ProgressionContractRecords = {
            exact_lookups: [
                {
                    table: "TbHeroAttribute",
                    id: "101",
                    field: "id",
                    exists: false,
                    missing_reason: "英雄配套属性行不存在",
                },
                {
                    table: "TbHeroUpgradeClass",
                    id: "101",
                    field: "config[2]",
                    exists: false,
                    missing_reason: "阶级精确 Map 缺少 key=2",
                },
                {
                    table: "TbHeroQualityGrow",
                    id: "101",
                    field: "config[A]",
                    exists: false,
                    missing_reason: "品质成长精确 Map 缺少 key=A",
                },
                {
                    table: "TbHeroLevelUp",
                    id: "all",
                    field: "lvClass=1",
                    exists: false,
                    missing_reason: "默认阶级无法解析等级上限",
                },
                {
                    table: "TbMainInstance",
                    id: 101,
                    field: "battleGroup",
                    exists: false,
                    missing_reason: "引用的 TbBattleGroup 不存在",
                },
                {
                    table: "TbBattleGroup",
                    id: "100001",
                    field: "mercenary[1]",
                    exists: false,
                    missing_reason: "引用的佣兵 TbMonster 不存在",
                },
                {
                    table: "TbMonster",
                    id: "201",
                    field: "heroId",
                    exists: false,
                    missing_reason: "引用的 TbHero 不存在",
                },
                {
                    table: "TbMonster",
                    id: "201",
                    field: "atkSkill",
                    exists: false,
                    missing_reason: "引用的普攻 TbSkill 不存在",
                },
                {
                    table: "TbMonster",
                    id: "201",
                    field: "skillList[0]",
                    exists: false,
                    missing_reason: "引用的主动 TbSkill 不存在",
                },
                {
                    table: "TbSkill",
                    id: 7001,
                    field: "args.next_skill",
                    exists: false,
                    missing_reason: "引用的连锁 TbSkill 不存在",
                },
                {
                    table: "TbSkill",
                    id: 7002,
                    field: "args.next_skill",
                    exists: true,
                    missing_reason: "有效引用不应报错",
                },
            ],
            minimum_lengths: [
                {
                    table: "TbHeroLevelUp",
                    id: "all",
                    field: "getDataList",
                    actual_length: 0,
                    minimum_length: 1,
                    short_reason: "等级表为空",
                },
                {
                    table: "TbHeroConst",
                    id: "const",
                    field: "imgLevelBar",
                    actual_length: 1,
                    minimum_length: 2,
                    short_reason: "经验条双图不完整",
                },
                {
                    table: "TbHeroConst",
                    id: "const",
                    field: "uiDetailTabImgs[0]",
                    actual_length: 0,
                    minimum_length: 2,
                    short_reason: "页签双态图片不完整",
                },
                {
                    table: "TbBattleGroup",
                    id: "100001",
                    field: "stages",
                    actual_length: 0,
                    minimum_length: 1,
                    short_reason: "主线战斗组没有首波",
                },
                {
                    table: "TbBattleGroup",
                    id: "100002",
                    field: "stages",
                    actual_length: 1,
                    minimum_length: 1,
                    short_reason: "有效首波不应报错",
                },
            ],
        };

        const errors = collect_progression_contract_errors(invalid_records);
        const report = errors.join("\n");

        expect(errors).toHaveLength(14);
        expect_structured_errors(errors);
        expect(report).toContain("table=TbHeroUpgradeClass, id=101, field=config[2]");
        expect(report).toContain("table=TbMainInstance, id=101, field=battleGroup");
        expect(report).toContain("table=TbMonster, id=201, field=skillList[0]");
        expect(report).toContain("table=TbSkill, id=7001, field=args.next_skill");
        expect(report).toContain("table=TbHeroConst, id=const, field=imgLevelBar");
        expect(report).toContain("table=TbBattleGroup, id=100001, field=stages");
    });

    it("should 当前配置满足客户端英雄与主线关卡成长的真实代码契约", () => {
        assert_no_errors(
            "存在客户端英雄与主线关卡成长配置代码契约错误：",
            collect_progression_contract_errors(current_records),
        );
    });
});
