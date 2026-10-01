// The formula grammar's tokenizer (learn-v5). Untrusted input (LLM output): a single
// forward-scanning pass over the input string, one character of lookahead at most (two
// for `<=`/`>=`/`<>`) - O(n) in the input length, no regular expressions built from the
// input and no backtracking, per the security review for this feature. The caller
// (`parseFormula.ts`) rejects anything over `limits.rules.maxFormulaChars` BEFORE this
// runs at all, so `tokenize` itself never needs its own length guard.
export type TokenType =
  | 'number'
  | 'string'
  | 'ident'
  | '('
  | ')'
  | ','
  | ':'
  | '+'
  | '-'
  | '*'
  | '/'
  | '='
  | '<>'
  | '<='
  | '>='
  | '<'
  | '>'
  | 'eof';

export interface Token {
  type: TokenType;
  /** The literal text (identifiers/numbers as written), or the decoded value for a
   * string token (escapes already resolved). */
  text: string;
  /** Character offset of the token's first character in the original formula text. */
  offset: number;
}

export class LexError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Tokenizes the whole formula up front. Throws `LexError` (never a regex-driven scan)
 * on the first unrecognized character, unterminated string, or invalid escape. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i] as string;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    const start = i;

    if (ch === '(') {
      tokens.push({ type: '(', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: ')', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: ',', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === ':') {
      // Only the named arguments of an across-row function (`by: account`) use it.
      tokens.push({ type: ':', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '+') {
      tokens.push({ type: '+', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '-') {
      tokens.push({ type: '-', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '*') {
      tokens.push({ type: '*', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '/') {
      tokens.push({ type: '/', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: '=', text: ch, offset: start });
      i++;
      continue;
    }
    if (ch === '<') {
      const next = text[i + 1];
      if (next === '=') {
        tokens.push({ type: '<=', text: '<=', offset: start });
        i += 2;
      } else if (next === '>') {
        tokens.push({ type: '<>', text: '<>', offset: start });
        i += 2;
      } else {
        tokens.push({ type: '<', text: '<', offset: start });
        i++;
      }
      continue;
    }
    if (ch === '>') {
      if (text[i + 1] === '=') {
        tokens.push({ type: '>=', text: '>=', offset: start });
        i += 2;
      } else {
        tokens.push({ type: '>', text: '>', offset: start });
        i++;
      }
      continue;
    }

    if (ch === '"') {
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = text[i] as string;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          const esc = text[i + 1];
          if (esc === '"' || esc === '\\') {
            out += esc;
            i += 2;
            continue;
          }
          throw new LexError(
            esc === undefined ? `unterminated string at ${start}` : `invalid escape "\\${esc}" at ${i}`,
            esc === undefined ? start : i,
          );
        }
        out += c;
        i++;
      }
      if (!closed) throw new LexError(`unterminated string at ${start}`, start);
      tokens.push({ type: 'string', text: out, offset: start });
      continue;
    }

    if (isDigit(ch)) {
      let j = i + 1;
      while (j < n && isDigit(text[j] as string)) j++;
      if (text[j] === '.' && isDigit(text[j + 1] ?? '')) {
        j++;
        while (j < n && isDigit(text[j] as string)) j++;
      }
      tokens.push({ type: 'number', text: text.slice(i, j), offset: start });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(text[j] as string)) j++;
      tokens.push({ type: 'ident', text: text.slice(i, j), offset: start });
      i = j;
      continue;
    }

    throw new LexError(`unexpected character "${ch}" at ${start}`, start);
  }

  tokens.push({ type: 'eof', text: '', offset: n });
  return tokens;
}
