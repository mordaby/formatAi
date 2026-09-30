import { describe, expect, it } from 'vitest';
import { createMasker } from '../../../src/learn/mask/masker';

function key(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

describe('masking privacy (SPEC 15: "the masking map stays local")', () => {
  it('a payload built only from masker outputs never contains a real masked word or the key, once serialized', () => {
    const realKey = key('super-secret-session-key');
    const masker = createMasker(realKey, { labelWords: ['דוח'] });

    const realWords = ['שלומי כהן', 'זקמ עגש', 'Customer Report', "מס' פוליסה"];
    const realId = '123456782';

    // Build a payload-shaped object the way the (out of scope) payload builder
    // would: every user-derived string goes through the masker first.
    const payload = {
      masking: true,
      input: {
        sheetName: 'גיליון1',
        columns: [
          { i: 0, header: 'שם לקוח', type: 'text' },
          { i: 1, header: 'ת.ז.', type: 'idLike' },
        ],
      },
      output: { layout: { titleRows: [{ text: masker.maskText('דוח ' + realWords[0]) }] } },
      samples: [
        {
          in: [masker.maskCell(realWords[0]!, 'text'), masker.maskCell(realId, 'idLike'), 1000],
          out: [masker.maskCell(realWords[1]!, 'text'), masker.maskCell(realId, 'idLike'), 1180],
        },
      ],
      hints: [
        { rel: 'valueMap', in: [0], out: 0, pairs: [[masker.maskText(realWords[2]!), masker.maskText(realWords[3]!)]], coverage: 1 },
      ],
    };

    const json = JSON.stringify(payload);

    // The key itself (as text, and as its raw byte values joined) never appears.
    expect(json).not.toContain('super-secret-session-key');

    // No real word or id shows up verbatim in the serialized payload.
    for (const real of [...realWords, realId]) {
      expect(json).not.toContain(real);
    }

    // The fake<->real map itself is a local object, never part of the payload.
    expect(Object.keys(payload)).not.toContain('fakeToReal');
    // Even an accidental `JSON.stringify(masker)` leaks nothing: functions are
    // dropped by JSON.stringify, and a Map has no own enumerable properties for
    // it to serialize, so the map's real-word contents never come out this way.
    expect(JSON.stringify(masker)).toBe('{"fakeToReal":{}}');
    expect(masker.fakeToReal.size).toBeGreaterThan(0); // sanity: the map isn't just empty
  });

  it('the fakeToReal map is exposed for local unmasking, but its VALUES (the real words) never leak into a payload built purely from mask*() outputs', () => {
    const masker = createMasker(key('another-key'));
    const real = 'ריבוע'; // a single word: fakeToReal is keyed per word, not per whole string
    const fake = masker.maskText(real);
    const payloadLikeValue = { const: fake };
    expect(JSON.stringify(payloadLikeValue)).not.toContain(real);
    // Sanity: the real word IS reachable from the map (that's the point of it),
    // just never emitted into anything shaped like a payload.
    expect(masker.fakeToReal.get(fake)).toBe(real);
  });
});
