# run_test 失败即停止策略

## 需求
当 `dotnet $LUBAN_DLL` 执行失败时，不应继续执行后续 `npm run test`。

## 实现
在 `tools/run_test` 中启用：
- `set -euo pipefail`

含义：
- `-e`：命令失败立即退出；
- `-u`：使用未定义变量时报错退出；
- `-o pipefail`：管道中任一命令失败即整体失败。

## 验证
已执行语法检查：
- `bash -n tools/run_test`

结果：
- 语法检查通过。

