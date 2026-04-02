# 建筑配置校验调整：存在性判断改为布尔返回

## 目标
将 `assert_item_exist` 风格的判断改为返回 `Option<string>`，从而在 `collect_*_errors` 中通过过滤 `Option.none` 收集错误，且不使用 `try/catch`。

## 改动
- `test/infra/config_asserts.ts`
  - `assert_item_exist(item_id: string): Option<string>`
  - `assert_equip_exist(equip_id: string): Option<string>`
  - `assert_hero_exist(hero_id: string): Option<string>`
  - 三个函数均改为：存在返回 `none`，不存在返回包含错误原因的 `some`。

- `test/modules/building/producing.test.ts`
  - `collect_item_product_exist_errors` / `collect_equip_product_exist_errors` / `collect_hero_product_exist_errors` 改为基于 `Option<string>` 过滤 `none` 并收集 `some`；
  - `collect_cost_errors` 中对消耗道具合法性的校验同样使用 `Option<string>` 收集错误信息。

## 效果
- 去除了存在性校验路径中的 `try/catch`；
- 错误收集逻辑更线性，且错误原因由断言层统一提供；
- 仍保持“收集错误列表 + 统一断言”的测试模式。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 8/8 测试通过。


