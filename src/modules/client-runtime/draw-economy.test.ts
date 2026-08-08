import {beforeAll, describe, it} from "vitest";
import {drawcard} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

const UINT32_MAX = 0xffff_ffff;
const UINT32_MAX_BIGINT = 4_294_967_295n;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const MAX_SAFE_SPECIAL_GACHA_COUNT = Math.floor(INT32_MAX / 10);

type DrawConfigRecord = Readonly<{
    type: number;
}>;

type DrawDailyPoolRecord = Readonly<{
    index: number;
    reward_id: string;
}>;

type DrawNeutralRecord = Readonly<{
    id: string;
    pool_id: string;
}>;

type DrawConstRecord = Readonly<{
    one_draw_coin_cost: number;
    ten_draw_coin_cost: number;
    common_normal_pool: string;
    common_jackpot_pool: string;
    common_quality_pool: string;
    common_hundred_pool: string;
    special_gacha_count: number;
    special_gacha_a_pool: string;
    special_gacha_b_pool: string;
    special_gacha_c_pool: string;
    special_gacha_d_pool: string;
}>;

type DropPoolRecord = Readonly<{
    weight: number;
    rates: ReadonlyArray<number>;
}>;

type DropRecord = Readonly<{
    id: string;
    rewards: ReadonlyArray<DropPoolRecord>;
}>;

type DrawEconomySnapshot = Readonly<{
    draw_configs: ReadonlyArray<DrawConfigRecord>;
    daily_pools: ReadonlyArray<DrawDailyPoolRecord>;
    neutral_pools: ReadonlyArray<DrawNeutralRecord>;
    draw_const: DrawConstRecord;
    drops_by_id: ReadonlyMap<string, DropRecord>;
}>;

type DrawPoolMode = "weighted-one" | "independent-rate";

type DrawPoolUsage = Readonly<{
    table: "TbDrawConst" | "TbDrawDailyPool" | "TbDrawNeutral";
    record: string;
    field: string;
    pool_id: string;
    mode: DrawPoolMode;
}>;

const format_error = (table: string, record: string, field: string, reason: string): string =>
    `table=${table}, record=${record}, field=${field}, reason=${reason}`;

const is_uint32 = (value: number): boolean =>
    Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;

const is_int32 = (value: number): boolean =>
    Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;

const collect_draw_config_lookup_errors = (
    records: ReadonlyArray<DrawConfigRecord>,
): ReadonlyArray<string> => {
    const configured_types = new Set(records.map((record) => record.type));
    const required_types: ReadonlyArray<drawcard.DrawType> = [
        drawcard.DrawType.Common,
        drawcard.DrawType.LimitedTime,
        drawcard.DrawType.Neutral,
    ];

    // DrawSwitchTab 固定 setup 0/1/2 三个页签；DrawTab 与 DrawHeader 都直接解引用 get(type)。
    return required_types.flatMap((type) => configured_types.has(type)
        ? []
        : [format_error(
            "TbDrawConfig",
            "all",
            "type",
            `缺少 type=${drawcard.DrawType[type]}(${type})，客户端 exact get 后会解引用 undefined`,
        )]);
};

const collect_draw_const_errors = (record: DrawConstRecord): ReadonlyArray<string> => {
    const errors: string[] = [];
    const costs: ReadonlyArray<readonly [string, number]> = [
        ["oneDrawCoinCost", record.one_draw_coin_cost],
        ["tenDrawCoinCost", record.ten_draw_coin_cost],
    ];
    costs.forEach(([field, cost]) => {
        // 客户端用 number 比较/展示；服务端把该值放入 SubReward。0 会形成不扣资源的静默扣费。
        if (!Number.isSafeInteger(cost) || cost <= 0) {
            errors.push(format_error(
                "TbDrawConst",
                "singleton",
                field,
                `${field}=${cost} 必须是正安全整数`,
            ));
        }
    });

    const special_count = record.special_gacha_count;
    if (!is_int32(special_count)) {
        errors.push(format_error(
            "TbDrawConst",
            "singleton",
            "SpecialGachaCount",
            `SpecialGachaCount=${special_count} 必须是 int32 整数`,
        ));
    }
    else if (special_count > MAX_SAFE_SPECIAL_GACHA_COUNT) {
        // pickSpecialPool 在 int32 上直接计算 n*10；溢出后正数位置会提前短路到普通池。
        errors.push(format_error(
            "TbDrawConst",
            "singleton",
            "SpecialGachaCount",
            `SpecialGachaCount=${special_count} 使 int32(n*10) 溢出，最大允许 ${MAX_SAFE_SPECIAL_GACHA_COUNT}`,
        ));
    }

    return errors;
};

const collect_top_level_weight_errors = (
    drop: DropRecord,
    consumer: string,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    drop.rewards.forEach((reward, index) => {
        if (!is_uint32(reward.weight)) {
            errors.push(format_error(
                "TbDrop",
                drop.id,
                `rewards[${index}].weight`,
                `consumer=${consumer}, weight=${reward.weight} 必须是 uint32 整数`,
            ));
        }
    });

    const positive_weights = drop.rewards
        .map((reward) => reward.weight)
        .filter((weight) => is_uint32(weight) && weight > 0);
    if (positive_weights.length === 0) {
        errors.push(format_error(
            "TbDrop",
            drop.id,
            "rewards",
            `consumer=${consumer}, getWeightReward 会索引空的正权重集合`,
        ));
        return errors;
    }

    const total_weight = positive_weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
    if (total_weight >= UINT32_MAX_BIGINT) {
        errors.push(format_error(
            "TbDrop",
            drop.id,
            "rewards.weight",
            `consumer=${consumer}, 正权重总和=${total_weight} 使 uint32(sum+1) 溢出`,
        ));
    }
    return errors;
};

const collect_weighted_one_errors = (
    drop: DropRecord,
    consumer: string,
): ReadonlyArray<string> => drop.rewards
    .map((reward, pool_index) => ({pool_index, reward}))
    .filter(({reward}) => is_uint32(reward.weight) && reward.weight > 0)
    .flatMap(({pool_index, reward}) => {
        const errors: string[] = [];
        reward.rates.forEach((rate, rate_index) => {
            if (!is_uint32(rate)) {
                errors.push(format_error(
                    "TbDrop",
                    drop.id,
                    `rewards[${pool_index}].drops[${rate_index}].rate`,
                    `consumer=${consumer}, rate=${rate} 作为二级权重时必须是 uint32 整数`,
                ));
            }
        });

        const positive_rates = reward.rates.filter((rate) => is_uint32(rate) && rate > 0);
        if (positive_rates.length === 0) {
            errors.push(format_error(
                "TbDrop",
                drop.id,
                `rewards[${pool_index}].drops`,
                `consumer=${consumer}, GetDropIdRewardList1 的二级 getWeightReward 会索引空集合`,
            ));
            return errors;
        }

        const total_rate = positive_rates.reduce((sum, rate) => sum + BigInt(rate), 0n);
        if (total_rate >= UINT32_MAX_BIGINT) {
            errors.push(format_error(
                "TbDrop",
                drop.id,
                `rewards[${pool_index}].drops.rate`,
                `consumer=${consumer}, 二级正权重总和=${total_rate} 使 uint32(sum+1) 溢出`,
            ));
        }
        return errors;
    });

const collect_independent_rate_errors = (
    drop: DropRecord,
    consumer: string,
): ReadonlyArray<string> => drop.rewards
    .map((reward, pool_index) => ({pool_index, reward}))
    .filter(({reward}) => is_uint32(reward.weight) && reward.weight > 0)
    .flatMap(({pool_index, reward}) => {
        const errors: string[] = [];
        reward.rates.forEach((rate, rate_index) => {
            if (!is_uint32(rate)) {
                errors.push(format_error(
                    "TbDrop",
                    drop.id,
                    `rewards[${pool_index}].drops[${rate_index}].rate`,
                    `consumer=${consumer}, rate=${rate} 必须是 uint32 整数`,
                ));
            }
        });

        // doDropReward 对每项执行 rand.Int31n(101) <= rate；只有 rate>=100 能机械保证本次非空。
        if (!reward.rates.some((rate) => is_uint32(rate) && rate >= 100)) {
            errors.push(format_error(
                "TbDrop",
                drop.id,
                `rewards[${pool_index}].drops.rate`,
                `consumer=${consumer}, rand.Int31n(101) <= rate 无必中奖项，抽取集合可能为空`,
            ));
        }
        return errors;
    });

const collect_pool_usage_errors = (
    usages: ReadonlyArray<DrawPoolUsage>,
    drops_by_id: ReadonlyMap<string, DropRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const checked_mechanics = new Set<string>();

    usages.forEach((usage) => {
        const drop = drops_by_id.get(usage.pool_id);
        if (!drop) {
            errors.push(format_error(
                usage.table,
                usage.record,
                usage.field,
                `poolId=${usage.pool_id} 在 TbDrop 中不存在`,
            ));
            return;
        }

        const mechanics_key = `${usage.mode}:${drop.id}`;
        if (checked_mechanics.has(mechanics_key)) return;
        checked_mechanics.add(mechanics_key);

        const consumer = `${usage.table}.${usage.field}`;
        errors.push(...collect_top_level_weight_errors(drop, consumer));
        errors.push(...(usage.mode === "weighted-one"
            ? collect_weighted_one_errors(drop, consumer)
            : collect_independent_rate_errors(drop, consumer)));
    });
    return errors;
};

const collect_pool_usages = (snapshot: DrawEconomySnapshot): ReadonlyArray<DrawPoolUsage> => {
    const usages: DrawPoolUsage[] = [
        {
            table: "TbDrawConst",
            record: "singleton",
            field: "commonNormalPool",
            pool_id: snapshot.draw_const.common_normal_pool,
            mode: "weighted-one",
        },
        {
            table: "TbDrawConst",
            record: "singleton",
            field: "commonJackpotPool",
            pool_id: snapshot.draw_const.common_jackpot_pool,
            mode: "weighted-one",
        },
        {
            table: "TbDrawConst",
            record: "singleton",
            field: "commonQualityPool",
            pool_id: snapshot.draw_const.common_quality_pool,
            mode: "weighted-one",
        },
        {
            table: "TbDrawConst",
            record: "singleton",
            field: "commonHundredPool",
            pool_id: snapshot.draw_const.common_hundred_pool,
            mode: "weighted-one",
        },
    ];

    const special_count = snapshot.draw_const.special_gacha_count;
    if (is_int32(special_count)
        && special_count > 0
        && special_count <= MAX_SAFE_SPECIAL_GACHA_COUNT
    ) {
        usages.push(
            {
                table: "TbDrawConst",
                record: "singleton",
                field: "SpecialGachaAPool",
                pool_id: snapshot.draw_const.special_gacha_a_pool,
                mode: "weighted-one",
            },
            {
                table: "TbDrawConst",
                record: "singleton",
                field: "SpecialGachaBPool",
                pool_id: snapshot.draw_const.special_gacha_b_pool,
                mode: "weighted-one",
            },
        );
        if (special_count > 1) {
            usages.push(
                {
                    table: "TbDrawConst",
                    record: "singleton",
                    field: "SpecialGachaCPool",
                    pool_id: snapshot.draw_const.special_gacha_c_pool,
                    mode: "weighted-one",
                },
                {
                    table: "TbDrawConst",
                    record: "singleton",
                    field: "SpecialGachaDPool",
                    pool_id: snapshot.draw_const.special_gacha_d_pool,
                    mode: "weighted-one",
                },
            );
        }
    }

    snapshot.daily_pools.forEach((record) => usages.push({
        table: "TbDrawDailyPool",
        record: String(record.index),
        field: "rewardID",
        pool_id: record.reward_id,
        mode: "independent-rate",
    }));
    snapshot.neutral_pools.forEach((record) => usages.push({
        table: "TbDrawNeutral",
        record: record.id,
        field: "poolID",
        pool_id: record.pool_id,
        mode: "independent-rate",
    }));
    return usages;
};

const collect_draw_economy_errors = (
    snapshot: DrawEconomySnapshot,
): ReadonlyArray<string> => {
    const errors: string[] = [
        ...collect_draw_config_lookup_errors(snapshot.draw_configs),
        ...collect_draw_const_errors(snapshot.draw_const),
    ];

    if (snapshot.daily_pools.length === 0) {
        errors.push(format_error(
            "TbDrawDailyPool",
            "all",
            "rows",
            "TbDrawDailyPool 不能为空：服务端 openDay % len 会除零，客户端也会 exact get(0)",
        ));
    }

    errors.push(...collect_pool_usage_errors(collect_pool_usages(snapshot), snapshot.drops_by_id));
    return errors;
};

const collect_current_snapshot = (): DrawEconomySnapshot => {
    const draw_const = tb.TbDrawConst.getData();
    return {
        draw_configs: tb.TbDrawConfig.getDataList().map((record) => ({type: record.type})),
        daily_pools: tb.TbDrawDailyPool.getDataList().map((record, index) => ({
            index,
            reward_id: record.rewardID,
        })),
        neutral_pools: tb.TbDrawNeutral.getDataList().map((record) => ({
            id: record.id,
            pool_id: record.poolID,
        })),
        draw_const: {
            one_draw_coin_cost: draw_const.oneDrawCoinCost,
            ten_draw_coin_cost: draw_const.tenDrawCoinCost,
            common_normal_pool: draw_const.commonNormalPool,
            common_jackpot_pool: draw_const.commonJackpotPool,
            common_quality_pool: draw_const.commonQualityPool,
            common_hundred_pool: draw_const.commonHundredPool,
            special_gacha_count: draw_const.SpecialGachaCount,
            special_gacha_a_pool: draw_const.SpecialGachaAPool,
            special_gacha_b_pool: draw_const.SpecialGachaBPool,
            special_gacha_c_pool: draw_const.SpecialGachaCPool,
            special_gacha_d_pool: draw_const.SpecialGachaDPool,
        },
        drops_by_id: new Map(tb.TbDrop.getDataList().map((record) => [record.id, {
            id: record.id,
            rewards: record.rewards.map((reward) => ({
                weight: reward.weight,
                rates: reward.drops.map((drop) => drop.rate),
            })),
        }] as const)),
    };
};

const create_valid_synthetic_snapshot = (): DrawEconomySnapshot => {
    const weighted_ok: DropRecord = {
        id: "weighted-ok",
        rewards: [{weight: 1, rates: [1]}],
    };
    const independent_ok: DropRecord = {
        id: "independent-ok",
        rewards: [{weight: 1, rates: [100]}],
    };
    return {
        draw_configs: [
            {type: drawcard.DrawType.Common},
            {type: drawcard.DrawType.LimitedTime},
            {type: drawcard.DrawType.Neutral},
        ],
        daily_pools: [{index: 0, reward_id: independent_ok.id}],
        neutral_pools: [],
        draw_const: {
            one_draw_coin_cost: 1,
            ten_draw_coin_cost: 10,
            common_normal_pool: weighted_ok.id,
            common_jackpot_pool: weighted_ok.id,
            common_quality_pool: weighted_ok.id,
            common_hundred_pool: weighted_ok.id,
            special_gacha_count: 0,
            special_gacha_a_pool: "",
            special_gacha_b_pool: "",
            special_gacha_c_pool: "",
            special_gacha_d_pool: "",
        },
        drops_by_id: new Map([
            [weighted_ok.id, weighted_ok],
            [independent_ok.id, independent_ok],
        ]),
    };
};

const verify_collector_output = (
    errors: ReadonlyArray<string>,
    expected_fragments: ReadonlyArray<string>,
): ReadonlyArray<string> => [
    ...(errors.length === expected_fragments.length
        ? []
        : [format_error(
            "SyntheticFixture",
            "draw-economy",
            "errors",
            `实际错误数=${errors.length}，预期=${expected_fragments.length}`,
        )]),
    ...expected_fragments.flatMap((fragment) => errors.some((error) => error.includes(fragment))
        ? []
        : [format_error(
            "SyntheticFixture",
            "draw-economy",
            "errors",
            `缺少预期错误片段=${fragment}`,
        )]),
];

describe("客户端抽卡与服务端奖池经济配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 合成坏数据能一次收集 exact lookup、扣费、奖池与随机机械错误", () => {
        const valid = create_valid_synthetic_snapshot();
        const invalid_drops: ReadonlyArray<DropRecord> = [
            {id: "independent-empty", rewards: [{weight: 1, rates: [99]}]},
            {id: "weighted-no-inner", rewards: [{weight: 1, rates: [0]}]},
            {id: "top-overflow", rewards: [{weight: UINT32_MAX, rates: [1]}]},
            {id: "inner-overflow", rewards: [{weight: 1, rates: [UINT32_MAX]}]},
            {id: "top-zero", rewards: [{weight: 0, rates: [1]}]},
        ];
        const invalid_snapshot: DrawEconomySnapshot = {
            ...valid,
            draw_configs: [{type: drawcard.DrawType.Common}],
            daily_pools: [{index: 0, reward_id: "missing-daily"}],
            neutral_pools: [{id: "activity-id", pool_id: "independent-empty"}],
            draw_const: {
                ...valid.draw_const,
                one_draw_coin_cost: 0,
                ten_draw_coin_cost: 1.5,
                common_normal_pool: "missing-common",
                common_jackpot_pool: "weighted-no-inner",
                common_quality_pool: "top-overflow",
                common_hundred_pool: "inner-overflow",
                special_gacha_count: 2,
                special_gacha_a_pool: "missing-special",
                special_gacha_b_pool: "top-zero",
                special_gacha_c_pool: "weighted-ok",
                special_gacha_d_pool: "weighted-ok",
            },
            drops_by_id: new Map([
                ...valid.drops_by_id,
                ...invalid_drops.map((drop) => [drop.id, drop] as const),
            ]),
        };
        const overflow_snapshot: DrawEconomySnapshot = {
            ...valid,
            draw_const: {
                ...valid.draw_const,
                special_gacha_count: INT32_MAX,
            },
        };
        const empty_daily_snapshot: DrawEconomySnapshot = {
            ...valid,
            daily_pools: [],
        };

        const errors = [
            ...collect_draw_economy_errors(invalid_snapshot),
            ...collect_draw_economy_errors(overflow_snapshot),
            ...collect_draw_economy_errors(empty_daily_snapshot),
        ];
        assert_no_errors("合成坏数据未覆盖全部抽卡经济规则：", verify_collector_output(errors, [
            "type=LimitedTime",
            "type=Neutral",
            "poolId=missing-daily 在 TbDrop 中不存在",
            "rand.Int31n(101) <= rate",
            "oneDrawCoinCost=0",
            "tenDrawCoinCost=1.5",
            "poolId=missing-common",
            "record=weighted-no-inner",
            "record=top-overflow",
            "record=inner-overflow",
            "poolId=missing-special",
            "record=top-zero",
            `SpecialGachaCount=${INT32_MAX}`,
            "TbDrawDailyPool 不能为空",
        ]));
    });

    it("should 当前快照满足抽卡 exact lookup、扣费、奖池与随机机械约束", () => {
        assert_no_errors("存在客户端抽卡或服务端奖池经济非法配置：", collect_draw_economy_errors(
            collect_current_snapshot(),
        ));
    });
});
