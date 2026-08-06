import {format_error} from "./log";

export const assert_no_errors = (title: string, errors: ReadonlyArray<string>): void => {
    if (errors.length > 0) {
        throw new Error(format_error(title, ...errors));
    }
};
