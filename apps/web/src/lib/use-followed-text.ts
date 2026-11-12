import * as React from 'react';

/** A JSON value as indented text; nothing as an empty field. */
export const jsonText = (value: unknown): string =>
  value === undefined ? '' : JSON.stringify(value, null, 2);

/**
 * Text that edits a value: it follows the value when it changes from outside, but never overwrites what is being
 * typed. Call `markWritten` with every value the field itself writes, so that echo is not taken for an outside change.
 * `toText` must be a stable function.
 */
export function useFollowedText(value: unknown, toText: (value: unknown) => string) {
  const [text, setText] = React.useState(toText(value));
  const written = React.useRef<unknown>(value);
  React.useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(written.current)) {
      setText(toText(value));
      written.current = value;
    }
  }, [value, toText]);
  const markWritten = React.useCallback((v: unknown) => {
    written.current = v;
  }, []);
  return { text, setText, markWritten };
}
