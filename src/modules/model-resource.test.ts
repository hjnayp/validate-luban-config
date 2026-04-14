import {beforeAll, describe, it} from "vitest";
import * as O from "fp-ts/Option";
import {cfg_mgr, tb} from "../infra/tb";
import {hero} from "../../gen/schema";
import {assert_no_errors} from "../infra/assert";
import {check_model_spine_resource_exist} from "../infra/config_asserts";
import {option_to_errors} from "../infra/option";

type HeroModelRecord = Readonly<{
    model_id: number;
    model_path: string;
}>;

const collect_hero_models = (): ReadonlyArray<HeroModelRecord> =>
    tb.TbHeroModel.getDataList()
        .map((hero_model: hero.HeroModelCfg) => ({
            model_id: hero_model.id,
            model_path: hero_model.model,
        }));

const ERROR_SOURCE_EXCEL = "模型@M-模型配置.xlsx";

const format_model_resource_error = (model: HeroModelRecord, reason: string): string =>
    `excel=${ERROR_SOURCE_EXCEL}, hero_model_id=${model.model_id}, model=${model.model_path}, reason=${reason}`;

const collect_model_resource_errors = (models: ReadonlyArray<HeroModelRecord>): ReadonlyArray<string> =>
    models.flatMap((model) =>
        option_to_errors(check_model_spine_resource_exist(model.model_path))
            .map((reason) => format_model_resource_error(model, reason))
    );

describe("模型配置校验", () => {
    let models: ReadonlyArray<HeroModelRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        models = collect_hero_models();
    });

    it("should 所有模型配置中的spine资源文件夹存在", () => {
        const errors = collect_model_resource_errors(models);
        assert_no_errors("存在非法模型资源目录：", errors);
    });
});
