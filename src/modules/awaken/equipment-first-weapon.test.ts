import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";
import {awaken} from "../../../gen/schema/awaken";

type FirstWeaponRecord = Readonly<{
    equip_id: number;
    equip_name: string;
    weapon_type: number;
    is_first_weapn: boolean;
}>;

// 天赋解锁武器类型时，会按 weapon_type 可选授予标记为 is_first_weapn 的武器。
// 服务端明确允许某类型不配置赠送武器，但重复标记会让查找结果依赖遍历顺序。
const collect_first_weapon_errors = (
    records: ReadonlyArray<FirstWeaponRecord>,
): ReadonlyArray<string> => {
    const by_weapon_type = new Map<number, FirstWeaponRecord[]>();
    records.forEach((record) => {
        const bucket = by_weapon_type.get(record.weapon_type) ?? [];
        bucket.push(record);
        by_weapon_type.set(record.weapon_type, bucket);
    });

    return Array.from(by_weapon_type.entries()).flatMap(([weapon_type, bucket]) => {
        const source = `excel=装备@M-喵王觉醒.xlsx, weapon_type=${weapon_type}`;
        const firsts = bucket.filter((record) => record.is_first_weapn);
        if (firsts.length <= 1) {
            return [];
        }

        return [
            `${source}, firsts=${firsts.map((record) => record.equip_id).join(",")}, reason=同一武器类型最多配置一把解锁赠送武器`,
        ];
    });
};

const collect_first_weapon_records = (): ReadonlyArray<FirstWeaponRecord> =>
    tb.TbAwakenEquipment.getDataList()
        .filter((equip) => equip.part === awaken.AwakenEquipmentPartEnum.Weapon)
        .map((equip) => ({
            equip_id: equip.id,
            equip_name: equip.name,
            weapon_type: equip.weaponType ?? 0,
            is_first_weapn: equip.isFirstWeapn,
        }));

describe("喵王觉醒武器首武器配置校验", () => {
    let records: ReadonlyArray<FirstWeaponRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_first_weapon_records();
    });

    it("should 同一武器类型最多配置一把解锁赠送武器", () => {
        const invalid_records: ReadonlyArray<FirstWeaponRecord> = [
            {equip_id: 201, equip_name: "不赠送武器", weapon_type: 1, is_first_weapn: false},
            {equip_id: 202, equip_name: "重复首武器A", weapon_type: 2, is_first_weapn: true},
            {equip_id: 203, equip_name: "重复首武器B", weapon_type: 2, is_first_weapn: true},
        ];

        const errors = collect_first_weapon_errors(invalid_records);

        expect(errors).toHaveLength(1);
        expect(errors.join("\n")).toContain("同一武器类型最多配置一把解锁赠送武器");
    });

    it("should 当前武器配置不存在重复的解锁赠送标记", () => {
        const errors = collect_first_weapon_errors(records);
        assert_no_errors("存在重复解锁赠送武器的喵王觉醒武器类型：", errors);
    });
});
