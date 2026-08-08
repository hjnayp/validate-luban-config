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
npm run validate:export
```

`validate:export` 会从配置源 fresh 导出 schema/JSON，在隔离目录完成类型检查与全部规则测试；只有全部通过才提升 `gen/` 缓存。

## 常用命令

- `npm test`：执行全部校验测试（`vitest run`）
  - 使用最近一次成功提升的 `gen/schema.ts`、`gen/json/` 与 `gen/validation-manifest.json`
  - 缓存缺失或落后于配置源时会失败，正式导出结论以 `npm run validate:export` 为准
- `npm run test:watch`：监听模式运行测试
- `npm start`：执行 `tools/start_validate`
  - 直接执行 `npm run test`
  - 使用已有 `gen/schema.ts` 与 `gen/json/*.json`，不重新导出 JSON
- `npm run export:code`：执行 `tools/export_code`
  - 导出服务端 `go-json` 代码到 `config/导出工具/server_output_go`
  - 导出包含客户端、服务端与枚举组的 `typescript-json` schema 到 Cattie 的 `assets/scripts/datas/schema`
- `npm run validate:export`：执行 fresh 全表导出门禁
  - 捕获配置源哈希快照，并在隔离副本中以 `target=all` 导出
  - 校验源定义、生成 getter、全部 JSON、主键覆盖、生成引用、通用奖励和客户端/服务端业务契约
  - 失败不覆盖正式 `gen/`；成功时串行、整目录切换提升缓存

## start_validate 流程

`start_validate` 使用 `set -euo pipefail`，只执行规则校验，不再触发 Luban 全量 JSON 导出。

配置仓 `导出工具/Makefile` 的数据导出目标会先执行 `validate:export`，因此正式数据导出不会绕过 fresh 业务门禁。

`export_code` 使用 `set -euo pipefail`，先导出服务端 Go 代码，再导出包含客户端、服务端与枚举组的 TypeScript schema；任一阶段失败会立即停止。

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
- `src/infra/tb.ts`：fresh 门禁强制读取隔离 JSON；日常测试才按 `src/infra/json/`、`gen/json/` 回退

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
