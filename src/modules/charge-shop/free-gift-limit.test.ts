import {beforeAll, describe, it} from "vitest";
import {chargershop} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type ChargeShopGoodsRecord = Readonly<{
    shop_id: number;
    gift_id: number;
    gift_name: string;
    buy_type: chargershop.GiftBuyType;
    limit_type: chargershop.GiftLimitType;
    limit_cnt: number;
}>;

const collect_charge_shop_goods = (): ReadonlyArray<ChargeShopGoodsRecord> =>
    tb.TbChargeShop.getDataList()
        .flatMap((shop_cfg) =>
            Array.from(shop_cfg.config.entries()).map(([gift_id, goods_cfg]) => ({
                shop_id: shop_cfg.id,
                gift_id,
                gift_name: goods_cfg.giftName,
                buy_type: goods_cfg.buyType,
                limit_type: goods_cfg.limitType,
                limit_cnt: goods_cfg.limitCnt,
            }))
        );

const ERROR_SOURCE_EXCEL = "商品配置@C-充值商店.xlsx";

const format_infinite_free_error = (goods: ChargeShopGoodsRecord): string =>
    `excel=${ERROR_SOURCE_EXCEL}, shop=${goods.shop_id}, gift=${goods.gift_id}(${goods.gift_name}), buyType=${goods.buy_type}, limitType=${goods.limit_type}, limitCnt=${goods.limit_cnt}`;

const collect_infinite_free_goods_errors = (
    goods_list: ReadonlyArray<ChargeShopGoodsRecord>,
): ReadonlyArray<string> =>
    goods_list.flatMap((goods) => {
        if (goods.buy_type !== chargershop.GiftBuyType.Free) return [];
        return goods.limit_cnt <= 0 ? [format_infinite_free_error(goods)] : [];
    });

describe("充值商店配置校验", () => {
    let goods_list: ReadonlyArray<ChargeShopGoodsRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        goods_list = collect_charge_shop_goods();
    });

    it("should 免费商品不能配置为无限购买", () => {
        const errors = collect_infinite_free_goods_errors(goods_list);
        assert_no_errors("存在可无限购买的免费商品：", errors);
    });
});
