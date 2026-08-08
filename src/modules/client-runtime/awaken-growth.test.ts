import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type LevelSequenceRecord = Readonly<{
    table: "TbAwakenEquipmentLevel" | "TbAwakenTalentLevel";
    id: number;
    field: "level" | "levels";
    levels: ReadonlyArray<number>;
}>;

type EquipmentSkillReferenceRecord = Readonly<{
    equipment_id: number;
    field: "skill1" | "skill2" | "skill3";
    skill_config_id: number;
    exists: boolean;
}>;

type EquipmentSkillLevelRecord = Readonly<{
    skill_config_id: number;
    levels: ReadonlyArray<Readonly<{
        level: number;
        skill_id: number;
        skill_exists: boolean;
    }>>;
}>;

type TalentUpgradeSkillRecord = Readonly<{
    talent_id: number;
    talent_level: number;
    upgrade_index: number;
    skill_ids: ReadonlyArray<number>;
    missing_skill_ids: ReadonlyArray<number>;
}>;

type BattleSkillReferenceRecord = Readonly<{
    table: "TbHero" | "TbAwakenPlayerBattleTemplate";
    id: string | number;
    field: "atkSkill" | "specialSkill" | "skillMap";
    skill_id: number;
    target_table: "TbSkill" | "TbSpecialSkill";
    exists: boolean;
}>;

type AwakenGrowthRecords = Readonly<{
    level_sequences: ReadonlyArray<LevelSequenceRecord>;
    equipment_skill_references: ReadonlyArray<EquipmentSkillReferenceRecord>;
    equipment_skill_levels: ReadonlyArray<EquipmentSkillLevelRecord>;
    talent_upgrade_skills: ReadonlyArray<TalentUpgradeSkillRecord>;
    battle_skill_references: ReadonlyArray<BattleSkillReferenceRecord>;
}>;

const format_error = (
    table: string,
    id: string | number,
    field: string,
    reason: string,
): string => `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const collect_level_sequence_errors = (
    records: ReadonlyArray<LevelSequenceRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const levels = Array.from(new Set(record.levels)).sort((left, right) => left - right);
        const max_level = levels.at(-1) ?? 0;
        const is_continuous = levels.length > 0
            && levels.every((level, index) => level === index + 1);
        return is_continuous
            ? []
            : [format_error(
                record.table,
                record.id,
                record.field,
                `等级键必须从1连续到max=${max_level}，当前为[${levels.join(",")}]`,
            )];
    });

const collect_equipment_skill_errors = (
    references: ReadonlyArray<EquipmentSkillReferenceRecord>,
    skill_levels: ReadonlyArray<EquipmentSkillLevelRecord>,
): ReadonlyArray<string> => [
    ...references.flatMap((record) =>
        record.exists
            ? []
            : [format_error(
                "TbAwakenEquipmentLevel",
                record.equipment_id,
                record.field,
                `引用的 TbAwakenEquipmentSkillLevel 不存在，skill_config_id=${record.skill_config_id}`,
            )]
    ),
    ...skill_levels.flatMap((record) => {
        const sorted_levels = record.levels
            .map((level) => level.level)
            .sort((left, right) => left - right);
        const max_level = sorted_levels.at(-1) ?? 0;
        const is_continuous = sorted_levels.length > 0
            && sorted_levels.every((level, index) => level === index + 1);
        const sequence_errors = is_continuous
            ? []
            : [format_error(
                "TbAwakenEquipmentSkillLevel",
                record.skill_config_id,
                "levels",
                `等级键必须从1连续到max=${max_level}，当前为[${sorted_levels.join(",")}]`,
            )];
        const skill_errors = record.levels.flatMap((level) =>
            level.skill_exists
                ? []
                : [format_error(
                    "TbAwakenEquipmentSkillLevel",
                    record.skill_config_id,
                    `levels[${level.level}].skillId`,
                    `引用的 TbSkill 不存在，skill_id=${level.skill_id}`,
                )]
        );
        return [...sequence_errors, ...skill_errors];
    }),
];

const collect_talent_upgrade_skill_errors = (
    records: ReadonlyArray<TalentUpgradeSkillRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const field = `levels[${record.talent_level}].upgradeSkills[${record.upgrade_index}]`;
        // 客户端把空数组当作 no-op，1 项为新增，2 项为替换；超过 2 项时尾部技能会被静默忽略。
        const length_errors = record.skill_ids.length <= 2
            ? []
            : [format_error(
                "TbAwakenTalentLevel",
                record.talent_id,
                field,
                `每项最多包含2个技能ID，当前长度=${record.skill_ids.length}，第3项及之后不会被客户端消费`,
            )];
        const skill_errors = record.missing_skill_ids.map((skill_id) =>
            format_error(
                "TbAwakenTalentLevel",
                record.talent_id,
                field,
                `引用的 TbSkill 不存在，skill_id=${skill_id}`,
            )
        );
        return [...length_errors, ...skill_errors];
    });

const collect_battle_skill_reference_errors = (
    records: ReadonlyArray<BattleSkillReferenceRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.exists
            ? []
            : [format_error(
                record.table,
                record.id,
                record.field,
                `战斗消费的技能配置在 ${record.target_table} 中不存在，skill_id=${record.skill_id}`,
            )]
    );

const collect_awaken_growth_errors = (records: AwakenGrowthRecords): ReadonlyArray<string> => [
    ...collect_level_sequence_errors(records.level_sequences),
    ...collect_equipment_skill_errors(
        records.equipment_skill_references,
        records.equipment_skill_levels,
    ),
    ...collect_talent_upgrade_skill_errors(records.talent_upgrade_skills),
    ...collect_battle_skill_reference_errors(records.battle_skill_references),
];

const collect_awaken_growth_records = (): AwakenGrowthRecords => {
    const equipment_level_configs = tb.TbAwakenEquipmentLevel.getDataList();
    const equipment_skill_references: EquipmentSkillReferenceRecord[] = [];
    const referenced_equipment_skill_ids = new Set<number>();
    equipment_level_configs.forEach((config) => {
        const skill_fields = [
            ["skill1", config.skill1 ?? 0],
            ["skill2", config.skill2 ?? 0],
            ["skill3", config.skill3 ?? 0],
        ] as const;
        skill_fields.forEach(([field, skill_config_id]) => {
            if (skill_config_id <= 0) return;

            const exists = tb.TbAwakenEquipmentSkillLevel.get(skill_config_id) != null;
            equipment_skill_references.push({
                equipment_id: config.id,
                field,
                skill_config_id,
                exists,
            });
            if (exists) referenced_equipment_skill_ids.add(skill_config_id);
        });
    });

    // DivineArtifact.skills 只会用装备表 skill1/2/3 构造 AwakenArtifactSkill；
    // 服务端下发字典中的其它 key 不会被遍历，因此未被装备引用的技能等级表不是客户端运行时可达配置。
    const equipment_skill_levels = Array.from(referenced_equipment_skill_ids).map((skill_config_id) => {
        const config = tb.TbAwakenEquipmentSkillLevel.get(skill_config_id)!;
        return {
            skill_config_id,
            levels: Array.from(config.levels.entries()).map(([level, level_config]) => ({
                level,
                skill_id: level_config.skillId,
                skill_exists: tb.TbSkill.get(level_config.skillId) != null,
            })),
        };
    });

    const reachable_talent_ids = new Set(tb.TbAwakenTalent.getDataMap().keys());
    const talent_level_configs = tb.TbAwakenTalentLevel.getDataList()
        .filter((config) => reachable_talent_ids.has(config.id));
    const talent_upgrade_skills = talent_level_configs.flatMap((config) =>
        Array.from(config.levels.entries()).flatMap(([talent_level, level_config]) =>
            level_config.upgradeSkills.map((skill_ids, upgrade_index) => ({
                talent_id: config.id,
                talent_level,
                upgrade_index,
                skill_ids,
                missing_skill_ids: skill_ids.filter((skill_id) => tb.TbSkill.get(skill_id) == null),
            }))
        )
    );

    const battle_skill_references: BattleSkillReferenceRecord[] = [];
    tb.TbHero.getDataList().forEach((hero) => {
        if (hero.atkSkill > 0) {
            battle_skill_references.push({
                table: "TbHero",
                id: hero.id,
                field: "atkSkill",
                skill_id: hero.atkSkill,
                target_table: "TbSkill",
                exists: tb.TbSkill.get(hero.atkSkill) != null,
            });
        }
        if (hero.specialSkill > 0) {
            battle_skill_references.push({
                table: "TbHero",
                id: hero.id,
                field: "specialSkill",
                skill_id: hero.specialSkill,
                target_table: "TbSpecialSkill",
                exists: tb.TbSpecialSkill.get(hero.specialSkill) != null,
            });
        }
        Array.from(hero.skillMap.keys()).forEach((skill_id) => {
            if (skill_id <= 0) return;
            battle_skill_references.push({
                table: "TbHero",
                id: hero.id,
                field: "skillMap",
                skill_id,
                target_table: "TbSkill",
                exists: tb.TbSkill.get(skill_id) != null,
            });
        });
    });
    tb.TbAwakenPlayerBattleTemplate.getDataList().forEach((template) => {
        if (template.atkSkill <= 0) return;
        battle_skill_references.push({
            table: "TbAwakenPlayerBattleTemplate",
            id: template.id,
            field: "atkSkill",
            skill_id: template.atkSkill,
            target_table: "TbSkill",
            exists: tb.TbSkill.get(template.atkSkill) != null,
        });
    });

    return {
        level_sequences: [
            ...equipment_level_configs.map((config) => ({
                table: "TbAwakenEquipmentLevel" as const,
                id: config.id,
                field: "level" as const,
                levels: Array.from(config.level.keys()),
            })),
            ...talent_level_configs.map((config) => ({
                table: "TbAwakenTalentLevel" as const,
                id: config.id,
                field: "levels" as const,
                levels: Array.from(config.levels.keys()),
            })),
        ],
        equipment_skill_references,
        equipment_skill_levels,
        talent_upgrade_skills,
        battle_skill_references,
    };
};

describe("客户端觉醒与成长配置消费契约校验", () => {
    let records: AwakenGrowthRecords;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_awaken_growth_records();
    });

    it("should 合成坏数据能一次报告全部等级断档与技能引用错误", () => {
        const invalid_records: AwakenGrowthRecords = {
            level_sequences: [
                {table: "TbAwakenEquipmentLevel", id: 101, field: "level", levels: [1, 3]},
                {table: "TbAwakenTalentLevel", id: 10001, field: "levels", levels: [1, 3]},
            ],
            equipment_skill_references: [
                {equipment_id: 101, field: "skill1", skill_config_id: 9001, exists: false},
            ],
            equipment_skill_levels: [
                {
                    skill_config_id: 9002,
                    levels: [
                        {level: 1, skill_id: 7001, skill_exists: true},
                        {level: 3, skill_id: 7003, skill_exists: false},
                    ],
                },
            ],
            talent_upgrade_skills: [
                {
                    talent_id: 10001,
                    talent_level: 1,
                    upgrade_index: 0,
                    skill_ids: [],
                    missing_skill_ids: [],
                },
                {
                    talent_id: 10001,
                    talent_level: 2,
                    upgrade_index: 0,
                    skill_ids: [8001],
                    missing_skill_ids: [],
                },
                {
                    talent_id: 10001,
                    talent_level: 3,
                    upgrade_index: 0,
                    skill_ids: [8001, 8002],
                    missing_skill_ids: [],
                },
                {
                    talent_id: 10001,
                    talent_level: 4,
                    upgrade_index: 0,
                    skill_ids: [8001, 8002, 8003],
                    missing_skill_ids: [8003],
                },
            ],
            battle_skill_references: [
                {
                    table: "TbHero",
                    id: "101",
                    field: "skillMap",
                    skill_id: 8101,
                    target_table: "TbSkill",
                    exists: false,
                },
                {
                    table: "TbHero",
                    id: "102",
                    field: "specialSkill",
                    skill_id: 8201,
                    target_table: "TbSpecialSkill",
                    exists: false,
                },
            ],
        };

        const errors = collect_awaken_growth_errors(invalid_records);
        const report = errors.join("\n");

        expect(errors).toHaveLength(9);
        expect(report).toContain("table=TbAwakenEquipmentLevel, id=101, field=level");
        expect(report).toContain("table=TbAwakenTalentLevel, id=10001, field=levels");
        expect(report).toContain("field=skill1, reason=引用的 TbAwakenEquipmentSkillLevel 不存在");
        expect(report).toContain("table=TbAwakenEquipmentSkillLevel, id=9002, field=levels");
        expect(report).toContain("field=levels[3].skillId, reason=引用的 TbSkill 不存在");
        expect(report).toContain("每项最多包含2个技能ID");
        expect(report).toContain("table=TbHero, id=102, field=specialSkill");
    });

    it("should 当前配置满足客户端觉醒与成长的真实消费契约", () => {
        assert_no_errors(
            "存在客户端觉醒与成长配置消费错误：",
            collect_awaken_growth_errors(records),
        );
    });
});
