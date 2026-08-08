import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {
    audit_json_snapshot_and_construct_tables,
    collect_schema_alignment_errors,
    collect_table_data_errors,
    extract_table_definitions,
    generated_table_file_names,
    generated_table_getter_names,
} from "./table_audit";

const temporary_roots: string[] = [];

const make_json_root = (): string => {
    const root = mkdtempSync(join(tmpdir(), "validate-table-audit-"));
    temporary_roots.push(root);
    return root;
};

afterEach(() => {
    temporary_roots.splice(0).forEach((root) => rmSync(root, {recursive: true, force: true}));
});

class FakeTables {
    get TbPresent(): unknown {
        return undefined;
    }

    static gtTableNames(): ReadonlyArray<string> {
        return [];
    }

    constructor(_loader: (file_name: string) => unknown) {}
}

describe("配置表通用结构 helper", () => {
    it("should 兼容新旧 Luban 表文件名 API", () => {
        class CurrentTables {
            static getTableNames(): ReadonlyArray<string> {
                return ["current"];
            }

            constructor(_loader: (file_name: string) => unknown) {}
        }

        expect(generated_table_file_names(CurrentTables)).toEqual(["current"]);
        expect(generated_table_file_names(FakeTables)).toEqual([]);
    });

    it("should 去掉 XML 注释并按 name/input 对齐 getter", () => {
        const definitions = extract_table_definitions(`
            <!--<table name="TbCommented" input="commented.xlsx" />-->
            <table name="TbPresent" input="present.xlsx" />
            <table
                input='missing.xlsx'
                name='TbMissing'
            />
        `, "defines/test.xml");
        const getter_names = generated_table_getter_names(FakeTables);

        expect(definitions.map((definition) => definition.name)).toEqual(["TbPresent", "TbMissing"]);
        expect(collect_schema_alignment_errors(definitions, getter_names)).toEqual([
            "defines 表未生成 getter: table=TbMissing, input=missing.xlsx, define=defines/test.xml",
        ]);
    });

    it("should 汇总重复主键与非空缺引用并接受明确空哨兵", () => {
        const tables = {
            TbPresent: {
                getDataList: () => [
                    {id: 1, required: 7, required_ref: undefined},
                    {id: 1, stringId: "missing", stringId_ref: undefined},
                    {undefinedId: undefined, undefinedId_ref: undefined},
                    {nullableId: null, nullableId_ref: undefined},
                    {zeroId: 0, zeroId_ref: undefined},
                    {emptyId: "", emptyId_ref: undefined},
                    {falseId: false, falseId_ref: undefined},
                ],
                getDataMap: () => new Map([[1, {id: 1}]]),
            },
        };

        expect(collect_table_data_errors(tables, ["TbPresent"])).toEqual([
            "表 list/map 数量不一致（可能发生主键覆盖）: table=TbPresent, list=7, map=1",
            "非空生成引用解析为 undefined: path=TbPresent.getDataList()[0].required_ref, source=required, value=7",
            "非空生成引用解析为 undefined: path=TbPresent.getDataList()[1].stringId_ref, source=stringId, value=missing",
        ]);
    });

    it("should 同时收集缺 JSON、多余 JSON 与坏 JSON", () => {
        class SnapshotTables {
            static gtTableNames(): ReadonlyArray<string> {
                return ["missing"];
            }

            constructor(_loader: (file_name: string) => unknown) {}
        }
        const json_root = make_json_root();
        writeFileSync(resolve(json_root, "extra.json"), "not-json");

        const result = audit_json_snapshot_and_construct_tables(SnapshotTables, json_root);

        expect(result.tables).toBeUndefined();
        expect(result.errors).toHaveLength(3);
        expect(result.errors.join("\n")).toContain("Tables 文件名列表对应 JSON 缺失");
        expect(result.errors.join("\n")).toContain("JSON 快照存在多余文件");
        expect(result.errors.join("\n")).toContain("JSON 快照解析失败");
    });

    it("should fresh 构造器必填字段缺失时带当前 JSON 上下文", () => {
        class RequiredTables {
            static gtTableNames(): ReadonlyArray<string> {
                return ["required"];
            }

            constructor(loader: (file_name: string) => unknown) {
                const value = loader("required") as {required?: unknown};
                if (value.required === undefined) {
                    throw new Error("required field is missing");
                }
            }
        }
        const json_root = make_json_root();
        mkdirSync(json_root, {recursive: true});
        writeFileSync(resolve(json_root, "required.json"), "{}");

        const result = audit_json_snapshot_and_construct_tables(RequiredTables, json_root);

        expect(result.tables).toBeUndefined();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(`current_json=${resolve(json_root, "required.json")}`);
        expect(result.errors[0]).toContain("required field is missing");
    });
});
