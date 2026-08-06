import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {posix} from "node:path";

/** Excel 源数据行定位信息。 */
export type ExcelRowLocation = Readonly<{
    sheet_name: string;
    row: number;
    key_cell: string;
    cells_by_header: ReadonlyMap<string, string>;
}>;

/** 按某个表头列建立 Excel 主键到源行定位的参数。 */
export type ExcelRowIndexOptions = Readonly<{
    excel_path: string;
    sheet_name: string;
    key_column_name: string;
    header_row?: number;
    header_rows?: ReadonlyArray<number>;
    data_start_row?: number;
}>;

/** 按父子键建立 Excel 行定位的参数，适合 Luban map 展开成多行的配置。 */
export type ExcelCompositeRowIndexOptions = Readonly<{
    excel_path: string;
    sheet_name: string;
    parent_key_column_name: string;
    child_key_column_name: string;
    header_rows?: ReadonlyArray<number>;
    data_start_row?: number;
    inherit_parent_key_from_previous_row?: boolean;
}>;

/** 格式化 Excel 源定位时使用的字段信息。 */
export type ExcelSourceFormatOptions = Readonly<{
    cell_header?: string;
    field_name?: string;
}>;

type WorksheetRow = Readonly<{
    row_number: number;
    cells_by_column: ReadonlyMap<string, string>;
}>;

type HeaderColumn = Readonly<{
    header: string;
    column: string;
}>;

/** 从源 xlsx 中按主键列建立行号索引；读取失败时返回空索引，不阻断规则校验。 */
export const build_excel_row_index_by_key = (options: ExcelRowIndexOptions): ReadonlyMap<string, ExcelRowLocation> => {
    const worksheet = read_worksheet_for_index(options);
    if (!worksheet) {
        return new Map<string, ExcelRowLocation>();
    }

    const key_column = worksheet.header_columns.find((column) => column.header === options.key_column_name);
    if (!key_column) {
        return new Map<string, ExcelRowLocation>();
    }

    return worksheet.rows
        .filter((row) => row.row_number >= worksheet.data_start_row)
        .reduce((index, row) => {
            const key = normalize_cell_value(row.cells_by_column.get(key_column.column));
            if (key === "" || index.has(key)) {
                return index;
            }

            index.set(key, build_location(options.sheet_name, row.row_number, key_column, worksheet.header_columns));
            return index;
        }, new Map<string, ExcelRowLocation>());
};

/** 建立 `parent_key + child_key` 到 Excel 行定位的索引。 */
export const build_excel_row_index_by_composite_key = (
    options: ExcelCompositeRowIndexOptions,
): ReadonlyMap<string, ExcelRowLocation> => {
    const worksheet = read_worksheet_for_index(options);
    if (!worksheet) {
        return new Map<string, ExcelRowLocation>();
    }

    const parent_key_column = worksheet.header_columns.find((column) => column.header === options.parent_key_column_name);
    const child_key_column = worksheet.header_columns.find((column) => column.header === options.child_key_column_name);
    if (!parent_key_column || !child_key_column) {
        return new Map<string, ExcelRowLocation>();
    }

    let inherited_parent_key = "";
    return worksheet.rows
        .filter((row) => row.row_number >= worksheet.data_start_row)
        .reduce((index, row) => {
            const parent_key = normalize_cell_value(row.cells_by_column.get(parent_key_column.column));
            if (parent_key !== "" || !options.inherit_parent_key_from_previous_row) {
                inherited_parent_key = parent_key;
            }

            const effective_parent_key = options.inherit_parent_key_from_previous_row
                ? inherited_parent_key
                : parent_key;
            const child_key = normalize_cell_value(row.cells_by_column.get(child_key_column.column));
            if (effective_parent_key === "" || child_key === "") {
                return index;
            }

            const key = make_excel_row_key(effective_parent_key, child_key);
            if (!index.has(key)) {
                index.set(key, build_location(options.sheet_name, row.row_number, child_key_column, worksheet.header_columns));
            }

            return index;
        }, new Map<string, ExcelRowLocation>());
};

/** 生成父子组合行索引用的稳定 key。 */
export const make_excel_row_key = (...parts: ReadonlyArray<string | number>): string =>
    parts.map((part) => String(part)).join("\u001f");

/** 按统一格式输出 Excel 文件、sheet、行号和单元格定位。 */
export const format_excel_error_source = (
    excel_name: string,
    location: ExcelRowLocation | undefined,
    options: ExcelSourceFormatOptions = {},
): string => {
    const parts = [`excel=${excel_name}`];
    if (location) {
        parts.push(`sheet=${location.sheet_name}`, `row=${location.row}`);

        const cell_header = options.cell_header ?? options.field_name;
        const cell = cell_header ? location.cells_by_header.get(cell_header) : location.key_cell;
        if (cell) {
            parts.push(`cell=${cell}`);
        }
    }

    if (options.field_name) {
        parts.push(`field=${options.field_name}`);
    }

    return parts.join(", ");
};

const read_xlsx_entry = (excel_path: string, entry_path: string): string | undefined => {
    try {
        return execFileSync("unzip", ["-p", excel_path, entry_path], {
            encoding: "utf-8",
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch {
        return undefined;
    }
};

const read_worksheet_for_index = (
    options: ExcelRowIndexOptions | ExcelCompositeRowIndexOptions,
): Readonly<{
    rows: ReadonlyArray<WorksheetRow>;
    header_columns: ReadonlyArray<HeaderColumn>;
    data_start_row: number;
}> | undefined => {
    if (!existsSync(options.excel_path)) {
        return undefined;
    }

    const worksheet_path = find_worksheet_path(options.excel_path, options.sheet_name);
    if (!worksheet_path) {
        return undefined;
    }

    const worksheet_xml = read_xlsx_entry(options.excel_path, worksheet_path);
    if (!worksheet_xml) {
        return undefined;
    }

    const shared_strings = read_shared_strings(options.excel_path);
    const rows = parse_worksheet_rows(worksheet_xml, shared_strings);
    const header_rows = resolve_header_rows(options);
    const header_columns = collect_header_columns(rows, header_rows);
    const data_start_row = options.data_start_row ?? Math.max(...header_rows) + 1;

    return {rows, header_columns, data_start_row};
};

const find_worksheet_path = (excel_path: string, sheet_name: string): string | undefined => {
    const workbook_xml = read_xlsx_entry(excel_path, "xl/workbook.xml");
    const workbook_rels_xml = read_xlsx_entry(excel_path, "xl/_rels/workbook.xml.rels");
    if (!workbook_xml || !workbook_rels_xml) {
        return undefined;
    }

    const sheet = find_sheet(workbook_xml, sheet_name);
    if (!sheet) {
        return undefined;
    }

    const target = find_relationship_target(workbook_rels_xml, sheet.relationship_id);
    return target ? normalize_workbook_target(target) : undefined;
};

const find_sheet = (
    workbook_xml: string,
    sheet_name: string,
): Readonly<{relationship_id: string}> | undefined => {
    const sheet_regex = /<sheet\b([^>]*)\/>/g;
    for (const match of workbook_xml.matchAll(sheet_regex)) {
        const attrs = match[1];
        if (decode_xml(get_xml_attribute(attrs, "name") ?? "") !== sheet_name) {
            continue;
        }

        const relationship_id = get_xml_attribute(attrs, "r:id");
        return relationship_id ? {relationship_id} : undefined;
    }

    return undefined;
};

const find_relationship_target = (rels_xml: string, relationship_id: string): string | undefined => {
    const relationship_regex = /<Relationship\b([^>]*)\/>/g;
    for (const match of rels_xml.matchAll(relationship_regex)) {
        const attrs = match[1];
        if (get_xml_attribute(attrs, "Id") !== relationship_id) {
            continue;
        }

        return get_xml_attribute(attrs, "Target");
    }

    return undefined;
};

const normalize_workbook_target = (target: string): string =>
    target.startsWith("/")
        ? target.replace(/^\/+/, "")
        : posix.normalize(posix.join("xl", target));

const read_shared_strings = (excel_path: string): ReadonlyArray<string> => {
    const shared_strings_xml = read_xlsx_entry(excel_path, "xl/sharedStrings.xml");
    if (!shared_strings_xml) {
        return [];
    }

    const shared_strings: string[] = [];
    const shared_string_regex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    for (const match of shared_strings_xml.matchAll(shared_string_regex)) {
        shared_strings.push(read_text_nodes(match[1]));
    }

    return shared_strings;
};

const parse_worksheet_rows = (
    worksheet_xml: string,
    shared_strings: ReadonlyArray<string>,
): ReadonlyArray<WorksheetRow> => {
    const rows: WorksheetRow[] = [];
    const row_regex = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
    for (const row_match of worksheet_xml.matchAll(row_regex)) {
        const row_attrs = row_match[1] ?? row_match[2] ?? "";
        const row_xml = row_match[3] ?? "";
        const row_number = Number(get_xml_attribute(row_attrs, "r"));
        if (!Number.isFinite(row_number)) {
            continue;
        }

        rows.push({
            row_number,
            cells_by_column: parse_cells(row_xml, shared_strings),
        });
    }

    return rows;
};

const parse_cells = (
    row_xml: string,
    shared_strings: ReadonlyArray<string>,
): ReadonlyMap<string, string> => {
    const cells_by_column = new Map<string, string>();
    const cell_regex = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    for (const cell_match of row_xml.matchAll(cell_regex)) {
        const cell_attrs = cell_match[1] ?? cell_match[2] ?? "";
        const cell_xml = cell_match[3] ?? "";
        const cell_ref = get_xml_attribute(cell_attrs, "r");
        if (!cell_ref) {
            continue;
        }

        const column = cell_ref.replace(/\d+$/u, "");
        cells_by_column.set(column, read_cell_value(cell_attrs, cell_xml, shared_strings));
    }

    return cells_by_column;
};

const read_cell_value = (
    cell_attrs: string,
    cell_xml: string,
    shared_strings: ReadonlyArray<string>,
): string => {
    const cell_type = get_xml_attribute(cell_attrs, "t");
    if (cell_type === "inlineStr") {
        return read_text_nodes(cell_xml);
    }

    const raw_value = read_first_tag_value(cell_xml, "v");
    if (raw_value === undefined) {
        return "";
    }

    if (cell_type === "s") {
        return shared_strings[Number(raw_value)] ?? "";
    }

    return decode_xml(raw_value);
};

const collect_header_columns = (
    rows: ReadonlyArray<WorksheetRow>,
    header_rows: ReadonlyArray<number>,
): ReadonlyArray<HeaderColumn> => {
    const columns: HeaderColumn[] = [];
    const seen = new Set<string>();

    header_rows
        .map((header_row_number) => rows.find((row) => row.row_number === header_row_number))
        .filter((row): row is WorksheetRow => row !== undefined)
        .forEach((header_row) => {
            Array.from(header_row.cells_by_column.entries())
                .flatMap(([column, value]) => normalize_header_names(value).map((header) => ({header, column})))
                .forEach((column) => {
                    const key = `${column.header}:${column.column}`;
                    if (seen.has(key)) {
                        return;
                    }

                    seen.add(key);
                    columns.push(column);
                });
        });

    return columns;
};

const build_cells_by_header = (
    header_columns: ReadonlyArray<HeaderColumn>,
    row_number: number,
): ReadonlyMap<string, string> =>
    header_columns.reduce((cells_by_header, {header, column}) => {
        if (!cells_by_header.has(header)) {
            cells_by_header.set(header, `${column}${row_number}`);
        }
        return cells_by_header;
    }, new Map<string, string>());

const build_location = (
    sheet_name: string,
    row_number: number,
    key_column: HeaderColumn,
    header_columns: ReadonlyArray<HeaderColumn>,
): ExcelRowLocation => ({
    sheet_name,
    row: row_number,
    key_cell: `${key_column.column}${row_number}`,
    cells_by_header: build_cells_by_header(header_columns, row_number),
});

const normalize_cell_value = (value: string | undefined): string =>
    (value ?? "").trim();

const normalize_header_names = (value: string | undefined): ReadonlyArray<string> => {
    const header = normalize_cell_value(value);
    if (header === "") {
        return [];
    }

    const normalized_headers = [header];
    if (header.startsWith("*")) {
        normalized_headers.push(header.slice(1));
    }

    return normalized_headers;
};

const resolve_header_rows = (
    options: ExcelRowIndexOptions | ExcelCompositeRowIndexOptions,
): ReadonlyArray<number> => {
    if ("header_rows" in options && options.header_rows && options.header_rows.length > 0) {
        return options.header_rows;
    }

    if ("header_row" in options && options.header_row) {
        return [options.header_row];
    }

    return [1];
};

const read_first_tag_value = (xml: string, tag_name: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag_name}\\b[^>]*>([\\s\\S]*?)<\\/${tag_name}>`));
    return match ? decode_xml(match[1]) : undefined;
};

const read_text_nodes = (xml: string): string => {
    const values: string[] = [];
    const text_regex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    for (const match of xml.matchAll(text_regex)) {
        values.push(decode_xml(match[1]));
    }

    return values.join("");
};

const get_xml_attribute = (attrs: string, name: string): string | undefined => {
    const match = attrs.match(new RegExp(`(?:^|\\s)${escape_regexp(name)}="([^"]*)"`));
    return match ? decode_xml(match[1]) : undefined;
};

const escape_regexp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const decode_xml = (value: string): string =>
    value
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex_value: string) => String.fromCodePoint(Number.parseInt(hex_value, 16)))
        .replace(/&#([0-9]+);/g, (_, decimal_value: string) => String.fromCodePoint(Number.parseInt(decimal_value, 10)))
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
