import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {describe, it} from "vitest";
import {Tables} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {verify_snapshot_manifest} from "../../infra/snapshot_manifest";
import {
    audit_json_snapshot_and_construct_tables,
    collect_schema_alignment_errors,
    collect_table_data_errors,
    collect_table_definitions,
    generated_table_getter_names,
} from "../../infra/table_audit";

const config_root = resolve(
    process.env.CONFIG_ROOT
    ?? process.env.LUBAN_CONFIG_ROOT
    ?? resolve(process.cwd(), "../../config"),
);
const manifest_path = resolve(
    process.env.LUBAN_CONFIG_SNAPSHOT_MANIFEST ?? resolve(process.cwd(), "gen/validation-manifest.json"),
);
const local_json_root = resolve(__dirname, "../../infra/json");
const json_root = resolve(
    process.env.LUBAN_CONFIG_SNAPSHOT_JSON_ROOT
    ?? (existsSync(local_json_root) ? local_json_root : resolve(process.cwd(), "gen/json")),
);

describe("全部配置表通用结构校验", () => {
    it("should 源定义、生成 schema、JSON 快照与引用结构严格一致", () => {
        const errors: string[] = [];

        if (!existsSync(manifest_path)) {
            errors.push(
                `配置源快照 manifest 不存在: ${manifest_path}, 请先运行 npm run validate:export 生成 fresh 导出快照`,
            );
        }
        else {
            try {
                errors.push(...verify_snapshot_manifest(config_root, manifest_path));
            }
            catch (error: unknown) {
                errors.push(`配置源快照校验失败: manifest=${manifest_path}, error=${String(error)}`);
            }
        }

        const definitions = collect_table_definitions(resolve(config_root, "defines"));
        const getter_names = generated_table_getter_names(Tables);
        errors.push(...collect_schema_alignment_errors(definitions, getter_names));

        const json_audit = audit_json_snapshot_and_construct_tables(Tables, json_root);
        errors.push(...json_audit.errors);
        if (json_audit.tables !== undefined) {
            errors.push(...collect_table_data_errors(json_audit.tables, getter_names));
        }

        assert_no_errors("全部配置表结构或导出快照不一致：", errors);
    });
});
