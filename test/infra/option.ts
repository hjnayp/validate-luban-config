import * as O from "fp-ts/Option";

export const option_to_errors = (error_option: O.Option<string>): ReadonlyArray<string> =>
    O.isNone(error_option) ? [] : [error_option.value];

