# 测试覆盖

## 覆盖口径

- 配置源当前定义的全部 **212 张表**都会经过 fresh 快照、schema/JSON 集合对齐、解析构造、list/map 主键覆盖和生成引用校验。
- 所有生成的 `base.Reward` / `base.RateReward` 都会经过类型、数量和目标表引用校验。
- 下列客户端/服务端专项只实现当前运行时代码能够唯一证明的契约；不推断概率产品口径、未来未引用配置、活动期限覆盖或档位连续性。
- 因此“212/212”表示全表结构审计，不表示每张表的所有未来产品语义都已穷尽。

## fresh 导出与全表通用校验

- `tools/validate_export_snapshot`：源文件哈希、隔离导出、类型检查/测试、失败不提升、成功切换缓存。
- `src/modules/all-tables/structure.test.ts`：defines、生成 getter、JSON 集合、构造/resolve、主键覆盖和 `_ref` 完整性。
- `src/modules/all-tables/reward-contract.test.ts`：递归遍历所有表中的通用奖励对象。

正式入口是 `npm run validate:export`；`npm test` / `npm start` 只复用最近一次成功提升的缓存。

## 客户端运行时契约

- `client-runtime/activity-task.test.ts`：活动任务到 taskv1、首子任务和活动内 rowId 唯一性。
- `client-runtime/awaken-growth.test.ts`：觉醒装备/天赋等级、装备技能与英雄战斗技能引用。
- `client-runtime/condition-graph.test.ts`：建筑条件、实际可达条件组、迷雾与系统开放图。
- `client-runtime/draw-economy.test.ts`：抽卡固定页签、扣费、可达池和随机算法机械安全。
- `client-runtime/feature-economy.test.ts`：FeaturePreview、Jump、SystemOpen、ChargeShop 与建筑生产次数。
- `client-runtime/progression-contract.test.ts`：英雄成长覆盖、主线战斗组/怪物与技能链。
- `client-runtime/story-guide-graph.test.ts`：主任务 nextStage、StepGuide、剧情/旁白/新手流程引用。

## 服务端运行时契约

- `server-runtime/activity-battle.test.ts`：活动窗口、战斗阵型/怪物、怪物掉落机械安全。
- `server-runtime/activity-reward-threshold.test.ts`：活动充值档位、路由与奖励引用。
- `server-runtime/businessship-awaken-building.test.ts`：商船随机、觉醒任务结构、建筑品质随机；当前下线的觉醒任务允许空占位奖励。
- `server-runtime/drop-shop-item.test.ts`：掉落权重、普通商店池和多态道具参数。
- `server-runtime/exchange-shop.test.ts`：兑换商店成本、商品池和限购语义。
- `server-runtime/progression-reference.test.ts`：主线、章节、限时征讨和爬塔引用。
- `server-runtime/purchase-product.test.ts`：充值商品、换价与月卡核心 ID。
- `server-runtime/rank-reward.test.ts`：排行榜端点、重叠、奖励组和邮件引用。
- `server-runtime/taskgroup-condition.test.ts`：TaskGroup 与被引用 ConditionUnit 的服务端语义。

## 建筑产出规则校验

文件：`src/modules/building/producing.test.ts`

启动前会先执行 `cfg_mgr.init_load_all_files()` 加载全量配置，随后按规则收集错误并统一断言。当前包含 8 条规则：

1. 采集区产物类型必须是道具
2. 生产区产物类型必须是道具/装备
3. 募兵营产物类型必须是军团
4. 所有产物生产 CD 必须大于 0
5. 所有产物消耗必须存在且数量大于 0
6. 道具类产物的 `product_id` 必须存在于道具表
7. 装备类产物的 `product_id` 必须存在于装备表
8. 军团类产物的 `product_id` 必须存在于军团表

## 充值商店规则校验

文件：`src/modules/charge-shop/free-gift-limit.test.ts`

当前包含 1 条规则：

1. `TbChargeShop` 中免费商品（`buyType=Free`）不允许配置为无限购买（`limitCnt < 0`；`0` 表示不可购买）

## 模型资源规则校验

文件：`src/modules/model-resource.test.ts`

当前包含 1 条规则：

1. `TbHeroModel` 中每个 `model` 指向的 Spine 资源必须存在

## 喵王觉醒规则校验

文件：`src/modules/awaken/equipment-first-weapon.test.ts`

1. `TbAwakenEquipment` 中每个武器类型（`part=Weapon`）最多配置一把 `is_first_weapn=true` 的解锁赠送武器
   （服务端允许某类型不赠送武器；重复标记会让查找结果依赖遍历顺序）

文件：`src/modules/awaken/collection-reward.test.ts`

1. `TbAwakenCollectionReward` 的档位 `id`（收集星数门槛）必须是正整数且配置了奖励
2. 档位门槛不得超过全部武器皮肤与喵王皮肤星级上限之和，否则该档位永远无法领取

## 日周任务规则校验

公共记录类型、Excel 行索引与奖励规则在 `src/modules/daily-weekly-task/records.ts`，三张表的规则按表拆分。

文件：`src/modules/daily-weekly-task/const.test.ts`

1. `TbDailyWeeklyTaskConst` 的 `id` 必须大于 0
2. `systemOpenId` 不能为空

文件：`src/modules/daily-weekly-task/task.test.ts`

1. 任务表不能为空
2. `code` 必须是 `D` 或 `W` 加正整数
3. `code` 前缀必须与 `periodType` 一致（`D`→daily、`W`→weekly）
4. `W8` 是预留占位编号，不允许配置
5. `D15` 必须配置
6. `taskId` 必须大于 0 且全表唯一
7. `activeScore` 与 `sort` 必须大于 0
8. `openMode` 必须是合法的关联玩法开放策略
9. `openSystemIds` 元素不能为空且不能重复
10. 奖励必须非空，且道具 ID 非空、类型合法、数量大于 0、同条配置内不重复

文件：`src/modules/daily-weekly-task/active-chest.test.ts`

1. 活跃宝箱表不能为空
2. `periodType` 必须合法，`chestId`、`threshold`、`sort` 必须大于 0
3. 同周期内 `threshold` 必须按服务端实际的 `sort`、`chestId` 排序严格递增
4. 奖励规则同任务表

文件：`src/modules/daily-weekly-task/taskv1-binding.test.ts`

1. 每条日周任务在 `TbTaskv1` 中的 `taskSource` 必须是 `dailyweeklytask`，且至少一条子任务
2. 子任务 `subTaskId` 必须大于 0 且同任务内唯一
3. 子任务 `eventType` 必须合法、`taskType` 只能是 0-2、`targetCount` 必须大于 0
4. 子任务禁止配置 `inheritTaskId`，避免玩法中途开放时补算历史进度
5. 子任务条件的 `conditionKey` 与 `operateType` 必须合法
6. `W5`、`W6` 的 taskv1 形态写死在玩法里：只允许一条子任务、一个条件，且事件、目标次数、条件取值必须完全一致

> `taskId`、`openSystemIds`、`systemOpenId` 的引用存在性由 Luban `#ref` 在导出阶段保证，这里不重复校验。

## 错误定位

规则错误会尽量输出源 Excel 定位信息：

```text
excel=来源表@文件.xlsx, sheet=Sheet名, row=行号, cell=单元格, field=字段名
```

## 配置加载冒烟测试

文件：`src/modules/tb.test.ts`

验证配置初始化与 `tb` 表实例可用性。
