import {resolve} from "node:path";
import {
    capture_snapshot_manifest,
    verify_snapshot_manifest,
    write_snapshot_manifest,
} from "../infra/snapshot_manifest";

type CliOptions = Readonly<Record<string, string>>;

const usage = (): never => {
    throw new Error(
        "用法: capture --config-root <path> --output <path> | verify --config-root <path> --manifest <path>",
    );
};

const parse_options = (args: ReadonlyArray<string>): CliOptions => {
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!option?.startsWith("--") || value === undefined || value.startsWith("--")) {
            usage();
        }
        const name = option.slice(2);
        if (options[name] !== undefined) {
            usage();
        }
        options[name] = value;
    }
    return options;
};

const assert_exact_options = (options: CliOptions, expected_names: ReadonlyArray<string>): void => {
    const actual_names = Object.keys(options).sort();
    const sorted_expected_names = Array.from(expected_names).sort();
    if (actual_names.join("\n") !== sorted_expected_names.join("\n")) {
        usage();
    }
};

const require_option = (options: CliOptions, name: string): string => {
    const value = options[name];
    return value === undefined ? usage() : value;
};

const main = (): void => {
    const [command, ...raw_options] = process.argv.slice(2);
    const options = parse_options(raw_options);
    const config_root = resolve(require_option(options, "config-root"));

    if (command === "capture") {
        assert_exact_options(options, ["config-root", "output"]);
        const output = resolve(require_option(options, "output"));
        const manifest = capture_snapshot_manifest(config_root);
        write_snapshot_manifest(output, manifest);
        process.stdout.write(`已捕获配置源快照: files=${manifest.files.length}, output=${output}\n`);
        return;
    }
    if (command === "verify") {
        assert_exact_options(options, ["config-root", "manifest"]);
        const manifest_path = resolve(require_option(options, "manifest"));
        const errors = verify_snapshot_manifest(config_root, manifest_path);
        if (errors.length > 0) {
            throw new Error(`配置源快照已失效:\n${errors.join("\n")}`);
        }
        process.stdout.write(`配置源快照校验通过: manifest=${manifest_path}\n`);
        return;
    }
    usage();
};

try {
    main();
}
catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
