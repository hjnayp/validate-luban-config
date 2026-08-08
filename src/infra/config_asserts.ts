import {existsSync, readdirSync, statSync} from "node:fs";
import {basename, extname, normalize, resolve} from "node:path";
import {tb} from "./tb"
import * as O from "fp-ts/Option";

const discover_cattie_resources_roots = (): ReadonlyArray<string> => {
    const configured_cattie_root = process.env.CATTIE_ROOT;
    const candidates = [
        ...(configured_cattie_root === undefined ? [] : [
            resolve(configured_cattie_root, "assets", "resources"),
            resolve(configured_cattie_root, "assets", "bundles"),
        ]),
        resolve(process.cwd(), "client", "cattie", "assets", "resources"),
        resolve(process.cwd(), "client", "cattie", "assets", "bundles"),
        resolve(process.cwd(), "..", "client", "cattie", "assets", "resources"),
        resolve(process.cwd(), "..", "client", "cattie", "assets", "bundles"),
        resolve(process.cwd(), "..", "..", "client", "cattie", "assets", "resources"),
        resolve(process.cwd(), "..", "..", "client", "cattie", "assets", "bundles"),
        resolve(__dirname, "..", "..", "..", "..", "client", "cattie", "assets", "resources"),
        resolve(__dirname, "..", "..", "..", "..", "client", "cattie", "assets", "bundles"),
    ];

    return [...new Set(candidates.filter(existsSync))];
};

const has_spine_assets = (resource_root: string, model: string): boolean => {
    const normalized_model = model.replace(/\\\\/g, "/");
    const model_resource_path = normalize(resolve(resource_root, normalized_model));
    const model_ext = extname(model_resource_path);

    if (existsSync(model_resource_path) && model_ext === "") {
        try {
            return statSync(model_resource_path).isFile();
        } catch {
            return false;
        }
    }

    const has_sk_file = existsSync(`${model_resource_path}.json`) || existsSync(`${model_resource_path}.skel`);
    const has_atlas_file = existsSync(`${model_resource_path}.atlas`) || existsSync(`${model_resource_path}.atlas.txt`);
    const has_png_file = existsSync(`${model_resource_path}.png`);
    if (has_sk_file && has_atlas_file && has_png_file) {
        return true;
    }

    if (!existsSync(model_resource_path) || !statSync(model_resource_path).isDirectory()) {
        return false;
    }

    const asset_files = readdirSync(model_resource_path);
    const has_any_json_like = asset_files.some((filename: string) =>
        filename.endsWith(".json") || filename.endsWith(".skel")
    );
    const has_any_atlas = asset_files.some((filename: string) =>
        filename.endsWith(".atlas") || filename.endsWith(".atlas.txt")
    );
    const has_any_png = asset_files.some((filename: string) => filename.endsWith(".png"));
    if (has_any_json_like && has_any_atlas && has_any_png) {
        return true;
    }

    const folder_model_name = basename(model_resource_path);
    const file_with_name_resource_path = resolve(model_resource_path, folder_model_name);
    const has_dir_sk_file = existsSync(`${file_with_name_resource_path}.json`) || existsSync(`${file_with_name_resource_path}.skel`);
    const has_dir_atlas_file = existsSync(`${file_with_name_resource_path}.atlas`) || existsSync(`${file_with_name_resource_path}.atlas.txt`);
    const has_dir_png_file = existsSync(`${file_with_name_resource_path}.png`);

    return has_dir_sk_file && has_dir_atlas_file && has_dir_png_file;
};

export const check_model_spine_resource_exist = (model: string): O.Option<string> => {
    const resources_roots = discover_cattie_resources_roots();

    if (resources_roots.length <= 0) {
        return O.some("无法定位 client/cattie/assets/resources 或 client/cattie/assets/bundles 资源根目录");
    }

    const hit = resources_roots.some((resources_root) => has_spine_assets(resources_root, model));
    if (hit) {
        return O.none;
    }

    const candidates = resources_roots.map((resources_root) => `${resources_root}/${model}[.json/.skel/.atlas/.atlas.txt/.png]`);
    return O.some(`spine资源不存在: ${model}, 候选路径: ${candidates.join(" | ")}`);
};

export const check_item_exist = (item_id: string): O.Option<string> =>
    tb.TbItem.get(item_id)
        ? O.none
        : O.some(`非法的道具, item_id=${item_id}`);

export const check_equip_exist = (equip_id: string): O.Option<string> =>
    tb.TbEquip.get(equip_id)
        ? O.none
        : O.some(`非法的装备, equip_id=${equip_id}`);

export const check_hero_exist = (hero_id: string): O.Option<string> =>
    tb.TbHero.get(hero_id)
        ? O.none
        : O.some(`非法的军团, hero_id=${hero_id}`);
