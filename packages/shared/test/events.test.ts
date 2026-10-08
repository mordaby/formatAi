import { describe, expect, it } from 'vitest';
import {
  CLIENT_EVENT_TYPES,
  EVENT_PROPS,
  fileTypeOfName,
  limits,
  LIMIT_CODES,
  pageNameOf,
  parseClientEvents,
  parseEvent,
  SERVER_EVENT_TYPES,
  WAITLIST_TRIGGERS,
  type EventType,
} from '../src/index';

/** One valid props object per event type: what a well-behaved caller sends. */
const VALID: Record<EventType, Record<string, unknown>> = {
  format_saved: { kind: 'new' },
  format_run: { daysSinceCreated: 9, rows: 120, flagged: 3 },
  limit_hit: { limit: 'savedFormats' },
  feedback_given: { replyRequested: true },
  lead_submitted: { kind: 'contact' },
  upgrade_intent: { trigger: 'aiLearns' },
  page_view: { page: 'home' },
  file_rejected: { reason: 'type' },
  file_uploaded: { role: 'input', fileType: 'xlsx', rows: 40, cols: 6 },
  learn_completed: { path: 'local', status: 'verified', masking: true, aiClicked: false },
  known_format: { kind: 'same', answer: 'convert' },
  signin_wall_shown: { trigger: 'save' },
  file_matched: { result: 'auto', score: 0.93 },
  formats_chosen: { offered: 3, chosen: 2, all: false, batch: false },
  download: { kind: 'single' },
  batch_run: { files: 5, converted: 3, needsAttention: 1, noMatch: 1, notChosen: 0 },
};

/** For each type, props that must be refused: an out-of-list string, an out-of-range number or a wrong kind of value. */
const INVALID: [EventType, Record<string, unknown>][] = [
  ['format_saved', { kind: 'import' }],
  ['format_run', { daysSinceCreated: -1, rows: 1, flagged: 0 }],
  ['format_run', { daysSinceCreated: limits.events.maxDaysSinceCreated + 1, rows: 1, flagged: 0 }],
  ['format_run', { daysSinceCreated: 1.5, rows: 1, flagged: 0 }],
  ['format_run', { daysSinceCreated: 1, rows: limits.events.maxCount + 1, flagged: 0 }],
  ['format_run', { daysSinceCreated: 1, rows: 1 }],
  ['limit_hit', { limit: 'my-secret-file.xlsx' }],
  ['feedback_given', { replyRequested: 'yes' }],
  ['lead_submitted', { kind: 'newsletter' }],
  ['upgrade_intent', { trigger: 'because I said so' }],
  ['page_view', { page: '/formats/65f0c2a1b3d4e5f607182930' }],
  ['file_rejected', { reason: 'orders-2026.xlsx' }],
  ['file_uploaded', { role: 'input', fileType: 'exe', rows: 1, cols: 1 }],
  ['file_uploaded', { role: 'other', fileType: 'csv', rows: 1, cols: 1 }],
  ['file_uploaded', { role: 'input', fileType: 'csv', rows: -1, cols: 1 }],
  ['file_uploaded', { role: 'input', fileType: 'csv', rows: 1, cols: limits.events.maxSmallCount + 1 }],
  ['learn_completed', { path: 'magic', status: 'verified', masking: true, aiClicked: false }],
  ['learn_completed', { path: 'local', status: 'Name,Amount', masking: true, aiClicked: false }],
  ['learn_completed', { path: 'local', status: 'verified', masking: 'on', aiClicked: false }],
  ['known_format', { kind: 'same', answer: 'yes' }],
  ['known_format', { kind: 'anotherInput', answer: 'convert' }],
  ['known_format', { kind: 'other', answer: 'yes' }],
  ['signin_wall_shown', { trigger: 'because' }],
  ['file_matched', { result: 'maybe' }],
  ['file_matched', { result: 'auto', score: 1.2 }],
  ['file_matched', { result: 'auto', score: -0.1 }],
  ['file_matched', { result: 'auto', score: '0.9' }],
  ['formats_chosen', { offered: -1, chosen: 0, all: false, batch: false }],
  ['formats_chosen', { offered: 3, chosen: 2, all: 0, batch: false }],
  ['download', { kind: 'invoice.pdf' }],
  ['batch_run', { files: 5, converted: 3, needsAttention: 1, noMatch: 1, notChosen: limits.events.maxSmallCount + 1 }],
];

describe('the event vocabulary', () => {
  it('lists every type once, as a server event or a client event', () => {
    const all = Object.keys(EVENT_PROPS).sort();
    expect([...SERVER_EVENT_TYPES, ...CLIENT_EVENT_TYPES].sort()).toEqual(all);
    expect(new Set([...SERVER_EVENT_TYPES, ...CLIENT_EVENT_TYPES]).size).toBe(all.length);
  });

  it('has a valid example for every type', () => {
    for (const type of Object.keys(EVENT_PROPS) as EventType[]) {
      expect(EVENT_PROPS[type].safeParse(VALID[type]).success, type).toBe(true);
    }
  });

  it.each(Object.keys(EVENT_PROPS) as EventType[])('%s refuses an extra key, even a harmless-looking one', (type) => {
    expect(EVENT_PROPS[type].safeParse({ ...VALID[type], fileName: 'orders.xlsx' }).success).toBe(false);
    expect(EVENT_PROPS[type].safeParse({ ...VALID[type], note: 'x' }).success).toBe(false);
  });

  it.each(INVALID)('%s refuses %j', (type, props) => {
    expect(EVENT_PROPS[type].safeParse(props).success).toBe(false);
  });

  it('holds no free string: every string prop is a value of a closed list', () => {
    // A string a user could type (a file name, a header, a cell) must not be accepted in any prop of any type.
    for (const type of Object.keys(EVENT_PROPS) as EventType[]) {
      for (const key of Object.keys(VALID[type])) {
        const value = VALID[type][key];
        if (typeof value !== 'string') continue;
        const attempt = { ...VALID[type], [key]: 'Quarterly orders.xlsx' };
        expect(EVENT_PROPS[type].safeParse(attempt).success, `${type}.${key}`).toBe(false);
      }
    }
  });

  it('takes the limits and triggers the product already has', () => {
    for (const limit of LIMIT_CODES) expect(EVENT_PROPS.limit_hit.safeParse({ limit }).success).toBe(true);
    for (const trigger of WAITLIST_TRIGGERS) expect(EVENT_PROPS.upgrade_intent.safeParse({ trigger }).success).toBe(true);
  });

  it('keeps a score to two decimals (a finer one is rounded, not refused)', () => {
    expect(EVENT_PROPS.file_matched.parse({ result: 'choose', score: 0.8567 })).toEqual({ result: 'choose', score: 0.86 });
    expect(EVENT_PROPS.file_matched.parse({ result: 'auto', score: 1 })).toEqual({ result: 'auto', score: 1 });
  });

  it('leaves the score and the file size out when there is none to report', () => {
    expect(EVENT_PROPS.file_matched.parse({ result: 'none' })).toEqual({ result: 'none' });
    expect(EVENT_PROPS.file_uploaded.parse({ role: 'run', fileType: 'csv' })).toEqual({ role: 'run', fileType: 'csv' });
  });
});

describe('parseEvent', () => {
  it('returns the type and only the props the schema lists', () => {
    expect(parseEvent({ type: 'page_view', props: { page: 'convert' } }, CLIENT_EVENT_TYPES)).toEqual({ type: 'page_view', props: { page: 'convert' } });
  });

  it('refuses a server event when only client events are allowed', () => {
    expect(parseEvent({ type: 'format_saved', props: { kind: 'new' } }, CLIENT_EVENT_TYPES)).toBeNull();
    expect(parseEvent({ type: 'format_saved', props: { kind: 'new' } }, SERVER_EVENT_TYPES)).not.toBeNull();
  });

  it.each([null, undefined, 'page_view', 5, [], {}, { type: 'unknown_event', props: {} }, { type: 7, props: {} }, { type: 'page_view', props: [] }, { type: 'page_view' }])(
    'refuses %j',
    (raw) => {
      expect(parseEvent(raw, CLIENT_EVENT_TYPES)).toBeNull();
    },
  );

  it('ignores a client time and anything else beside the type and props', () => {
    const parsed = parseEvent({ type: 'download', props: { kind: 'zip' }, ts: '2001-01-01', userId: 'x', anonId: 'y' }, CLIENT_EVENT_TYPES);
    expect(parsed).toEqual({ type: 'download', props: { kind: 'zip' } });
  });
});

describe('parseClientEvents', () => {
  const good = { type: 'page_view', props: { page: 'home' } };

  it('keeps the valid events and drops the invalid ones without costing the batch', () => {
    const r = parseClientEvents({ events: [good, { type: 'page_view', props: { page: '/x' } }, { type: 'format_saved', props: { kind: 'new' } }, 'nope', good] });
    expect(r.events).toHaveLength(2);
    expect(r.dropped).toBe(3);
  });

  it(`looks at no more than ${limits.events.maxPerRequest} events`, () => {
    const r = parseClientEvents({ events: Array.from({ length: limits.events.maxPerRequest + 5 }, () => good) });
    expect(r.events).toHaveLength(limits.events.maxPerRequest);
    expect(r.dropped).toBe(5);
  });

  it.each([null, undefined, [], 'x', {}, { events: 'x' }, { events: {} }])('finds no event in %j', (body) => {
    expect(parseClientEvents(body)).toEqual({ events: [], dropped: 0 });
  });
});

describe('pageNameOf', () => {
  it.each([
    ['/', 'home'],
    ['', 'home'],
    ['/result', 'learn'],
    ['/formats', 'formats'],
    ['/formats/', 'formats'],
    ['/formats/65f0c2a1b3d4e5f607182930', 'format'],
    ['/formats/65f0c2a1b3d4e5f607182930/add-source', 'format'],
    ['/formats/65f0c2a1b3d4e5f607182930/sources/65f0c2a1b3d4e5f607182931', 'format'],
    ['/convert', 'convert'],
    ['/convert?format=65f0c2a1b3d4e5f607182930', 'convert'],
    ['/batch', 'convert'],
    ['/business', 'business'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/accessibility', 'accessibility'],
    ['/admin', 'admin'],
    ['/admin?tab=users', 'admin'],
    ['/dev', 'other'],
    ['/something/else', 'other'],
  ])('%s is %s', (path, page) => {
    expect(pageNameOf(path)).toBe(page);
  });
});

describe('fileTypeOfName', () => {
  it('reads the extension and nothing else', () => {
    expect(fileTypeOfName('Orders 2026.XLSX')).toBe('xlsx');
    expect(fileTypeOfName('a.b.csv')).toBe('csv');
    expect(fileTypeOfName('old.xls')).toBe('xls');
    expect(fileTypeOfName('list.txt')).toBe('txt');
  });
  it('is null for a type we do not read, or none', () => {
    expect(fileTypeOfName('photo.png')).toBeNull();
    expect(fileTypeOfName('noextension')).toBeNull();
    expect(fileTypeOfName('')).toBeNull();
  });
});
