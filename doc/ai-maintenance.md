# AI 维护手册（validate）

> 本文档给后续 AI 编程助手阅读。`validate` 是配置导出与规则校验子仓，维护重点是：规则清晰、错误可读、一次输出尽可能多的问题。

## 阅读顺序

1. 先读 `AGENTS.md`，确认仓库定位和约定。
2. 再读本文档，理解规则模式和新增范例。
3. 查现有覆盖时读 `doc/testing-coverage.md`。
4. 需要运行入口时读 `README.md` 和 `start_validate`。
5. 回主仓时读 `../docs/ai-maintenance.md`。

## 项目定位

`validate` 是 `web-pannel` 的配置校验子项目，技术栈是 TypeScript + Vitest。它有三种常用运行方式：

- `npm test`：直接读取已有 `gen/schema.ts` 和 `gen/json/*.json`，执行规则测试。
- `npm start`：运行 `start_validate`，直接执行 `npm run test`，不导出 JSON。
- `npm run export:code`：运行 `export_code`，分别导出服务端和客户端代码。

主仓工具箱的「校验配置」最终会通过 `panel-server` 调用本仓的 `npm start`。

本仓负责：

- 调用 Luban 导出服务端 Go 和客户端 TypeScript 代码。
- 加载配置表 JSON。
- 编写规则型测试。
- 输出策划能看懂的错误信息。

本仓不要负责：

- 前端页面展示。
- 访问 token、工作流、路径配置。
- Git/SVN/Cocos 操作。
- 修复配置数据本身。

## 目录地图

| 路径 | 说明 |
|---|---|
| `start_validate` | 规则测试串联脚本，不重新导出 JSON |
| `export_code` | 服务端、客户端 Luban 代码导出脚本 |
| `gen/schema.ts` | Luban 生成的 TS 类型和表访问器 |
| `gen/json/` | Luban 生成的配置 JSON |
| `src/infra/tb.ts` | 配置加载入口 |
| `src/infra/assert.ts` | 错误列表统一断言 |
| `src/infra/config_asserts.ts` | 跨规则复用的存在性和资源检查 |
| `src/infra/excel_source.ts` | 从源 xlsx 反查 `sheet/row/cell`，用于错误定位 |
| `src/infra/option.ts` | `Option<string>` 到错误列表转换 |
| `src/infra/log.ts` | 错误格式化 |
| `src/modules/tb.test.ts` | 配置加载冒烟测试 |
| `src/modules/model-resource.test.ts` | 模型 Spine 资源存在性 |
| `src/modules/building/producing.test.ts` | 建筑产出规则 |
| `src/modules/charge-shop/free-gift-limit.test.ts` | 充值商店免费商品规则 |
| `src/modules/all-tables/structure.test.ts` | 全部源表、schema、JSON、主键和生成引用结构审计 |
| `src/modules/all-tables/reward-contract.test.ts` | 全表通用 Reward / RateReward 契约 |
| `src/modules/client-runtime/` | 客户端真实消费链业务规则 |
| `src/modules/server-runtime/` | 服务端真实消费链业务规则 |
| `src/infra/snapshot_manifest.ts` | fresh 导出源文件哈希与 TOCTOU 校验 |
| `src/infra/table_audit.ts` | 表集合、JSON、构造、主键与引用通用审计 |
| `tools/validate_export_snapshot` | 隔离 fresh 导出、测试和缓存提升门禁 |
| `src/modules/daily-weekly-task/records.ts` | 日周任务三张表的记录类型、Excel 行索引与奖励公共规则 |
| `src/modules/daily-weekly-task/const.test.ts` | 日周任务常量表规则 |
| `src/modules/daily-weekly-task/task.test.ts` | 日周任务表规则 |
| `src/modules/daily-weekly-task/active-chest.test.ts` | 日周活跃宝箱表规则 |
| `src/modules/daily-weekly-task/taskv1-binding.test.ts` | 日周任务与 taskv1 的绑定规则 |
| `doc/testing-coverage.md` | 当前测试覆盖摘要 |

## 数据流

`npm start` 流程：

1. `start_validate` 使用 `set -euo pipefail`。
2. 执行 `npm run test`。
3. 使用仓库内已有的 `gen/schema.ts` 与 `gen/json/*.json`。

`npm run export:code` 流程：

1. `export_code` 使用 `set -euo pipefail`。
2. 调用 `config/导出工具/gen.py` 导出服务端 `go-json` 代码。
3. 调用同一脚本以 `all` 目标导出客户端、服务端与枚举组的 `typescript-json` schema。
4. 不导出 JSON 数据。

`npm test` 流程：

1. Vitest 启动。
2. 规则文件在 `beforeAll` 中调用 `cfg_mgr.init_load_all_files()`。
3. `tb.ts` 读取 `jsonCfg.Tables.getTableNames()`。
4. 对每张表读取 JSON。
5. 用 `new jsonCfg.Tables(load_file)` 初始化 `tb`。
6. 各规则收集错误列表。
7. `assert_no_errors(title, errors)` 一次性断言。

JSON 读取优先级：

- 优先 `src/infra/json/<table>.json`。
- 不存在时回退到 `process.cwd()/gen/json/<table>.json`。

这个优先级允许局部测试使用小样本 JSON，但正常仓库默认使用 `gen/json`。

## 当前规则需求

### 配置加载冒烟

文件：`src/modules/tb.test.ts`

需求：

- `cfg_mgr.init_load_all_files()` 能成功执行。
- `tb` 表实例可用。

### 建筑产出

文件：`src/modules/building/producing.test.ts`

当前规则：

1. 采集区产物类型必须是道具。
2. 生产区产物类型必须是道具或装备。
3. 募兵营产物类型必须是军团。
4. 所有产物生产 CD 必须大于 0。
5. 所有产物消耗必须存在且数量大于 0。
6. 道具类产物的 `product_id` 必须存在于道具表。
7. 装备类产物的 `product_id` 必须存在于装备表。
8. 军团类产物的 `product_id` 必须存在于军团表。
9. 装备类产物走 `TbBuildingProduceGroup` 展开检查 CD 和消耗。

错误来源会定位到源 Excel 行：

```text
excel=建筑生产@J-建筑.xlsx, sheet=建筑生产, row=7, cell=F7
excel=生产组@J-建筑.xlsx, sheet=生产组, row=6, cell=E6
```

### 充值商店

文件：`src/modules/charge-shop/free-gift-limit.test.ts`

当前规则：

- `TbChargeShop` 中免费商品（`buyType=Free`）不允许配置为无限购买，即 `limitCnt < 0` 必须报错；`0` 表示不可购买，不是无限购买。

错误来源会定位到源 Excel 行：

```text
excel=商品配置@C-充值商店.xlsx, sheet=商品配置, row=8, cell=I8
```

### 日周任务

文件：`src/modules/daily-weekly-task/`

三张表（`TbDailyWeeklyTaskConst`、`TbDailyWeeklyTask`、`TbDailyWeeklyActiveChest`）来自同一个 Excel，按 sheet 拆成三个规则文件，与 taskv1 的绑定规则单列一个文件。完整规则清单见 `doc/testing-coverage.md`，维护时注意：

- 服务端 `data/dailyweeklytask` 不再做任何配置规则校验，规则漏配等于线上无人拦截。
- `taskId`、`openSystemIds`、`systemOpenId` 的引用存在性由 Luban `#ref` 保证，不要在这里重复实现。
- `W5`、`W6` 的 taskv1 形态（事件、目标次数、条件取值）写死在玩法代码里，改这两条规则前要先确认玩法实现。

错误来源会定位到源 Excel 行：

```text
excel=任务@R-任务系统-每日每周.xlsx, sheet=任务, row=12, cell=D12, field=periodType
excel=任务详情@R-任务系统.xlsx, sheet=任务详情, row=1081, cell=G1081, field=inheritTaskId
```

### 模型资源

文件：`src/modules/model-resource.test.ts`

当前规则：

- `TbHeroModel` 中每个 `model` 指向的 Spine 资源必须存在。

资源根目录自动探测：

- `client/cattie/assets/resources`
- `client/cattie/assets/bundles`
- `../client/cattie/assets/resources`
- `../client/cattie/assets/bundles`
- `../../client/cattie/assets/resources`
- `../../client/cattie/assets/bundles`
- 从 `__dirname` 推导到上层的客户端资源目录

资源存在性支持：

- 直接文件路径。
- `{model}.json` 或 `{model}.skel`。
- `{model}.atlas` 或 `{model}.atlas.txt`。
- `{model}.png`。
- model 是目录时，允许目录内任意 json/skel + atlas/atlas.txt + png。
- model 是目录时，也允许目录名同名三件套。

错误来源会定位到源 Excel 行：

```text
excel=模型@M-模型配置.xlsx, sheet=模型, row=107, cell=D107
```

## 规则编写原则

核心模式：

- 先把表数据收集成小的 `Record` 类型。
- 每条规则写成 `collect_xxx_errors(records): ReadonlyArray<string>`。
- 不在 `it(...)` 里写复杂循环。
- 不在第一条错误时 throw。
- 用 `flatMap` 收集所有错误。
- 最后 `assert_no_errors("标题：", errors)`。

推荐结构：

```ts
type ExampleRecord = Readonly<{
    id: number;
    name: string;
    value: number;
}>;

const ERROR_SOURCE_EXCEL = "表名@文件.xlsx";

const format_error_with_source = (message: string): string =>
    `excel=${ERROR_SOURCE_EXCEL}, ${message}`;

const collect_example_records = (): ReadonlyArray<ExampleRecord> =>
    tb.TbExample.getDataList().map((cfg) => ({
        id: cfg.id,
        name: cfg.name,
        value: cfg.value,
    }));

const collect_value_errors = (
    records: ReadonlyArray<ExampleRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.value > 0
            ? []
            : [format_error_with_source(`id=${record.id}(${record.name}), value=${record.value}`)]
    );

describe("示例配置校验", () => {
    let records: ReadonlyArray<ExampleRecord>;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        records = collect_example_records();
    });

    it("should value 必须大于 0", () => {
        const errors = collect_value_errors(records);
        assert_no_errors("存在非法 value：", errors);
    });
});
```

## 错误格式规范

面向用户的错误尽量用这个格式：

```text
excel=来源表@文件.xlsx, sheet=Sheet名, row=123, cell=D123, field=字段名, id=123, name=名称, reason=具体原因
```

为什么要带 `excel=`：

- `panel-server` 会提取 `validate` 输出中的用户错误。
- 主仓工具箱会按 Excel 来源分组展示。
- 策划可以直接定位到表。

错误内容建议包含：

- Excel 来源。
- 源表定位：`sheet`、`row`、能定位字段的 `cell`、字段名 `field`。
- 领域 ID，例如 building、gift、hero_model_id。
- 可读名称，例如 `gift=1001(免费礼包)`。
- 当前非法值。
- 原因。

避免：

- 只写 “invalid config”。
- 输出堆栈或英文内部错误给策划。
- 一个断言只报第一条错误。
- 错误里只给数组 index，不给业务 ID。

## Excel 行定位

规则错误需要尽量通过 `src/infra/excel_source.ts` 反查源表行号：

- 普通一行一条配置：使用 `build_excel_row_index_by_key(...)`。
- Luban map 展开成多行：使用 `build_excel_row_index_by_composite_key(...)`，并用 `make_excel_row_key(parent, child)` 查找具体子行。
- 输出来源用 `format_excel_error_source(...)`，保持每条用户错误以 `excel=` 开头，方便主仓抽取和分组。
- `data_start_row` 应跳过 Luban 的 `##var`、`##type`、`##group`、说明行。
- 如果源 xlsx 暂时读不到，helper 会返回空索引；规则仍应继续输出业务 ID 和原因，不要因为定位失败吞掉校验错误。

## `Option<string>` 约定

`src/infra/config_asserts.ts` 中的存在性检查返回 `fp-ts/Option<string>`：

- `O.none` 表示通过。
- `O.some(reason)` 表示失败原因。

调用方用 `option_to_errors(...)` 转数组，再拼领域上下文。

范例：

```ts
const collect_item_errors = (records: ReadonlyArray<ExampleRecord>): ReadonlyArray<string> =>
    records.flatMap((record) =>
        option_to_errors(check_item_exist(String(record.item_id)))
            .map((reason) =>
                `excel=${ERROR_SOURCE_EXCEL}, id=${record.id}, item=${record.item_id}, reason=${reason}`
            )
    );
```

这个模式的好处是：公共检查不需要知道调用方在哪张表、哪个字段；业务上下文由规则文件补足。

## TypeScript 约定

- 当前项目是 CommonJS，测试文件正常使用 TypeScript import 语法，由 Vitest/tsx 处理。
- 对 `Map`、`Iterator`、schema 生成对象，优先 `Array.from(...)`，不要依赖运行时 Iterator Helper。
- 表对象来自 `gen/schema.ts`，字段命名跟配置生成结果保持一致，不要自行改名。
- 类型别名用 `Readonly<...>` 和 `ReadonlyArray<...>`，规则函数尽量无副作用。
- `beforeAll` 里初始化数据，`it` 里只调用收集函数和断言。

## 新增规则流程

1. 确认规则属于哪个配置域。
2. 如果已有同域文件，优先追加到现有文件。
3. 如果是新域，在 `src/modules/<domain>/xxx.test.ts` 新建文件。
4. 定义 Record 类型和收集函数。
5. 定义错误来源 `ERROR_SOURCE_EXCEL`。
6. 编写一个或多个 `collect_xxx_errors`。
7. 用 `assert_no_errors` 统一断言。
8. 运行 `npm test`。
9. 更新 `doc/testing-coverage.md`。
10. 如果规则影响主仓展示或 panel-server 提取，更新对应仓文档。

## 新增公共检查

当多个规则需要同一种存在性或资源检查时，放到 `src/infra/config_asserts.ts`。

范例：

```ts
export const check_skill_exist = (skill_id: string): O.Option<string> =>
    tb.TbSkill.get(skill_id)
        ? O.none
        : O.some(`非法的技能, skill_id=${skill_id}`);
```

公共检查只返回原因，不拼 `excel=`。调用方负责添加来源和领域上下文。

## 和主仓工具箱的衔接

调用链：

```text
web-pannel 工具箱
  -> panel-server /api/toolbox/validate-config
  -> scripts/validate_config.sh
  -> validate npm start
  -> start_validate
  -> npm run test
```

维护注意：

- `npm start` 失败时，panel-server 仍会返回 `status:"error"` 和 `output/user_errors`。
- 主仓优先展示 `user_errors`，不是完整命令日志。
- 规则错误带 `excel=` 时，主仓能更好分组。
- 如果修改测试输出格式，要检查 `panel-server` 的 `extract_validate_user_errors` 和主仓 `build_validate_output`。

## 开发范例

### 增加「表字段必须非空」

```ts
type NameRecord = Readonly<{
    id: number;
    name: string;
}>;

const ERROR_SOURCE_EXCEL = "示例@S-示例.xlsx";

const collect_name_empty_errors = (
    records: ReadonlyArray<NameRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.name.trim()
            ? []
            : [`excel=${ERROR_SOURCE_EXCEL}, id=${record.id}, reason=name 不能为空`]
    );
```

### 增加「引用 ID 必须存在」

```ts
const collect_reward_item_errors = (
    records: ReadonlyArray<RewardRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        option_to_errors(check_item_exist(record.item_id))
            .map((reason) =>
                `excel=${ERROR_SOURCE_EXCEL}, reward=${record.reward_id}, item=${record.item_id}, reason=${reason}`
            )
    );
```

### 增加「组合字段规则」

```ts
const collect_limit_errors = (
    records: ReadonlyArray<GiftRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) => {
        if (record.buy_type !== chargershop.GiftBuyType.Free) return [];
        if (record.limit_cnt > 0) return [];

        return [
            `excel=${ERROR_SOURCE_EXCEL}, gift=${record.gift_id}(${record.gift_name}), buyType=${record.buy_type}, limitCnt=${record.limit_cnt}, reason=免费商品不能无限购买`,
        ];
    });
```

## 测试与验收

常用命令：

```bash
npm install
npm test
npm run test:watch
npm start
```

选择命令：

- 只改规则代码：先 `npm test`。
- 改 Luban 导出参数或需要最新配置：跑 `npm start`。
- 改资源存在性规则：需要保证本机有 client 资源目录，否则错误可能来自资源根不存在。
- 改 `tb.ts`：至少跑完整 `npm test`，因为所有规则依赖它。

验收标准：

- 规则失败时一次输出所有命中的错误。
- 错误信息包含 Excel 来源和业务 ID。
- 通过时输出干净，没有额外 debug 噪声。
- `doc/testing-coverage.md` 反映新增规则。

## 常见坑

- `tb` 是模块级变量，必须先调用 `cfg_mgr.init_load_all_files()`。
- 不要在每个 `it` 里重复初始化全量配置，除非测试需要隔离。
- 不要依赖配置表数组顺序表达业务意义，除非 schema 明确如此。
- `gen/schema.ts` 是生成物，不要手改。
- `gen/json` 是运行输入，规则应兼容真实导出数据。
- `start_validate` 使用相对路径 `../../config`，从别的工作目录调用时要确认路径是否仍然成立。
- Spine 资源检查依赖本机客户端资源目录，CI 或新机器上可能需要先准备资源。

## 文档维护

- 新规则必须更新 `doc/testing-coverage.md`。
- 新公共检查或输出格式变化要更新本文档。
- 如果主仓工具箱展示逻辑需要配合，更新 `../docs/ai-maintenance.md`。
- 只写长期契约，不写某次临时排障过程。
