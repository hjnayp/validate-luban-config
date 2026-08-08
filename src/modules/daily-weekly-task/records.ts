import {resolve} from "node:path";
import {base, dailyweeklytask} from "../../../gen/schema";
import {build_excel_row_index_by_key, ExcelRowLocation, format_excel_error_source} from "../../infra/excel_source";
import {tb} from "../../infra/tb";

/** 三张日周任务表同源于一个 Excel 文件，按 sheet 区分错误来源。 */
export const DAILY_WEEKLY_TASK_EXCEL_PATH = resolve(process.cwd(), "..", "..", "config", "配置表", "R-任务系统-每日每周.xlsx");
export const ERROR_SOURCE_CONST_EXCEL = "系统常量@R-任务系统-每日每周.xlsx";
export const ERROR_SOURCE_TASK_EXCEL = "任务@R-任务系统-每日每周.xlsx";
export const ERROR_SOURCE_CHEST_EXCEL = "活跃宝箱@R-任务系统-每日每周.xlsx";

// 三张 sheet 的 ##var 都在第 1 行，##type/##group/## 说明占到第 4 行，数据从第 5 行开始。
const HEADER_ROWS = [1];
const DATA_START_ROW = 5;

export type DailyWeeklyTaskConstRecord = Readonly<{
    id: number;
    system_open_id: string;
    source_location: ExcelRowLocation | undefined;
}>;

export type DailyWeeklyTaskRecord = Readonly<{
    code: string;
    task_id: number;
    period_type: dailyweeklytask.PeriodType;
    active_score: number;
    reward: ReadonlyArray<base.Reward>;
    open_system_ids: ReadonlyArray<string>;
    open_mode: dailyweeklytask.OpenMode;
    sort: number;
    source_location: ExcelRowLocation | undefined;
}>;

export type DailyWeeklyActiveChestRecord = Readonly<{
    chest_id: number;
    period_type: dailyweeklytask.PeriodType;
    threshold: number;
    reward: ReadonlyArray<base.Reward>;
    sort: number;
    source_location: ExcelRowLocation | undefined;
}>;

/** 表尚未导出时给出可执行的提示，而不是抛出 undefined 读属性的内部错误。 */
const require_table = <T>(table: T | undefined, table_name: string): T => {
    if (!table) {
        throw new Error(
            `配置表未导出: ${table_name}，请先在 config/defines/dailyweeklytask.xml 中启用该表并重新导出 gen 与 gen/json`,
        );
    }

    return table;
};

const build_row_index = (sheet_name: string, key_column_name: string): ReadonlyMap<string, ExcelRowLocation> =>
    build_excel_row_index_by_key({
        excel_path: DAILY_WEEKLY_TASK_EXCEL_PATH,
        sheet_name,
        key_column_name,
        header_rows: HEADER_ROWS,
        data_start_row: DATA_START_ROW,
    });

export const collect_daily_weekly_task_const_record = (): DailyWeeklyTaskConstRecord => {
    const table = require_table(tb.TbDailyWeeklyTaskConst, "TbDailyWeeklyTaskConst");
    const row_index_by_id = build_row_index("系统常量", "id");
    const config = table.getData();

    return {
        id: config.id,
        system_open_id: config.systemOpenId,
        source_location: row_index_by_id.get(String(config.id)),
    };
};

export const collect_daily_weekly_task_records = (): ReadonlyArray<DailyWeeklyTaskRecord> => {
    const table = require_table(tb.TbDailyWeeklyTask, "TbDailyWeeklyTask");
    const row_index_by_code = build_row_index("任务", "code");

    return table.getDataList().map((config) => ({
        code: config.code,
        task_id: config.taskId,
        period_type: config.periodType,
        active_score: config.activeScore,
        reward: config.reward,
        open_system_ids: config.openSystemIds,
        open_mode: config.openMode,
        sort: config.sort,
        source_location: row_index_by_code.get(config.code),
    }));
};

export const collect_daily_weekly_active_chest_records = (): ReadonlyArray<DailyWeeklyActiveChestRecord> => {
    const table = require_table(tb.TbDailyWeeklyActiveChest, "TbDailyWeeklyActiveChest");
    const row_index_by_chest_id = build_row_index("活跃宝箱", "chestId");

    return table.getDataList().map((config) => ({
        chest_id: config.chestId,
        period_type: config.periodType,
        threshold: config.threshold,
        reward: config.reward,
        sort: config.sort,
        source_location: row_index_by_chest_id.get(String(config.chestId)),
    }));
};

/** 周期枚举转成策划可读的名字，未知值直接回落到原始数值。 */
export const format_period_type = (period_type: dailyweeklytask.PeriodType): string =>
    dailyweeklytask.PeriodType[period_type] ?? String(period_type);

/** 拼接一条带 Excel 来源的用户错误。 */
export const format_daily_weekly_task_error = (
    error_source_excel: string,
    location: ExcelRowLocation | undefined,
    field_name: string,
    detail: string,
): string =>
    `${format_excel_error_source(error_source_excel, location, {cell_header: field_name, field_name})}, ${detail}`;

/**
 * 奖励字段在任务表和宝箱表共用同一份规则：至少一条、道具 ID 非空、
 * 奖励类型合法、数量为正、同一 (type,id) 不重复。
 */
export const collect_reward_errors = (
    error_source_excel: string,
    location: ExcelRowLocation | undefined,
    owner: string,
    rewards: ReadonlyArray<base.Reward>,
): ReadonlyArray<string> => {
    const to_error = (detail: string): string =>
        format_daily_weekly_task_error(error_source_excel, location, "reward", `${owner}, ${detail}`);

    if (rewards.length <= 0) {
        return [to_error("reason=奖励不能为空")];
    }

    const seen_rewards = new Set<string>();
    return rewards.flatMap((reward) => {
        const errors: string[] = [];
        if (String(reward.id ?? "").trim() === "") {
            errors.push(to_error("reason=奖励道具 ID 不能为空"));
        }
        if (base.RewardType[reward.type] === undefined) {
            errors.push(to_error(`reward=${reward.id}, type=${reward.type}, reason=非法的奖励类型`));
        }
        if (reward.count <= 0) {
            errors.push(to_error(`reward=${reward.id}, count=${reward.count}, reason=奖励数量必须大于 0`));
        }

        const reward_key = `${reward.type}:${reward.id}`;
        if (seen_rewards.has(reward_key)) {
            errors.push(to_error(`reward=${reward.id}, type=${reward.type}, reason=同一条配置内奖励重复`));
        }
        seen_rewards.add(reward_key);

        return errors;
    });
};
