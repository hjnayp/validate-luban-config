import {describe, expect, it} from "vitest";
import {cfg_mgr, tb} from "../../src/tb";

describe("配置加载冒烟测试", () => {
    it("应当可以初始化并拿到 tables 实例", () => {
        // 主动执行一次初始化，确保测试进程里也能访问配置。
        cfg_mgr.init_load_all_files();
        expect(tb).toBeDefined();
    });
});

