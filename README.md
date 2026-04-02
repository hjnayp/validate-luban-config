# validate (TypeScript init)

## 快速开始

```bash
npm install
npm run index
npm test
```

## 测试说明

- 使用 `vitest` 作为 TypeScript 测试框架。
- `npm test` 会先执行 `pretest`，即自动运行 `npm run index`。
- 单次执行测试：`npm test`
- 监听模式：`npm run test:watch`

## 说明

- `tsconfig.json` 已完成初始化并默认编译 `src/**/*.ts`。
- `gen/` 是自动生成目录，目前未纳入默认类型检查范围，避免初始化阶段被历史生成代码阻塞。
- 如需检查 `gen/`，可在修复生成类型问题后再调整 `include`/`exclude`。
