import {createHash} from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import {dirname, isAbsolute, resolve, sep} from "node:path";

export type SnapshotManifestEntry = Readonly<{
    path: string;
    sha256: string;
}>;

export type SnapshotManifest = Readonly<{
    version: 1;
    files: ReadonlyArray<SnapshotManifestEntry>;
}>;

const to_posix_path = (path: string): string => path.split(sep).join("/");

const list_files_recursively = (
    root: string,
    relative_directory: string,
    extension: string,
): ReadonlyArray<string> => {
    const absolute_directory = resolve(root, relative_directory);
    if (!existsSync(absolute_directory)) {
        throw new Error(`配置源目录不存在: ${relative_directory}`);
    }

    return readdirSync(absolute_directory, {withFileTypes: true}).flatMap((entry) => {
        const relative_path = `${relative_directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return list_files_recursively(root, relative_path, extension);
        }
        if (entry.isFile() && entry.name.endsWith(extension)) {
            return [relative_path];
        }
        return [];
    });
};

export const list_snapshot_source_paths = (config_root: string): ReadonlyArray<string> => {
    const paths = [
        ...list_files_recursively(config_root, "defines", ".xml"),
        ...list_files_recursively(config_root, "配置表", ".xlsx"),
        "errorcode/ErrorCode.xlsx",
        "l10n/Language.xlsx",
        "luban_conf.conf",
    ].map(to_posix_path).sort((left, right) => left.localeCompare(right, "en"));

    const missing_paths = paths.filter((path) => !existsSync(resolve(config_root, path)));
    if (missing_paths.length > 0) {
        throw new Error(`配置源文件不存在: ${missing_paths.join(", ")}`);
    }
    return paths;
};

const same_file_state = (
    left: ReturnType<typeof lstatSync>,
    right: ReturnType<typeof lstatSync>,
): boolean =>
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;

const read_file_state = (config_root: string, relative_path: string): ReturnType<typeof lstatSync> => {
    const absolute_path = resolve(config_root, relative_path);
    const state = lstatSync(absolute_path);
    if (!state.isFile()) {
        throw new Error(`配置源不是普通文件: ${relative_path}`);
    }
    return state;
};

export const capture_snapshot_manifest = (config_root: string): SnapshotManifest => {
    const normalized_root = resolve(config_root);
    const before_paths = list_snapshot_source_paths(normalized_root);
    const before_states = new Map(before_paths.map((path) => [path, read_file_state(normalized_root, path)]));
    const files = before_paths.map((path): SnapshotManifestEntry => ({
        path,
        sha256: createHash("sha256").update(readFileSync(resolve(normalized_root, path))).digest("hex"),
    }));
    const after_paths = list_snapshot_source_paths(normalized_root);
    if (before_paths.join("\n") !== after_paths.join("\n")) {
        throw new Error("配置源文件集合在快照期间发生变化，请停止导出并重试");
    }
    after_paths.forEach((path) => {
        const before = before_states.get(path);
        const after = read_file_state(normalized_root, path);
        if (before === undefined || !same_file_state(before, after)) {
            throw new Error(`配置源在快照期间发生变化: ${path}`);
        }
    });
    return {version: 1, files};
};

export const serialize_snapshot_manifest = (manifest: SnapshotManifest): string =>
    `${JSON.stringify(manifest, null, 2)}\n`;

export const write_snapshot_manifest = (output_path: string, manifest: SnapshotManifest): void => {
    const absolute_output_path = resolve(output_path);
    mkdirSync(dirname(absolute_output_path), {recursive: true});
    const temporary_path = `${absolute_output_path}.${process.pid}.tmp`;
    writeFileSync(temporary_path, serialize_snapshot_manifest(manifest), "utf-8");
    renameSync(temporary_path, absolute_output_path);
};

const parse_snapshot_manifest = (manifest_path: string): SnapshotManifest => {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(manifest_path, "utf-8"));
    }
    catch (error: unknown) {
        throw new Error(`无法读取快照 manifest: ${manifest_path}, error=${String(error)}`);
    }

    if (typeof value !== "object" || value === null) {
        throw new Error(`快照 manifest 格式非法: ${manifest_path}`);
    }
    const candidate = value as {version?: unknown; files?: unknown};
    if (candidate.version !== 1 || !Array.isArray(candidate.files)) {
        throw new Error(`快照 manifest 版本或 files 非法: ${manifest_path}`);
    }

    const files = candidate.files.map((entry, index): SnapshotManifestEntry => {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(`快照 manifest 条目非法: index=${index}`);
        }
        const item = entry as {path?: unknown; sha256?: unknown};
        if (
            typeof item.path !== "string"
            || item.path.length === 0
            || isAbsolute(item.path)
            || item.path.includes("\\")
            || item.path.split("/").includes("..")
            || typeof item.sha256 !== "string"
            || !/^[0-9a-f]{64}$/.test(item.sha256)
        ) {
            throw new Error(`快照 manifest 条目非法: index=${index}`);
        }
        return {path: item.path, sha256: item.sha256};
    });

    const sorted_paths = files.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, "en"));
    if (files.map((entry) => entry.path).join("\n") !== sorted_paths.join("\n")) {
        throw new Error("快照 manifest 文件路径未稳定排序");
    }
    if (new Set(sorted_paths).size !== sorted_paths.length) {
        throw new Error("快照 manifest 包含重复文件路径");
    }
    return {version: 1, files};
};

export const collect_snapshot_manifest_errors = (
    expected: SnapshotManifest,
    actual: SnapshotManifest,
): ReadonlyArray<string> => {
    const expected_by_path = new Map(expected.files.map((entry) => [entry.path, entry.sha256]));
    const actual_by_path = new Map(actual.files.map((entry) => [entry.path, entry.sha256]));
    const missing = expected.files
        .filter((entry) => !actual_by_path.has(entry.path))
        .map((entry) => `快照后配置源文件缺失: ${entry.path}`);
    const extra = actual.files
        .filter((entry) => !expected_by_path.has(entry.path))
        .map((entry) => `快照后新增配置源文件: ${entry.path}`);
    const changed = expected.files
        .filter((entry) => {
            const actual_hash = actual_by_path.get(entry.path);
            return actual_hash !== undefined && actual_hash !== entry.sha256;
        })
        .map((entry) => `快照后配置源内容已变化: ${entry.path}`);
    return [...missing, ...extra, ...changed];
};

export const verify_snapshot_manifest = (
    config_root: string,
    manifest_path: string,
): ReadonlyArray<string> => {
    const expected = parse_snapshot_manifest(resolve(manifest_path));
    const actual = capture_snapshot_manifest(resolve(config_root));
    return collect_snapshot_manifest_errors(expected, actual);
};
