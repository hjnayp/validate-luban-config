import {beforeAll, describe, expect, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type SkinLevelRecord = Readonly<{
    skin_kind: "武器皮肤" | "喵王皮肤";
    skin_id: number;
    skin_name: string;
    quality: number;
    levels: ReadonlyArray<number>;
}>;

const collect_skin_level_errors = (
    records: ReadonlyArray<SkinLevelRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        const source = `excel=${record.skin_kind}@M-喵王觉醒.xlsx, skin=${record.skin_id}(${record.skin_name})`;
        if (!Number.isInteger(record.quality) || record.quality < 0) {
            return [`${source}, quality=${record.quality}, reason=品质必须是非负整数`];
        }

        const levels = Array.from(new Set(record.levels)).sort((left, right) => left - right);
        if (levels[0] !== 1) {
            return [`${source}, levels=${levels.join(",")}, reason=缺少1星配置`];
        }

        const max_level = levels.at(-1) ?? 0;
        const is_continuous = levels.every((level, index) => level === index + 1);
        return is_continuous
            ? []
            : [`${source}, levels=${levels.join(",")}, reason=等级配置必须从1星连续到${max_level}星`];
    });

const collect_skin_level_records = (): ReadonlyArray<SkinLevelRecord> => [
    ...tb.TbAwakenWeaponSkin.getDataList().map((skin) => ({
        skin_kind: "武器皮肤" as const,
        skin_id: skin.id,
        skin_name: skin.name,
        quality: skin.quality,
        levels: Array.from(skin.weaponSkinLevel.keys()),
    })),
    ...tb.TbAwakenSkin.getDataList().map((skin) => ({
        skin_kind: "喵王皮肤" as const,
        skin_id: skin.id,
        skin_name: skin.name,
        quality: skin.quality,
        levels: Array.from(skin.weaponSkinLevel.keys()),
    })),
];

describe("喵王觉醒皮肤星级配置校验", () => {
    let records: ReadonlyArray<SkinLevelRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_skin_level_records();
    });

    it("should 等级上限取每个皮肤配置的最大等级且配置必须从1星连续", () => {
        const invalid_records: ReadonlyArray<SkinLevelRecord> = [
            {skin_kind: "武器皮肤", skin_id: 1, skin_name: "缺少1星", quality: 0, levels: [2, 3]},
            {skin_kind: "喵王皮肤", skin_id: 2, skin_name: "等级断档", quality: 1, levels: [1, 3]},
            {skin_kind: "喵王皮肤", skin_id: 3, skin_name: "品质非法", quality: -1, levels: [1]},
        ];

        const errors = collect_skin_level_errors(invalid_records);

        expect(errors).toHaveLength(3);
        expect(errors.join("\n")).toContain("缺少1星配置");
        expect(errors.join("\n")).toContain("等级配置必须从1星连续到3星");
        expect(errors.join("\n")).toContain("品质必须是非负整数");
    });

    it("should 当前两类皮肤配置均满足星级契约", () => {
        const errors = collect_skin_level_errors(records);
        assert_no_errors("存在非法喵王觉醒皮肤星级配置：", errors);
    });
});
