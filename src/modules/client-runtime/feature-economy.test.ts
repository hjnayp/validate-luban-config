import {beforeAll, describe, expect, it} from "vitest";
import {base, chargershop} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type FeaturePreviewRecord = Readonly<{
    system_id: string;
    guide_id: number | undefined;
    jump_target: string;
}>;

type SystemOpenRecord = Readonly<{
    id: string;
    main_task_size: number;
    main_instance_size: number;
}>;

type ChargeCostRecord = Readonly<{
    id: string;
    type: base.RewardType;
    count: number;
}>;

type ChargeShopGoodsRecord = Readonly<{
    shop_id: number;
    gift_id: number;
    buy_type: chargershop.GiftBuyType;
    charge_id: string;
    cost_rewards: ReadonlyArray<ChargeCostRecord>;
    give_reward_count: number;
}>;

type BuildingProduceCountRecord = Readonly<{
    id: number;
    value: number;
}>;

const format_error = (table: string, id: string | number, field: string, reason: string): string =>
    `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const collect_jump_target_errors = (record: FeaturePreviewRecord): ReadonlyArray<string> => {
    if (record.jump_target.trim().length === 0) {
        // FeaturePreviewComp 对空跳转目标明确 no-op；仅校验实际会进入 JumpSystem 的非空值。
        return [];
    }

    const parts = record.jump_target.split("|");
    const errors: string[] = [];
    if (parts[0].trim().length === 0) {
        errors.push(format_error("TbFeaturePreview", record.system_id, "jumpTarget", "跳转方法不能为空"));
    }
    if (parts.length > 2) {
        errors.push(format_error(
            "TbFeaturePreview",
            record.system_id,
            "jumpTarget",
            "只能包含一个参数分隔符 |，后续片段会被客户端静默忽略",
        ));
    }
    if (parts.length >= 2) {
        parts[1].split(",").forEach((argument, index) => {
            // JumpSystem.parseArg 明确支持空参数(null)、"=" 常量和 ":" 来源字段；
            // 方法名与来源字段均为动态注册，不在配置校验中枚举。
            if (argument.length > 0 && !argument.includes("=") && !argument.includes(":")) {
                errors.push(format_error(
                    "TbFeaturePreview",
                    record.system_id,
                    `jumpTarget.args[${index}]`,
                    "参数必须使用 = 常量或 : 来源字段语法，否则客户端会解析为 undefined",
                ));
            }
            const equal_count = argument.split("=").length - 1;
            const colon_count = argument.split(":").length - 1;
            if (equal_count > 1 || (equal_count === 0 && colon_count > 1)) {
                errors.push(format_error(
                    "TbFeaturePreview",
                    record.system_id,
                    `jumpTarget.args[${index}]`,
                    "同一参数的解析分隔符只能出现一次，后续片段会被客户端静默截断",
                ));
            }
        });
    }

    return errors;
};

const collect_feature_preview_errors = (
    records: ReadonlyArray<FeaturePreviewRecord>,
    system_open_ids: ReadonlySet<string>,
    step_guide_ids: ReadonlySet<number>,
): ReadonlyArray<string> => {
    const seen_system_ids = new Set<string>();
    return records.flatMap((record) => {
        const errors: string[] = [];
        if (seen_system_ids.has(record.system_id)) {
            errors.push(format_error("TbFeaturePreview", record.system_id, "systemId", "systemId 必须全表唯一"));
        }
        seen_system_ids.add(record.system_id);

        if (!system_open_ids.has(record.system_id)) {
            errors.push(format_error("TbFeaturePreview", record.system_id, "systemId", "TbSystemOpen 中不存在对应系统"));
        }
        // MiaoWangFeatureView 通过 `if (!guideId)` 把 undefined/0 明确视为“无引导”。
        if (record.guide_id !== undefined && record.guide_id > 0 && !step_guide_ids.has(record.guide_id)) {
            errors.push(format_error(
                "TbFeaturePreview",
                record.system_id,
                "guideId",
                `guideId=${record.guide_id} 在 TbStepGuide 中不存在`,
            ));
        }

        return [...errors, ...collect_jump_target_errors(record)];
    });
};

const collect_system_open_map_errors = (
    records: ReadonlyArray<SystemOpenRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const errors: string[] = [];
        // 客户端 SystemOpenEvaluation 使用 firstEntry；服务端 data/system_open.Validate
        // 也在读取首个 map entry 后 break。配置多项不会形成“任一/全部”语义，只会静默丢失。
        if (record.main_task_size > 1) {
            errors.push(format_error(
                "TbSystemOpen",
                record.id,
                "mainTask",
                `配置了 ${record.main_task_size} 项，但客户端和服务端只消费首项`,
            ));
        }
        if (record.main_instance_size > 1) {
            errors.push(format_error(
                "TbSystemOpen",
                record.id,
                "mainInstance",
                `配置了 ${record.main_instance_size} 项，但客户端和服务端只消费首项`,
            ));
        }
        return errors;
    });

const collect_charge_shop_errors = (
    records: ReadonlyArray<ChargeShopGoodsRecord>,
    product_ids: ReadonlySet<string>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const id = `${record.shop_id}:${record.gift_id}`;
        const errors: string[] = [];
        if (record.buy_type === chargershop.GiftBuyType.Rmb) {
            if (record.charge_id.trim().length === 0) {
                errors.push(format_error("TbChargeShop", id, "config.chargeId", "Rmb 商品的 chargeId 不能为空"));
            }
            else if (!product_ids.has(record.charge_id)) {
                errors.push(format_error(
                    "TbChargeShop",
                    id,
                    "config.chargeId",
                    `chargeId=${record.charge_id} 在 TbProduct 中不存在`,
                ));
            }
        }

        // 配置真源声明 costReward 供 Free/Item 使用；Ad/Rmb 分别由广告与平台支付路径结算。
        const cost_must_be_empty = record.buy_type === chargershop.GiftBuyType.Ad
            || record.buy_type === chargershop.GiftBuyType.Rmb;
        if (record.buy_type === chargershop.GiftBuyType.Item && record.cost_rewards.length === 0) {
            errors.push(format_error("TbChargeShop", id, "config.costReward", "Item 商品必须配置购买扣费"));
        }
        else if (cost_must_be_empty && record.cost_rewards.length > 0) {
            errors.push(format_error(
                "TbChargeShop",
                id,
                "config.costReward",
                `${chargershop.GiftBuyType[record.buy_type]} 商品不能配置购买扣费`,
            ));
        }

        const deductible_reward_types: ReadonlySet<base.RewardType> = new Set([
            base.RewardType.Item,
            base.RewardType.Equip,
            base.RewardType.BingYingHero,
        ]);
        record.cost_rewards.forEach((reward, index) => {
            if (!deductible_reward_types.has(reward.type)) {
                errors.push(format_error(
                    "TbChargeShop",
                    id,
                    `config.costReward[${index}].type`,
                    `reward=${reward.id}, type=${base.RewardType[reward.type] ?? reward.type} 不支持 SubReward 扣除`,
                ));
            }
            if (!(reward.count > 0)) {
                errors.push(format_error(
                    "TbChargeShop",
                    id,
                    `config.costReward[${index}].count`,
                    `reward=${reward.id}, count=${reward.count}，扣费数量必须大于 0`,
                ));
            }
        });

        // giveReward 的 type/id/count 通用合法性由全局奖励规则负责；本模块只保证商品不会空发。
        if (record.give_reward_count === 0) {
            errors.push(format_error("TbChargeShop", id, "config.giveReward", "购买后奖励不能为空"));
        }
        return errors;
    });

const collect_building_produce_count_errors = (
    records: ReadonlyArray<BuildingProduceCountRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const seen_values = new Set<number>();
    let infinite_count = 0;
    let positive_count = 0;

    // ProductionPlanInteraction 会自行把普通数量升序、-1 排到最后；配置源顺序不是契约。
    records.forEach((record) => {
        if (seen_values.has(record.value)) {
            errors.push(format_error(
                "TbBuildingProduceCount",
                record.id,
                "value",
                `value=${record.value} 与其他档位重复`,
            ));
        }
        seen_values.add(record.value);

        if (record.value === -1) {
            infinite_count += 1;
        }
        else if (record.value > 0) {
            positive_count += 1;
        }
        else {
            errors.push(format_error(
                "TbBuildingProduceCount",
                record.id,
                "value",
                `value=${record.value}，除 -1 无限生产外必须大于 0`,
            ));
        }
    });

    if (infinite_count > 1) {
        errors.push(format_error(
            "TbBuildingProduceCount",
            "all",
            "value",
            `value=-1 配置了 ${infinite_count} 次，无限生产档位至多一个`,
        ));
    }
    if (positive_count === 0) {
        errors.push(format_error("TbBuildingProduceCount", "all", "value", "至少需要一个大于 0 的生产数量档位"));
    }

    return errors;
};

const collect_current_config_errors = (): ReadonlyArray<string> => {
    const feature_preview_records: ReadonlyArray<FeaturePreviewRecord> = tb.TbFeaturePreview.getDataList()
        .map((config) => ({
            system_id: config.systemId,
            guide_id: config.guideId,
            jump_target: config.jumpTarget,
        }));
    const system_open_records: ReadonlyArray<SystemOpenRecord> = tb.TbSystemOpen.getDataList()
        .map((config) => ({
            id: config.id,
            main_task_size: config.mainTask.size,
            main_instance_size: config.mainInstance.size,
        }));
    const charge_shop_records: ReadonlyArray<ChargeShopGoodsRecord> = tb.TbChargeShop.getDataList()
        .flatMap((shop) => Array.from(shop.config.entries()).map(([gift_id, goods]) => ({
            shop_id: shop.id,
            gift_id,
            buy_type: goods.buyType,
            charge_id: goods.chargeId,
            cost_rewards: goods.costReward.map((reward) => ({
                id: reward.id,
                type: reward.type,
                count: reward.count,
            })),
            give_reward_count: goods.giveReward.length,
        })));
    const building_produce_count_records: ReadonlyArray<BuildingProduceCountRecord> =
        tb.TbBuildingProduceCount.getDataList().map((config) => ({id: config.id, value: config.value}));

    const system_open_ids = new Set(tb.TbSystemOpen.getDataList().map((config) => config.id));
    const step_guide_ids = new Set(tb.TbStepGuide.getDataList().map((config) => config.id));
    const product_ids = new Set(tb.TbProduct.getDataList().map((config) => config.id));

    return [
        ...collect_feature_preview_errors(feature_preview_records, system_open_ids, step_guide_ids),
        ...collect_system_open_map_errors(system_open_records),
        ...collect_charge_shop_errors(charge_shop_records, product_ids),
        ...collect_building_produce_count_errors(building_produce_count_records),
    ];
};

describe("客户端功能开放、充值与建筑档位配置校验", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 合成功能预告坏数据能被完整识别", () => {
        const records: ReadonlyArray<FeaturePreviewRecord> = [
            {system_id: "100", guide_id: 0, jump_target: "$open_chat"},
            {system_id: "100", guide_id: 500, jump_target: "$jump_view|bare|ignored"},
            {system_id: "101", guide_id: undefined, jump_target: "$jump_view|=first=ignored"},
            {system_id: "missing", guide_id: 999, jump_target: ""},
        ];

        const errors = collect_feature_preview_errors(records, new Set(["100", "101"]), new Set([500]));

        expect(errors).toHaveLength(6);
        expect(errors.join("\n")).toContain("systemId 必须全表唯一");
        expect(errors.join("\n")).toContain("TbSystemOpen 中不存在对应系统");
        expect(errors.join("\n")).toContain("在 TbStepGuide 中不存在");
        expect(errors.join("\n")).toContain("只能包含一个参数分隔符");
        expect(errors.join("\n")).toContain("参数必须使用 = 常量或 : 来源字段语法");
        expect(errors.join("\n")).toContain("后续片段会被客户端静默截断");
    });

    it("should 合成系统开放多项 Map 能被识别", () => {
        const errors = collect_system_open_map_errors([{
            id: "1001",
            main_task_size: 2,
            main_instance_size: 3,
        }]);

        expect(errors).toHaveLength(2);
        expect(errors.join("\n")).toContain("field=mainTask");
        expect(errors.join("\n")).toContain("field=mainInstance");
    });

    it("should 合成充值商品坏数据能被完整识别", () => {
        const records: ReadonlyArray<ChargeShopGoodsRecord> = [
            {
                shop_id: 1,
                gift_id: 1001,
                buy_type: chargershop.GiftBuyType.Rmb,
                charge_id: "",
                cost_rewards: [{id: "coin", type: base.RewardType.Item, count: 1}],
                give_reward_count: 0,
            },
            {
                shop_id: 1,
                gift_id: 1002,
                buy_type: chargershop.GiftBuyType.Rmb,
                charge_id: "missing_product",
                cost_rewards: [],
                give_reward_count: 1,
            },
            {
                shop_id: 1,
                gift_id: 1003,
                buy_type: chargershop.GiftBuyType.Item,
                charge_id: "",
                cost_rewards: [],
                give_reward_count: 1,
            },
            {
                shop_id: 1,
                gift_id: 1004,
                buy_type: chargershop.GiftBuyType.Item,
                charge_id: "",
                cost_rewards: [{id: "worker", type: base.RewardType.Worker, count: 0}],
                give_reward_count: 1,
            },
            {
                shop_id: 1,
                gift_id: 1005,
                buy_type: chargershop.GiftBuyType.Free,
                charge_id: "",
                cost_rewards: [{id: "coin", type: base.RewardType.Item, count: 1}],
                give_reward_count: 1,
            },
        ];
        const errors = collect_charge_shop_errors(records, new Set());

        expect(errors).toHaveLength(7);
        expect(errors.join("\n")).toContain("Rmb 商品的 chargeId 不能为空");
        expect(errors.join("\n")).toContain("在 TbProduct 中不存在");
        expect(errors.join("\n")).toContain("购买后奖励不能为空");
        expect(errors.join("\n")).toContain("Rmb 商品不能配置购买扣费");
        expect(errors.join("\n")).toContain("Item 商品必须配置购买扣费");
        expect(errors.join("\n")).toContain("不支持 SubReward 扣除");
        expect(errors.join("\n")).toContain("扣费数量必须大于 0");
    });

    it("should 合成建筑生产数量坏数据能被完整识别", () => {
        const errors = collect_building_produce_count_errors([
            {id: 1, value: -1},
            {id: 2, value: -1},
            {id: 3, value: 0},
            {id: 4, value: -2},
        ]);

        expect(errors).toHaveLength(5);
        expect(errors.join("\n")).toContain("与其他档位重复");
        expect(errors.join("\n")).toContain("无限生产档位至多一个");
        expect(errors.join("\n")).toContain("除 -1 无限生产外必须大于 0");
        expect(errors.join("\n")).toContain("至少需要一个大于 0");
    });

    it("should 当前配置满足客户端运行时已证明的约束", () => {
        assert_no_errors("客户端功能开放、充值与建筑档位配置非法：", collect_current_config_errors());
    });
});
