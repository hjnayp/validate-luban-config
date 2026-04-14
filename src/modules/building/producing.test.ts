import {beforeAll, describe, it} from "vitest";
import * as O from "fp-ts/Option";
import {cfg_mgr, tb} from "../../infra/tb";
import {base, building, work} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {check_equip_exist, check_hero_exist, check_item_exist} from "../../infra/config_asserts";
import {option_to_errors} from "../../infra/option";
import WorkPlace = work.WorkPlace;
import RewardType = base.RewardType;

type ProductRecord = Readonly<{
    building_id: number;
    building_name: string;
    product_id: string;
    config: building.BuildingProduceBean;
}>;

type ReadonlyRewardTypeSet = ReadonlySet<RewardType>;
type ReadonlyWorkPlaceSet = ReadonlySet<WorkPlace>;

const collecting_work_places: ReadonlyWorkPlaceSet = new Set<WorkPlace>([
    WorkPlace.FaMuChang,
    WorkPlace.CaiKuangChang,
    WorkPlace.YuChang,
]);

const producing_work_places: ReadonlyWorkPlaceSet = new Set<WorkPlace>([
    WorkPlace.TieJiangPu,
    WorkPlace.ChuFang,
    WorkPlace.LianJinFang,
    WorkPlace.JuanZhouZuoFang,
    WorkPlace.ShouGongFang,
    WorkPlace.ShouLan,
]);

const barrack_work_places: ReadonlyWorkPlaceSet = new Set<WorkPlace>([
    WorkPlace.BingYing,
]);

const collecting_allowed_types: ReadonlyRewardTypeSet = new Set<RewardType>([
    RewardType.Item,
]);

const producing_allowed_types: ReadonlyRewardTypeSet = new Set<RewardType>([
    RewardType.Item,
    RewardType.Equip,
]);

const barrack_allowed_types: ReadonlyRewardTypeSet = new Set<RewardType>([
    RewardType.Hero,
]);

const format_type_error = (product: ProductRecord): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, type=${product.config.productType}`;

const format_cd_error = (product: ProductRecord): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceCd=${product.config.produceCd}`;

const format_cost_empty_error = (product: ProductRecord): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, cost is empty`;

const format_cost_zero_error = (product: ProductRecord, item_id: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, item=${item_id} cost is 0`;

const format_cost_error = (product: ProductRecord, item_id: string, cost: number): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, item=${item_id}, cost=${cost}`;

const format_product_item_error = (product: ProductRecord, reason: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, reason=${reason}`;

const format_product_equip_error = (product: ProductRecord, reason: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, reason=${reason}`;

const format_product_hero_error = (product: ProductRecord, reason: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, reason=${reason}`;

const format_cost_item_not_exist_error = (product: ProductRecord, item_id: string, reason: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, item=${item_id}, reason=${reason}`;


const collect_products = (): ReadonlyArray<ProductRecord> =>
    tb.TbBuildingProduce.getDataList()
        .flatMap((building_produce) =>
            Array.from(building_produce.config.entries())
                .map(([product_id, config]) => ({
                    building_id: building_produce.id,
                    building_name: building_produce.name,
                    product_id,
                    config,
                }))
        );

const ERROR_SOURCE_EXCEL = "建筑生产@J-建筑.xlsx";

const collect_item_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Item)
        .flatMap((product) =>
            option_to_errors(check_item_exist(product.product_id))
                .map((reason) => format_error_with_source(format_product_item_error(product, reason), ERROR_SOURCE_EXCEL))
        );

const collect_equip_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Equip)
        .flatMap((product) =>
            option_to_errors(check_equip_exist(product.product_id))
                .map((reason) => format_error_with_source(format_product_equip_error(product, reason), ERROR_SOURCE_EXCEL))
        );

const collect_hero_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Hero)
        .flatMap((product) =>
            option_to_errors(check_hero_exist(product.product_id))
                .map((reason) => format_error_with_source(format_product_hero_error(product, reason), ERROR_SOURCE_EXCEL))
        );

const collect_type_errors = (
    products: ReadonlyArray<ProductRecord>,
    target_work_places: ReadonlyWorkPlaceSet,
    allowed_types: ReadonlyRewardTypeSet,
): ReadonlyArray<string> =>
    products
        .filter(({building_id}) => target_work_places.has(building_id as WorkPlace))
        .flatMap((product) =>
            allowed_types.has(product.config.productType as RewardType)
                ? []
                : [format_error_with_source(format_type_error(product), ERROR_SOURCE_EXCEL)]
        );

const collect_cd_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products.flatMap((product) => {
        if (product.config.productType !== RewardType.Equip) {
            return product.config.produceCd > 0
                ? []
                : [format_error_with_source(format_cd_error(product), ERROR_SOURCE_EXCEL)];
        }

        const produce_group = tb.TbBuildingProduceGroup.get(product.config.produceGroup);
        return Array.from(produce_group.config.values())
            .map((bean) => bean.produceCd)
            .filter((produce_cd) => produce_cd <= 0)
            .map(() => format_error_with_source(format_cd_error(product), ERROR_SOURCE_EXCEL));
    });

const collect_cost_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products.flatMap((product) => {
        if (product.config.productType !== RewardType.Equip) {
            return Array.from(product.config.produceCost.entries())
                .flatMap(([item_id, cost]) => {
            const item_exist_error = check_item_exist(item_id);
            if (O.isSome(item_exist_error)) {
                        return [format_error_with_source(format_cost_item_not_exist_error(product, item_id, item_exist_error.value), ERROR_SOURCE_EXCEL)];
                    }

                    return cost <= 0 ? [format_error_with_source(format_cost_error(product, item_id, cost), ERROR_SOURCE_EXCEL)] : [];
                });
        }

        const produce_group = tb.TbBuildingProduceGroup.get(product.config.produceGroup);
        return Array.from(produce_group.config.values()).flatMap((bean) => {
                const cost_dict = bean.produceCost;
            if (cost_dict.size <= 0) {
            return [format_error_with_source(format_cost_empty_error(product), ERROR_SOURCE_EXCEL)];
            }

            return Array.from(cost_dict.entries())
                .flatMap(([item_id, cost]) => {
                const item_exist_error = check_item_exist(item_id);
                if (O.isSome(item_exist_error)) {
                        return [format_error_with_source(format_cost_item_not_exist_error(product, item_id, item_exist_error.value), ERROR_SOURCE_EXCEL)];
                    }

                    return cost <= 0 ? [format_error_with_source(format_cost_zero_error(product, item_id), ERROR_SOURCE_EXCEL)] : [];
                });
        });
    });

const format_error_with_source = (message: string, source_file: string): string =>
    `excel=${source_file}, ${message}`;

describe("建筑配置校验", () => {
    let products: ReadonlyArray<ProductRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        products = collect_products();
    });

    it("should 采集区的产品类型应该是道具", () => {
        const errors = collect_type_errors(products, collecting_work_places, collecting_allowed_types);
        assert_no_errors("存在非法产品类型：", errors);
    });

    it("should 生产区的产品类型应该是道具/装备", () => {
        const errors = collect_type_errors(products, producing_work_places, producing_allowed_types);
        assert_no_errors("存在非法产品类型：", errors);
    });

    it("should 募兵营的产品类型应该是军团", () => {
        const errors = collect_type_errors(products, barrack_work_places, barrack_allowed_types);
        assert_no_errors("存在非法产品类型：", errors);
    });

    it("should 所有的产品cd必须大于0", () => {
        const errors = collect_cd_errors(products);
        assert_no_errors("存在非法产品生产 CD：", errors);
    });

    it("should 所有产品必须有消耗配置且数量大于 0", () => {
        const errors = collect_cost_errors(products);
        assert_no_errors("存在非法产品消耗配置：", errors);
    });

    it("should 当产品类型是道具时 product_id 必须存在于道具表", () => {
        const errors = collect_item_product_exist_errors(products);
        assert_no_errors("存在非法道具产品配置：", errors);
    });

    it("should 当产品类型是装备时 product_id 必须存在于装备表", () => {
        const errors = collect_equip_product_exist_errors(products);
        assert_no_errors("存在非法装备产品配置：", errors);
    });

    it("should 当产品类型是军团时 product_id 必须存在于军团表", () => {
        const errors = collect_hero_product_exist_errors(products);
        assert_no_errors("存在非法军团产品配置：", errors);
    });
});
