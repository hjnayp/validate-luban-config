# 建筑产出配置新增校验：道具产物存在性

## 需求
当建筑生产的产品类型是道具（`RewardType.Item`）时，`product_id` 必须存在于道具表中。

## 实现
- 在 `test/modules/building/producing.test.ts` 中新增纯函数 `collect_item_product_exist_errors`；
- 该函数过滤出 `productType === RewardType.Item` 的产物；
- 对每个道具产物执行 `assert_item_exist(product_id)`；
- 为保证一次性输出全部问题，对断言异常进行捕获并转为错误文本；
- 新增测试用例：`should 当产品类型是道具时 product_id 必须存在于道具表`。

## 兼容性说明
- 原有测试与断言均保留；
- 新增校验不会影响已有规则的执行顺序与失败输出模式。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 6/6 测试通过。

