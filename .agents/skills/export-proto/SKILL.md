---
name: export-proto
description: "A skill to export proto definitions and regenerate project protobuf artifacts."
---

## Environment

- Workspace root: `client/cattie`
- Script path: `.github/skills/export-proto/scripts/proto_update`
- Recommended invocation:
  - If `proto_update` is available in PATH: `proto_update <branch_name>`
  - Otherwise run by absolute/relative script path:
    - `./.github/skills/export-proto/scripts/proto_update <branch_name>`

## Trigger rules

When the user says one of the following exact intents with parameter `${branch_name}`:
- `export_proto`
- `exp_proto`
- `proto`

Then run `proto_update ${branch_name}` (or fallback to script path execution).

If user omits `${branch_name}`:

1. Go to proto repo at `../../proto` (relative to `client/cattie`)
2. Get branches sorted by latest commit/update time
3. Show top 5 recently updated branches as suggestions
4. Ask user to choose one option or input a branch name directly
5. Execute export only after user confirms branch

## Fuzzy intent rules

If user input is close to proto export intent (typo/plural/abbreviation), confirm intent first:

- Typical fuzzy inputs:
  - `export_protos`
  - `export proto`
  - `proto export`
  - `exp proto`
- Response strategy:
  - Suggest the canonical command form: `export_proto <branch_name>`
  - If branch is missing, follow missing-parameter flow above
  - Do not run export automatically without branch confirmation

## Execution safety rules

- Never assume default branch silently; always confirm if branch is not explicit
- If command is not found, retry with script path
- Report concise key output:
  - selected branch
  - whether protobuf generation commands ran
  - final exit code / success or failure
- On failure, return actionable next step (e.g., missing dependency / script permission)


## Response Result

Only show the final result after executing the command, do not show intermediate steps or raw command outputs.

Use concise structured response in one of these forms:

1. Success
   - `Branch: <branch_name>`
   - `Command: <actual command>`
   - `Result: success`
   - `Key output: <1~3 important lines>`

2. Need user confirmation (missing branch)
   - `Result: pending`
   - `Reason: missing branch_name`
   - `Suggestions: <top 5 recent branches>`
   - `Question: which branch should be exported?`

3. Failure
   - `Branch: <branch_name>`
   - `Command: <actual command>`
   - `Result: failed`
   - `Error: <core error message>`
   - `Next step: <clear recovery action>`

## Example

User: export_proto master
Agent: Run `proto_update master`

User: export_proto
Agent: Which branch do you want to export? Recent branches: `${THE_LAST_5_UPDATED_BRANCH}`

User: export_protos
Agent: It seems that you want to run proto export. Please use `export_proto <branch_name>`. If you want, I can list recent branches for you.


