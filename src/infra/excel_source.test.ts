import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {build_excel_row_index_by_key} from "./excel_source";

vi.mock("node:child_process", () => ({
    execFileSync: vi.fn(),
}));

const temporary_roots: string[] = [];
const mocked_exec_file_sync = vi.mocked(execFileSync);

const workbook_xml = `
    <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
    </workbook>
`;
const workbook_relationships_xml = `
    <Relationships>
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    </Relationships>
`;
const worksheet_xml = `
    <worksheet><sheetData>
        <row r="1">
            <c r="A1" t="inlineStr"><is><t>id</t></is></c>
            <c r="B1" t="inlineStr"><is><t>name</t></is></c>
        </row>
        <row r="2">
            <c r="A2"><v>7</v></c>
            <c r="B2" t="inlineStr"><is><t>alpha</t></is></c>
        </row>
    </sheetData></worksheet>
`;

beforeEach(() => {
    mocked_exec_file_sync.mockReset();
    mocked_exec_file_sync.mockImplementation(((_file, args) => {
        if (!args) {
            throw new Error("missing unzip arguments");
        }

        if (args[0] === "-Z1") {
            return [
                "xl/workbook.xml",
                "xl/_rels/workbook.xml.rels",
                "xl/worksheets/sheet1.xml",
            ].join("\n");
        }

        switch (args[2]) {
            case "xl/workbook.xml":
                return workbook_xml;
            case "xl/_rels/workbook.xml.rels":
                return workbook_relationships_xml;
            case "xl/worksheets/sheet1.xml":
                return worksheet_xml;
            default:
                throw new Error(`unexpected xlsx entry: ${args[2]}`);
        }
    }) as typeof execFileSync);
});

afterEach(() => {
    temporary_roots.splice(0).forEach((root) => rmSync(root, {recursive: true, force: true}));
});

describe("Excel 源定位", () => {
    it("should 内联字符串工作簿缺少 sharedStrings entry 时静默读取", () => {
        const root = mkdtempSync(join(tmpdir(), "validate-excel-source-"));
        temporary_roots.push(root);
        const excel_path = resolve(root, "inline-strings.xlsx");
        writeFileSync(excel_path, "mock xlsx");

        const index = build_excel_row_index_by_key({
            excel_path,
            sheet_name: "Data",
            key_column_name: "id",
        });

        expect(index.get("7")).toEqual({
            sheet_name: "Data",
            row: 2,
            key_cell: "A2",
            cells_by_header: new Map([
                ["id", "A2"],
                ["name", "B2"],
            ]),
        });
        expect(mocked_exec_file_sync.mock.calls.map(([, args]) => args)).toContainEqual([
            "-Z1",
            excel_path,
        ]);
        expect(mocked_exec_file_sync.mock.calls.map(([, args]) => args)).not.toContainEqual([
            "-p",
            excel_path,
            "xl/sharedStrings.xml",
        ]);
    });
});
