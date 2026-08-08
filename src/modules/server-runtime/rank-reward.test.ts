import {beforeAll, describe, expect, it} from "vitest";
import {rank} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type RankRecord = Readonly<{
    id: string;
    type: number;
    reward_ids: ReadonlyArray<string>;
}>;

type RewardTierRecord = Readonly<{
    low: number;
    high: number;
    rewards: ReadonlyArray<unknown>;
    mail: string;
}>;

type RewardGroupRecord = Readonly<{
    id: string;
    tiers: ReadonlyArray<RewardTierRecord>;
}>;

type RewardRequirement = {
    sources: Set<string>;
    mail_sources: Set<string>;
};

const UINT32_MAX = 4_294_967_295;
const ARENA_DAILY_REWARD_ID = "3";
const ARENA_SEASON_MAIL_ID = "7";

const format_error = (table: string, id: string, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const is_positive_uint32 = (value: number): boolean =>
    Number.isInteger(value) && value >= 1 && value <= UINT32_MAX;

const add_reward_requirement = (
    requirements: Map<string, RewardRequirement>,
    reward_id: string,
    source: string,
    requires_configured_mail: boolean,
): void => {
    const requirement = requirements.get(reward_id) ?? {
        sources: new Set<string>(),
        mail_sources: new Set<string>(),
    };
    requirement.sources.add(source);
    if (requires_configured_mail) {
        requirement.mail_sources.add(source);
    }
    requirements.set(reward_id, requirement);
};

const collect_rank_reference_errors = (
    records: ReadonlyArray<RankRecord>,
    reward_groups: ReadonlyMap<string, RewardGroupRecord>,
    mail_ids: ReadonlySet<string>,
    requirements: Map<string, RewardRequirement>,
): ReadonlyArray<string> => {
    const errors: string[] = [];

    records.forEach((record) => {
        if (record.type !== rank.Type.UserRank && record.type !== rank.Type.ArenaRank) {
            return;
        }

        record.reward_ids.forEach((reward_id, index) => {
            if (!reward_groups.has(reward_id)) {
                errors.push(format_error(
                    "TbRank",
                    record.id,
                    `rewardID[${index}]`,
                    `rewardID=${reward_id || "<empty>"} 不存在于 TbRankReward，period % rewardID.length 会选中无配置奖励组`,
                ));
                return;
            }
            add_reward_requirement(
                requirements,
                reward_id,
                `TbRank:${record.id}.rewardID[${index}]`,
                record.type === rank.Type.UserRank,
            );
        });

        if (record.type !== rank.Type.ArenaRank) {
            return;
        }
        if (!reward_groups.has(ARENA_DAILY_REWARD_ID)) {
            errors.push(format_error(
                "TbRank",
                record.id,
                "arenaDailyRewardID",
                `竞技场日结固定精确查找 TbRankReward id=${ARENA_DAILY_REWARD_ID}，当前不存在`,
            ));
        }
        else {
            add_reward_requirement(
                requirements,
                ARENA_DAILY_REWARD_ID,
                `TbRank:${record.id}.arenaDailyRewardID`,
                true,
            );
        }
        if (record.reward_ids.length > 0 && !mail_ids.has(ARENA_SEASON_MAIL_ID)) {
            errors.push(format_error(
                "TbRank",
                record.id,
                "arenaSeasonMail",
                `竞技场赛季结算固定邮件模板 id=${ARENA_SEASON_MAIL_ID} 不存在于 TbMailTemplate`,
            ));
        }
    });

    return errors;
};

const collect_reward_group_errors = (
    reward_groups: ReadonlyMap<string, RewardGroupRecord>,
    requirements: ReadonlyMap<string, RewardRequirement>,
    mail_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const errors: string[] = [];

    Array.from(requirements.entries()).forEach(([group_id, requirement]) => {
        const group = reward_groups.get(group_id);
        if (!group) {
            return;
        }
        const sources = Array.from(requirement.sources).join(" | ");
        if (group.tiers.length === 0) {
            errors.push(format_error(
                "TbRankReward",
                group_id,
                "rewards",
                `被 ${sources} 使用的奖励档位列表不能为空`,
            ));
        }

        const valid_tiers: Array<RewardTierRecord & {index: number}> = [];
        group.tiers.forEach((tier, index) => {
            const field = `rewards[${index}]`;
            if (!is_positive_uint32(tier.low) || !is_positive_uint32(tier.high)) {
                errors.push(format_error(
                    "TbRankReward",
                    group_id,
                    `${field}.low/high`,
                    `闭区间 [${tier.low},${tier.high}] 两端必须是正 uint32`,
                ));
                return;
            }
            if (tier.low > tier.high) {
                errors.push(format_error(
                    "TbRankReward",
                    group_id,
                    `${field}.low/high`,
                    `闭区间 [${tier.low},${tier.high}] 不能为空，必须 low<=high`,
                ));
                return;
            }
            valid_tiers.push({...tier, index});
            if (tier.rewards.length === 0) {
                errors.push(format_error(
                    "TbRankReward",
                    group_id,
                    `${field}.rewards`,
                    `奖励组被 ${sources} 结算使用，档位 [${tier.low},${tier.high}] 的奖励列表不能为空`,
                ));
            }
            if (requirement.mail_sources.size === 0) {
                return;
            }
            if (tier.mail === "") {
                errors.push(format_error(
                    "TbRankReward",
                    group_id,
                    `${field}.mail`,
                    `mail=<empty>，${Array.from(requirement.mail_sources).join(" | ")} 会发送空模板 ID`,
                ));
            }
            else if (!mail_ids.has(tier.mail)) {
                errors.push(format_error(
                    "TbRankReward",
                    group_id,
                    `${field}.mail`,
                    `mail=${tier.mail} 不存在于 TbMailTemplate，客户端精确查找不到邮件模板`,
                ));
            }
        });

        valid_tiers.forEach((later, later_position) => {
            valid_tiers.slice(0, later_position).forEach((earlier) => {
                const overlap_low = Math.max(earlier.low, later.low);
                const overlap_high = Math.min(earlier.high, later.high);
                if (overlap_low <= overlap_high) {
                    errors.push(format_error(
                        "TbRankReward",
                        group_id,
                        `rewards[${later.index}].low/high`,
                        `名次 [${overlap_low},${overlap_high}] 与 rewards[${earlier.index}] 重叠，first-match 会遮蔽后续档位`,
                    ));
                }
            });
        });

    });

    return errors;
};

const collect_rank_reward_errors = (
    ranks: ReadonlyArray<RankRecord>,
    reward_groups: ReadonlyArray<RewardGroupRecord>,
    mail_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const groups_by_id = new Map(reward_groups.map((group) => [group.id, group]));
    const requirements = new Map<string, RewardRequirement>();
    return [
        ...collect_rank_reference_errors(ranks, groups_by_id, mail_ids, requirements),
        ...collect_reward_group_errors(groups_by_id, requirements, mail_ids),
    ];
};

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("服务端排行榜结算与发奖配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("合成坏数据一次收集周期索引、奖励档位、邮件与区间错误", () => {
        const ranks: ReadonlyArray<RankRecord> = [
            {id: "user-cycle", type: rank.Type.UserRank, reward_ids: ["bad", "missing", "empty"]},
            {id: "arena", type: rank.Type.ArenaRank, reward_ids: ["arena-season"]},
            {id: "no-reward", type: rank.Type.UserRank, reward_ids: []},
        ];
        const reward_groups: ReadonlyArray<RewardGroupRecord> = [
            {
                id: "bad",
                tiers: [
                    {low: 1, high: 3, rewards: [], mail: ""},
                    {low: 3, high: 4, rewards: [{}], mail: "missing-mail"},
                    {low: 0, high: 1, rewards: [{}], mail: "known-mail"},
                    {low: 8, high: 7, rewards: [{}], mail: "known-mail"},
                ],
            },
            {id: "empty", tiers: []},
            {id: "arena-season", tiers: [{low: 1, high: 6, rewards: [{}], mail: ""}]},
            {
                id: ARENA_DAILY_REWARD_ID,
                tiers: [
                    {low: 1, high: 2, rewards: [{}], mail: "known-mail"},
                    {low: 3, high: 6, rewards: [], mail: "missing-mail"},
                ],
            },
        ];
        const errors = collect_rank_reward_errors(ranks, reward_groups, new Set(["known-mail"]));

        expect_structured_errors(errors);
        expect(errors).toHaveLength(11);
        [
            "rewardID=missing 不存在于 TbRankReward",
            "固定邮件模板 id=7 不存在于 TbMailTemplate",
            "闭区间 [0,1] 两端必须是正 uint32",
            "闭区间 [8,7] 不能为空",
            "档位 [1,3] 的奖励列表不能为空",
            "mail=<empty>",
            "mail=missing-mail 不存在于 TbMailTemplate",
            "first-match 会遮蔽后续档位",
            "奖励档位列表不能为空",
        ].forEach((fragment) => {
            expect(errors.some((message) => message.includes(fragment))).toBe(true);
        });
        expect(errors.some((message) =>
            message.includes("id=arena-season") && message.includes(".mail"))).toBe(false);
        expect(errors.some((message) => message.includes("id=no-reward"))).toBe(false);
    });

    it("当前快照满足服务端排行榜结算、奖励档位与邮件引用契约", () => {
        const ranks: ReadonlyArray<RankRecord> = tb.TbRank.getDataList().map((record) => ({
            id: record.id,
            type: record.type,
            reward_ids: record.rewardID,
        }));
        const reward_groups: ReadonlyArray<RewardGroupRecord> = tb.TbRankReward.getDataList().map((group) => ({
            id: group.id,
            tiers: group.rewards.map((tier) => ({
                low: tier.low,
                high: tier.high,
                rewards: tier.rewards,
                mail: tier.mail,
            })),
        }));
        const mail_ids = new Set(tb.TbMailTemplate.getDataList().map((mail) => mail.id));

        assert_no_errors(
            "存在服务端无法安全结算的排行榜配置：",
            collect_rank_reward_errors(ranks, reward_groups, mail_ids),
        );
    });
});
