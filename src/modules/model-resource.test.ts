import {beforeAll, describe, it} from "vitest";
import {resolve} from "node:path";
import * as O from "fp-ts/Option";
import {cfg_mgr, tb} from "../infra/tb";
import {hero} from "../../gen/schema";
import {assert_no_errors} from "../infra/assert";
import {check_model_spine_resource_exist} from "../infra/config_asserts";
import {build_excel_row_index_by_key, ExcelRowLocation, format_excel_error_source} from "../infra/excel_source";
import {option_to_errors} from "../infra/option";

type HeroModelRecord = Readonly<{
    model_id: number;
    model_path: string;
    source_location: ExcelRowLocation | undefined;
}>;

const collect_hero_models = (
    row_index_by_model_id: ReadonlyMap<string, ExcelRowLocation>,
): ReadonlyArray<HeroModelRecord> =>
    tb.TbHeroModel.getDataList()
        .map((hero_model: hero.HeroModelCfg) => ({
            model_id: hero_model.id,
            model_path: hero_model.model,
            source_location: row_index_by_model_id.get(String(hero_model.id)),
        }));

const ERROR_SOURCE_EXCEL = "模型@M-模型配置.xlsx";
const MODEL_CONFIG_EXCEL_PATH = resolve(process.cwd(), "..", "..", "config", "配置表", "M-模型配置.xlsx");
const MODELS_WITHOUT_LOCAL_SPINE_RESOURCE = new Set([1003, 31002, 31003, 31004, 31005, 31007, 40001]);

const format_model_resource_error = (model: HeroModelRecord, reason: string): string =>
    `${format_excel_error_source(ERROR_SOURCE_EXCEL, model.source_location, {cell_header: "model", field_name: "model"})}, hero_model_id=${model.model_id}, model=${model.model_path}, reason=${reason}`;

const collect_model_resource_errors = (models: ReadonlyArray<HeroModelRecord>): ReadonlyArray<string> =>
    models
        .filter((model) => !MODELS_WITHOUT_LOCAL_SPINE_RESOURCE.has(model.model_id))
        .flatMap((model) =>
            option_to_errors(check_model_spine_resource_exist(model.model_path))
                .map((reason) => format_model_resource_error(model, reason))
        );

describe("模型配置校验", () => {
    let models: ReadonlyArray<HeroModelRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        const row_index_by_model_id = build_excel_row_index_by_key({
            excel_path: MODEL_CONFIG_EXCEL_PATH,
            sheet_name: "模型",
            key_column_name: "id",
            data_start_row: 5,
        });
        models = collect_hero_models(row_index_by_model_id);
    });

    it("should 所有模型配置中的spine资源文件夹存在", () => {
        const errors = collect_model_resource_errors(models);
        assert_no_errors("存在非法模型资源目录：", errors);
    });
});
