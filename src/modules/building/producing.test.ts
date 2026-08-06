import {beforeAll, describe, it} from "vitest";
import {resolve} from "node:path";
import * as O from "fp-ts/Option";
import {cfg_mgr, tb} from "../../infra/tb";
import {base, building, work} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {check_equip_exist, check_hero_exist, check_item_exist} from "../../infra/config_asserts";
import {build_excel_row_index_by_composite_key, ExcelRowLocation, format_excel_error_source, make_excel_row_key} from "../../infra/excel_source";
import {option_to_errors} from "../../infra/option";
import WorkPlace = work.WorkPlace;
import RewardType = base.RewardType;

type ProductRecord = Readonly<{
    building_id: number;
    building_name: string;
    product_id: string;
    config: building.BuildingProduceBean;
    source_location: ExcelRowLocation | undefined;
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

const format_produce_group_missing_error = (product: ProductRecord): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceGroup=${product.config.produceGroup}, reason=生产组不存在`;

const format_group_cd_error = (product: ProductRecord, group_level: number, produce_cd: number): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceGroup=${product.config.produceGroup}, groupLevel=${group_level}, produceCd=${produce_cd}`;

const format_group_cost_empty_error = (product: ProductRecord, group_level: number): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceGroup=${product.config.produceGroup}, groupLevel=${group_level}, cost is empty`;

const format_cost_zero_error = (product: ProductRecord, item_id: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, item=${item_id} cost is 0`;

const format_group_cost_zero_error = (product: ProductRecord, group_level: number, item_id: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceGroup=${product.config.produceGroup}, groupLevel=${group_level}, item=${item_id} cost is 0`;

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

const format_group_cost_item_not_exist_error = (product: ProductRecord, group_level: number, item_id: string, reason: string): string =>
    `building=${product.building_id}(${product.building_name}), product=${product.product_id}, produceGroup=${product.config.produceGroup}, groupLevel=${group_level}, item=${item_id}, reason=${reason}`;

const collect_products = (
    product_row_index: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<ProductRecord> =>
    tb.TbBuildingProduce.getDataList()
        .flatMap((building_produce) =>
            Array.from(building_produce.config.entries())
                .map(([product_id, config]) => ({
                    building_id: building_produce.id,
                    building_name: building_produce.name,
                    product_id,
                    config,
                    source_location: product_row_index.get(make_excel_row_key(building_produce.id, product_id)),
                }))
        );

const BUILDING_CONFIG_EXCEL_PATH = resolve(process.cwd(), "..", "..", "config", "配置表", "J-建筑.xlsx");
const BUILDING_PRODUCE_SOURCE_EXCEL = "建筑生产@J-建筑.xlsx";
const BUILDING_PRODUCE_GROUP_SOURCE_EXCEL = "生产组@J-建筑.xlsx";

const collect_item_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Item)
        .flatMap((product) =>
            option_to_errors(check_item_exist(product.product_id))
                .map((reason) => format_building_produce_error(product, "config.$key", format_product_item_error(product, reason)))
        );

const collect_equip_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Equip)
        .flatMap((product) =>
            option_to_errors(check_equip_exist(product.product_id))
                .map((reason) => format_building_produce_error(product, "config.$key", format_product_equip_error(product, reason)))
        );

const collect_hero_product_exist_errors = (products: ReadonlyArray<ProductRecord>): ReadonlyArray<string> =>
    products
        .filter((product) => product.config.productType === RewardType.Hero)
        .flatMap((product) =>
            option_to_errors(check_hero_exist(product.product_id))
                .map((reason) => format_building_produce_error(product, "config.$key", format_product_hero_error(product, reason)))
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
                : [format_building_produce_error(product, "config.productType", format_type_error(product))]
        );

const collect_cd_errors = (
    products: ReadonlyArray<ProductRecord>,
    produce_group_row_index: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<string> =>
    products.flatMap((product) => {
        if (product.config.productType !== RewardType.Equip) {
            return product.config.produceCd > 0
                ? []
                : [format_building_produce_error(product, "config.produceCd", format_cd_error(product))];
        }

        const produce_group = tb.TbBuildingProduceGroup.get(product.config.produceGroup);
        if (!produce_group) {
            return [format_building_produce_error(product, "config.produceGroup", format_produce_group_missing_error(product))];
        }

        return Array.from(produce_group.config.entries())
            .filter(([, bean]) => bean.produceCd <= 0)
            .map(([group_level, bean]) =>
                format_building_produce_group_error(
                    product,
                    produce_group_row_index.get(make_excel_row_key(product.config.produceGroup, group_level)),
                    "config.produceCd",
                    format_group_cd_error(product, group_level, bean.produceCd),
                )
            );
    });

const collect_cost_errors = (
    products: ReadonlyArray<ProductRecord>,
    produce_group_row_index: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<string> =>
    products.flatMap((product) => {
        if (product.config.productType !== RewardType.Equip) {
            return Array.from(product.config.produceCost.entries())
                .flatMap(([item_id, cost]) => {
                    const item_exist_error = check_item_exist(item_id);
                    if (O.isSome(item_exist_error)) {
                        return [format_building_produce_error(product, "config.produceCost", format_cost_item_not_exist_error(product, item_id, item_exist_error.value))];
                    }

                    return cost <= 0 ? [format_building_produce_error(product, "config.produceCost", format_cost_error(product, item_id, cost))] : [];
                });
        }

        const produce_group = tb.TbBuildingProduceGroup.get(product.config.produceGroup);
        if (!produce_group) {
            return [format_building_produce_error(product, "config.produceGroup", format_produce_group_missing_error(product))];
        }

        return Array.from(produce_group.config.entries()).flatMap(([group_level, bean]) => {
            const cost_dict = bean.produceCost;
            if (cost_dict.size <= 0) {
                return [
                    format_building_produce_group_error(
                        product,
                        produce_group_row_index.get(make_excel_row_key(product.config.produceGroup, group_level)),
                        "config.produceCost",
                        format_group_cost_empty_error(product, group_level),
                    ),
                ];
            }

            return Array.from(cost_dict.entries())
                .flatMap(([item_id, cost]) => {
                    const item_exist_error = check_item_exist(item_id);
                    if (O.isSome(item_exist_error)) {
                        return [
                            format_building_produce_group_error(
                                product,
                                produce_group_row_index.get(make_excel_row_key(product.config.produceGroup, group_level)),
                                "config.produceCost",
                                format_group_cost_item_not_exist_error(product, group_level, item_id, item_exist_error.value),
                            ),
                        ];
                    }

                    return cost <= 0
                        ? [
                            format_building_produce_group_error(
                                product,
                                produce_group_row_index.get(make_excel_row_key(product.config.produceGroup, group_level)),
                                "config.produceCost",
                                format_group_cost_zero_error(product, group_level, item_id),
                            ),
                        ]
                        : [];
                });
        });
    });

const format_building_produce_error = (
    product: ProductRecord,
    field_name: string,
    message: string,
): string =>
    `${format_excel_error_source(BUILDING_PRODUCE_SOURCE_EXCEL, product.source_location, {cell_header: excel_cell_header_from_field(field_name), field_name})}, ${message}`;

const format_building_produce_group_error = (
    product: ProductRecord,
    group_location: ExcelRowLocation | undefined,
    field_name: string,
    message: string,
): string =>
    `${format_excel_error_source(BUILDING_PRODUCE_GROUP_SOURCE_EXCEL, group_location, {cell_header: excel_cell_header_from_field(field_name), field_name})}, ${message}`;

const excel_cell_header_from_field = (field_name: string): string =>
    field_name.replace(/^config\./u, "");

describe("建筑配置校验", () => {
    let products: ReadonlyArray<ProductRecord>;
    let produce_group_row_index: ReadonlyMap<string, ExcelRowLocation>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        const product_row_index = build_excel_row_index_by_composite_key({
            excel_path: BUILDING_CONFIG_EXCEL_PATH,
            sheet_name: "建筑生产",
            parent_key_column_name: "id",
            child_key_column_name: "$key",
            header_rows: [1, 3],
            data_start_row: 7,
            inherit_parent_key_from_previous_row: true,
        });
        produce_group_row_index = build_excel_row_index_by_composite_key({
            excel_path: BUILDING_CONFIG_EXCEL_PATH,
            sheet_name: "生产组",
            parent_key_column_name: "id",
            child_key_column_name: "$key",
            header_rows: [1, 4],
            data_start_row: 6,
            inherit_parent_key_from_previous_row: true,
        });
        products = collect_products(product_row_index);
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
        const errors = collect_cd_errors(products, produce_group_row_index);
        assert_no_errors("存在非法产品生产 CD：", errors);
    });

    it("should 所有产品必须有消耗配置且数量大于 0", () => {
        const errors = collect_cost_errors(products, produce_group_row_index);
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
