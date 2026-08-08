import {beforeAll, describe, it} from "vitest";
import {base, item} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

const UINT32_MAX = 0xffff_ffff;
const UINT32_MAX_BIGINT = 4_294_967_295n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const SERVER_HERO_QUALITIES: ReadonlySet<string> = new Set([
    "C", "Cp", "B", "Bp", "A", "Ap", "S", "Sp", "L",
]);

type WeightedEntry = Readonly<{
    weight: number;
}>;

type DropRewardRecord = Readonly<{
    id: string;
    type: number;
    count: number;
}>;

type DropPoolRecord = Readonly<{
    weight: number;
    drops: ReadonlyArray<DropRewardRecord>;
}>;

type DropRecord = Readonly<{
    id: string;
    rewards: ReadonlyArray<DropPoolRecord>;
}>;

type RewardReferenceCatalog = Readonly<{
    item_ids: ReadonlySet<string>;
    hero_ids: ReadonlySet<string>;
    hero_qualities: ReadonlySet<string>;
    equip_ids: ReadonlySet<string>;
}>;

type ShopGoodsPoolRecord = Readonly<{
    goods_id: string;
    weight: number;
}>;

type ShopPoolRecord = Readonly<{
    id: string;
    shop_id: string;
    level: ReadonlyArray<number>;
    draw_cnt: ReadonlyArray<number>;
    goods_pool: ReadonlyArray<ShopGoodsPoolRecord>;
}>;

type ItemArgsRecord = Readonly<{
    id: string;
    main_type: number;
    sub_type: number;
    args: ReadonlyMap<string, string>;
}>;

type ItemArgRule = Readonly<{
    field: "args.cost" | "args.cnt" | "args.ownTime";
    key: "cost" | "cnt" | "ownTime";
    max: bigint;
}>;

const format_error = (table: string, record: string, field: string, reason: string): string =>
    `table=${table}, record=${record}, field=${field}, reason=${reason}`;

const is_uint32 = (value: number): boolean =>
    Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;

const collect_weight_errors = (
    table: string,
    record: string,
    field: string,
    entries: ReadonlyArray<WeightedEntry>,
    required: boolean,
): ReadonlyArray<string> => {
    const errors = entries.flatMap((entry, index) =>
        is_uint32(entry.weight)
            ? []
            : [format_error(table, record, `${field}[${index}].weight`, `weight=${entry.weight} 必须是 uint32 整数`)]
    );
    const valid_positive_weights = entries
        .map((entry) => entry.weight)
        .filter((weight) => is_uint32(weight) && weight > 0);

    if (required && valid_positive_weights.length === 0) {
        errors.push(format_error(table, record, field, "需要随机抽取时至少配置一个正权重"));
    }

    const total_weight = valid_positive_weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
    if (total_weight >= UINT32_MAX_BIGINT) {
        errors.push(format_error(table, record, field, `正权重总和=${total_weight} 必须小于 uint32 上限=${UINT32_MAX_BIGINT}，否则随机上界 +1 溢出`));
    }

    return errors;
};

const collect_drop_reference_errors = (
    drop_id: string,
    pool_index: number,
    drop_index: number,
    reward: DropRewardRecord,
    catalog: RewardReferenceCatalog,
): ReadonlyArray<string> => {
    const record = `${drop_id}.rewards[${pool_index}].drops[${drop_index}]`;
    const errors: string[] = [];

    if (!Number.isSafeInteger(reward.count) || reward.count <= 0) {
        errors.push(format_error("TbDrop", record, "count", `count=${reward.count} 必须是正安全整数`));
    }

    switch (reward.type) {
        case base.RewardType.Item:
            if (!catalog.item_ids.has(reward.id)) {
                errors.push(format_error("TbDrop", record, "id", `type=${reward.type} 的道具 id=${reward.id} 不存在于 TbItem`));
            }
            break;
        case base.RewardType.Hero: {
            const separator_index = reward.id.indexOf("_");
            const hero_id = separator_index < 0 ? "" : reward.id.slice(0, separator_index);
            const quality = separator_index < 0 ? "" : reward.id.slice(separator_index + 1);
            if (!catalog.hero_ids.has(hero_id) || !catalog.hero_qualities.has(quality) || !SERVER_HERO_QUALITIES.has(quality)) {
                errors.push(format_error("TbDrop", record, "id", `抽卡军团 id=${reward.id} 必须为已存在且受服务端 QualityOrderIdx 支持的 heroId_quality`));
            }
            break;
        }
        case base.RewardType.Equip:
            if (!catalog.equip_ids.has(reward.id)) {
                errors.push(format_error("TbDrop", record, "id", `装备 id=${reward.id} 不存在于 TbEquip`));
            }
            break;
        case base.RewardType.BingYingHero:
            if (!catalog.hero_ids.has(reward.id)) {
                errors.push(format_error("TbDrop", record, "id", `兵营军团 id=${reward.id} 不存在于 TbHero`));
            }
            break;
        case base.RewardType.Worker:
        case base.RewardType.Exp:
            // 两类处理器均忽略传入 id，仅按奖励类型投影结果；这里不推断无运行时约束的特殊 id。
            break;
        case base.RewardType.DrawTrans:
            errors.push(format_error("TbDrop", record, "type", "DrawTrans 是军团升品内部同步类型，未注册可发放奖励模块"));
            break;
        default:
            errors.push(format_error("TbDrop", record, "type", `未知奖励 type=${reward.type}`));
    }

    return errors;
};

const collect_drop_errors = (
    records: ReadonlyArray<DropRecord>,
    catalog: RewardReferenceCatalog,
): ReadonlyArray<string> =>
    records.flatMap((record) => [
        ...collect_weight_errors("TbDrop", record.id, "rewards", record.rewards, true),
        ...record.rewards.flatMap((pool, pool_index) =>
            pool.drops.flatMap((reward, drop_index) =>
                collect_drop_reference_errors(record.id, pool_index, drop_index, reward, catalog)
            )
        ),
    ]);

const collect_shop_pool_errors = (
    records: ReadonlyArray<ShopPoolRecord>,
    goods_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const errors = records.flatMap((record) => {
        const record_errors: string[] = [];
        record.draw_cnt.forEach((draw_cnt, index) => {
            if (!Number.isSafeInteger(draw_cnt) || draw_cnt < 0) {
                record_errors.push(format_error("TbCommonShopPool", record.id, `drawCnt[${index}]`, `drawCnt=${draw_cnt} 必须是非负安全整数`));
            }
        });
        if (record.draw_cnt.length !== 2) {
            record_errors.push(format_error("TbCommonShopPool", record.id, "drawCnt", `长度=${record.draw_cnt.length}，服务端固定读取 [0]/[1]，必须恰为 2`));
        }

        record.level.forEach((level, index) => {
            if (!is_uint32(level)) {
                record_errors.push(format_error("TbCommonShopPool", record.id, `level[${index}]`, `level=${level} 必须是 uint32 整数`));
            }
        });
        if (record.level.length !== 2) {
            record_errors.push(format_error("TbCommonShopPool", record.id, "level", `长度=${record.level.length}，服务端固定读取 [0]/[1]，必须恰为 2`));
        }
        if (record.level.length === 2 && is_uint32(record.level[0]) && is_uint32(record.level[1]) && record.level[0] >= record.level[1]) {
            record_errors.push(format_error("TbCommonShopPool", record.id, "level", `半开区间 [${record.level[0]},${record.level[1]}) 必须非空，即 min < max`));
        }

        const needs_draw = record.draw_cnt.slice(0, 2).some((draw_cnt) => Number.isSafeInteger(draw_cnt) && draw_cnt > 0);
        record_errors.push(...collect_weight_errors("TbCommonShopPool", record.id, "goodsPool", record.goods_pool, needs_draw));
        record.goods_pool.forEach((goods, index) => {
            if (!goods_ids.has(goods.goods_id)) {
                record_errors.push(format_error("TbCommonShopPool", record.id, `goodsPool[${index}].goodsId`, `goodsId=${goods.goods_id} 不存在于 TbCommonShopGoods`));
            }
        });
        return record_errors;
    });

    const records_by_shop = new Map<string, ShopPoolRecord[]>();
    records.forEach((record) => {
        const shop_records = records_by_shop.get(record.shop_id) ?? [];
        shop_records.push(record);
        records_by_shop.set(record.shop_id, shop_records);
    });
    Array.from(records_by_shop.entries()).forEach(([shop_id, shop_records]) => {
        const valid_records = shop_records
            .filter((record) => record.level.length === 2 && is_uint32(record.level[0]) && is_uint32(record.level[1]) && record.level[0] < record.level[1])
            .sort((left, right) => left.level[0] - right.level[0] || left.level[1] - right.level[1]);
        valid_records.forEach((right, right_index) => {
            valid_records.slice(0, right_index).forEach((left) => {
                if (left.level[0] < right.level[1] && right.level[0] < left.level[1]) {
                    errors.push(format_error(
                        "TbCommonShopPool",
                        right.id,
                        "level",
                        `shopId=${shop_id} 的区间[${right.level[0]},${right.level[1]})与 record=${left.id} 区间[${left.level[0]},${left.level[1]})重叠`,
                    ));
                }
            });
        });
    });

    return errors;
};

const resolve_item_arg_rule = (record: ItemArgsRecord): ItemArgRule | undefined => {
    if (record.main_type === item.MainType.Common && record.sub_type === item.SubType.CommonChipCanUse) {
        return {field: "args.cost", key: "cost", max: INT64_MAX};
    }
    if (record.main_type === item.MainType.Common && [
        item.SubType.HourGlassAll,
        item.SubType.HourGlassProduce,
        item.SubType.HourGlassCoin,
    ].includes(record.sub_type)) {
        return {field: "args.ownTime", key: "ownTime", max: INT64_MAX};
    }
    if (record.main_type === item.MainType.LimitedTime && record.sub_type === item.SubType.LimitedTimeDuration) {
        return {field: "args.ownTime", key: "ownTime", max: INT64_MAX};
    }
    if (record.main_type === item.MainType.Common && [
        item.SubType.JXSHFightItem,
        item.SubType.WXCFFightItem,
        item.SubType.XSZTFightItem,
    ].includes(record.sub_type)) {
        return {field: "args.cnt", key: "cnt", max: UINT32_MAX_BIGINT};
    }
    return undefined;
};

const parse_go_decimal = (raw_value: string): bigint | undefined => {
    if (!/^[+-]?[0-9]+$/.test(raw_value)) {
        return undefined;
    }
    try {
        return BigInt(raw_value);
    }
    catch {
        return undefined;
    }
};

const collect_item_arg_errors = (records: ReadonlyArray<ItemArgsRecord>): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const rule = resolve_item_arg_rule(record);
        if (!rule) {
            return [];
        }
        const raw_value = record.args.get(rule.key);
        if (raw_value === undefined) {
            return [format_error("TbItem", record.id, rule.field, `subType=${record.sub_type} 缺少 ${rule.key}`)];
        }
        const value = parse_go_decimal(raw_value);
        if (value === undefined) {
            return [format_error("TbItem", record.id, rule.field, `value=${raw_value} 必须是 Go Atoi 可解析的十进制整数`)];
        }
        return value > 0n && value <= rule.max
            ? []
            : [format_error("TbItem", record.id, rule.field, `value=${raw_value} 必须在目标 Go 类型范围 1..${rule.max} 内`)];
    });

const collect_item_time_range_errors = (records: ReadonlyArray<ItemArgsRecord>): ReadonlyArray<string> =>
    records
        .filter((record) => record.main_type === item.MainType.LimitedTime && record.sub_type === item.SubType.LimitedTimeTimeRange)
        .flatMap((record) => {
            const errors: string[] = [];
            const collect_timestamp = (key: "start" | "end"): bigint | undefined => {
                const raw_value = record.args.get(key);
                if (raw_value === undefined) {
                    errors.push(format_error("TbItem", record.id, `args.${key}`, `subType=${record.sub_type} 缺少 ${key}`));
                    return undefined;
                }
                const value = parse_go_decimal(raw_value);
                if (value === undefined || value < -INT64_MAX - 1n || value > INT64_MAX) {
                    errors.push(format_error("TbItem", record.id, `args.${key}`, `value=${raw_value} 必须在 int64 范围内且可由 Go Atoi 解析`));
                    return undefined;
                }
                return value;
            };
            const start = collect_timestamp("start");
            const end = collect_timestamp("end");
            if (start !== undefined && end !== undefined && (end <= 0n || start >= end)) {
                errors.push(format_error("TbItem", record.id, "args.start/end", `时间段 start=${start}, end=${end} 必须满足 end > 0 且 start < end`));
            }
            return errors;
        });

const verify_collector_output = (
    collector: string,
    errors: ReadonlyArray<string>,
    expected_fragments: ReadonlyArray<string>,
): ReadonlyArray<string> => [
    ...(errors.length === expected_fragments.length
        ? []
        : [format_error("SyntheticFixture", collector, "errors", `实际错误数=${errors.length}，预期=${expected_fragments.length}`)]),
    ...expected_fragments.flatMap((fragment) =>
        errors.some((error) => error.includes(fragment))
            ? []
            : [format_error("SyntheticFixture", collector, "errors", `缺少预期错误片段=${fragment}`)]
    ),
];

const collect_current_drop_records = (): ReadonlyArray<DropRecord> =>
    tb.TbDrop.getDataList().map((record) => ({
        id: record.id,
        rewards: record.rewards.map((pool) => ({
            weight: pool.weight,
            drops: pool.drops.map((drop) => ({id: drop.id, type: drop.type, count: drop.count})),
        })),
    }));

const collect_current_reward_catalog = (): RewardReferenceCatalog => ({
    item_ids: new Set(tb.TbItem.getDataList().map((record) => record.id)),
    hero_ids: new Set(tb.TbHero.getDataList().map((record) => record.id)),
    hero_qualities: new Set(tb.TbHeroQuality.getDataList().map((record) => record.id)),
    equip_ids: new Set(tb.TbEquip.getDataList().map((record) => record.id)),
});

const collect_current_shop_pool_records = (): ReadonlyArray<ShopPoolRecord> =>
    tb.TbCommonShopPool.getDataList().map((record) => ({
        id: record.id,
        shop_id: record.shopId,
        level: record.level,
        draw_cnt: record.drawCnt,
        goods_pool: record.goodsPool.map((goods) => ({goods_id: goods.goodsId, weight: goods.weight})),
    }));

const collect_current_item_arg_records = (): ReadonlyArray<ItemArgsRecord> =>
    tb.TbItem.getDataList().map((record) => ({
        id: record.id,
        main_type: record.mainType,
        sub_type: record.subType,
        args: record.args,
    }));

describe("服务端随机、商店与道具运行时配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 合成坏数据能一次收集所有目标规则错误", () => {
        const catalog: RewardReferenceCatalog = {
            item_ids: new Set(["item-ok"]),
            hero_ids: new Set(["hero-ok"]),
            hero_qualities: new Set(["A", "Z"]),
            equip_ids: new Set(["equip-ok"]),
        };
        const drop_errors = collect_drop_errors([
            {
                id: "drop-zero",
                rewards: [{weight: 0, drops: [
                    {id: "missing-item", type: base.RewardType.Item, count: 0},
                    {id: "bad-hero", type: base.RewardType.Hero, count: 1},
                    {id: "hero-ok_Z", type: base.RewardType.Hero, count: 1},
                    {id: "item-ok", type: base.RewardType.DrawTrans, count: 1},
                    {id: "unknown", type: 99, count: 1},
                ]}],
            },
            {
                id: "drop-overflow",
                rewards: [{weight: UINT32_MAX, drops: []}],
            },
        ], catalog);
        const shop_errors = collect_shop_pool_errors([
            {
                id: "pool-a",
                shop_id: "shop",
                level: [1, 10],
                draw_cnt: [-1, 1],
                goods_pool: [{goods_id: "missing", weight: 0}],
            },
            {
                id: "pool-b",
                shop_id: "shop",
                level: [5, 20],
                draw_cnt: [1, 1],
                goods_pool: [{goods_id: "known", weight: UINT32_MAX}],
            },
            {
                id: "pool-reversed",
                shop_id: "other",
                level: [20, 10],
                draw_cnt: [0, 0],
                goods_pool: [],
            },
            {
                id: "pool-short",
                shop_id: "short",
                level: [1],
                draw_cnt: [0],
                goods_pool: [],
            },
            {
                id: "pool-zero-width",
                shop_id: "zero",
                level: [3, 3],
                draw_cnt: [0, 0],
                goods_pool: [],
            },
        ], new Set(["known"]));
        const item_records: ReadonlyArray<ItemArgsRecord> = [
            {id: "chip", main_type: item.MainType.Common, sub_type: item.SubType.CommonChipCanUse, args: new Map([["cost", "0"]])},
            {id: "chip-bigint", main_type: item.MainType.Common, sub_type: item.SubType.CommonChipCanUse, args: new Map([["cost", "9007199254740993"]])},
            {id: "fight", main_type: item.MainType.Common, sub_type: item.SubType.JXSHFightItem, args: new Map([["cnt", String(UINT32_MAX + 1)]])},
            {id: "hourglass", main_type: item.MainType.Common, sub_type: item.SubType.HourGlassAll, args: new Map()},
            {id: "limited", main_type: item.MainType.LimitedTime, sub_type: item.SubType.LimitedTimeDuration, args: new Map([["ownTime", "-1"]])},
            {id: "time-missing", main_type: item.MainType.LimitedTime, sub_type: item.SubType.LimitedTimeTimeRange, args: new Map([["start", "1"]])},
            {id: "time-overflow", main_type: item.MainType.LimitedTime, sub_type: item.SubType.LimitedTimeTimeRange, args: new Map([["start", "9223372036854775808"], ["end", "2"]])},
            {id: "time-reversed", main_type: item.MainType.LimitedTime, sub_type: item.SubType.LimitedTimeTimeRange, args: new Map([["start", "10"], ["end", "10"]])},
            {id: "time-zero-end", main_type: item.MainType.LimitedTime, sub_type: item.SubType.LimitedTimeTimeRange, args: new Map([["start", "-1"], ["end", "0"]])},
            {id: "ordinary", main_type: item.MainType.Common, sub_type: item.SubType.CommonNormal, args: new Map([["cost", "0"]])},
        ];
        const item_errors = [
            ...collect_item_arg_errors(item_records),
            ...collect_item_time_range_errors(item_records),
        ];

        const verification_errors = [
            ...verify_collector_output("TbDrop", drop_errors, [
                "至少配置一个正权重",
                "count=0 必须是正安全整数",
                "不存在于 TbItem",
                "抽卡军团 id=bad-hero 必须为已存在",
                "抽卡军团 id=hero-ok_Z 必须为已存在",
                "DrawTrans 是军团升品内部同步类型",
                "未知奖励 type=99",
                "随机上界 +1 溢出",
            ]),
            ...verify_collector_output("TbCommonShopPool", shop_errors, [
                "必须是非负安全整数",
                "至少配置一个正权重",
                "不存在于 TbCommonShopGoods",
                "随机上界 +1 溢出",
                "区间[5,20)与 record=pool-a",
                "半开区间 [20,10) 必须非空",
                "field=drawCnt, reason=长度=1",
                "field=level, reason=长度=1",
                "半开区间 [3,3) 必须非空",
            ]),
            ...verify_collector_output("TbItem", item_errors, [
                "value=0 必须在",
                `value=${UINT32_MAX + 1} 必须在`,
                "缺少 ownTime",
                "value=-1 必须在目标 Go 类型范围",
                "缺少 end",
                "value=9223372036854775808 必须在 int64 范围内",
                "时间段 start=10, end=10",
                "时间段 start=-1, end=0",
            ]),
        ];
        assert_no_errors("合成坏数据未覆盖全部目标规则：", verification_errors);
    });

    it("should 当前配置满足服务端随机、商店与道具运行时约束", () => {
        const errors = [
            ...collect_drop_errors(collect_current_drop_records(), collect_current_reward_catalog()),
            ...collect_shop_pool_errors(
                collect_current_shop_pool_records(),
                new Set(tb.TbCommonShopGoods.getDataList().map((record) => String(record.id))),
            ),
            ...collect_item_arg_errors(collect_current_item_arg_records()),
            ...collect_item_time_range_errors(collect_current_item_arg_records()),
        ];
        assert_no_errors("存在服务端随机、商店或道具运行时非法配置：", errors);
    });
});
