import {beforeAll, describe, expect, it} from "vitest";
import {base} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type RewardRecord = Readonly<{
    id: string;
    type: number;
    count: number;
}>;

type RewardReferences = Readonly<{
    items: ReadonlySet<string>;
    heroes: ReadonlySet<string>;
    hero_qualities: ReadonlySet<string>;
    equips: ReadonlySet<string>;
}>;

type AwakenTaskRecord = Readonly<{
    id: number;
    type: number;
    pre_task: number;
    trigger_ratio: number;
    rewards: ReadonlyArray<RewardRecord>;
}>;

type DailyOrderRecord = Readonly<{
    id: number;
    cell_num: number;
}>;

type BusinessOrderRecord = Readonly<{
    id: number;
    open_min_day: number;
    open_max_day: number;
    cell_min_num: number;
    cell_max_num: number;
    quality_ranges: ReadonlyArray<string>;
    factor: number;
}>;

type NumPoolRecord = Readonly<{
    id: number;
    part: number;
    quality_ranges: ReadonlyMap<number, string>;
    weights: ReadonlyMap<number, number>;
}>;

type OpenDayRecord = Readonly<{
    id: number;
    open_min_day: number;
    open_max_day: number;
}>;

type ProduceGroupRecord = Readonly<{
    group_id: number;
    level: number;
    weights: ReadonlyMap<number, number>;
    protects: ReadonlyMap<number, number>;
}>;

type ProduceGroupConsumer = Readonly<{
    group_id: number;
    equip_group_id: number;
}>;

const AWAKEN_SOURCE = "excel=觉醒任务@M-喵王觉醒.xlsx";
const BUSINESS_SOURCE = "excel=S-商船.xlsx";
const BUILDING_SOURCE = "excel=生产组@J-建筑.xlsx";
const MAX_INT32 = 2_147_483_647n;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_UINT32 = 4_294_967_295;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const LEGAL_AWAKEN_TASK_TYPES: ReadonlySet<number> = new Set([1, 2]);

const collect_reward_errors = (
    owner: string,
    rewards: ReadonlyArray<RewardRecord>,
    references: RewardReferences,
    allow_empty = false,
): ReadonlyArray<string> => {
    if (rewards.length === 0) {
        return allow_empty ? [] : [`${owner}, reason=奖励列表不能为空`];
    }

    return rewards.flatMap((reward, index) => {
        const source = `${owner}, reward_index=${index}, reward_id=${reward.id}, reward_type=${reward.type}`;
        const errors: string[] = [];
        if (!Number.isSafeInteger(reward.count) || reward.count <= 0) {
            errors.push(`${source}, count=${reward.count}, reason=奖励数量必须是正整数`);
        }
        switch (reward.type) {
            case base.RewardType.Item:
                if (!references.items.has(reward.id)) {
                    errors.push(`${source}, reason=道具奖励引用不存在`);
                }
                break;
            case base.RewardType.Hero: {
                const separator = reward.id.indexOf("_");
                const hero_id = separator >= 0 ? reward.id.slice(0, separator) : "";
                const quality = separator >= 0 ? reward.id.slice(separator + 1) : "";
                if (!hero_id || !quality) {
                    errors.push(`${source}, reason=抽取军团奖励必须符合 heroId_quality 格式`);
                } else {
                    if (!references.heroes.has(hero_id)) {
                        errors.push(`${source}, hero_id=${hero_id}, reason=抽取军团引用不存在`);
                    }
                    if (!references.hero_qualities.has(quality)) {
                        errors.push(`${source}, quality=${quality}, reason=抽取军团品质不存在`);
                    }
                }
                break;
            }
            case base.RewardType.Equip:
                if (!references.equips.has(reward.id)) {
                    errors.push(`${source}, reason=装备奖励引用不存在`);
                }
                break;
            case base.RewardType.BingYingHero:
                if (!references.heroes.has(reward.id)) {
                    errors.push(`${source}, reason=兵营军团奖励必须是存在的裸 heroId`);
                }
                break;
            case base.RewardType.Worker:
            case base.RewardType.Exp:
                // 两个处理器都忽略 reward id，只消费 count。
                break;
            case base.RewardType.DrawTrans:
            default:
                errors.push(`${source}, reason=服务端不存在该奖励类型处理器`);
                break;
        }
        return errors;
    });
};

const collect_awaken_cycle_errors = (
    tasks_by_id: ReadonlyMap<number, AwakenTaskRecord>,
): ReadonlyArray<string> => {
    const states = new Map<number, 0 | 1 | 2>();
    const stack: number[] = [];
    const errors: string[] = [];

    const visit = (id: number): void => {
        const state = states.get(id) ?? 0;
        if (state === 2) {
            return;
        }
        if (state === 1) {
            const start = stack.indexOf(id);
            const cycle = [...stack.slice(start), id];
            errors.push(`${AWAKEN_SOURCE}, task_ids=${cycle.join(" -> ")}, reason=前置任务形成环`);
            return;
        }

        states.set(id, 1);
        stack.push(id);
        const pre_task = tasks_by_id.get(id)?.pre_task ?? 0;
        if (pre_task !== 0 && tasks_by_id.has(pre_task)) {
            visit(pre_task);
        }
        stack.pop();
        states.set(id, 2);
    };

    Array.from(tasks_by_id.keys()).forEach(visit);
    return errors;
};

const collect_awaken_task_errors = (
    records: ReadonlyArray<AwakenTaskRecord>,
    reward_references: RewardReferences,
    allow_empty_rewards = false,
): ReadonlyArray<string> => {
    const counts = new Map<number, number>();
    records.forEach((record) => counts.set(record.id, (counts.get(record.id) ?? 0) + 1));
    const tasks_by_id = new Map<number, AwakenTaskRecord>();
    records.forEach((record) => {
        if (!tasks_by_id.has(record.id)) {
            tasks_by_id.set(record.id, record);
        }
    });

    return [
        ...Array.from(counts.entries()).flatMap(([id, count]) =>
            count > 1 ? [`${AWAKEN_SOURCE}, task_id=${id}, count=${count}, reason=任务 id 重复`] : []
        ),
        ...records.flatMap((record) => {
            const source = `${AWAKEN_SOURCE}, task_id=${record.id}`;
            return [
                ...(LEGAL_AWAKEN_TASK_TYPES.has(record.type)
                    ? []
                    : [`${source}, type=${record.type}, reason=服务端仅处理 Type 1 和 2`]),
                ...(record.pre_task === 0 || tasks_by_id.has(record.pre_task)
                    ? []
                    : [`${source}, pre_task=${record.pre_task}, reason=前置任务不存在`]),
                ...(Number.isSafeInteger(record.trigger_ratio)
                    && record.trigger_ratio >= 1
                    ? []
                    : [`${source}, trigger_ratio=${record.trigger_ratio}, reason=触发概率必须是正整数；大于 10000 按服务端 guaranteed sentinel 处理`]),
                ...collect_reward_errors(source, record.rewards, reward_references, allow_empty_rewards),
            ];
        }),
        ...collect_awaken_cycle_errors(tasks_by_id),
    ];
};

const parse_uint = (value: string, bits: 32 | 64): bigint | undefined => {
    const trimmed = value.trim();
    if (!/^\+?\d+$/u.test(trimmed)) {
        return undefined;
    }
    const parsed = BigInt(trimmed);
    const max = bits === 32 ? 4_294_967_295n : 18_446_744_073_709_551_615n;
    return parsed <= max ? parsed : undefined;
};

const parse_daily_quantity_range = (value: string): Readonly<[bigint, bigint]> | undefined => {
    const parts = value.split("_");
    if (parts.length !== 2) {
        return undefined;
    }
    const min = parse_uint(parts[0], 64);
    const max = parse_uint(parts[1], 64);
    return min !== undefined && max !== undefined && min <= max ? [min, max] : undefined;
};

const parse_business_quality_range = (
    value: string,
): Readonly<[bigint, bigint, bigint]> | undefined => {
    const quality_parts = value.split("_");
    if (quality_parts.length !== 2) {
        return undefined;
    }
    const quality = parse_uint(quality_parts[0], 32);
    const num_parts = quality_parts[1].split("-");
    if (num_parts.length !== 2) {
        return undefined;
    }
    const min = parse_uint(num_parts[0], 64);
    const max = parse_uint(num_parts[1], 64);
    return quality !== undefined && min !== undefined && max !== undefined && min <= max
        ? [quality, min, max]
        : undefined;
};

const is_daily_random_range_safe = (min: bigint, max: bigint): boolean =>
    min === max || max - min + 1n <= MAX_INT64;

const count_multiples_in_range = (min: bigint, max: bigint, factor: bigint): bigint => {
    const remainder = min % factor;
    const first = remainder === 0n ? min : min + factor - remainder;
    return first <= max ? (max - first) / factor + 1n : 0n;
};

const has_positive_multiple_in_range = (min: bigint, max: bigint, factor: bigint): boolean => {
    const positive_min = min > 0n ? min : 1n;
    return count_multiples_in_range(positive_min, max, factor) > 0n;
};

const equip_path_key = (job_type: number, quality: number, part: number): string =>
    `${job_type}:${quality}:${part}`;

const collect_equip_path_errors = (
    source: string,
    part: number,
    quality: number,
    equip_paths: ReadonlySet<string>,
): ReadonlyArray<string> =>
    Array.from({length: 7}, (_, index) => index + 1).flatMap((job_type) =>
        equip_paths.has(equip_path_key(job_type, quality, part))
            ? []
            : [`${source}, part=${part}, quality=${quality}, job_type=${job_type}, reason=GetEquipIds 消费路径无可用装备`]
    );

const collect_open_day_errors = (
    table: string,
    records: ReadonlyArray<OpenDayRecord>,
    allow_identical_intervals: boolean,
): ReadonlyArray<string> => {
    const errors = records.flatMap((record) =>
        Number.isSafeInteger(record.open_min_day)
        && Number.isSafeInteger(record.open_max_day)
        && record.open_min_day <= record.open_max_day
            ? []
            : [`${BUSINESS_SOURCE}, table=${table}, id=${record.id}, open_days=${record.open_min_day}..${record.open_max_day}, reason=开服日区间无效`]
    );
    const intervals = records
        .map(({open_min_day, open_max_day}) => ({open_min_day, open_max_day}))
        .sort((left, right) => left.open_min_day - right.open_min_day || left.open_max_day - right.open_max_day)
        .filter((record, index, all) =>
            !allow_identical_intervals
            || index === 0
            || record.open_min_day !== all[index - 1].open_min_day
            || record.open_max_day !== all[index - 1].open_max_day
        );
    for (let index = 1; index < intervals.length; index += 1) {
        const previous = intervals[index - 1];
        const current = intervals[index];
        if (current.open_min_day <= previous.open_max_day) {
            errors.push(`${BUSINESS_SOURCE}, table=${table}, intervals=${previous.open_min_day}..${previous.open_max_day} and ${current.open_min_day}..${current.open_max_day}, reason=开服日区间重叠`);
        }
    }
    return errors;
};

const collect_business_ship_errors = (
    daily_orders: ReadonlyArray<DailyOrderRecord>,
    business_orders: ReadonlyArray<BusinessOrderRecord>,
    num_pools: ReadonlyArray<NumPoolRecord>,
    equip_paths: ReadonlySet<string>,
    reward_pool_ids: ReadonlySet<number>,
    order_rewards: ReadonlyArray<OpenDayRecord>,
): ReadonlyArray<string> => {
    return [
        ...daily_orders.flatMap((record) =>
            Number.isSafeInteger(record.cell_num)
            && record.cell_num >= 0
            && record.cell_num <= MAX_UINT32
                ? []
                : [`${BUSINESS_SOURCE}, table=DailyOrder, id=${record.id}, cell_num=${record.cell_num}, reason=随机格子数必须是 uint32；0 会由服务端归一为 1`]
        ),
        ...business_orders.flatMap((record) => {
            const source = `${BUSINESS_SOURCE}, table=BusinessOrder, id=${record.id}`;
            const factor_valid = Number.isSafeInteger(record.factor)
                && record.factor > 0
                && record.factor <= MAX_UINT32;
            return [
                ...(Number.isSafeInteger(record.cell_min_num)
                    && Number.isSafeInteger(record.cell_max_num)
                    && record.cell_min_num > 0
                    && record.cell_max_num <= MAX_UINT32
                    && record.cell_min_num <= record.cell_max_num
                    ? []
                    : [`${source}, cells=${record.cell_min_num}..${record.cell_max_num}, reason=格子上下限必须为正整数且 min<=max`]),
                ...(factor_valid
                    ? []
                    : [`${source}, factor=${record.factor}, reason=奖励倍数除数必须是正 uint32`]),
                ...(record.quality_ranges.length > 0
                    ? []
                    : [`${source}, reason=品质数量区间不能为空，否则服务端必然生成空订单`]),
                ...record.quality_ranges.flatMap((value) => {
                    const parsed = parse_business_quality_range(value);
                    if (!parsed) {
                        return [`${source}, quality_range=${value}, reason=必须符合服务端 quality_min-max 语法且 min<=max`];
                    }
                    const [quality_bigint, min, max] = parsed;
                    const quality = Number(quality_bigint);
                    const range_source = `${source}, quality_range=${value}`;
                    const factor = factor_valid ? BigInt(record.factor) : undefined;
                    const pool_errors = Array.from({length: 4}, (_, index) => index + 1).flatMap((part) => {
                        const pool_id = part * 10 + quality;
                        return [
                            ...collect_equip_path_errors(range_source, part, quality, equip_paths),
                            ...(reward_pool_ids.has(pool_id)
                                ? []
                                : [`${range_source}, part=${part}, quality=${quality}, pool_id=${pool_id}, reason=calcReward 消费的 Reward 配置不存在`]),
                        ];
                    });
                    return [
                        ...(max < MAX_UINT64
                            ? []
                            : [`${range_source}, reason=findInRange 的 end=MaxUint64 会使 i++ 回绕后无限循环`]),
                        ...(factor && count_multiples_in_range(min, max, factor) <= MAX_INT64
                            ? []
                            : factor
                                ? [`${range_source}, reason=findInRange 结果数量超过 int/rand.Intn 可表示范围`]
                                : []),
                        ...(factor && has_positive_multiple_in_range(min, max, factor)
                            ? []
                            : factor
                                ? [`${range_source}, factor=${record.factor}, reason=区间内没有可被 factor 整除的正数量，服务端必然生成空订单`]
                                : []),
                        ...pool_errors,
                    ];
                }),
            ];
        }),
        ...num_pools.flatMap((record) => {
            const source = `${BUSINESS_SOURCE}, table=NumPool, id=${record.id}`;
            const positive_weights = Array.from(record.weights.values()).filter((weight) => weight > 0);
            const safe_weights = positive_weights.filter(Number.isSafeInteger);
            const total = safe_weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
            return [
                ...(positive_weights.length > 0
                    ? []
                    : [`${source}, reason=至少需要一个正权重`]),
                ...(safe_weights.length === positive_weights.length && total <= MAX_INT32
                    ? []
                    : [`${source}, total_positive_weight=${total}, reason=正权重必须是安全整数且总和不能超过 MaxInt32`]),
                ...Array.from(record.quality_ranges.entries()).flatMap(([quality, value]) => {
                    const parsed = parse_daily_quantity_range(value);
                    if (!parsed) {
                        return [`${source}, quality=${quality}, quantity_range=${value}, reason=必须符合服务端 min_max 语法且 min<=max`];
                    }
                    return is_daily_random_range_safe(...parsed)
                        ? []
                        : [`${source}, quality=${quality}, quantity_range=${value}, reason=区间宽度超过 int/rand.Intn 可表示范围`];
                }),
                ...Array.from(record.weights.entries()).flatMap(([quality, weight]) => {
                    if (weight <= 0) {
                        return [];
                    }
                    const pool_id = record.part * 10 + quality;
                    return [
                        ...(record.quality_ranges.has(quality)
                            ? []
                            : [`${source}, quality=${quality}, reason=权重品质缺少数量区间`]),
                        ...collect_equip_path_errors(source, record.part, quality, equip_paths),
                        ...(reward_pool_ids.has(pool_id)
                            ? []
                            : [`${source}, quality=${quality}, pool_id=${pool_id}, reason=calcReward 消费的 Reward 配置不存在`]),
                    ];
                }),
            ];
        }),
        ...collect_open_day_errors("BusinessOrder", business_orders, false),
        ...collect_open_day_errors("OrderReward", order_rewards, true),
    ];
};

const collect_building_produce_group_errors = (
    groups: ReadonlyArray<ProduceGroupRecord>,
    consumers: ReadonlyArray<ProduceGroupConsumer>,
    equip_group_qualities: ReadonlyMap<number, ReadonlySet<number>>,
): ReadonlyArray<string> => {
    const consumers_by_group = new Map<number, ProduceGroupConsumer[]>();
    consumers.forEach((consumer) => {
        const current = consumers_by_group.get(consumer.group_id) ?? [];
        current.push(consumer);
        consumers_by_group.set(consumer.group_id, current);
    });

    return groups.flatMap((record) => {
        const source = `${BUILDING_SOURCE}, group_id=${record.group_id}, level=${record.level}`;
        const positive_weights = Array.from(record.weights.entries()).filter(([, weight]) => weight > 0);
        const safe_weights = positive_weights.filter(([, weight]) => Number.isSafeInteger(weight));
        const total = safe_weights.reduce((sum, [, weight]) => sum + BigInt(weight), 0n);
        return [
            ...(positive_weights.length > 0
                ? []
                : [`${source}, reason=produceWeight 至少需要一个正权重`]),
            ...(safe_weights.length === positive_weights.length && total <= MAX_INT64
                ? []
                : [`${source}, total_positive_weight=${total}, reason=正权重必须是安全整数且总和不能溢出 int64`]),
            ...Array.from(record.protects.keys()).flatMap((quality) =>
                record.weights.has(quality)
                    ? []
                    : [`${source}, quality=${quality}, reason=protectCnt 品质不是 produceWeight key`]
            ),
            ...(consumers_by_group.get(record.group_id) ?? []).flatMap((consumer) => {
                const qualities = equip_group_qualities.get(consumer.equip_group_id);
                if (!qualities) {
                    return [`${source}, equip_group_id=${consumer.equip_group_id}, reason=引用的装备组不存在`];
                }
                return Array.from(record.weights.keys()).flatMap((quality) =>
                    qualities.has(quality)
                        ? []
                        : [`${source}, equip_group_id=${consumer.equip_group_id}, quality=${quality}, reason=装备组缺少权重引用的品质`]
                );
            }),
        ];
    });
};

const collect_reward_references = (): RewardReferences => ({
    items: new Set(tb.TbItem.getDataList().map((record) => record.id)),
    heroes: new Set(tb.TbHero.getDataList().map((record) => record.id)),
    hero_qualities: new Set(tb.TbHeroQuality.getDataList().map((record) => record.id)),
    equips: new Set(tb.TbEquip.getDataList().map((record) => record.id)),
});

describe("服务端商船、觉醒任务与建筑随机配置校验", () => {
    let reward_references: RewardReferences;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        reward_references = collect_reward_references();
    });

    it("should 合成坏数据能覆盖服务端机械失败分支", () => {
        const awaken_errors = collect_awaken_task_errors([
            {id: 1, type: 9, pre_task: 2, trigger_ratio: 0, rewards: []},
            {id: 2, type: 1, pre_task: 1, trigger_ratio: 10_001, rewards: [{id: "missing", type: base.RewardType.Item, count: 0}]},
            {id: 2, type: 1, pre_task: 0, trigger_ratio: 1, rewards: [{id: "", type: base.RewardType.Worker, count: 1}]},
            {id: 3, type: 2, pre_task: 99, trigger_ratio: 1, rewards: [{id: "worker", type: base.RewardType.Worker, count: 1}]},
            {id: 4, type: 2, pre_task: 0, trigger_ratio: 1, rewards: [{id: "1001", type: base.RewardType.Hero, count: 1}]},
            {id: 5, type: 2, pre_task: 0, trigger_ratio: 1, rewards: [{id: "1001", type: base.RewardType.DrawTrans, count: 1}]},
            {id: 6, type: 2, pre_task: 0, trigger_ratio: 1, rewards: [{id: "1001_C", type: base.RewardType.BingYingHero, count: 1}]},
        ], {items: new Set(), heroes: new Set(), hero_qualities: new Set(), equips: new Set()});
        const business_errors = collect_business_ship_errors(
            [{id: 1, cell_num: 0}, {id: 2, cell_num: -1}],
            [
                {id: 1, open_min_day: 1, open_max_day: 3, cell_min_num: 2, cell_max_num: 1, quality_ranges: ["1_9-2"], factor: 0},
                {id: 2, open_min_day: 3, open_max_day: 5, cell_min_num: 1, cell_max_num: 1, quality_ranges: ["1_1-1"], factor: 1},
                {id: 3, open_min_day: 6, open_max_day: 7, cell_min_num: 1, cell_max_num: 1, quality_ranges: ["1_2-3"], factor: 4},
                {id: 4, open_min_day: 8, open_max_day: 9, cell_min_num: 1, cell_max_num: 1, quality_ranges: ["1_18446744073709551615-18446744073709551615"], factor: 1},
            ],
            [
                {id: 11, part: 1, quality_ranges: new Map([[1, "3_1"], [2, "0_18446744073709551615"]]), weights: new Map([[1, 0], [2, 1]])},
                {id: 12, part: 1, quality_ranges: new Map([[1, "1_1"]]), weights: new Map([[1, 0]])},
            ],
            new Set(),
            new Set(),
            [],
        );
        const building_errors = collect_building_produce_group_errors(
            [{group_id: 1, level: 1, weights: new Map([[1, 0]]), protects: new Map([[2, 0]])}],
            [{group_id: 1, equip_group_id: 99}],
            new Map(),
        );

        expect(awaken_errors.join("\n")).toContain("任务 id 重复");
        expect(awaken_errors.join("\n")).toContain("前置任务形成环");
        expect(awaken_errors.join("\n")).toContain("前置任务不存在");
        expect(awaken_errors.join("\n")).toContain("服务端仅处理 Type 1 和 2");
        expect(awaken_errors.join("\n")).toContain("触发概率必须是正整数");
        expect(awaken_errors.join("\n")).toContain("奖励列表不能为空");
        expect(awaken_errors.join("\n")).toContain("道具奖励引用不存在");
        expect(awaken_errors.join("\n")).toContain("奖励数量必须是正整数");
        expect(awaken_errors.join("\n")).toContain("heroId_quality");
        expect(awaken_errors.join("\n")).toContain("裸 heroId");
        expect(awaken_errors.join("\n")).toContain("服务端不存在该奖励类型处理器");
        expect(awaken_errors.join("\n")).not.toContain("task_id=2, reward_index=0, reward_id=, reward_type=3");
        expect(business_errors.join("\n")).toContain("随机格子数必须是 uint32");
        expect(business_errors.join("\n")).not.toContain("id=1, cell_num=0");
        expect(business_errors.join("\n")).toContain("格子上下限必须为正整数且 min<=max");
        expect(business_errors.join("\n")).toContain("奖励倍数除数必须是正 uint32");
        expect(business_errors.join("\n")).toContain("quality_min-max");
        expect(business_errors.join("\n")).toContain("min_max");
        expect(business_errors.join("\n")).toContain("至少需要一个正权重");
        expect(business_errors.join("\n")).toContain("int/rand.Intn 可表示范围");
        expect(business_errors.join("\n")).toContain("没有可被 factor 整除的正数量");
        expect(business_errors.join("\n")).toContain("i++ 回绕后无限循环");
        expect(business_errors.join("\n")).toContain("GetEquipIds 消费路径无可用装备");
        expect(business_errors.join("\n")).toContain("calcReward 消费的 Reward 配置不存在");
        expect(business_errors.join("\n")).toContain("开服日区间重叠");
        expect(building_errors.join("\n")).toContain("至少需要一个正权重");
        expect(building_errors.join("\n")).toContain("protectCnt 品质不是 produceWeight key");
        expect(building_errors.join("\n")).toContain("引用的装备组不存在");
    });

    it("should 当前禁用的觉醒任务占位配置满足非奖励结构规则", () => {
        const records: ReadonlyArray<AwakenTaskRecord> = tb.TbAwakenTask.getDataList().map((record) => ({
            id: record.id,
            type: record.type,
            pre_task: record.preTask,
            trigger_ratio: record.triggerRatio,
            rewards: record.rewards.map((reward) => ({id: reward.id, type: reward.type, count: reward.count})),
        }));
        // 领取协议、生产触发和同步入口当前均被服务端显式注释；空奖励是未启用玩法的占位值。
        // 恢复 awaken task 注册时应移除 allow_empty_rewards，并在上线前补齐奖励。
        assert_no_errors(
            "存在服务端不可安全执行的觉醒任务配置：",
            collect_awaken_task_errors(records, reward_references, true),
        );
    });

    it("should 当前商船配置满足服务端解析、随机与引用规则", () => {
        const errors = collect_business_ship_errors(
            tb.TbBusinessShipDailyOrder.getDataList().map((record) => ({id: record.id, cell_num: record.cellNum})),
            tb.TbBusinessShipBusinessOrder.getDataList().map((record) => ({
                id: record.id,
                open_min_day: record.openMinDay,
                open_max_day: record.openMaxDay,
                cell_min_num: record.cellMinNum,
                cell_max_num: record.cellMaxNum,
                quality_ranges: record.qualitys,
                factor: record.factor,
            })),
            tb.TbBusinessShipNumPool.getDataList().map((record) => ({
                id: record.id,
                part: record.part,
                quality_ranges: record.qualitys,
                weights: record.weights,
            })),
            new Set(tb.TbEquip.getDataList().map((record) => equip_path_key(record.jobType, record.quality, record.part))),
            new Set(tb.TbBusinessShipReward.getDataList().map((record) => record.id)),
            tb.TbBusinessShipOrderReward.getDataList().map((record) => ({id: record.id, open_min_day: record.openMinDay, open_max_day: record.openMaxDay})),
        );
        assert_no_errors("存在服务端不可安全执行的商船配置：", errors);
    });

    it("should 当前建筑生产组满足服务端权重、保底与装备组引用规则", () => {
        const groups = tb.TbBuildingProduceGroup.getDataList().flatMap((group) =>
            Array.from(group.config.entries()).map(([level, config]) => ({
                group_id: group.id,
                level,
                weights: config.produceWeight,
                protects: config.protectCnt,
            }))
        );
        const consumers = tb.TbBuildingProduce.getDataList().flatMap((building) =>
            Array.from(building.config.values()).flatMap((config) =>
                config.productType === base.RewardType.Equip && config.produceGroup > 0
                    ? [{group_id: config.produceGroup, equip_group_id: config.equipGroup}]
                    : []
            )
        );
        const equip_group_qualities = new Map(
            tb.TbBuildingEquipGroup.getDataList().map((group) => [
                group.id,
                new Set(Array.from(group.config.values()).map((config) => config.quality)),
            ]),
        );
        assert_no_errors(
            "存在服务端不可安全执行的建筑生产组配置：",
            collect_building_produce_group_errors(groups, consumers, equip_group_qualities),
        );
    });
});
