import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type CollectionRewardRecord = Readonly<{
    threshold: number;
    reward_count: number;
}>;

// 收集奖励档位 id 即“需要收集到的星星总数”，服务端按玩家已收集星数与档位比较放行领取。
// 门槛超过全部皮肤星级上限之和时，该档位永远无法领取。
const collect_collection_reward_errors = (
    records: ReadonlyArray<CollectionRewardRecord>,
    total_collectible_stars: number,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const source = `excel=图鉴收集奖励@M-喵王觉醒.xlsx, threshold=${record.threshold}`;
        if (!Number.isInteger(record.threshold) || record.threshold <= 0) {
            return [`${source}, reason=收集档位必须是正整数`];
        }
        if (record.reward_count <= 0) {
            return [`${source}, reason=收集档位必须配置奖励`];
        }

        return record.threshold > total_collectible_stars
            ? [`${source}, total_collectible_stars=${total_collectible_stars}, reason=档位门槛超过全部皮肤可收集星数总和，该档位永远无法领取`]
            : [];
    });

// 可收集星数总和：武器皮肤与喵王皮肤各自的星级上限（星级表最大 key）之和。
const sum_total_collectible_stars = (): number => {
    const max_star_of = (levels: ReadonlyArray<number>): number =>
        levels.reduce((max, level) => (level > max ? level : max), 0);

    const weapon_skin_stars = tb.TbAwakenWeaponSkin.getDataList()
        .reduce((total, skin) => total + max_star_of(Array.from(skin.weaponSkinLevel.keys())), 0);
    const personal_skin_stars = tb.TbAwakenSkin.getDataList()
        .reduce((total, skin) => total + max_star_of(Array.from(skin.weaponSkinLevel.keys())), 0);

    return weapon_skin_stars + personal_skin_stars;
};

const collect_collection_reward_records = (): ReadonlyArray<CollectionRewardRecord> =>
    tb.TbAwakenCollectionReward.getDataList().map((reward) => ({
        threshold: reward.id,
        reward_count: reward.rewards.length,
    }));

describe("喵王觉醒图鉴收集奖励配置校验", () => {
    let records: ReadonlyArray<CollectionRewardRecord>;
    let total_collectible_stars: number;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_collection_reward_records();
        total_collectible_stars = sum_total_collectible_stars();
    });

    it("should 非法档位、空奖励与不可达门槛都被识别", () => {
        const invalid_records: ReadonlyArray<CollectionRewardRecord> = [
            {threshold: 0, reward_count: 1},
            {threshold: 5, reward_count: 0},
            {threshold: 999, reward_count: 1},
        ];

        const errors = collect_collection_reward_errors(invalid_records, 37);

        expect(errors).toHaveLength(3);
        expect(errors.join("\n")).toContain("收集档位必须是正整数");
        expect(errors.join("\n")).toContain("收集档位必须配置奖励");
        expect(errors.join("\n")).toContain("永远无法领取");
    });

    it("should 当前收集奖励档位均可达且配置了奖励", () => {
        const errors = collect_collection_reward_errors(records, total_collectible_stars);
        assert_no_errors("存在非法或不可达的喵王觉醒图鉴收集奖励档位：", errors);
    });
});
