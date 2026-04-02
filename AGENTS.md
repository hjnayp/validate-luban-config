# AGENTS

## 模块说明

### test/modules/building/producing.test.ts
- 负责建筑产出配置的规则校验，覆盖产品类型、生产 CD、消耗合法性、道具/装备/军团产物存在性四类约束。
- 测试数据来源于 `cfg_mgr.init_load_all_files()` 之后的全量配置缓存。
- 校验函数采用纯函数拆分，每条规则保留独立 `it`，在可读性与复用性间保持平衡。

### test/infra/option.ts
- 提供 `Option<string>` 到错误列表的纯函数转换工具，统一规则层对 `none/some` 的处理方式。

### tools/run_test
- 负责执行配置导出与测试串联流程；脚本启用 `set -euo pipefail`，确保任一阶段失败后立即停止。

## 任务经验
- 将重复的过滤/格式化逻辑抽到独立纯函数后，测试可读性和维护性显著提升。
- 对 `Map`/`Iterator` 统一使用 `Array.from(...)` 转换，可避免运行时对 Iterator Helper 的依赖。
- 规则型测试建议采用“收集错误列表 + 统一断言”模式，能一次性输出全部失败信息，定位更高效。
- 对会抛出断言异常的校验（如 `assert_item_exist`），建议在收集阶段捕获并转为错误字符串，避免一次失败中断整批扫描。
- 产物存在性校验应按 `RewardType` 分流到对应断言（`assert_item_exist`/`assert_equip_exist`/`assert_hero_exist`），避免混用同一张表导致误判。
- 当团队更重视可读性时，推荐“纯函数复用 + 单规则单 `it`”模式，降低阅读和定位门槛。
- 为了避免在错误收集函数中使用 `try/catch`，存在性断言可改为纯布尔函数，并由规则层统一拼装错误信息。
- 进一步可将存在性断言升级为 `Option<string>`：`none` 表示通过，`some` 承载错误原因，规则层统一过滤 `none` 后输出错误列表。
- `Option<string>` 的 `none/some` 过滤逻辑建议抽到 infra 公共函数，避免各规则重复实现分支判断。
- 脚本编排场景建议默认开启 `set -euo pipefail`，避免前置命令失败后误继续执行后续步骤。

