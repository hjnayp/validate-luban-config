# 建筑产出配置新增校验：装备/军团产物存在性

## 需求
在建筑生产配置中，除道具产物外，还要校验：
- 当 `productType === RewardType.Equip` 时，`product_id` 必须存在于装备表；
- 当 `productType === RewardType.Hero` 时，`product_id` 必须存在于军团表。

## 实现
- 在 `test/infra/config_asserts.ts` 中新增：
  - `assert_equip_exist(equip_id: string)`
  - `assert_hero_exist(hero_id: string)`
- 在 `test/modules/building/producing.test.ts` 中新增：
  - `collect_equip_product_exist_errors(...)`
  - `collect_hero_product_exist_errors(...)`
- 新增两条测试：
  - `should 当产品类型是装备时 product_id 必须存在于装备表`
  - `should 当产品类型是军团时 product_id 必须存在于军团表`

## 说明
- 与已有道具校验一致，采用“收集错误列表 + `assert_no_errors`”模式；
- 对断言异常进行捕获并转换为错误字符串，避免首个失败中断全量扫描。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 8/8 测试通过。

