import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

const UINT32_MAX = 0xffff_ffff;
const INT32_MAX = 0x7fff_ffff;
const ACT_GIFT_BUY_TYPE_CHARGE = 1;
const CARD_TYPE_FREE = 1;
const CARD_TYPE_MONTH = 2;
const CARD_TYPE_LIFETIME = 3;
const CORE_CARD_IDS: ReadonlyArray<number> = [
    CARD_TYPE_FREE,
    CARD_TYPE_MONTH,
    CARD_TYPE_LIFETIME,
];

type ProductRecord = Readonly<{
    id: string;
    price: number;
}>;

type RechargeConfigRecord = Readonly<{
    id: number;
    uni_us_price: number;
}>;

type ProductReferenceRecord = Readonly<{
    table: string;
    id: string | number;
    field: string;
    product_id: string;
    allow_empty: boolean;
}>;

type MonthCardRecord = Readonly<{
    id: number;
    card_type: number;
    charge_id: string;
    duration_days: number;
}>;

const format_error = (table: string, id: string | number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const is_uint32 = (value: number): boolean =>
    Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;

const collect_product_price_errors = (
    records: ReadonlyArray<ProductRecord>,
    recharge_config_ids: ReadonlySet<number>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const server_price = Math.fround(record.price);
        if (!Number.isFinite(record.price) || !Number.isFinite(server_price)) {
            return [format_error(
                "TbProduct",
                record.id,
                "price",
                `price=${record.price} 必须能加载为有限的 Go float32`,
            )];
        }
        if (!is_uint32(record.price) || server_price !== record.price) {
            return [format_error(
                "TbProduct",
                record.id,
                "price",
                `price=${record.price} 必须是 0..${UINT32_MAX} 内且可由 Go float32 精确表示的整数，否则 uint32(price) 会改变换价 key`,
            )];
        }
        return recharge_config_ids.has(record.price)
            ? []
            : [format_error(
                "TbProduct",
                record.id,
                "price",
                `price=${record.price} 转为 exchange key 后在 TbRechargeConfig 中不存在`,
            )];
    });

const collect_recharge_config_errors = (
    records: ReadonlyArray<RechargeConfigRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        if (!is_uint32(record.id)) {
            errors.push(format_error(
                "TbRechargeConfig",
                record.id,
                "id",
                `id=${record.id} 必须是 Go uint32 整数`,
            ));
        }

        const server_price = Math.fround(record.uni_us_price);
        if (!Number.isFinite(record.uni_us_price) || !Number.isFinite(server_price) || record.uni_us_price < 0) {
            errors.push(format_error(
                "TbRechargeConfig",
                record.id,
                "uniUsPrice",
                `uniUsPrice=${record.uni_us_price} 必须能加载为非负有限的 Go float32`,
            ));
            return errors;
        }

        // payment.CreateOrder 会分别把 round(price)*100 和 price*100 转成 uint32 做比较及持久化。
        const compared_cents = Math.round(server_price) * 100;
        const persisted_cents = server_price * 100;
        if (compared_cents > UINT32_MAX || persisted_cents > UINT32_MAX) {
            errors.push(format_error(
                "TbRechargeConfig",
                record.id,
                "uniUsPrice",
                `uniUsPrice=${record.uni_us_price} 的支付分值转换超出 Go uint32 上限=${UINT32_MAX}`,
            ));
        }
        return errors;
    });

const collect_product_reference_errors = (
    records: ReadonlyArray<ProductReferenceRecord>,
    product_ids: ReadonlySet<string>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        if (record.product_id.length === 0) {
            return record.allow_empty
                ? []
                : [format_error(record.table, record.id, record.field, "服务端下单使用的商品 ID 不能为空")];
        }
        return product_ids.has(record.product_id)
            ? []
            : [format_error(
                record.table,
                record.id,
                record.field,
                `productId=${record.product_id} 在 TbProduct 中不存在，服务端 exact lookup 会拒绝下单`,
            )];
    });

const collect_month_card_errors = (
    records: ReadonlyArray<MonthCardRecord>,
    product_ids: ReadonlySet<string>,
): ReadonlyArray<string> => {
    const records_by_id = new Map(records.map((record) => [record.id, record]));
    return CORE_CARD_IDS.flatMap((card_id) => {
        const record = records_by_id.get(card_id);
        if (!record) {
            return [format_error(
                "TbMonthCard",
                card_id,
                "id",
                `缺少服务端固定查询的核心卡配置 cardId=${card_id}`,
            )];
        }

        const errors: string[] = [];
        if (record.id !== record.card_type) {
            errors.push(format_error(
                "TbMonthCard",
                record.id,
                "cardType",
                `cardType=${record.card_type} 必须与按常量查询及发货分支使用的 cardId=${record.id} 一致`,
            ));
        }

        if (record.id === CARD_TYPE_MONTH) {
            if (!Number.isInteger(record.duration_days)
                || record.duration_days <= 0
                || record.duration_days > INT32_MAX) {
                errors.push(format_error(
                    "TbMonthCard",
                    record.id,
                    "durationDays",
                    `月卡 durationDays=${record.duration_days} 必须是 1..${INT32_MAX} 的 int32 整数`,
                ));
            }
        }

        if (record.id === CARD_TYPE_MONTH || record.id === CARD_TYPE_LIFETIME) {
            errors.push(...collect_product_reference_errors([{
                table: "TbMonthCard",
                id: record.id,
                field: "chargeId",
                product_id: record.charge_id,
                allow_empty: false,
            }], product_ids));
        }
        return errors;
    });
};

const collect_current_product_references = (): ReadonlyArray<ProductReferenceRecord> => [
    ...tb.TbFirstRecharge.getDataList().map((record) => ({
        table: "TbFirstRecharge",
        id: record.id,
        field: "productId",
        product_id: record.productId,
        allow_empty: false,
    })),
    ...tb.TbDiamondCharge.getDataList().map((record) => ({
        table: "TbDiamondCharge",
        id: record.id,
        field: "productId",
        product_id: record.productId,
        allow_empty: false,
    })),
    ...tb.TbLimitActivity.getDataList().map((record) => ({
        table: "TbLimitActivity",
        id: record.id,
        field: "productId",
        product_id: record.productId,
        allow_empty: false,
    })),
    // 战令配置明确允许无付费档；只有非空值才会成为购买 SKU。
    ...tb.TbActBp.getDataList().map((record) => ({
        table: "TbActBp",
        id: record.subActivityId,
        field: "productId",
        product_id: record.productId,
        allow_empty: true,
    })),
    // Trial 以空 productId 表示免费礼包，非空条目才进入 TrialGift.GetProductInfo。
    ...tb.TbDailyTrial.getDataList().flatMap((daily) =>
        daily.gifts.map((gift) => ({
            table: "TbDailyTrial",
            id: `${daily.id}:gift=${gift.giftId}`,
            field: "gifts.productId",
            product_id: gift.productId,
            allow_empty: true,
        }))
    ),
    // act_gift 只有 buyType=1 的充值条目会进入 GetProductConfig；兑换条目的 productId 不参与支付。
    ...tb.TbActGift.getDataList().flatMap((activity) =>
        activity.gifts
            .filter((gift) => gift.buyType === ACT_GIFT_BUY_TYPE_CHARGE)
            .map((gift) => ({
                table: "TbActGift",
                id: `${activity.subActivityId}:gift=${gift.giftId}`,
                field: "gifts.productId",
                product_id: gift.productId,
                allow_empty: false,
            }))
    ),
    // TbChargeShop 的 Rmb chargeId exact reference 已由 client-runtime/feature-economy.test.ts 负责。
];

const collect_current_errors = (): ReadonlyArray<string> => {
    const products: ReadonlyArray<ProductRecord> = tb.TbProduct.getDataList()
        .map((record) => ({id: record.id, price: record.price}));
    const recharge_configs: ReadonlyArray<RechargeConfigRecord> = tb.TbRechargeConfig.getDataList()
        .map((record) => ({id: record.id, uni_us_price: record.uniUsPrice}));
    const month_cards: ReadonlyArray<MonthCardRecord> = tb.TbMonthCard.getDataList()
        .map((record) => ({
            id: record.id,
            card_type: record.cardType,
            charge_id: record.chargeId,
            duration_days: record.durationDays,
        }));
    const product_ids = new Set(products.map((record) => record.id));

    return [
        ...collect_product_price_errors(products, new Set(recharge_configs.map((record) => record.id))),
        ...collect_recharge_config_errors(recharge_configs),
        ...collect_product_reference_errors(collect_current_product_references(), product_ids),
        ...collect_month_card_errors(month_cards, product_ids),
    ];
};

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    expect(errors.length).toBeGreaterThan(0);
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("服务端购买商品、换价与月卡 collector", () => {
    it("合成坏数据一次收集 exact lookup、数值转换与月卡契约错误", () => {
        const product_errors = collect_product_price_errors([
            {id: "not-finite", price: Number.NaN},
            {id: "fraction", price: 1.5},
            {id: "overflow", price: UINT32_MAX + 1},
            {id: "float32-rounding", price: 16_777_217},
            {id: "missing-exchange", price: 12},
            {id: "valid", price: 6},
        ], new Set([6]));
        const recharge_errors = collect_recharge_config_errors([
            {id: -1, uni_us_price: -1},
            {id: 1.5, uni_us_price: 1},
            {id: 2, uni_us_price: Number.POSITIVE_INFINITY},
            {id: 3, uni_us_price: UINT32_MAX / 100 + 10},
            {id: 4, uni_us_price: 0.99},
        ]);
        const reference_errors = collect_product_reference_errors([
            {table: "TbFirstRecharge", id: "empty", field: "productId", product_id: "", allow_empty: false},
            {table: "TbLimitActivity", id: 1, field: "productId", product_id: "missing", allow_empty: false},
            {table: "TbActBp", id: 2, field: "productId", product_id: "", allow_empty: true},
            {table: "TbDailyTrial", id: "1:gift=1", field: "gifts.productId", product_id: " ", allow_empty: true},
            {table: "TbDiamondCharge", id: "ok", field: "productId", product_id: "known", allow_empty: false},
        ], new Set(["known"]));
        const month_card_errors = collect_month_card_errors([
            {id: CARD_TYPE_MONTH, card_type: CARD_TYPE_MONTH, charge_id: "", duration_days: 0},
            {id: CARD_TYPE_LIFETIME, card_type: CARD_TYPE_MONTH, charge_id: "missing", duration_days: 1},
            // 服务端不会查询额外行；其 id/cardType/durationDays/chargeId 不应阻断配置。
            {id: 4, card_type: 999, charge_id: "", duration_days: -1},
        ], new Set());
        const inert_month_card_errors = collect_month_card_errors([
            {id: CARD_TYPE_FREE, card_type: CARD_TYPE_FREE, charge_id: "", duration_days: -1},
            {id: CARD_TYPE_MONTH, card_type: CARD_TYPE_MONTH, charge_id: "known", duration_days: 30},
            {id: CARD_TYPE_LIFETIME, card_type: CARD_TYPE_LIFETIME, charge_id: "known", duration_days: 99},
            {id: 4, card_type: 999, charge_id: "", duration_days: -1},
        ], new Set(["known"]));
        const errors = [
            ...product_errors,
            ...recharge_errors,
            ...reference_errors,
            ...month_card_errors,
        ];

        expect_structured_errors(errors);
        expect(product_errors).toHaveLength(5);
        expect(recharge_errors).toHaveLength(5);
        expect(reference_errors).toHaveLength(3);
        expect(month_card_errors).toHaveLength(5);
        expect(inert_month_card_errors).toEqual([]);
        expect(errors.join("\n")).toContain("uint32(price) 会改变换价 key");
        expect(errors.join("\n")).toContain("支付分值转换超出 Go uint32");
        expect(errors.join("\n")).toContain("服务端 exact lookup 会拒绝下单");
        expect(errors.join("\n")).toContain("缺少服务端固定查询的核心卡配置");
        expect(errors.join("\n")).toContain("必须与按常量查询及发货分支使用的 cardId");
    });
});

describe("服务端购买商品、换价与月卡配置", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("当前配置满足服务端购买 exact lookup 与支付数值转换契约", () => {
        assert_no_errors("存在服务端购买商品、换价或月卡非法配置：", collect_current_errors());
    });
});
