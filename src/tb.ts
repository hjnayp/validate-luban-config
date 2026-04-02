import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import * as jsonCfg from "../gen/schema";

export let tb: jsonCfg.Tables | undefined;
const datas = new Map<string, unknown>();
const load_file = (fileName: string): unknown => {
    if (datas.has(fileName)) {
        return datas.get(fileName);
    }

    return null;
};

export class cfg_mgr {
    private static _tables: jsonCfg.Tables;

    static get tables(): jsonCfg.Tables {
        return this._tables;
    }

    private static set tables(value: jsonCfg.Tables) {
        tb = this._tables = value;
    }

    public static readonly init_load_all_files = () => {
        const file_names: readonly string[] = jsonCfg.Tables.getTableNames();

        // 优先读取与当前文件同级目录下的 json，其次回退到进程工作目录。
        const resolve_json_file_path = (file_name: string): string => {
            const local_path = resolve(__dirname, "json", `${file_name}.json`);
            if (existsSync(local_path)) {
                return local_path;
            }

            return resolve(process.cwd(), "gen", "json", `${file_name}.json`);
        };

        const load_one_json = (file_name: string): void => {
            const json_file_path = resolve_json_file_path(file_name);

            try {
                const raw_json: string = readFileSync(json_file_path, "utf-8");
                const parsed_json: unknown = JSON.parse(raw_json);
                datas.set(file_name, parsed_json);
            } catch (error: unknown) {
                if (error instanceof SyntaxError) {
                    throw new Error(`[ConfigManager] JSON 解析失败: ${file_name}, path=${json_file_path}`);
                }

                const node_error = error as NodeJS.ErrnoException;
                if (node_error.code === "ENOENT") {
                    throw new Error(`[ConfigManager] 配置文件不存在: ${file_name}, path=${json_file_path}`);
                }

                throw new Error(`[ConfigManager] 配置加载失败: ${file_name}, path=${json_file_path}, error=${String(error)}`);
            }
        };

        file_names.forEach(load_one_json);
        this.tables = new jsonCfg.Tables(load_file);
    }
}
