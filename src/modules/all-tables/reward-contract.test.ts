import {beforeAll, describe, it} from "vitest";
import {assert_no_errors} from "../../infra/assert";
import {collect_all_table_reward_contract_errors} from "../../infra/reward_contract";
import {cfg_mgr} from "../../infra/tb";

describe("全部配置表通用奖励契约", () => {
    beforeAll(() => {
        cfg_mgr.init_load_all_files();
    });

    it("should 所有生成 Reward 与 RateReward 都能被双端安全消费", () => {
        assert_no_errors(
            "全部配置表存在非法通用奖励：",
            collect_all_table_reward_contract_errors(cfg_mgr.tables),
        );
    });
});
