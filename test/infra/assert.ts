import {expect} from "vitest";
import {format_error} from "./log";

export const assert_no_errors = (title: string, errors: ReadonlyArray<string>): void => {
    expect(errors, format_error(title, ...errors)).toEqual([]);
};

