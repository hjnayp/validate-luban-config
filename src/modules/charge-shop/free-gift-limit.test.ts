import {beforeAll, describe, it} from "vitest";
import {resolve} from "node:path";
import {chargershop} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {build_excel_row_index_by_composite_key, ExcelRowLocation, format_excel_error_source, make_excel_row_key} from "../../infra/excel_source";
import {cfg_mgr, tb} from "../../infra/tb";

type ChargeShopGoodsRecord = Readonly<{
    shop_id: number;
    gift_id: number;
    gift_name: string;
    buy_type: chargershop.GiftBuyType;
    limit_type: chargershop.GiftLimitType;
    limit_cnt: number;
    source_location: ExcelRowLocation | undefined;
}>;

const collect_charge_shop_goods = (
    row_index_by_shop_and_gift_id: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<ChargeShopGoodsRecord> =>
    tb.TbChargeShop.getDataList()
        .flatMap((shop_cfg) =>
            Array.from(shop_cfg.config.entries()).map(([gift_id, goods_cfg]) => ({
                shop_id: shop_cfg.id,
                gift_id,
                gift_name: goods_cfg.giftName,
                buy_type: goods_cfg.buyType,
                limit_type: goods_cfg.limitType,
                limit_cnt: goods_cfg.limitCnt,
                source_location: row_index_by_shop_and_gift_id.get(make_excel_row_key(shop_cfg.id, gift_id)),
            }))
        );

const ERROR_SOURCE_EXCEL = "商品配置@C-充值商店.xlsx";
const CHARGE_SHOP_EXCEL_PATH = resolve(process.cwd(), "..", "..", "config", "配置表", "C-充值商店.xlsx");

const format_infinite_free_error = (goods: ChargeShopGoodsRecord): string =>
    `${format_excel_error_source(ERROR_SOURCE_EXCEL, goods.source_location, {cell_header: "limitCnt", field_name: "config.limitCnt"})}, shop=${goods.shop_id}, gift=${goods.gift_id}(${goods.gift_name}), buyType=${goods.buy_type}, limitType=${goods.limit_type}, limitCnt=${goods.limit_cnt}`;

const collect_infinite_free_goods_errors = (
    goods_list: ReadonlyArray<ChargeShopGoodsRecord>,
): ReadonlyArray<string> =>
    goods_list.flatMap((goods) => {
        if (goods.buy_type !== chargershop.GiftBuyType.Free) return [];
        return goods.limit_cnt < 0 ? [format_infinite_free_error(goods)] : [];
    });

describe("充值商店配置校验", () => {
    let goods_list: ReadonlyArray<ChargeShopGoodsRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        const row_index_by_shop_and_gift_id = build_excel_row_index_by_composite_key({
            excel_path: CHARGE_SHOP_EXCEL_PATH,
            sheet_name: "商品配置",
            parent_key_column_name: "id",
            child_key_column_name: "$key",
            header_rows: [1, 4],
            data_start_row: 8,
            inherit_parent_key_from_previous_row: true,
        });
        goods_list = collect_charge_shop_goods(row_index_by_shop_and_gift_id);
    });

    it("should 免费商品不能配置为无限购买", () => {
        const errors = collect_infinite_free_goods_errors(goods_list);
        assert_no_errors("存在可无限购买的免费商品：", errors);
    });
});
