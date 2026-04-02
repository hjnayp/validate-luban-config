# 建筑配置校验重构说明

## 背景
`test/modules/building/producing.test.ts` 原实现中存在大量重复逻辑（工作区过滤、错误字符串拼接、装备与非装备分支展开），导致新增规则时改动面较大。

## 目标
- 保留原有 5 个测试用例与断言语义；
- 提升代码可读性与可维护性；
- 保持失败信息格式稳定，避免影响现有排错流程。

## 实现要点
- 提取 `collect_products`、`collect_type_errors`、`collect_cd_errors`、`collect_cost_errors` 四个纯函数；
- 抽离工作区集合与允许类型集合，避免硬编码条件链；
- 抽离错误格式化函数，统一错误输出模板；
- 将 `Iterator` 转数组统一改为 `Array.from(...)`，避免 `.toArray()` 兼容性问题。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 5/5 测试通过，行为与原断言保持一致。

