# 建筑配置校验优化：抽离 Option 错误转换工具

## 目标
将 `producing.test.ts` 中重复出现的 `Option<string>` 到 `string[]` 转换逻辑抽离到公共 infra，减少样板代码并统一处理策略。

## 改动
- 新增 `test/infra/option.ts`：
  - `option_to_errors(error_option: Option<string>): ReadonlyArray<string>`
  - 语义：`none -> []`，`some(error) -> [error]`
- `test/modules/building/producing.test.ts`：
  - 删除本地 `option_to_errors`；
  - 改为导入 `../../infra/option` 中的同名函数。

## 收益
- 规则文件聚焦业务校验本身；
- `Option` 处理行为统一，后续复用成本更低；
- 避免多个测试模块重复维护相同辅助函数。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 8/8 测试通过。

