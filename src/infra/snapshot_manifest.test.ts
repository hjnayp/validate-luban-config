import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {
    capture_snapshot_manifest,
    serialize_snapshot_manifest,
    verify_snapshot_manifest,
    write_snapshot_manifest,
} from "./snapshot_manifest";

const temporary_roots: string[] = [];

const make_config_root = (): string => {
    const root = mkdtempSync(join(tmpdir(), "validate-snapshot-manifest-"));
    temporary_roots.push(root);
    mkdirSync(resolve(root, "defines/nested"), {recursive: true});
    mkdirSync(resolve(root, "配置表/nested"), {recursive: true});
    mkdirSync(resolve(root, "errorcode"), {recursive: true});
    mkdirSync(resolve(root, "l10n"), {recursive: true});
    writeFileSync(resolve(root, "defines/nested/table.xml"), "<module />");
    writeFileSync(resolve(root, "配置表/nested/table.xlsx"), "xlsx");
    writeFileSync(resolve(root, "errorcode/ErrorCode.xlsx"), "error-code");
    writeFileSync(resolve(root, "l10n/Language.xlsx"), "language");
    writeFileSync(resolve(root, "luban_conf.conf"), "conf");
    return root;
};

afterEach(() => {
    temporary_roots.splice(0).forEach((root) => rmSync(root, {recursive: true, force: true}));
});

describe("配置源 snapshot manifest", () => {
    it("should 仅记录稳定排序的相对路径与 SHA-256", () => {
        const config_root = make_config_root();
        const manifest = capture_snapshot_manifest(config_root);
        const serialized = serialize_snapshot_manifest(manifest);

        expect(manifest.files.map((entry) => entry.path)).toEqual([
            "defines/nested/table.xml",
            "errorcode/ErrorCode.xlsx",
            "l10n/Language.xlsx",
            "luban_conf.conf",
            "配置表/nested/table.xlsx",
        ]);
        expect(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
        expect(serialized).not.toContain(config_root);
    });

    it("should 配置源内容变化时报告 manifest stale", () => {
        const config_root = make_config_root();
        const manifest_path = resolve(config_root, "manifest.json");
        write_snapshot_manifest(manifest_path, capture_snapshot_manifest(config_root));
        expect(verify_snapshot_manifest(config_root, manifest_path)).toEqual([]);

        writeFileSync(resolve(config_root, "errorcode/ErrorCode.xlsx"), "changed");
        expect(verify_snapshot_manifest(config_root, manifest_path)).toEqual([
            "快照后配置源内容已变化: errorcode/ErrorCode.xlsx",
        ]);
    });
});
