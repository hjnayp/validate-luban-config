import {beforeAll, describe, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type RewardRecord = Readonly<{
    id: string;
    type: number;
    count: number;
}>;

type GoodsRecord = Readonly<{
    goods_id: number;
    cost_rewards: ReadonlyArray<RewardRecord>;
    give_rewards: ReadonlyArray<RewardRecord>;
    refresh_type: number;
    stock: number;
    weight: number;
}>;

type GoodsPoolRecord = Readonly<{
    id: number;
    goods: ReadonlyArray<GoodsRecord>;
}>;

type ExchangeShopRecord = Readonly<{
    id: number;
    goods_pool: number;
    min_draw_cnt: number;
    max_draw_cnt: number;
    can_refresh: boolean;
    free_refresh_cnt: number;
    cost_refresh_cnt: number;
    refresh_costs: ReadonlyArray<RewardRecord>;
}>;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT32_MAX_BIGINT = 2_147_483_647n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const RESETTING_REFRESH_TYPES: ReadonlySet<number> = new Set([1, 2, 3]);
const LEGAL_REFRESH_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4]);

const format_error = (table: string, record: string, field: string, reason: string): string =>
    `table=${table}, record=${record}, field=${field}, reason=${reason}`;

const is_int32 = (value: number): boolean =>
    Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;

const duplicate_values = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
    const counts = new Map<number, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    return Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([value]) => value);
};

const effective_goods = (pool: GoodsPoolRecord): ReadonlyMap<number, GoodsRecord> => {
    // 服务端 sheetToCache 按数组顺序写 map[goodsId]，重复 id 时最后一条覆盖前一条。
    const result = new Map<number, GoodsRecord>();
    pool.goods.forEach((goods) => result.set(goods.goods_id, goods));
    return result;
};

const collect_batch_multiply_errors = (
    pool_id: number,
    goods: GoodsRecord,
    field: "costReward" | "giveReward",
    rewards: ReadonlyArray<RewardRecord>,
): ReadonlyArray<string> => {
    let max_successful_batch: bigint | undefined;
    if (RESETTING_REFRESH_TYPES.has(goods.refresh_type) && Number.isInteger(goods.stock) && goods.stock > 0) {
        max_successful_batch = BigInt(goods.stock);
    } else if (goods.refresh_type === 4 && goods.stock < 0) {
        // shopcore 将任意负库存视为无限购；C2S cnt 为 int32。
        max_successful_batch = INT32_MAX_BIGINT;
    }
    if (max_successful_batch === undefined) {
        return [];
    }

    const counts_by_reward = new Map<string, bigint>();
    rewards.forEach((reward) => {
        // Reward 的基础类型、引用和正数约束由通用 Reward 校验负责；这里只检查本路径的批量乘法边界。
        if (!Number.isSafeInteger(reward.count) || reward.count < 0) {
            return;
        }
        const key = `${reward.type}\u0000${reward.id}`;
        counts_by_reward.set(key, (counts_by_reward.get(key) ?? 0n) + BigInt(reward.count));
    });

    return Array.from(counts_by_reward.entries()).flatMap(([key, unit_count]) => {
        const batch_count = unit_count * max_successful_batch;
        if (batch_count <= UINT64_MAX) {
            return [];
        }
        const separator = key.indexOf("\u0000");
        const reward_type = key.slice(0, separator);
        const reward_id = key.slice(separator + 1);
        return [format_error(
            "TbExchangeShopGoodsPool",
            `pool=${pool_id},goods=${goods.goods_id}`,
            field,
            `rewardType=${reward_type}, rewardId=${reward_id}, unitTotal=${unit_count}, maxBatch=${max_successful_batch}，multiplyDrops/PackReward 合并后会溢出 uint64`,
        )];
    });
};

const collect_goods_errors = (pool: GoodsPoolRecord): ReadonlyArray<string> => {
    const errors: string[] = [];
    pool.goods.forEach((goods, index) => {
        if (!is_int32(goods.goods_id)) {
            errors.push(format_error(
                "TbExchangeShopGoodsPool",
                `pool=${pool.id},index=${index}`,
                "goodsId",
                `goodsId=${goods.goods_id} 不能作为服务端 map[int32] exact key`,
            ));
        }
    });
    duplicate_values(pool.goods.map((goods) => goods.goods_id)).forEach((goods_id) => {
        errors.push(format_error(
            "TbExchangeShopGoodsPool",
            `pool=${pool.id}`,
            "config.goodsId",
            `goodsId=${goods_id} 重复，服务端 sheetToCache 会静默用后一条覆盖前一条`,
        ));
    });

    Array.from(effective_goods(pool).values()).forEach((goods) => {
        const record = `pool=${pool.id},goods=${goods.goods_id}`;
        if (!is_int32(goods.weight)) {
            errors.push(format_error("TbExchangeShopGoodsPool", record, "weight", `weight=${goods.weight} 必须可解码为 int32`));
        }
        if (!is_int32(goods.stock)) {
            errors.push(format_error("TbExchangeShopGoodsPool", record, "stock", `stock=${goods.stock} 必须可解码为 int32`));
        } else if (goods.stock === 0) {
            errors.push(format_error("TbExchangeShopGoodsPool", record, "stock", "stock=0 永远无法通过 shopcore.CheckBuyLimit"));
        }

        if (!LEGAL_REFRESH_TYPES.has(goods.refresh_type)) {
            errors.push(format_error(
                "TbExchangeShopGoodsPool",
                record,
                "refreshType",
                `refreshType=${goods.refresh_type} 未定义，mapFreshType 会静默回退到永久桶`,
            ));
        } else if (RESETTING_REFRESH_TYPES.has(goods.refresh_type) && goods.stock < 0) {
            errors.push(format_error(
                "TbExchangeShopGoodsPool",
                record,
                "refreshType/stock",
                `refreshType=${goods.refresh_type}, stock=${goods.stock} 为负数时 ExchangeGoods 的 batch pre-check 连 cnt=1 也会拒绝`,
            ));
        } else if (goods.refresh_type === 4 && goods.stock > 0) {
            errors.push(format_error(
                "TbExchangeShopGoodsPool",
                record,
                "refreshType/stock",
                `refreshType=4, stock=${goods.stock} 使用永久桶但跳过整批限购预检，cnt 可越过有限库存`,
            ));
        }

        errors.push(
            ...collect_batch_multiply_errors(pool.id, goods, "costReward", goods.cost_rewards),
            ...collect_batch_multiply_errors(pool.id, goods, "giveReward", goods.give_rewards),
        );
    });
    return errors;
};

const collect_draw_errors = (
    shop: ExchangeShopRecord,
    pool: GoodsPoolRecord,
): ReadonlyArray<string> => {
    if (shop.max_draw_cnt <= 0 || !is_int32(shop.min_draw_cnt) || !is_int32(shop.max_draw_cnt)) {
        // max<=0 是服务端明确的全量上架哨兵，权重和 min 在该分支不参与抽取。
        return [];
    }

    const record = `shop=${shop.id},pool=${pool.id}`;
    const errors: string[] = [];
    if (shop.min_draw_cnt <= 0) {
        errors.push(format_error(
            "TbExchangeShop",
            record,
            "minDrawCnt",
            `minDrawCnt=${shop.min_draw_cnt}, maxDrawCnt=${shop.max_draw_cnt} 会允许抽到 0；空 DrawnGoods 随后被解释为全量上架`,
        ));
    }
    if (shop.min_draw_cnt > shop.max_draw_cnt) {
        errors.push(format_error(
            "TbExchangeShop",
            record,
            "minDrawCnt/maxDrawCnt",
            `minDrawCnt=${shop.min_draw_cnt} > maxDrawCnt=${shop.max_draw_cnt}，resolveDrawCount 会静默回退为 maxDrawCnt`,
        ));
        return errors;
    }

    const normalized_min = Math.max(0, shop.min_draw_cnt);
    const draw_width = BigInt(shop.max_draw_cnt) - BigInt(normalized_min) + 1n;
    if (draw_width > INT32_MAX_BIGINT) {
        errors.push(format_error(
            "TbExchangeShop",
            record,
            "minDrawCnt/maxDrawCnt",
            `随机区间宽度=${draw_width} 在 int32 的 max-min+1 中溢出，rand.Int31n 会收到非正上界并 panic`,
        ));
    }

    const goods = Array.from(effective_goods(pool).values());
    const positive_weights = goods
        .map((entry) => entry.weight)
        .filter((weight) => Number.isSafeInteger(weight) && weight > 0);
    if (positive_weights.length === 0) {
        errors.push(format_error(
            "TbExchangeShopGoodsPool",
            record,
            "config.weight",
            "抽取模式没有正权重商品，drawByWeight 返回 nil 后商店会错误地全量上架",
        ));
        return errors;
    }

    const total_weight = positive_weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
    if (total_weight > INT64_MAX) {
        errors.push(format_error(
            "TbExchangeShopGoodsPool",
            record,
            "config.weight",
            `正权重总和=${total_weight} 超过 int64，drawByWeight 累加会溢出`,
        ));
    }
    if (shop.min_draw_cnt > positive_weights.length) {
        errors.push(format_error(
            "TbExchangeShop",
            record,
            "minDrawCnt",
            `minDrawCnt=${shop.min_draw_cnt} 大于正权重商品数=${positive_weights.length}，drawByWeight 必然裁剪到配置下限以下`,
        ));
    }
    return errors;
};

const collect_exchange_shop_errors = (
    shops: ReadonlyArray<ExchangeShopRecord>,
    pools: ReadonlyArray<GoodsPoolRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    shops.forEach((shop, index) => {
        if (!is_int32(shop.id)) {
            errors.push(format_error("TbExchangeShop", `index=${index}`, "id", `id=${shop.id} 不能作为服务端 GetShopInfo 的 int32 exact key`));
        }
    });
    duplicate_values(shops.map((shop) => shop.id)).forEach((shop_id) => {
        errors.push(format_error("TbExchangeShop", `shop=${shop_id}`, "id", "shop id 重复，服务端 map exact lookup 只能保留一条"));
    });

    pools.forEach((pool, index) => {
        if (!is_int32(pool.id)) {
            errors.push(format_error("TbExchangeShopGoodsPool", `index=${index}`, "id", `id=${pool.id} 不能作为服务端 GetPool 的 int32 exact key`));
        }
        errors.push(...collect_goods_errors(pool));
    });
    duplicate_values(pools.map((pool) => pool.id)).forEach((pool_id) => {
        errors.push(format_error("TbExchangeShopGoodsPool", `pool=${pool_id}`, "id", "pool id 重复，服务端 map exact lookup 只能保留一条"));
    });

    // 与服务端 map 写入一致：重复 pool id 时后一条生效；重复本身已在上面单独报错。
    const pools_by_id = new Map<number, GoodsPoolRecord>();
    pools.forEach((pool) => pools_by_id.set(pool.id, pool));

    shops.forEach((shop) => {
        const record = `shop=${shop.id}`;
        if (!is_int32(shop.goods_pool)) {
            errors.push(format_error("TbExchangeShop", record, "goodsPool", `goodsPool=${shop.goods_pool} 不能用于 GetPool(int32) exact lookup`));
        }
        if (!is_int32(shop.min_draw_cnt)) {
            errors.push(format_error("TbExchangeShop", record, "minDrawCnt", `minDrawCnt=${shop.min_draw_cnt} 必须可解码为 int32`));
        }
        if (!is_int32(shop.max_draw_cnt)) {
            errors.push(format_error("TbExchangeShop", record, "maxDrawCnt", `maxDrawCnt=${shop.max_draw_cnt} 必须可解码为 int32`));
        }
        if (!is_int32(shop.free_refresh_cnt) || shop.free_refresh_cnt < 0) {
            errors.push(format_error("TbExchangeShop", record, "freeRefreshCnt", `freeRefreshCnt=${shop.free_refresh_cnt} 必须是非负 int32 计数`));
        }
        if (!is_int32(shop.cost_refresh_cnt) || shop.cost_refresh_cnt < 0) {
            errors.push(format_error("TbExchangeShop", record, "costRefreshCnt", `costRefreshCnt=${shop.cost_refresh_cnt} 必须是非负 int32 计数`));
        }
        if (shop.can_refresh && shop.cost_refresh_cnt > 0 && !shop.refresh_costs.some((reward) => Number.isSafeInteger(reward.count) && reward.count > 0)) {
            errors.push(format_error(
                "TbExchangeShop",
                record,
                "listRefreshCost",
                `costRefreshCnt=${shop.cost_refresh_cnt} 但没有有效正数消耗，SubReward 会以 miss reward 失败`,
            ));
        }

        const pool = pools_by_id.get(shop.goods_pool);
        if (!pool) {
            errors.push(format_error(
                "TbExchangeShop",
                record,
                "goodsPool",
                `goodsPool=${shop.goods_pool} 不存在；信息、刷新与兑换都只做 exact GetPool lookup`,
            ));
            return;
        }
        if (effective_goods(pool).size === 0) {
            errors.push(format_error("TbExchangeShopGoodsPool", `shop=${shop.id},pool=${pool.id}`, "config", "被商店引用的商品池没有可兑换商品"));
        }
        errors.push(...collect_draw_errors(shop, pool));
    });

    return errors;
};

const missing_expected_fragments = (
    errors: ReadonlyArray<string>,
    expected_fragments: ReadonlyArray<string>,
): ReadonlyArray<string> =>
    expected_fragments.flatMap((fragment) =>
        errors.some((error) => error.includes(fragment))
            ? []
            : [`合成坏数据缺少预期错误片段：${fragment}`]
    );

const to_reward_records = (rewards: ReadonlyArray<{id: string; type: number; count: number}>): ReadonlyArray<RewardRecord> =>
    rewards.map((reward) => ({id: reward.id, type: reward.type, count: reward.count}));

const collect_current_shops = (): ReadonlyArray<ExchangeShopRecord> =>
    tb.TbExchangeShop.getDataList().map((shop) => ({
        id: shop.id,
        goods_pool: shop.goodsPool,
        min_draw_cnt: shop.minDrawCnt,
        max_draw_cnt: shop.maxDrawCnt,
        can_refresh: shop.canRefresh,
        free_refresh_cnt: shop.freeRefreshCnt,
        cost_refresh_cnt: shop.costRefreshCnt,
        refresh_costs: to_reward_records(shop.listRefreshCost),
    }));

const collect_current_pools = (): ReadonlyArray<GoodsPoolRecord> =>
    tb.TbExchangeShopGoodsPool.getDataList().map((pool) => ({
        id: pool.id,
        goods: pool.config.map((goods) => ({
            goods_id: goods.goodsId,
            cost_rewards: to_reward_records(goods.costReward),
            give_rewards: to_reward_records(goods.giveReward),
            refresh_type: goods.refreshType,
            stock: goods.stock,
            weight: goods.weight,
        })),
    }));

describe("服务端兑换商店运行时配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 合成坏数据覆盖 exact lookup、抽取、限购和批量数量失败分支", () => {
        const overflow_goods: GoodsRecord[] = Array.from({length: 1_026}, (_, index) => ({
            goods_id: 10_000 + index,
            cost_rewards: [],
            give_rewards: [],
            refresh_type: 1,
            stock: 1,
            weight: Number.MAX_SAFE_INTEGER,
        }));
        const errors = collect_exchange_shop_errors([
            {
                id: 1,
                goods_pool: 10,
                min_draw_cnt: 0,
                max_draw_cnt: INT32_MAX,
                can_refresh: true,
                free_refresh_cnt: -1,
                cost_refresh_cnt: 1,
                refresh_costs: [],
            },
            {
                id: 1,
                goods_pool: 99,
                min_draw_cnt: 5,
                max_draw_cnt: 2,
                can_refresh: false,
                free_refresh_cnt: 0,
                cost_refresh_cnt: 0,
                refresh_costs: [],
            },
            {
                id: INT32_MAX + 1,
                goods_pool: INT32_MAX + 1,
                min_draw_cnt: 1,
                max_draw_cnt: 1,
                can_refresh: false,
                free_refresh_cnt: 0,
                cost_refresh_cnt: 0,
                refresh_costs: [],
            },
            {id: 4, goods_pool: 12, min_draw_cnt: 1, max_draw_cnt: 1, can_refresh: false, free_refresh_cnt: 0, cost_refresh_cnt: 0, refresh_costs: []},
            {id: 5, goods_pool: 13, min_draw_cnt: 3, max_draw_cnt: 3, can_refresh: false, free_refresh_cnt: 0, cost_refresh_cnt: 0, refresh_costs: []},
            {id: 6, goods_pool: 14, min_draw_cnt: 0, max_draw_cnt: 0, can_refresh: false, free_refresh_cnt: 0, cost_refresh_cnt: 0, refresh_costs: []},
            {id: 7, goods_pool: 15, min_draw_cnt: 0, max_draw_cnt: 0, can_refresh: false, free_refresh_cnt: 0, cost_refresh_cnt: 0, refresh_costs: []},
            {id: 8, goods_pool: 13, min_draw_cnt: 5, max_draw_cnt: 2, can_refresh: false, free_refresh_cnt: 0, cost_refresh_cnt: 0, refresh_costs: []},
        ], [
            {
                id: 10,
                goods: [
                    {goods_id: 1, cost_rewards: [], give_rewards: [], refresh_type: 1, stock: 1, weight: 1},
                    {goods_id: 1, cost_rewards: [], give_rewards: [], refresh_type: 4, stock: 0, weight: 0},
                    {goods_id: INT32_MAX + 1, cost_rewards: [], give_rewards: [], refresh_type: 9, stock: -2, weight: -1},
                    {goods_id: 3, cost_rewards: [], give_rewards: [], refresh_type: 1, stock: -1, weight: 0},
                    {goods_id: 4, cost_rewards: [], give_rewards: [], refresh_type: 4, stock: 2, weight: 0},
                ],
            },
            {id: 12, goods: overflow_goods},
            {
                id: 13,
                goods: [
                    {goods_id: 1, cost_rewards: [], give_rewards: [], refresh_type: 1, stock: 1, weight: 1},
                    {goods_id: 2, cost_rewards: [], give_rewards: [], refresh_type: 1, stock: 1, weight: 1},
                ],
            },
            {id: 14, goods: []},
            {
                id: 15,
                goods: [{
                    goods_id: 1,
                    cost_rewards: [{id: "cost", type: 0, count: Number.MAX_SAFE_INTEGER}],
                    give_rewards: [],
                    refresh_type: 4,
                    stock: -1,
                    weight: 0,
                }],
            },
            {id: 50, goods: []},
            {id: 50, goods: []},
            {id: INT32_MAX + 1, goods: []},
        ]);

        assert_no_errors("合成坏数据没有覆盖全部兑换商店失败分支：", missing_expected_fragments(errors, [
            "GetShopInfo 的 int32 exact key",
            "shop id 重复",
            "GetPool 的 int32 exact key",
            "pool id 重复",
            "goodsId=1 重复",
            "map[int32] exact key",
            "stock=0 永远无法",
            "未定义，mapFreshType 会静默回退",
            "为负数时 ExchangeGoods 的 batch pre-check",
            "跳过整批限购预检",
            "溢出 uint64",
            "freeRefreshCnt=-1",
            "没有有效正数消耗",
            "不存在；信息、刷新与兑换都只做 exact GetPool lookup",
            "允许抽到 0",
            "rand.Int31n 会收到非正上界",
            "没有正权重商品",
            "resolveDrawCount 会静默回退",
            "正权重总和=",
            "必然裁剪到配置下限以下",
            "被商店引用的商品池没有可兑换商品",
        ]));
    });

    it("should 保留服务端明确的全量、禁抽与负数无限购语义", () => {
        const errors = collect_exchange_shop_errors([
            {
                id: 1,
                goods_pool: 1,
                min_draw_cnt: -100,
                max_draw_cnt: 0,
                can_refresh: true,
                free_refresh_cnt: 1,
                cost_refresh_cnt: 0,
                refresh_costs: [],
            },
        ], [{
            id: 1,
            goods: [{
                goods_id: 0,
                cost_rewards: [],
                give_rewards: [],
                refresh_type: 4,
                stock: -2,
                weight: 0,
            }],
        }]);
        assert_no_errors("合法哨兵被误判：", errors);
    });

    it("should 当前兑换商店配置满足服务端 exact lookup、抽取与兑换约束", () => {
        assert_no_errors(
            "存在服务端不可安全执行的兑换商店配置：",
            collect_exchange_shop_errors(collect_current_shops(), collect_current_pools()),
        );
    });
});
