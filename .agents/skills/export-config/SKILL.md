---
name: export-config
description: "A skill to export game config excels to json for the project."
---

## Trigger rules

When the user says one of the following exact intents:
- `export_config`
- `cfg_exp`
- `cfg`

Then run the `config_export_client` shell command directly.

## Fuzzy intent rules

When the user says something that likely means running config export
(for example typo or similar phrase), ask for confirmation first.

Suggested confirmation:
`It seems that you want to run export-config. Do you want me to run config_export_client now?`

If user answers yes, run `config_export_client`.

If user answers no, do not run the shell.
Reply briefly and end the flow.

If user answer is unclear, ask once more with a short yes/no question.

## Execution report rules
Only show the final result after executing the command, do not show intermediate steps or raw command outputs.

After running `config_export_client`, always report:
- success or failure
- key output lines
- exit status
- log path if available

If command is not found, try local script path:
`.github/skills/export-config/scripts/config_export_client`

If both fail, report failure reason and ask whether to continue troubleshooting.
    
## example

User: export_config
Agent: Run `config_export_client`

User: exprt_config
Agent: It seems that you want to run export-config. Do you want me to run config_export_client now?

User: configuration
Agent: It seems that you want to run export-config. Do you want me to run config_export_client now?

User: no
Agent: Got it. I will not run export-config.

