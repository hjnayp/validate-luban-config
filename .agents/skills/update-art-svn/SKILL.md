---
name: update-art-svn
description: "A skill to update and commit the art SVN repository for the project."
---

## Environment

- Workspace root: `client/cattie`
- Art SVN repo: `../../art` (relative to workspace root, i.e. `work-project-02/art`)
- SVN URL: `svn://192.168.200.231/cattie/trunk/art`
- Scripts:
  - Pull: `.github/skills/update-art-svn/scripts/update_art_svn`
  - Commit: `.github/skills/update-art-svn/scripts/commit_art_svn`
- Log output: `/tmp/{update|commit}_art_svn_<timestamp>.log`

## Trigger rules

### Pull (update)

When the user says one of the following exact intents:
- `update_art_svn`
- `update_art`
- `art_svn`
- `svn_update`

Then run `update_art_svn [子目录]` directly.

Optional parameter `[子目录]`:
- 不传参 → 更新整个 `art/` 目录
- `src` → 仅更新 `art/src/`（美术源文件）
- `dist` → 仅更新 `art/dist/`（输出产物，含 FGUI 工程）

#### Invocation methods

1. If `update_art_svn` is available in PATH:
   ```bash
   update_art_svn [子目录]
   ```
2. Otherwise run by script path:
   ```bash
   ./.github/skills/update-art-svn/scripts/update_art_svn [子目录]
   ```

### Commit

When the user says one of the following exact intents:
- `commit_art_svn`
- `commit_art`
- `art_commit`
- `svn_commit`

Then run `commit_art_svn <提交信息> [子目录]`.

Required parameter `<提交信息>`:
- 必须提供，描述本次提交的变更内容

Optional parameter `[子目录]`:
- 不传参 → 提交整个 `art/` 目录的变更
- `src` → 仅提交 `art/src/` 下的变更
- `dist` → 仅提交 `art/dist/` 下的变更

#### Invocation methods

1. If `commit_art_svn` is available in PATH:
   ```bash
   commit_art_svn "提交信息" [子目录]
   ```
2. Otherwise run by script path:
   ```bash
   ./.github/skills/update-art-svn/scripts/commit_art_svn "提交信息" [子目录]
   ```

#### Commit workflow

脚本会自动执行以下流程：
1. **收集变更** — `svn status` 分析工作副本状态
2. **展示摘要** — 分类展示已修改(M)、已添加(A)、已删除(D)、未版本控制(?)、缺失(!)文件
3. **冲突检查** — 存在冲突(C)文件时阻断提交，提示手动解决
4. **自动 stage** — 对未版本控制文件执行 `svn add`，对缺失文件执行 `svn delete`
5. **执行提交** — `svn commit -m "提交信息"`
6. **输出结果** — 展示提交版本号和变更统计

## Fuzzy intent rules

### Pull (update) fuzzy

When the user says something that likely means updating art SVN
(for example typo, similar phrase, or related Chinese terms), ask for confirmation first.

Typical fuzzy inputs:
- `更新美术` / `更新美术资源` / `拉美术`
- `update art` / `art update` / `pull art`
- `svn up art`
- `更新svn` (ambiguous — could mean config SVN, need clarification)

Suggested confirmation:
`看起来你想更新美术 SVN 仓库。是否立即执行 update_art_svn？`

### Commit fuzzy

When the user says something that likely means committing art SVN changes, ask for confirmation and collect missing parameters.

Typical fuzzy inputs:
- `提交美术` / `提交美术资源` / `推美术`
- `commit art` / `art commit` / `push art`
- `svn ci art`
- `提交svn` (ambiguous — could mean config SVN, need clarification)

Suggested confirmation flow:
1. If commit message is missing:
   `看起来你想提交美术 SVN 变更。请提供提交信息。`
2. If commit message is provided:
   `看起来你想提交美术 SVN 变更，提交信息为："<msg>"。是否立即执行？`

### General rules

If user answers yes → run the command.
If user answers no → do not run, reply briefly and end.
If user answer is unclear → ask once more with a short yes/no question.

## Execution safety rules

- If user specifies a subdirectory, validate it exists before running.
- If `svn` command is not found, output installation instructions for current platform.
- If art directory does not exist, report path and suggest checking project layout.

## Execution report rules

Only show the final result after executing the command, do not show intermediate steps or raw command outputs.

### Update report

After running `update_art_svn`, always report in one of these forms:

#### 1. Success

| Field    | Value                     |
|----------|---------------------------|
| Target   | `<更新目标路径>`            |
| Command  | `update_art_svn [子目录]`  |
| Result   | ✅ success                |
| Revision | r{old} → r{new}           |
| Changes  | 更新={n} 新增={n} 删除={n} |
| Log      | `<日志文件路径>`            |

#### 2. Failure

| Field     | Value                     |
|-----------|---------------------------|
| Target    | `<更新目标路径>`            |
| Command   | `update_art_svn [子目录]`  |
| Result    | ❌ failed                 |
| Error     | `<核心错误信息>`            |
| Next step | `<明确的恢复操作建议>`       |

### Commit report

After running `commit_art_svn`, always report in one of these forms:

#### 1. Success

| Field    | Value                           |
|----------|---------------------------------|
| Target   | `<提交目标路径>`                  |
| Command  | `commit_art_svn "msg" [子目录]`  |
| Result   | ✅ success                      |
| Revision | r{committed_rev}                |
| Message  | `<提交信息>`                     |
| Staged   | svn add={n} svn delete={n}      |
| Log      | `<日志文件路径>`                  |

#### 2. No changes

| Field  | Value            |
|--------|------------------|
| Target | `<提交目标路径>`   |
| Result | ⏭️ skipped       |
| Reason | 无变更，跳过提交   |

#### 3. Blocked by conflicts

| Field     | Value                          |
|-----------|--------------------------------|
| Target    | `<提交目标路径>`                 |
| Result    | ❌ blocked                     |
| Reason    | `{n} 个冲突文件`                |
| Files     | `<冲突文件列表>`                 |
| Next step | 手动解决冲突后重试                |

#### 4. Failure

| Field     | Value                           |
|-----------|---------------------------------|
| Target    | `<提交目标路径>`                  |
| Command   | `commit_art_svn "msg" [子目录]`  |
| Result    | ❌ failed                       |
| Error     | `<核心错误信息>`                  |
| Next step | `<明确的恢复操作建议>`             |

### Common failure causes

- **冲突 (conflict)**: 提示手动解决冲突
- **版本过旧 (out of date)**: 提示先执行 `update_art_svn`
- **认证失败**: 提示检查 SVN 凭据
- **网络不通**: 提示检查 VPN 或网络连接

### Command not found

If command is not found, try local script path:
`.github/skills/update-art-svn/scripts/update_art_svn`

If both fail, report failure reason and ask whether to continue troubleshooting.

## Examples

### Update examples

```
User: update_art_svn
Agent: [执行 update_art_svn，报告结果]

User: update_art_svn src
Agent: [执行 update_art_svn src，仅更新 art/src]

User: 更新美术资源
Agent: 看起来你想更新美术 SVN 仓库。是否立即执行 update_art_svn？

User: 拉一下art的svn
Agent: 看起来你想更新美术 SVN 仓库。是否立即执行 update_art_svn？

User: svn_update
Agent: [执行 update_art_svn，报告结果]
```

### Commit examples

```
User: commit_art_svn "修复角色立绘尺寸"
Agent: [执行 commit_art_svn "修复角色立绘尺寸"，报告结果]

User: commit_art_svn "更新 FGUI 工程" dist
Agent: [执行 commit_art_svn "更新 FGUI 工程" dist，仅提交 art/dist 下变更]

User: 提交美术资源
Agent: 看起来你想提交美术 SVN 变更。请提供提交信息。

User: 提交一下art, 备注是"新增角色spine动画"
Agent: 看起来你想提交美术 SVN 变更，提交信息为："新增角色spine动画"。是否立即执行？

User: svn_commit "调整 UI 资源"
Agent: [执行 commit_art_svn "调整 UI 资源"，报告结果]
```

## Cross-platform notes

| Platform | SVN 安装方式                           |
|----------|---------------------------------------|
| macOS    | `brew install subversion`             |
| Ubuntu   | `sudo apt install subversion`         |
| CentOS   | `sudo yum install subversion`         |
| Windows  | 安装 TortoiseSVN 并勾选 command line tools，或使用 WSL |

> ⚠️ 脚本使用 `bash`，Windows 用户需通过 Git Bash / WSL 执行。
