# 测试覆盖

## 建筑产出规则校验

文件：`src/modules/building/producing.test.ts`

启动前会先执行 `cfg_mgr.init_load_all_files()` 加载全量配置，随后按规则收集错误并统一断言。当前包含 8 条规则：

1. 采集区产物类型必须是道具
2. 生产区产物类型必须是道具/装备
3. 募兵营产物类型必须是军团
4. 所有产物生产 CD 必须大于 0
5. 所有产物消耗必须存在且数量大于 0
6. 道具类产物的 `product_id` 必须存在于道具表
7. 装备类产物的 `product_id` 必须存在于装备表
8. 军团类产物的 `product_id` 必须存在于军团表

## 充值商店规则校验

文件：`src/modules/charge-shop/free-gift-limit.test.ts`

当前包含 1 条规则：

1. `TbChargeShop` 中免费商品（`buyType=Free`）不允许配置为无限购买（`limitCnt <= 0`）

## 模型资源规则校验

文件：`src/modules/model-resource.test.ts`

当前包含 1 条规则：

1. `TbHeroModel` 中每个 `model` 指向的 Spine 资源必须存在

## 错误定位

规则错误会尽量输出源 Excel 定位信息：

```text
excel=来源表@文件.xlsx, sheet=Sheet名, row=行号, cell=单元格, field=字段名
```

## 配置加载冒烟测试

文件：`src/modules/tb.test.ts`

验证配置初始化与 `tb` 表实例可用性。
