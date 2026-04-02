# 建筑配置校验规则表驱动改造

## 目标
在保留原有测试名称、断言语义与校验逻辑的前提下，将重复的 `it` 执行逻辑改为规则表驱动，提升维护效率。

## 设计
- 新增 `ValidationRuleName` 枚举，作为规则标识；
- 新增 `ValidationRule` 类型，统一约束：测试名、断言前缀、错误收集函数；
- 新增 `validation_rules` 规则表，集中配置 6 条规则；
- 在 `describe` 内通过 `validation_rules.forEach(...)` 统一执行并断言。

## 收益
- 新增规则时只需补充一条规则配置；
- 断言出口统一，降低遗漏风险；
- 测试文件结构更清晰，逻辑层次更稳定。

## 验证
已执行：
- `npx vitest run test/modules/building/producing.test.ts`

结果：
- 6/6 测试通过。

