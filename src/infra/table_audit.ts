import {existsSync, readFileSync, readdirSync} from "node:fs";
import {basename, extname, resolve} from "node:path";

export type TableDefinition = Readonly<{
    name: string;
    input: string;
    define_path: string;
}>;

type TablesConstructor = {
    prototype: object;
    getTableNames?: () => ReadonlyArray<string>;
    gtTableNames?: () => ReadonlyArray<string>;
    new(loader: (file_name: string) => unknown): unknown;
};

type TableAccessor = Readonly<{
    getDataList?: () => ReadonlyArray<unknown>;
    getDataMap?: () => Map<unknown, unknown>;
    getData?: () => unknown;
}>;

const decode_xml_attribute = (value: string): string => value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const read_attribute = (tag: string, name: string): string | undefined => {
    const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`));
    return match === null ? undefined : decode_xml_attribute(match[2]);
};

export const extract_table_definitions = (
    xml: string,
    define_path: string,
): ReadonlyArray<TableDefinition> => {
    const without_comments = xml.replace(/<!--[\s\S]*?-->/g, "");
    return Array.from(without_comments.matchAll(/<table\b[^>]*>/g)).map((match) => {
        const name = read_attribute(match[0], "name");
        const input = read_attribute(match[0], "input");
        if (name === undefined || input === undefined) {
            throw new Error(`defines table 缺少 name 或 input: define=${define_path}, tag=${match[0]}`);
        }
        return {name, input, define_path};
    });
};

const list_xml_files = (root: string, relative_directory = ""): ReadonlyArray<string> =>
    readdirSync(resolve(root, relative_directory), {withFileTypes: true}).flatMap((entry) => {
        const relative_path = relative_directory === "" ? entry.name : `${relative_directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return list_xml_files(root, relative_path);
        }
        return entry.isFile() && entry.name.endsWith(".xml") ? [relative_path] : [];
    });

export const collect_table_definitions = (defines_root: string): ReadonlyArray<TableDefinition> =>
    Array.from(list_xml_files(defines_root))
        .sort((left, right) => left.localeCompare(right, "en"))
        .flatMap((define_path) => extract_table_definitions(
            readFileSync(resolve(defines_root, define_path), "utf-8"),
            `defines/${define_path}`,
        ));

export const generated_table_getter_names = (tables_constructor: TablesConstructor): ReadonlyArray<string> =>
    Object.getOwnPropertyNames(tables_constructor.prototype)
        .filter((name) => name.startsWith("Tb"))
        .filter((name) => typeof Object.getOwnPropertyDescriptor(tables_constructor.prototype, name)?.get === "function")
        .sort((left, right) => left.localeCompare(right, "en"));

export const generated_table_file_names = (tables_constructor: TablesConstructor): ReadonlyArray<string> => {
    const list_names = tables_constructor.getTableNames ?? tables_constructor.gtTableNames;
    if (list_names === undefined) {
        throw new Error("生成 Tables 缺少 getTableNames()/gtTableNames() API");
    }
    return Array.from(list_names.call(tables_constructor));
};

export const collect_schema_alignment_errors = (
    definitions: ReadonlyArray<TableDefinition>,
    generated_getters: ReadonlyArray<string>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const definitions_by_name = new Map<string, TableDefinition>();
    definitions.forEach((definition) => {
        const previous = definitions_by_name.get(definition.name);
        if (previous !== undefined) {
            errors.push(`defines 表名重复: table=${definition.name}, define=${previous.define_path} | ${definition.define_path}`);
        }
        definitions_by_name.set(definition.name, definition);
    });

    const getters = new Set(generated_getters);
    definitions.forEach((definition) => {
        if (!getters.has(definition.name)) {
            errors.push(`defines 表未生成 getter: table=${definition.name}, input=${definition.input}, define=${definition.define_path}`);
        }
    });
    const definition_names = new Set(definitions.map((definition) => definition.name));
    generated_getters.forEach((getter) => {
        if (!definition_names.has(getter)) {
            errors.push(`生成 getter 不存在于 defines: table=${getter}`);
        }
    });
    return errors;
};

const list_json_file_names = (json_root: string): ReadonlyArray<string> =>
    readdirSync(json_root, {withFileTypes: true})
        .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
        .map((entry) => basename(entry.name, ".json"))
        .sort((left, right) => left.localeCompare(right, "en"));

export const audit_json_snapshot_and_construct_tables = (
    tables_constructor: TablesConstructor,
    json_root: string,
): Readonly<{errors: ReadonlyArray<string>; tables?: unknown}> => {
    const errors: string[] = [];
    if (!existsSync(json_root)) {
        return {errors: [`JSON 快照目录不存在: ${json_root}`]};
    }

    let expected_names: ReadonlyArray<string>;
    try {
        expected_names = Array.from(generated_table_file_names(tables_constructor))
            .sort((left, right) => left.localeCompare(right, "en"));
    }
    catch (error: unknown) {
        return {errors: [`读取生成 Tables 文件名列表失败: error=${String(error)}`]};
    }
    const actual_names = list_json_file_names(json_root);
    const expected = new Set(expected_names);
    const actual = new Set(actual_names);
    Array.from(expected)
        .filter((name) => expected_names.filter((candidate) => candidate === name).length > 1)
        .forEach((name) => errors.push(`Tables 文件名列表包含重复项: table=${name}`));
    expected_names.filter((name) => !actual.has(name)).forEach((name) => {
        errors.push(`Tables 文件名列表对应 JSON 缺失: json=${resolve(json_root, `${name}.json`)}`);
    });
    actual_names.filter((name) => !expected.has(name)).forEach((name) => {
        errors.push(`JSON 快照存在多余文件: json=${resolve(json_root, `${name}.json`)}`);
    });

    const parsed_by_name = new Map<string, unknown>();
    actual_names.forEach((name) => {
        const json_path = resolve(json_root, `${name}.json`);
        try {
            parsed_by_name.set(name, JSON.parse(readFileSync(json_path, "utf-8")));
        }
        catch (error: unknown) {
            errors.push(`JSON 快照解析失败: json=${json_path}, error=${String(error)}`);
        }
    });
    if (errors.length > 0) {
        return {errors};
    }

    let current_json_path = "<尚未读取>";
    try {
        const tables = new tables_constructor((file_name) => {
            current_json_path = resolve(json_root, `${file_name}.json`);
            if (!parsed_by_name.has(file_name)) {
                throw new Error(`loader 未找到 JSON: ${current_json_path}`);
            }
            return parsed_by_name.get(file_name);
        });
        return {errors, tables};
    }
    catch (error: unknown) {
        errors.push(`构造 fresh Tables 失败: current_json=${current_json_path}, error=${String(error)}`);
        return {errors};
    }
};

const collect_undefined_ref_errors = (
    value: unknown,
    root_path: string,
    visited: WeakSet<object>,
): ReadonlyArray<string> => {
    if (value === null || typeof value !== "object") {
        return [];
    }
    if (visited.has(value)) {
        return [];
    }
    visited.add(value);

    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => collect_undefined_ref_errors(entry, `${root_path}[${index}]`, visited));
    }
    if (value instanceof Map) {
        return Array.from(value.entries()).flatMap(([key, entry]) =>
            collect_undefined_ref_errors(entry, `${root_path}{${String(key)}}`, visited)
        );
    }

    return Object.keys(value).flatMap((key) => {
        const child = (value as Record<string, unknown>)[key];
        const child_path = `${root_path}.${key}`;
        if (key.endsWith("_ref")) {
            const source_key = key.slice(0, -"_ref".length);
            const source_value = (value as Record<string, unknown>)[source_key];
            const is_empty_sentinel = source_value === undefined
                || source_value === null
                || source_value === 0
                || source_value === ""
                || source_value === false;
            return child === undefined && !is_empty_sentinel
                ? [`非空生成引用解析为 undefined: path=${child_path}, source=${source_key}, value=${String(source_value)}`]
                : [];
        }
        return collect_undefined_ref_errors(child, child_path, visited);
    });
};

export const collect_table_data_errors = (
    tables: unknown,
    table_getter_names: ReadonlyArray<string>,
): ReadonlyArray<string> => table_getter_names.flatMap((table_name) => {
    const errors: string[] = [];
    let table: TableAccessor;
    try {
        table = (tables as Record<string, TableAccessor>)[table_name];
    }
    catch (error: unknown) {
        return [`读取生成 table getter 失败: table=${table_name}, error=${String(error)}`];
    }

    let list: ReadonlyArray<unknown> | undefined;
    let map: Map<unknown, unknown> | undefined;
    let singleton: unknown;
    try {
        list = typeof table.getDataList === "function" ? table.getDataList() : undefined;
        map = typeof table.getDataMap === "function" ? table.getDataMap() : undefined;
        singleton = typeof table.getData === "function" ? table.getData() : undefined;
    }
    catch (error: unknown) {
        return [`读取生成表数据失败: table=${table_name}, error=${String(error)}`];
    }

    if (list !== undefined && map !== undefined && list.length !== map.size) {
        errors.push(`表 list/map 数量不一致（可能发生主键覆盖）: table=${table_name}, list=${list.length}, map=${map.size}`);
    }

    const visited = new WeakSet<object>();
    if (list !== undefined) {
        errors.push(...collect_undefined_ref_errors(list, `${table_name}.getDataList()`, visited));
    }
    if (map !== undefined) {
        errors.push(...collect_undefined_ref_errors(map, `${table_name}.getDataMap()`, visited));
    }
    if (singleton !== undefined) {
        errors.push(...collect_undefined_ref_errors(singleton, `${table_name}.getData()`, visited));
    }
    return errors;
});
