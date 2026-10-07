// Engine audit (2026-10-07), fix 1: `shape` leaked the text of non-Latin scripts. `shapeOf` kept every character literally except ASCII
// letters, digits and Hebrew letters, `toPayloadColumn` sent it, and the payload never masked it: a Russian "Rep" column and an Arabic
// "Agent" column went to the AI whole (`"shape":"Иван Петров|Анна Козлова|..."`), an accented Latin name partly ("José" -> "AAAé").
import { describe, expect, it } from 'vitest';
import { isSafeShape, shapeOf } from '../../../src/learn/analyze';
import { createMasker } from '../../../src/learn/mask';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const RU = ['Иван Петров', 'Анна Козлова', 'Олег Смирнов', 'Иван Петров', 'Анна Козлова', 'Олег Смирнов'];
const AR = ['محمد علي', 'سارة حسن', 'خالد عمر', 'محمد علي', 'سارة حسن', 'خالد عمر'];
const ACCENTED = ['José', 'Zoë', 'Renée', 'José', 'Zoë', 'Renée'];

describe('shapeOf: script-agnostic', () => {
  it('every letter of every script is a shape letter, every digit a D', () => {
    expect(shapeOf('Иван Петров')).toBe('AAAA AAAAAA');
    expect(shapeOf('محمد علي')).toBe('AAAA AAA');
    expect(shapeOf('José')).toBe('AAAA');
    expect(shapeOf('José')).toBe('AAAA'); // a combining accent belongs to its letter
    expect(shapeOf('Ζωή-٣٤')).toBe('AAA-DD');
    expect(shapeOf('東京 12')).toBe('AA DD');
  });

  it('Hebrew letters stay H, ASCII stays as it was', () => {
    expect(shapeOf('ת.ז. 12-ab')).toBe('H.H. DD-AA');
    expect(shapeOf('AB-1234')).toBe('AA-DDDD');
  });

  it('isSafeShape: only shape letters, D and separators', () => {
    expect(isSafeShape('AAAA AAAAAA|HHH')).toBe(true);
    expect(isSafeShape('Иван Петров')).toBe(false);
    expect(isSafeShape('AAAé')).toBe(false);
    expect(isSafeShape('AA-DDDD')).toBe(true);
  });
});

describe('the payload: a masked column\'s shape never holds a real value', () => {
  const input: V[][] = [['Rep', 'Agent', 'Name', 'Amount']];
  const output: V[][] = [['Rep', 'Agent', 'Name', 'Amount']];
  for (let i = 0; i < 6; i++) {
    input.push([RU[i]!, AR[i]!, ACCENTED[i]!, 100 + i]);
    output.push([RU[i]!, AR[i]!, ACCENTED[i]!, 100 + i]);
  }
  const a = analyzeOk(xlsx(input), xlsx(output));
  const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(new TextEncoder().encode('shape')) });
  const columns = [...payload.input.columns, ...payload.output.columns];

  it('the columns carry a shape made of shape letters', () => {
    expect(payload.input.columns[0]!.shape).toBe('AAAA AAAAAA|AAAA AAAAAAA');
    expect(payload.input.columns[1]!.shape).toBe('AAAA AAA');
    expect(payload.input.columns[2]!.shape).toBe('AAA|AAAA|AAAAA');
    for (const c of columns) if (c.shape !== undefined) expect(isSafeShape(c.shape)).toBe(true);
  });

  it('no word of the columns anywhere in the payload', () => {
    const json = JSON.stringify(payload);
    for (const v of [...RU, ...AR, ...ACCENTED]) for (const w of v.split(' ')) expect(json).not.toContain(w);
    expect(json).not.toContain('é');
  });
});
