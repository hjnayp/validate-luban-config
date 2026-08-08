import {beforeAll, describe, expect, it} from "vitest";
import {story} from "../../../gen/schema";
import {assert_no_errors} from "../../infra/assert";
import {cfg_mgr, tb} from "../../infra/tb";

type MainTaskStageRecord = Readonly<{
    id: string;
    next_stage: string;
}>;

type MainTaskGuideReference = Readonly<{
    stage_id: string;
    task_id: number;
    jump: string;
    step_guide_id: number | undefined;
}>;

type StepGuideRecord = Readonly<{
    id: number;
    targets: ReadonlyArray<string>;
}>;

type ExactLookupRecord = Readonly<{
    table: string;
    id: string | number;
    field: string;
    exists: boolean;
    missing_reason: string;
}>;

type GuideFormulaSource = Readonly<{
    guide_id: number;
    field: string;
    expression: string;
}>;

type GuideGroupRecord = Readonly<{
    id: number;
    step_ids: ReadonlyArray<number>;
}>;

type StoryGuideRuntimeRecords = Readonly<{
    main_task_stages: ReadonlyArray<MainTaskStageRecord>;
    main_task_guide_references: ReadonlyArray<MainTaskGuideReference>;
    step_guides: ReadonlyArray<StepGuideRecord>;
    story_exact_lookups: ReadonlyArray<ExactLookupRecord>;
    guide_formula_sources: ReadonlyArray<GuideFormulaSource>;
    guide_groups: ReadonlyArray<GuideGroupRecord>;
}>;

const REQUIRED_STORY_CONFIG_IDS: ReadonlyArray<number> = [10001, 10002, 10003];
const REQUIRED_NEWBIE_STORY_FLOW_IDS: ReadonlyArray<number> = [1003, 1004, 1006];

const format_error = (
    table: string,
    id: string | number,
    field: string,
    reason: string,
): string => `table=${table}, id=${id}, field=${field}, reason=${reason}`;

const collect_main_task_graph_errors = (
    records: ReadonlyArray<MainTaskStageRecord>,
): ReadonlyArray<string> => {
    const errors: string[] = [];
    const stage_by_id = new Map(records.map((record) => [record.id, record]));

    records.forEach((record) => {
        if (record.next_stage !== "" && !stage_by_id.has(record.next_stage)) {
            errors.push(format_error(
                "TbMainTask",
                record.id,
                "nextStage",
                `nextStage=${record.next_stage} 在 TbMainTask 中不存在`,
            ));
        }
    });

    // nextStage 是单后继图。服务端沿后继持续遍历且没有 visited/步数保护，
    // 因此只需报告每个连通分量中首次发现的环，不要求单根或单终点。
    const completed_ids = new Set<string>();
    records.forEach((record) => {
        if (completed_ids.has(record.id)) return;

        const path: string[] = [];
        const path_index_by_id = new Map<string, number>();
        let current_id = record.id;
        while (current_id !== "") {
            const current = stage_by_id.get(current_id);
            if (current == null || completed_ids.has(current_id)) break;

            const cycle_start_index = path_index_by_id.get(current_id);
            if (cycle_start_index != null) {
                const cycle = [...path.slice(cycle_start_index), current_id];
                errors.push(format_error(
                    "TbMainTask",
                    current_id,
                    "nextStage",
                    `nextStage 形成环 ${cycle.join(" -> ")}，服务端遍历无法终止`,
                ));
                break;
            }

            path_index_by_id.set(current_id, path.length);
            path.push(current_id);
            current_id = current.next_stage;
        }

        path.forEach((id) => completed_ids.add(id));
    });

    return errors;
};

const collect_main_task_step_guide_errors = (
    references: ReadonlyArray<MainTaskGuideReference>,
    step_guides: ReadonlyArray<StepGuideRecord>,
): ReadonlyArray<string> => {
    const step_guide_by_id = new Map(step_guides.map((record) => [record.id, record]));

    return references.flatMap((reference) => {
        // TaskJumpGuideRuntime 优先执行 jump；只有 jump 为空时才进入 StepGuide fallback。
        if (reference.jump !== "") {
            return [];
        }

        const field = `task[taskId=${reference.task_id}].stepGuideId`;
        if (reference.step_guide_id == null || reference.step_guide_id <= 0) {
            return [format_error(
                "TbMainTask",
                reference.stage_id,
                field,
                `jump 为空且 stepGuideId=${String(reference.step_guide_id)} 不是正数，任务点击后无可执行动作`,
            )];
        }

        const step_guide = step_guide_by_id.get(reference.step_guide_id);
        if (step_guide == null) {
            return [format_error(
                "TbMainTask",
                reference.stage_id,
                field,
                `stepGuideId=${reference.step_guide_id} 在 TbStepGuide 中不存在，任务点击后无可执行动作`,
            )];
        }

        if (step_guide.targets.length === 0) {
            return [format_error(
                "TbStepGuide",
                step_guide.id,
                "targets",
                `被 TbMainTask(${reference.stage_id}).taskId=${reference.task_id} 引用，但 targets 为空`,
            )];
        }

        return step_guide.targets.flatMap((target, index) =>
            target.trim().length === 0
                ? [format_error(
                    "TbStepGuide",
                    step_guide.id,
                    `targets[${index}]`,
                    `被 TbMainTask(${reference.stage_id}).taskId=${reference.task_id} 引用，但目标步骤为空`,
                )]
                : []
        );
    });
};

const collect_exact_lookup_errors = (
    records: ReadonlyArray<ExactLookupRecord>,
): ReadonlyArray<string> =>
    records.flatMap((record) =>
        record.exists
            ? []
            : [format_error(record.table, record.id, record.field, record.missing_reason)]
    );

const collect_guide_formula_errors = (
    sources: ReadonlyArray<GuideFormulaSource>,
    groups: ReadonlyArray<GuideGroupRecord>,
): ReadonlyArray<string> => {
    const group_by_id = new Map(groups.map((group) => [group.id, new Set(group.step_ids)]));

    return sources.flatMap((source) => {
        const errors: string[] = [];

        Array.from(source.expression.matchAll(/\bisGuideGroup\s*\(\s*(\d+)\s*\)/gu))
            .forEach((match) => {
                const group_id = Number(match[1]);
                if (!group_by_id.has(group_id)) {
                    errors.push(format_error(
                        "TbGuide",
                        source.guide_id,
                        source.field,
                        `isGuideGroup(${group_id}) 引用的引导组在 TbGuide 中不存在`,
                    ));
                }
            });

        Array.from(source.expression.matchAll(/\bisGuideStep\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gu))
            .forEach((match) => {
                const group_id = Number(match[1]);
                const step_id = Number(match[2]);
                const step_ids = group_by_id.get(group_id);
                if (step_ids == null) {
                    errors.push(format_error(
                        "TbGuide",
                        source.guide_id,
                        source.field,
                        `isGuideStep(${group_id},${step_id}) 引用的引导组在 TbGuide 中不存在`,
                    ));
                }
                else if (!step_ids.has(step_id)) {
                    errors.push(format_error(
                        "TbGuide",
                        source.guide_id,
                        source.field,
                        `isGuideStep(${group_id},${step_id}) 引用的步骤在引导组 ${group_id} 中不存在`,
                    ));
                }
            });

        return errors;
    });
};

const collect_story_guide_runtime_errors = (
    records: StoryGuideRuntimeRecords,
): ReadonlyArray<string> => [
    ...collect_main_task_graph_errors(records.main_task_stages),
    ...collect_main_task_step_guide_errors(records.main_task_guide_references, records.step_guides),
    ...collect_exact_lookup_errors(records.story_exact_lookups),
    ...collect_guide_formula_errors(records.guide_formula_sources, records.guide_groups),
];

const collect_current_story_lookups = (): ReadonlyArray<ExactLookupRecord> => {
    const lookups: ExactLookupRecord[] = [];
    const format_reference_id = (id: number | undefined): string => id == null ? "<empty>" : String(id);
    const add_lookup = (
        table: string,
        id: string | number,
        field: string,
        target_table: string,
        target_id: number | undefined,
        exists: boolean,
    ): void => {
        lookups.push({
            table,
            id,
            field,
            exists,
            missing_reason: `${field}=${format_reference_id(target_id)} 在 ${target_table} 中不存在`,
        });
    };

    tb.TbMainStoryConfig.getDataList().forEach((config) => {
        config.stories.forEach((story_config, index) => {
            add_lookup(
                "TbMainStoryConfig",
                config.levelId,
                `stories[${index}].storyGroupId`,
                "TbMainStoryTalkConfig",
                story_config.storyGroupId,
                tb.TbMainStoryTalkConfig.get(story_config.storyGroupId) != null,
            );
        });
    });

    tb.TbSpecStoryConfig.getDataList().forEach((config) => {
        config.stories.forEach((story_config, index) => {
            add_lookup(
                "TbSpecStoryConfig",
                config.storyType,
                `stories[${index}].storyGroupId`,
                "TbMainStoryTalkConfig",
                story_config.storyGroupId,
                tb.TbMainStoryTalkConfig.get(story_config.storyGroupId) != null,
            );
        });
    });

    tb.TbStory.getDataList().forEach((config) => {
        config.config.forEach((node, node_index) => {
            Array.from(node.storyId.entries()).forEach(([story_slot, story_group_id]) => {
                add_lookup(
                    "TbStory",
                    config.id,
                    `config[${node_index}].storyId[${story_slot}]`,
                    "TbMainStoryTalkConfig",
                    story_group_id,
                    tb.TbMainStoryTalkConfig.get(story_group_id) != null,
                );
            });
        });
    });

    tb.TbStoryNarration2.getDataList().forEach((config) => {
        config.steps.forEach((step, index) => {
            if (step.type !== story.StoryNarration2StepType.MainTalk) return;

            add_lookup(
                "TbStoryNarration2",
                config.id,
                `steps[${index}].mainTalkId`,
                "TbMainStoryTalkConfig",
                step.mainTalkId,
                step.mainTalkId != null && tb.TbMainStoryTalkConfig.get(step.mainTalkId) != null,
            );
        });
    });

    tb.TbNewbieStoryFlow.getDataList().forEach((config) => {
        config.steps.forEach((step, index) => {
            switch (step.nodeType) {
                case story.NewbieStoryNodeType.MainTalk:
                    add_lookup(
                        "TbNewbieStoryFlow",
                        config.id,
                        `steps[${index}].mainTalkId`,
                        "TbMainStoryTalkConfig",
                        step.mainTalkId,
                        step.mainTalkId != null && tb.TbMainStoryTalkConfig.get(step.mainTalkId) != null,
                    );
                    break;
                case story.NewbieStoryNodeType.Narration1:
                    add_lookup(
                        "TbNewbieStoryFlow",
                        config.id,
                        `steps[${index}].narration1Id`,
                        "TbStoryNarration1",
                        step.narration1Id,
                        step.narration1Id != null && tb.TbStoryNarration1.get(step.narration1Id) != null,
                    );
                    break;
                case story.NewbieStoryNodeType.Narration2:
                    add_lookup(
                        "TbNewbieStoryFlow",
                        config.id,
                        `steps[${index}].narration2Id`,
                        "TbStoryNarration2",
                        step.narration2Id,
                        step.narration2Id != null && tb.TbStoryNarration2.get(step.narration2Id) != null,
                    );
                    break;
                case story.NewbieStoryNodeType.Guide:
                    add_lookup(
                        "TbNewbieStoryFlow",
                        config.id,
                        `steps[${index}].guideId`,
                        "TbNewbieStoryGuideGroup",
                        step.guideId,
                        step.guideId != null && tb.TbNewbieStoryGuideGroup.get(step.guideId) != null,
                    );
                    break;
            }
        });
    });

    // StorySystem 与 NewbieStoryService 会按这些枚举/流程常量直接精确读取。
    REQUIRED_STORY_CONFIG_IDS.forEach((id) => {
        lookups.push({
            table: "TbStoryConfig",
            id,
            field: "id",
            exists: tb.TbStoryConfig.get(id) != null,
            missing_reason: "StorySystem 通过 StoryIdEnum 精确读取该剧情 prefab 配置",
        });
    });
    REQUIRED_NEWBIE_STORY_FLOW_IDS.forEach((id) => {
        lookups.push({
            table: "TbNewbieStoryFlow",
            id,
            field: "id",
            exists: tb.TbNewbieStoryFlow.get(id) != null,
            missing_reason: "NewbieStoryService 通过流程常量精确读取该新手剧情流程",
        });
    });

    return lookups;
};

const collect_current_runtime_records = (): StoryGuideRuntimeRecords => {
    const main_task_stages: MainTaskStageRecord[] = [];
    const main_task_guide_references: MainTaskGuideReference[] = [];
    tb.TbMainTask.getDataList().forEach((stage) => {
        main_task_stages.push({id: stage.id, next_stage: stage.nextStage});
        stage.task.forEach((task_config) => {
            main_task_guide_references.push({
                stage_id: stage.id,
                task_id: task_config.taskId,
                jump: task_config.jump,
                step_guide_id: task_config.stepGuideId,
            });
        });
    });

    const step_guides: ReadonlyArray<StepGuideRecord> = tb.TbStepGuide.getDataList()
        .map((config) => ({id: config.id, targets: config.targets}));
    const guide_formula_sources: GuideFormulaSource[] = [];
    const guide_groups: GuideGroupRecord[] = [];
    tb.TbGuide.getDataList().forEach((config) => {
        guide_groups.push({id: config.id, step_ids: config.steps.map((step) => step.stepId)});
        guide_formula_sources.push(
            {guide_id: config.id, field: "target", expression: config.target},
            {guide_id: config.id, field: "startCondition", expression: config.startCondition},
        );
        config.steps.forEach((step) => {
            guide_formula_sources.push(
                {
                    guide_id: config.id,
                    field: `steps[stepId=${step.stepId}].stepStartCondition`,
                    expression: step.stepStartCondition,
                },
                {
                    guide_id: config.id,
                    field: `steps[stepId=${step.stepId}].stepTarget`,
                    expression: step.stepTarget,
                },
            );
        });
    });

    return {
        main_task_stages,
        main_task_guide_references,
        step_guides,
        story_exact_lookups: collect_current_story_lookups(),
        guide_formula_sources,
        guide_groups,
    };
};

const expect_structured_errors = (errors: ReadonlyArray<string>): void => {
    errors.forEach((message) => {
        expect(message).toMatch(/^table=.+, id=.+, field=.+, reason=.+$/u);
    });
};

describe("客户端主任务、剧情与引导图配置契约", () => {
    let current_records: StoryGuideRuntimeRecords;

    beforeAll(() => {
        cfg_mgr.init_load_all_files();
        current_records = collect_current_runtime_records();
    });

    it("should 合成主任务 nextStage 悬空、自环与多节点环均能被识别", () => {
        const errors = collect_main_task_graph_errors([
            {id: "TERMINAL", next_stage: ""},
            {id: "DANGLING", next_stage: "MISSING"},
            {id: "SELF", next_stage: "SELF"},
            {id: "A", next_stage: "B"},
            {id: "B", next_stage: "A"},
            {id: "TAIL", next_stage: "A"},
        ]);
        const report = errors.join("\n");

        expect(errors).toHaveLength(3);
        expect_structured_errors(errors);
        expect(report).toContain("nextStage=MISSING 在 TbMainTask 中不存在");
        expect(report).toContain("SELF -> SELF");
        expect(report).toContain("A -> B -> A");
    });

    it("should 合成无 jump 任务的 StepGuide 缺行、空 targets 与空步骤均能被识别", () => {
        const references: ReadonlyArray<MainTaskGuideReference> = [
            {stage_id: "S1", task_id: 1, jump: "", step_guide_id: 99},
            {stage_id: "S1", task_id: 2, jump: "", step_guide_id: 10},
            {stage_id: "S1", task_id: 3, jump: "", step_guide_id: 11},
            {stage_id: "S1", task_id: 4, jump: "$open_view", step_guide_id: 99},
            {stage_id: "S1", task_id: 5, jump: "", step_guide_id: 0},
            {stage_id: "S1", task_id: 6, jump: "", step_guide_id: 12},
            {stage_id: "S1", task_id: 7, jump: "", step_guide_id: -1},
            {stage_id: "S1", task_id: 8, jump: "", step_guide_id: undefined},
        ];
        const step_guides: ReadonlyArray<StepGuideRecord> = [
            {id: 10, targets: []},
            {id: 11, targets: ["Main/MainView/button", " "]},
            {id: 12, targets: ["Main/MainView/button"]},
        ];

        const errors = collect_main_task_step_guide_errors(references, step_guides);
        const report = errors.join("\n");

        expect(errors).toHaveLength(6);
        expect_structured_errors(errors);
        expect(report).toContain("stepGuideId=99 在 TbStepGuide 中不存在");
        expect(report).toContain("table=TbStepGuide, id=10, field=targets");
        expect(report).toContain("table=TbStepGuide, id=11, field=targets[1]");
        expect(report).toContain("stepGuideId=0 不是正数");
        expect(report).toContain("stepGuideId=-1 不是正数");
        expect(report).toContain("stepGuideId=undefined 不是正数");
    });

    it("should 合成每类剧情节点及运行时 Story Flow 锚点的精确引用错误均能被识别", () => {
        const invalid_lookups: ReadonlyArray<ExactLookupRecord> = [
            {
                table: "TbMainStoryConfig",
                id: 1001,
                field: "stories[0].storyGroupId",
                exists: false,
                missing_reason: "主线剧情对话组不存在",
            },
            {
                table: "TbSpecStoryConfig",
                id: "battle_win",
                field: "stories[0].storyGroupId",
                exists: false,
                missing_reason: "特殊剧情对话组不存在",
            },
            {
                table: "TbStory",
                id: 1,
                field: "config[0].storyId[0]",
                exists: false,
                missing_reason: "剧情链对话组不存在",
            },
            {
                table: "TbStoryNarration2",
                id: 2,
                field: "steps[0].mainTalkId",
                exists: false,
                missing_reason: "全屏旁白 MainTalk 对话组不存在",
            },
            {
                table: "TbNewbieStoryFlow",
                id: 3,
                field: "steps[0].mainTalkId",
                exists: false,
                missing_reason: "MainTalk 节点引用不存在",
            },
            {
                table: "TbNewbieStoryFlow",
                id: 3,
                field: "steps[1].narration1Id",
                exists: false,
                missing_reason: "Narration1 节点引用不存在",
            },
            {
                table: "TbNewbieStoryFlow",
                id: 3,
                field: "steps[2].narration2Id",
                exists: false,
                missing_reason: "Narration2 节点引用不存在",
            },
            {
                table: "TbNewbieStoryFlow",
                id: 3,
                field: "steps[3].guideId",
                exists: false,
                missing_reason: "Guide 节点引用不存在",
            },
            {
                table: "TbStoryConfig",
                id: 10001,
                field: "id",
                exists: false,
                missing_reason: "StoryIdEnum 锚点不存在",
            },
            {
                table: "TbNewbieStoryFlow",
                id: 1003,
                field: "id",
                exists: false,
                missing_reason: "新手剧情流程锚点不存在",
            },
            {
                table: "TbMainStoryTalkConfig",
                id: 100,
                field: "id",
                exists: true,
                missing_reason: "有效引用不应报错",
            },
        ];

        const errors = collect_exact_lookup_errors(invalid_lookups);
        const report = errors.join("\n");

        expect(errors).toHaveLength(10);
        expect_structured_errors(errors);
        expect(report).toContain("table=TbMainStoryConfig");
        expect(report).toContain("table=TbSpecStoryConfig");
        expect(report).toContain("table=TbStory, id=1");
        expect(report).toContain("table=TbStoryNarration2");
        expect(report).toContain("field=steps[0].mainTalkId");
        expect(report).toContain("field=steps[1].narration1Id");
        expect(report).toContain("field=steps[2].narration2Id");
        expect(report).toContain("field=steps[3].guideId");
        expect(report).toContain("table=TbStoryConfig, id=10001");
        expect(report).toContain("table=TbNewbieStoryFlow, id=1003, field=id");
    });

    it("should 合成 Guide 条件中的缺失引导组与步骤引用均能被识别", () => {
        const errors = collect_guide_formula_errors([
            {
                guide_id: 2,
                field: "startCondition",
                expression: [
                    "isGuideGroup(999)",
                    "isGuideStep(1, 999)",
                    "isGuideStep(998, 1)",
                    "isGuideGroup(1)",
                    "isGuideStep(1, 101)",
                ].join("&&"),
            },
        ], [
            {id: 1, step_ids: [101]},
            {id: 2, step_ids: [201]},
        ]);
        const report = errors.join("\n");

        expect(errors).toHaveLength(3);
        expect_structured_errors(errors);
        expect(report).toContain("isGuideGroup(999) 引用的引导组");
        expect(report).toContain("isGuideStep(1,999) 引用的步骤");
        expect(report).toContain("isGuideStep(998,1) 引用的引导组");
    });

    it("should 当前配置满足客户端主任务、剧情与引导图的真实运行时契约", () => {
        assert_no_errors(
            "存在客户端主任务、剧情或引导图配置契约错误：",
            collect_story_guide_runtime_errors(current_records),
        );
    });
});
