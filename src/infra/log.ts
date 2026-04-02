export const format_error = (title: string, ...errors: ReadonlyArray<string>): string => ["", `============${title}`, ...errors, "============", ""].join("\n");
