import {base} from "../../gen/schema/base";

type LookupTable = Readonly<{
    get: (id: string) => unknown;
}>;

export type RewardReferenceTables = Readonly<{
    TbItem: LookupTable;
    TbHero: LookupTable;
    TbHeroQuality: LookupTable;
    TbEquip: LookupTable;
    TbSpecialRewardItem: LookupTable;
}>;

type TableAccessor = Readonly<{
    getDataList?: () => ReadonlyArray<unknown>;
    getDataMap?: () => Map<unknown, unknown>;
    getData?: () => unknown;
}>;

const reward_types = new Set<number>([
    base.RewardType.Item,
    base.RewardType.Hero,
    base.RewardType.Equip,
    base.RewardType.Worker,
    base.RewardType.BingYingHero,
    base.RewardType.Exp,
    base.RewardType.DrawTrans,
]);

const collect_one_reward_errors = (
    reward: base.Reward | base.RateReward,
    tables: RewardReferenceTables,
    context: string,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const prefix = `${context}, rewardType=${String(reward.type)}, rewardId=${String(reward.id)}`;

    if (!reward_types.has(reward.type)) {
        errors.push(`未知 RewardType: ${prefix}`);
        return errors;
    }
    if (reward.id.length === 0
        && reward.type !== base.RewardType.Worker
        && reward.type !== base.RewardType.Exp
    ) {
        errors.push(`奖励 id 不能为空: ${prefix}`);
    }
    if (!Number.isSafeInteger(reward.count) || reward.count <= 0) {
        errors.push(`奖励 count 必须是正安全整数: ${prefix}, count=${String(reward.count)}`);
    }

    switch (reward.type) {
        case base.RewardType.Item:
            if (tables.TbItem.get(reward.id) === undefined) {
                errors.push(`奖励引用不存在: ${prefix}, target=TbItem`);
            }
            break;
        case base.RewardType.Hero:
        case base.RewardType.DrawTrans: {
            const separator_index = reward.id.indexOf("_");
            const hero_id = separator_index < 0 ? "" : reward.id.slice(0, separator_index);
            const quality = separator_index < 0 ? "" : reward.id.slice(separator_index + 1);
            if (hero_id.length === 0 || quality.length === 0 || quality.includes("_")) {
                errors.push(`英雄或抽卡转换奖励 id 必须为 heroId_quality: ${prefix}`);
                break;
            }
            if (tables.TbHero.get(hero_id) === undefined) {
                errors.push(`奖励引用不存在: ${prefix}, heroId=${hero_id}, target=TbHero`);
            }
            if (tables.TbHeroQuality.get(quality) === undefined) {
                errors.push(`奖励引用不存在: ${prefix}, quality=${quality}, target=TbHeroQuality`);
            }
            break;
        }
        case base.RewardType.Equip:
            if (tables.TbEquip.get(reward.id) === undefined) {
                errors.push(`奖励引用不存在: ${prefix}, target=TbEquip`);
            }
            break;
        case base.RewardType.BingYingHero:
            if (tables.TbHero.get(reward.id) === undefined) {
                errors.push(`奖励引用不存在: ${prefix}, target=TbHero`);
            }
            break;
        case base.RewardType.Worker:
        case base.RewardType.Exp:
            // 双端消费都不使用配置 id：服务端处理器忽略入参，客户端按类型固定展示特殊项。
            break;
    }

    return errors;
};

const collect_nested_reward_errors = (
    value: unknown,
    tables: RewardReferenceTables,
    path: string,
    visited: WeakSet<object>,
): ReadonlyArray<string> => {
    if (value === null || typeof value !== "object") {
        return [];
    }
    if (visited.has(value)) {
        return [];
    }
    visited.add(value);

    if (value instanceof base.Reward || value instanceof base.RateReward) {
        return collect_one_reward_errors(value, tables, `path=${path}`);
    }
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) =>
            collect_nested_reward_errors(entry, tables, `${path}[${index}]`, visited)
        );
    }
    if (value instanceof Map) {
        return Array.from(value.entries()).flatMap(([key, entry]) =>
            collect_nested_reward_errors(entry, tables, `${path}{${String(key)}}`, visited)
        );
    }

    return Object.keys(value)
        .filter((key) => !key.endsWith("_ref"))
        .flatMap((key) => collect_nested_reward_errors(
            (value as Record<string, unknown>)[key],
            tables,
            `${path}.${key}`,
            visited,
        ));
};

export const collect_reward_contract_errors = (
    value: unknown,
    tables: RewardReferenceTables,
    root_path = "root",
): ReadonlyArray<string> => collect_nested_reward_errors(value, tables, root_path, new WeakSet<object>());

export const collect_all_table_reward_contract_errors = (
    tables: RewardReferenceTables & object,
): ReadonlyArray<string> => Object.getOwnPropertyNames(Object.getPrototypeOf(tables))
    .filter((table_name) => table_name.startsWith("Tb"))
    .filter((table_name) => typeof Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(tables),
        table_name,
    )?.get === "function")
    .sort((left, right) => left.localeCompare(right, "en"))
    .flatMap((table_name) => {
        let table: TableAccessor;
        try {
            table = (tables as unknown as Record<string, TableAccessor>)[table_name];
        }
        catch (error: unknown) {
            return [`读取奖励所在配置表失败: table=${table_name}, error=${String(error)}`];
        }

        try {
            if (typeof table.getDataList === "function") {
                return collect_reward_contract_errors(
                    table.getDataList(),
                    tables,
                    `${table_name}.getDataList()`,
                );
            }
            if (typeof table.getDataMap === "function") {
                return collect_reward_contract_errors(
                    table.getDataMap(),
                    tables,
                    `${table_name}.getDataMap()`,
                );
            }
            if (typeof table.getData === "function") {
                return collect_reward_contract_errors(
                    table.getData(),
                    tables,
                    `${table_name}.getData()`,
                );
            }
            return [];
        }
        catch (error: unknown) {
            return [`遍历奖励所在配置表失败: table=${table_name}, error=${String(error)}`];
        }
    });
