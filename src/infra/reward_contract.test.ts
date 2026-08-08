import {describe, expect, it} from "vitest";
import {base} from "../../gen/schema/base";
import {
    collect_reward_contract_errors,
    RewardReferenceTables,
} from "./reward_contract";

const references = (overrides: Partial<Record<keyof RewardReferenceTables, ReadonlyArray<string>>> = {}) => {
    const values: Record<keyof RewardReferenceTables, ReadonlyArray<string>> = {
        TbItem: overrides.TbItem ?? ["item", "piece"],
        TbHero: overrides.TbHero ?? ["hero"],
        TbHeroQuality: overrides.TbHeroQuality ?? ["A"],
        TbEquip: overrides.TbEquip ?? ["equip"],
        TbSpecialRewardItem: overrides.TbSpecialRewardItem ?? ["worker", "exp"],
    };
    return Object.fromEntries(Object.entries(values).map(([name, ids]) => [
        name,
        {get: (id: string) => ids.includes(id) ? {id} : undefined},
    ])) as RewardReferenceTables;
};

const reward = (id: string, type: number, count = 1): base.Reward =>
    new base.Reward({id, type, count});

describe("通用奖励契约", () => {
    it("should 覆盖每类奖励引用、未知类型与数值契约", () => {
        const root = [
            reward("missing-item", base.RewardType.Item),
            reward("missing-draw-hero_A", base.RewardType.DrawTrans),
            reward("hero_missing-draw-quality", base.RewardType.DrawTrans),
            reward("hero_A", base.RewardType.DrawTrans),
            reward("missing-hero_A", base.RewardType.Hero),
            reward("hero_missing-quality", base.RewardType.Hero),
            reward("hero", base.RewardType.Hero),
            reward("missing-equip", base.RewardType.Equip),
            reward("missing-soldier", base.RewardType.BingYingHero),
            reward("anything", 999),
            reward("item", base.RewardType.Item, 0),
            reward("item", base.RewardType.Item, 1.5),
            reward("item", base.RewardType.Item, Number.MAX_SAFE_INTEGER + 1),
            new base.RateReward({id: "missing-rate-item", type: base.RewardType.Item, count: 1, rate: 0.5}),
        ];

        const errors = collect_reward_contract_errors(root, references(), "SyntheticTable.rows");
        const text = errors.join("\n");

        expect(text).toContain("rewardId=missing-item, target=TbItem");
        expect(text).toContain("heroId=missing-draw-hero, target=TbHero");
        expect(text).toContain("quality=missing-draw-quality, target=TbHeroQuality");
        expect(text).toContain("heroId=missing-hero, target=TbHero");
        expect(text).toContain("quality=missing-quality, target=TbHeroQuality");
        expect(text).toContain("英雄或抽卡转换奖励 id 必须为 heroId_quality");
        expect(text).toContain("rewardId=missing-equip, target=TbEquip");
        expect(text).toContain("rewardId=missing-soldier, target=TbHero");
        expect(text).toContain("未知 RewardType");
        expect(errors.filter((error) => error.includes("count 必须是正安全整数"))).toHaveLength(3);
        expect(text).toContain("rewardId=missing-rate-item, target=TbItem");
    });

    it("should 不把普通同形对象或引用回边识别为奖励", () => {
        const fake_reward = {id: "missing", type: base.RewardType.Item, count: 1};
        const real_reward = reward("missing", base.RewardType.Item);
        const errors = collect_reward_contract_errors({
            fake_reward,
            real_reward_ref: real_reward,
            worker: reward("", base.RewardType.Worker),
            exp: reward("", base.RewardType.Exp),
        }, references({TbSpecialRewardItem: []}));

        expect(errors).toEqual([]);
    });
});
