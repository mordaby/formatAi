// Engine audit (2026-10-07), fix 4: two values could share one fake, and the unmasking mapped every token. The masker's `pickCandidate`
// took its last candidate even when it was another value's fake, and `unmaskString` restored every word it found in the fake -> real map.
// The probe: "Floor 1" .. "Floor 9" gave two digits the same fake, and the AI's own constant "1" came back as "9".
import { describe, expect, it } from 'vitest';
import { createMasker, unmaskRules } from '../../../src/learn/mask';
import { wordsOfShape } from '../../../src/learn/mask/words';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);
const FLOORS = Array.from({ length: 9 }, (_, i) => `Floor ${i + 1}`);

describe('no two real values share a fake', () => {
  it('"Floor 1" .. "Floor 9": nine digits, nine different fakes - for every key', () => {
    for (let k = 0; k < 40; k++) {
      const m = createMasker(key(`floors-${k}`));
      const fakes = FLOORS.map((f) => m.maskText(f));
      expect(new Set(fakes).size).toBe(9);
      const digits = fakes.map((f) => f.split(' ')[1]);
      expect(new Set(digits).size).toBe(9);
      for (const d of digits) expect(d).toMatch(/^[1-9]$/);
    }
  });

  it('more one-letter words than the fake alphabet holds (every Hebrew letter, final forms too): still all different', () => {
    const letters = Array.from('אבגדהוזחטיכךלמםנןסעפףצץקרשת');
    const m = createMasker(key('letters'));
    const fakes = letters.map((l) => m.maskText(l));
    expect(new Set(fakes).size).toBe(letters.length);
  });

  it('a hundred one-character words of a script with no alphabet of its own (CJK -> Latin letters): all different', () => {
    const chars = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const m = createMasker(key('cjk'));
    const fakes = chars.map((c) => m.maskText(c));
    expect(new Set(fakes).size).toBe(100);
  });

  it('wordsOfShape: every word of the shape once, then wider ones', () => {
    const seen = new Set<string>();
    let n = 0;
    for (const w of wordsOfShape(['7'], new Uint8Array([3]))) {
      if (n++ >= 110) break;
      expect(seen.has(w)).toBe(false);
      seen.add(w);
    }
    expect([...seen].filter((w) => w.length === 1)).toHaveLength(10);
    expect([...seen].filter((w) => w.length === 2)).toHaveLength(100);
  });
});

describe('unmasking: whole values and the masker\'s own fakes, never the AI\'s short numbers', () => {
  const m = createMasker(key('unmask'));
  const fakes = FLOORS.map((f) => m.maskText(f));
  const fakeWord = fakes[0]!.split(' ')[0]!;

  it('the AI\'s own "1" stays "1", whatever real digit "1" is the fake of', () => {
    expect(m.fakeToReal.has('1')).toBe(true); // (every digit is a fake here)
    const rules = { transform: { computed: [{ id: 'c', type: 'text', expr: { op: 'concat', args: [{ col: 'a' }, { const: '1' }] } }] } };
    expect(unmaskRules(rules, m)).toEqual(rules);
  });

  it('a whole masked value comes back whole', () => {
    for (let i = 0; i < 9; i++) expect(unmaskRules({ value: fakes[i] }, m)).toEqual({ value: FLOORS[i] });
  });

  it('a fake word inside the AI\'s own text comes back; a short number beside it is the AI\'s', () => {
    expect(unmaskRules({ value: `${fakeWord} 12` }, m)).toEqual({ value: 'Floor 12' });
    expect(unmaskRules({ value: `${fakeWord}:` }, m)).toEqual({ value: 'Floor:' });
  });

  it('a long fake number and a run with leading zeros are the masker\'s: restored', () => {
    const phone = m.maskIdLike('050-1234567');
    const [prefix, rest] = phone.split('-') as [string, string];
    expect(prefix.startsWith('0')).toBe(true);
    expect(unmaskRules({ text: prefix }, m)).toEqual({ text: '050' });
    expect(unmaskRules({ text: rest }, m)).toEqual({ text: '1234567' });
    expect(unmaskRules({ text: phone }, m)).toEqual({ text: '050-1234567' });
  });
});
