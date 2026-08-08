import {beforeAll, describe, expect, it} from "vitest";
import {base} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type ActivityRecord = Readonly<{
    activityId: number;
    subActivityIds: ReadonlyArray<number>;
    serverOpenStartDay: number;
    serverOpenEndDay: number;
    serverOpenStartTime: number | undefined;
    serverOpenEndTime: number | undefined;
    serverOpenDayMin: number;
    serverOpenDayMax: number;
    serverOpenTimeAfter: number | undefined;
    serverOpenTimeBefore: number | undefined;
    showTime: number;
}>;

type BattleFormRecord = Readonly<{
    id: number;
    groups: ReadonlyArray<number>;
}>;

type BattleStageRecord = Readonly<{
    formId: number;
    monsters: ReadonlyArray<string>;
}>;

type BattleGroupRecord = Readonly<{
    id: string;
    stages: ReadonlyArray<BattleStageRecord>;
}>;

type WeightTargetRecord = Readonly<{
    target: number;
    weight: number;
}>;

type RateRewardRecord = Readonly<{
    id: string;
    type: number;
    count: number;
    rate: number;
}>;

type MonsterRecord = Readonly<{
    id: string;
    dropRewardCopies: ReadonlyArray<WeightTargetRecord>;
    dropReward: ReadonlyArray<RateRewardRecord>;
}>;

type RewardCatalog = Readonly<{
    itemIds: ReadonlySet<string>;
    heroIds: ReadonlySet<string>;
    equipIds: ReadonlySet<string>;
    heroQualities: ReadonlySet<string>;
}>;

const DAY_SECONDS = 86_400;
const INT32_MAX = 2_147_483_647;
const UINT32_MAX = 4_294_967_295;

const error = (table: string, id: string | number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const is_configured = (value: number | undefined): value is number =>
    value !== undefined && value > 0;

const collect_activity_errors = (
    activities: ReadonlyArray<ActivityRecord>,
    activity_sub_ids: ReadonlySet<number>,
): ReadonlyArray<string> =>
    activities.flatMap((activity) => {
        const errors: string[] = [];
        const int32_fields: ReadonlyArray<readonly [string, number]> = [
            ["serverOpenStartDay", activity.serverOpenStartDay],
            ["serverOpenEndDay", activity.serverOpenEndDay],
            ["serverOpenDayMin", activity.serverOpenDayMin],
            ["serverOpenDayMax", activity.serverOpenDayMax],
        ];
        const int64_fields: ReadonlyArray<readonly [string, number | undefined]> = [
            ["serverOpenStartTime", activity.serverOpenStartTime],
            ["serverOpenEndTime", activity.serverOpenEndTime],
            ["serverOpenTimeAfter", activity.serverOpenTimeAfter],
            ["serverOpenTimeBefore", activity.serverOpenTimeBefore],
            ["showTime", activity.showTime],
        ];
        int32_fields.forEach(([field, value]) => {
            if (!Number.isInteger(value) || value < 0 || value > INT32_MAX) {
                errors.push(error("TbActivity", activity.activityId, field, `值 ${value} 必须是 0..${INT32_MAX} 的整数，0 表示未配置`));
            }
        });
        int64_fields.forEach(([field, value]) => {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                errors.push(error("TbActivity", activity.activityId, field, `值 ${value} 必须是非负安全整数，0/undefined 表示未配置`));
            }
        });

        const relative_start = is_configured(activity.serverOpenStartDay);
        const relative_end = is_configured(activity.serverOpenEndDay);
        const absolute_start = is_configured(activity.serverOpenStartTime);
        const absolute_end = is_configured(activity.serverOpenEndTime);

        if ((relative_start || relative_end) && (absolute_start || absolute_end)) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenStartDay/serverOpenStartTime", "相对开服日与绝对时间模式互斥"));
        }
        if (relative_end && !relative_start) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenEndDay", "结束日已配置但开始日未配置"));
        }
        if (absolute_end && !absolute_start) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenEndTime", "结束时间已配置但开始时间未配置"));
        }
        if (relative_start && relative_end && activity.serverOpenStartDay > activity.serverOpenEndDay) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenStartDay/serverOpenEndDay", "开始日不能晚于结束日"));
        }
        if (absolute_start && absolute_end && activity.serverOpenStartTime > activity.serverOpenEndTime) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenStartTime/serverOpenEndTime", "开始时间不能晚于结束时间"));
        }
        if (
            is_configured(activity.serverOpenDayMin)
            && is_configured(activity.serverOpenDayMax)
            && activity.serverOpenDayMin > activity.serverOpenDayMax
        ) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenDayMin/serverOpenDayMax", "资格下限不能大于上限"));
        }
        if (
            is_configured(activity.serverOpenTimeAfter)
            && is_configured(activity.serverOpenTimeBefore)
            && activity.serverOpenTimeAfter >= activity.serverOpenTimeBefore
        ) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenTimeAfter/serverOpenTimeBefore", "开服时间资格下界必须早于上界"));
        }
        if (
            activity.showTime > 0
            && absolute_end
            && !Number.isSafeInteger(activity.serverOpenEndTime + activity.showTime)
        ) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenEndTime/showTime", "展示期结束时间加法超出安全整数范围"));
        }
        if (
            activity.showTime > 0
            && relative_end
            && !Number.isSafeInteger(activity.serverOpenEndDay * DAY_SECONDS - 1 + activity.showTime)
        ) {
            errors.push(error("TbActivity", activity.activityId, "serverOpenEndDay/showTime", "相对窗口与展示期加法超出安全整数范围"));
        }

        const seen_sub_ids = new Set<number>();
        activity.subActivityIds.forEach((sub_activity_id, index) => {
            if (seen_sub_ids.has(sub_activity_id)) {
                errors.push(error("TbActivity", activity.activityId, `subActivityIds[${index}]`, `子活动 ${sub_activity_id} 重复`));
            }
            seen_sub_ids.add(sub_activity_id);
            if (!activity_sub_ids.has(sub_activity_id)) {
                errors.push(error("TbActivity", activity.activityId, `subActivityIds[${index}]`, `子活动 ${sub_activity_id} 不存在于 TbActivitySub`));
            }
        });

        return errors;
    });

const collect_battle_group_errors = (
    battle_groups: ReadonlyArray<BattleGroupRecord>,
    battle_forms: ReadonlyMap<number, BattleFormRecord>,
    monster_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const errors: string[] = [];

    Array.from(battle_forms.values()).forEach((form) => {
        const seen_groups = new Set<number>();
        form.groups.forEach((group_id, index) => {
            if (!Number.isInteger(group_id) || group_id < 1 || group_id > 9) {
                errors.push(error("TbBattleForm", form.id, `groups[${index}]`, `九宫格 ID ${group_id} 非法，应为 1..9 的整数`));
            }
            if (seen_groups.has(group_id)) {
                errors.push(error("TbBattleForm", form.id, `groups[${index}]`, `九宫格 ID ${group_id} 重复`));
            }
            seen_groups.add(group_id);
        });
    });

    battle_groups.forEach((battle_group) => {
        battle_group.stages.forEach((stage, stage_index) => {
            const form = battle_forms.get(stage.formId);
            if (!form) {
                errors.push(error("TbBattleGroup", battle_group.id, `stages[${stage_index}].formId`, `阵型 ${stage.formId} 不存在于 TbBattleForm`));
                return;
            }
            if (stage.monsters.length > form.groups.length) {
                errors.push(error(
                    "TbBattleGroup",
                    battle_group.id,
                    `stages[${stage_index}].monsters`,
                    `怪物数量 ${stage.monsters.length} 超过阵型格子数量 ${form.groups.length}，末尾怪物没有可映射的格子`,
                ));
            }
            stage.monsters.forEach((monster_id, monster_index) => {
                if (monster_id === "" || monster_id === "0") {
                    return;
                }
                if (!monster_ids.has(monster_id)) {
                    errors.push(error(
                        "TbBattleGroup",
                        battle_group.id,
                        `stages[${stage_index}].monsters[${monster_index}]`,
                        `怪物 ${monster_id} 不存在于 TbMonster`,
                    ));
                }
            });
        });
    });

    return errors;
};

const collect_weight_pool_errors = <T>(
    table_id: string,
    field: string,
    weight_field: "weight" | "rate",
    max_weight: number,
    entries: ReadonlyArray<T>,
    get_weight: (entry: T) => number,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    let total = 0;
    entries.forEach((entry, index) => {
        const weight = get_weight(entry);
        if (!Number.isSafeInteger(weight) || weight < 0 || weight > max_weight) {
            errors.push(error("TbMonster", table_id, `${field}[${index}].${weight_field}`, `权重 ${weight} 必须是 0..${max_weight} 的安全整数`));
        }
        total += weight;
        if (!Number.isSafeInteger(total)) {
            errors.push(error("TbMonster", table_id, field, "权重总和超出安全整数范围"));
        }
    });
    if (entries.length > 0 && !entries.some((entry) => get_weight(entry) > 0)) {
        errors.push(error("TbMonster", table_id, field, "随机池至少需要一个正权重"));
    }
    return errors;
};

const collect_reward_reference_errors = (
    monster_id: string,
    reward: RateRewardRecord,
    index: number,
    catalog: RewardCatalog,
): ReadonlyArray<string> => {
    const field = `dropReward[${index}]`;
    const errors: string[] = [];
    const reward_id = String(reward.id ?? "").trim();

    if (reward_id === "") {
        errors.push(error("TbMonster", monster_id, `${field}.id`, "奖励 ID 不能为空"));
    }
    if (!Number.isSafeInteger(reward.count) || reward.count <= 0) {
        errors.push(error("TbMonster", monster_id, `${field}.count`, `奖励数量 ${reward.count} 必须是正安全整数`));
    }
    if (base.RewardType[reward.type] === undefined) {
        errors.push(error("TbMonster", monster_id, `${field}.type`, `奖励类型 ${reward.type} 非法`));
        return errors;
    }
    if (reward_id === "") {
        return errors;
    }

    switch (reward.type) {
        case base.RewardType.Item:
        case base.RewardType.DrawTrans:
            if (!catalog.itemIds.has(reward_id)) {
                errors.push(error("TbMonster", monster_id, `${field}.id`, `道具 ${reward_id} 不存在于 TbItem`));
            }
            break;
        case base.RewardType.Hero: {
            const separator = reward_id.indexOf("_");
            const hero_id = separator < 0 ? reward_id : reward_id.slice(0, separator);
            const quality = separator < 0 ? "" : reward_id.slice(separator + 1);
            if (separator < 0 || !catalog.heroIds.has(hero_id) || !catalog.heroQualities.has(quality)) {
                errors.push(error("TbMonster", monster_id, `${field}.id`, `英雄奖励 ${reward_id} 必须引用有效的 heroId_quality`));
            }
            break;
        }
        case base.RewardType.Equip:
            if (!catalog.equipIds.has(reward_id)) {
                errors.push(error("TbMonster", monster_id, `${field}.id`, `装备 ${reward_id} 不存在于 TbEquip`));
            }
            break;
        case base.RewardType.BingYingHero:
            if (!catalog.heroIds.has(reward_id)) {
                errors.push(error("TbMonster", monster_id, `${field}.id`, `军团 ${reward_id} 不存在于 TbHero`));
            }
            break;
        case base.RewardType.Worker:
        case base.RewardType.Exp:
            break;
    }

    return errors;
};

const collect_monster_errors = (
    monsters: ReadonlyArray<MonsterRecord>,
    catalog: RewardCatalog,
): ReadonlyArray<string> =>
    monsters.flatMap((monster) => {
        const errors = [
            ...collect_weight_pool_errors(monster.id, "dropRewardCopies", "weight", Number.MAX_SAFE_INTEGER, monster.dropRewardCopies, (entry) => entry.weight),
            ...collect_weight_pool_errors(monster.id, "dropReward", "rate", UINT32_MAX, monster.dropReward, (entry) => entry.rate),
        ];

        monster.dropRewardCopies.forEach((entry, index) => {
            if (!Number.isInteger(entry.target) || entry.target < 0 || entry.target > INT32_MAX) {
                errors.push(error("TbMonster", monster.id, `dropRewardCopies[${index}].target`, `Target ${entry.target} 必须是 0..${INT32_MAX} 的整数`));
            }
        });
        monster.dropReward.forEach((reward, index) => {
            errors.push(...collect_reward_reference_errors(monster.id, reward, index, catalog));
        });

        return errors;
    });

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    expect(errors.length).toBeGreaterThan(0);
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("服务端活动与战斗配置 collector", () => {
    it("合成坏数据一次收集活动、阵型、怪物与奖励错误", () => {
        const activity_errors = collect_activity_errors([
            {
                activityId: 1,
                subActivityIds: [5, 5, 6],
                serverOpenStartDay: 3,
                serverOpenEndDay: 2,
                serverOpenStartTime: 100,
                serverOpenEndTime: 50,
                serverOpenDayMin: 8,
                serverOpenDayMax: 2,
                serverOpenTimeAfter: 100,
                serverOpenTimeBefore: 50,
                showTime: -1,
            },
            {
                activityId: 2,
                subActivityIds: [],
                serverOpenStartDay: 0,
                serverOpenEndDay: 2,
                serverOpenStartTime: undefined,
                serverOpenEndTime: undefined,
                serverOpenDayMin: 0,
                serverOpenDayMax: 0,
                serverOpenTimeAfter: undefined,
                serverOpenTimeBefore: undefined,
                showTime: 0,
            },
            {
                activityId: 3,
                subActivityIds: [],
                serverOpenStartDay: 0,
                serverOpenEndDay: 0,
                serverOpenStartTime: 1,
                serverOpenEndTime: Number.MAX_SAFE_INTEGER,
                serverOpenDayMin: 0,
                serverOpenDayMax: 0,
                serverOpenTimeAfter: 0,
                serverOpenTimeBefore: 0,
                showTime: 1,
            },
            {
                activityId: 4,
                subActivityIds: [],
                serverOpenStartDay: -1,
                serverOpenEndDay: 1.5,
                serverOpenStartTime: -1,
                serverOpenEndTime: Number.MAX_SAFE_INTEGER + 1,
                serverOpenDayMin: -1,
                serverOpenDayMax: INT32_MAX + 1,
                serverOpenTimeAfter: 1.5,
                serverOpenTimeBefore: -1,
                showTime: Number.MAX_SAFE_INTEGER + 1,
            },
        ], new Set([5]));

        const battle_errors = collect_battle_group_errors([
            {id: "bad", stages: [{formId: 1, monsters: ["missing", "0", "known", "known"]}, {formId: 2, monsters: []}]},
        ], new Map([[1, {id: 1, groups: [1, 1, 10]}]]), new Set(["known"]));

        const shorter_prefix_errors = collect_battle_group_errors([
            {id: "short-prefix", stages: [{formId: 3, monsters: ["known"]}]},
        ], new Map([[3, {id: 3, groups: [1, 2, 3]}]]), new Set(["known"]));

        const worker_exp_id_errors = collect_monster_errors([{
            id: "worker-exp-id-ignored-by-runtime",
            dropRewardCopies: [],
            dropReward: [
                {id: "arbitrary-worker-token", type: base.RewardType.Worker, count: 1, rate: 1},
                {id: "coin", type: base.RewardType.Exp, count: 1, rate: 1},
            ],
        }], {
            itemIds: new Set(),
            heroIds: new Set(),
            equipIds: new Set(),
            heroQualities: new Set(),
        });

        const monster_errors = collect_monster_errors([
            {
                id: "bad-monster",
                dropRewardCopies: [{target: -1, weight: -1}],
                dropReward: [
                    {id: "missing-item", type: base.RewardType.Item, count: 0, rate: 0},
                    {id: "x", type: 999, count: 1, rate: 0},
                ],
            },
            {
                id: "overflow-monster",
                dropRewardCopies: [
                    {target: INT32_MAX + 1, weight: Number.MAX_SAFE_INTEGER},
                    {target: 1, weight: 1},
                ],
                dropReward: [
                    {id: "exp", type: base.RewardType.Exp, count: 1, rate: UINT32_MAX + 1},
                ],
            },
        ], {
            itemIds: new Set(),
            heroIds: new Set(),
            equipIds: new Set(),
            heroQualities: new Set(),
        });

        const errors = [...activity_errors, ...battle_errors, ...monster_errors];
        expect_structured_errors(errors);
        expect(errors.some((message) => message.includes("相对开服日与绝对时间模式互斥"))).toBe(true);
        expect(errors.some((message) => message.includes("结束日已配置但开始日未配置"))).toBe(true);
        expect(errors.some((message) => message.includes("展示期结束时间加法超出安全整数范围"))).toBe(true);
        expect(errors.some((message) => message.includes("serverOpenStartDay") && message.includes("0..2147483647"))).toBe(true);
        expect(errors.some((message) => message.includes("serverOpenEndTime") && message.includes("非负安全整数"))).toBe(true);
        expect(errors.some((message) => message.includes("开服时间资格下界必须早于上界"))).toBe(true);
        expect(errors.some((message) => message.includes("怪物数量 4 超过阵型格子数量 3"))).toBe(true);
        expect(errors.some((message) => message.includes("怪物 missing 不存在于 TbMonster"))).toBe(true);
        expect(errors.some((message) => message.includes("九宫格 ID 1 重复"))).toBe(true);
        expect(errors.some((message) => message.includes("随机池至少需要一个正权重"))).toBe(true);
        expect(errors.some((message) => message.includes(`Target ${INT32_MAX + 1}`))).toBe(true);
        expect(errors.some((message) => message.includes(`权重 ${UINT32_MAX + 1}`))).toBe(true);
        expect(errors.some((message) => message.includes("权重总和超出安全整数范围"))).toBe(true);
        expect(errors.some((message) => message.includes("奖励类型 999 非法"))).toBe(true);
        expect(shorter_prefix_errors).toEqual([]);
        expect(worker_exp_id_errors).toEqual([]);
    });
});

describe("服务端活动与战斗配置", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("当前配置满足活动窗口、战斗阵型、怪物随机池与奖励引用规则", () => {
        const reward_catalog: RewardCatalog = {
            itemIds: new Set(tb.TbItem.getDataMap().keys()),
            heroIds: new Set(tb.TbHero.getDataMap().keys()),
            equipIds: new Set(tb.TbEquip.getDataMap().keys()),
            heroQualities: new Set(tb.TbHeroQuality.getDataMap().keys()),
        };
        const errors = [
            ...collect_activity_errors(
                tb.TbActivity.getDataList(),
                new Set(tb.TbActivitySub.getDataMap().keys()),
            ),
            ...collect_battle_group_errors(
                tb.TbBattleGroup.getDataList(),
                new Map(Array.from(tb.TbBattleForm.getDataMap().entries())),
                new Set(tb.TbMonster.getDataMap().keys()),
            ),
            ...collect_monster_errors(tb.TbMonster.getDataList(), reward_catalog),
        ];

        assert_no_errors("服务端活动与战斗配置校验失败", errors);
    });
});
