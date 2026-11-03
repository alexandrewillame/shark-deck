/**
 * Extract just the comment text from a TypeScript/JavaScript source file.
 *
 * Hand-rolled as a single character-state pass, because both obvious
 * shortcuts give wrong answers on this codebase:
 *
 *  - **Stripping string literals with a regex** eats the backtick-quoted spans
 *    inside JSDoc, which is exactly where most provenance tags live
 *    (`` `provenance: verified-capture` ``).
 *  - **The TypeScript scanner** under-reports comment trivia here: on
 *    compx-mouse-8k.ts it returned 22 comments totalling 4.9 kB for a file
 *    that actually carries ~17.7 kB of them.
 *
 * Getting this right is the whole reason a provenance check can be trusted:
 * the i18n catalogues contain a message key called `hint.inferred`, so a naive
 * search over raw source reports a provenance tag in all eleven of them.
 */
export function commentsOf(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // Line comment: to end of line.
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      out.push(src.slice(i, end === -1 ? n : end));
      i = end === -1 ? n : end;
      continue;
    }

    // Block comment: to the closing delimiter.
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      out.push(src.slice(i, end === -1 ? n : end + 2));
      i = end === -1 ? n : end + 2;
      continue;
    }

    // String or template literal: skip it whole, so its contents can never be
    // mistaken for a comment.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        // A single/double-quoted string cannot span lines; bail at the newline
        // rather than swallowing the rest of the file on an odd quote (an
        // apostrophe in a comment, say).
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      continue;
    }

    i++;
  }

  return out.join('\n');
}
