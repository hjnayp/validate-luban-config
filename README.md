# validate

配置导出与规则校验项目，基于 TypeScript + Vitest。

> 本仓库作为 `web-pannel` 的子 Git 仓库使用，路径为 `web-pannel/validate`。

## 环境要求

- Node.js（建议 LTS）
- npm
- （运行 `npm start` 时需要）`.NET` 运行时，用于执行 `Luban.dll`

## 快速开始

```bash
npm install
npm test
```

当前仓库已包含 `gen/schema.ts` 与 `gen/json/`，可直接执行测试。

## 常用命令

- `npm test`：执行全部校验测试（`vitest run`）
- `npm run test:watch`：监听模式运行测试
- `npm start`：执行 `./start_validate`
  - 使用 Luban 导出 `gen` 与 `gen/json`
  - 导出成功后自动执行 `npm run test`

## start_validate 流程

`start_validate` 使用 `set -euo pipefail`，任一阶段失败会立即停止，避免“前置失败但后续继续执行”。

默认依赖路径：

- 工作区：`../../config`
- Luban：`../../config/导出工具/luban-bin/Luban.dll`
- 导出代码目录：`gen`
- 导出数据目录：`gen/json`

## 测试覆盖

测试覆盖说明已迁移到文档目录，请查看：[`doc/testing-coverage.md`](doc/testing-coverage.md)。

## 关键实现约定

- `src/infra/config_asserts.ts`：存在性校验返回 `Option<string>`（`none` 通过，`some` 为错误原因）
- `src/infra/option.ts`：`option_to_errors` 统一将 `Option<string>` 转为错误列表
- `src/infra/assert.ts`：使用“错误列表 + 一次性断言”输出完整失败信息
- `src/infra/tb.ts`：优先读取 `src/infra/json/*.json`，不存在时回退到 `gen/json/*.json`

## 目录结构

```text
src/
  infra/
    assert.ts
    config_asserts.ts
    option.ts
    tb.ts
  modules/
    tb.test.ts
    building/
      producing.test.ts
gen/
  schema.ts
  json/
start_validate
```
