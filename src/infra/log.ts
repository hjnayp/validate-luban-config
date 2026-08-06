export const format_error = (title: string, ...errors: ReadonlyArray<string>): string => [
    "",
    `============${title} count=${errors.length}`,
    ...errors,
    "============",
    "",
].join("\n");
