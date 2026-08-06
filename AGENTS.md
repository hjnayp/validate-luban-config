# AGENTS

> 面向 AI 编程助手的 validate 子仓上下文（由主仓 `web-pannel` 引用）。

## 项目定位

配置导出与规则校验子项目，技术栈为 TypeScript + Vitest。

## 实际目录与关键文件

- `src/modules/building/producing.test.ts`：建筑产出规则校验
- `src/modules/tb.test.ts`：配置表基础校验
- `src/infra/config_asserts.ts`：配置断言与存在性校验
- `src/infra/option.ts`：`Option<string>` 到错误列表转换
- `src/infra/tb.ts`：读取配置 JSON（优先 `src/infra/json`，回退 `gen/json`）
- `start_validate`：规则校验串联脚本（`set -euo pipefail`）
- `export_code`：Luban 服务端、客户端代码导出脚本

## 常用命令

- `npm test`：执行全部规则校验
- `npm run test:watch`：监听模式
- `npm start`：执行全部规则校验，不重新导出 JSON
- `npm run export:code`：导出服务端和客户端代码

## 约定

- 规则型测试优先“收集错误列表 + 统一断言”，确保一次输出完整失败信息。
- 对 `Map`/`Iterator` 结果统一 `Array.from(...)`，避免依赖 Iterator Helper 运行时特性。
- 公共过滤逻辑抽到 infra 层，避免在各规则文件重复实现。
- 详细规则写法、错误格式、开发范例和主仓工具箱衔接见 `doc/ai-maintenance.md`；当前规则覆盖见 `doc/testing-coverage.md`。
