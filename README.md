# validate

配置导出与规则校验项目，基于 TypeScript + Vitest。

> 本仓库作为 `web-pannel` 的子 Git 仓库使用，路径为 `web-pannel/validate`。

## 主仓文档导航

- 主仓文档导航页（GitHub）：<https://github.com/hjnayp/web-pannel/blob/master/docs/documentation-map.md>
- 在主仓工作区中可直接打开：`../docs/documentation-map.md`
- 本仓 AI 维护手册：[`doc/ai-maintenance.md`](doc/ai-maintenance.md)

## 环境要求

- Node.js（建议 LTS）
- npm
- （运行 `npm run export:code` 时需要）Python 3 与 `.NET` 8 运行时，用于执行 `Luban.dll`

## 快速开始

```bash
npm install
npm test
```

当前仓库已包含 `gen/schema.ts` 与 `gen/json/`，可直接执行测试。

## 常用命令

- `npm test`：执行全部校验测试（`vitest run`）
- `npm run test:watch`：监听模式运行测试
- `npm start`：执行 `tools/start_validate`
  - 直接执行 `npm run test`
  - 使用已有 `gen/schema.ts` 与 `gen/json/*.json`，不重新导出 JSON
- `npm run export:code`：执行 `tools/export_code`
  - 导出服务端 `go-json` 代码到 `config/导出工具/server_output_go`
  - 导出客户端 `typescript-json` 代码到 Cattie 的 `assets/scripts/datas/schema`

## start_validate 流程

`start_validate` 使用 `set -euo pipefail`，只执行规则校验，不再触发 Luban 全量 JSON 导出。

`export_code` 使用 `set -euo pipefail`，先导出服务端代码，再导出客户端代码；任一阶段失败会立即停止。

`export_code` 默认依赖路径：

- 工作区：`../../config`
- Luban：`../../config/导出工具/luban-bin/Luban.dll`
- 服务端代码目录：`../../config/导出工具/server_output_go`
- 客户端代码目录：`../../client/cattie/assets/scripts/datas/schema`

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
