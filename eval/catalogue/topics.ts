// The catalogue: every transformation type, grouped by topic. Each topic lives in its own file under topics/; adding a type
// means adding a `defineType({...})` to the right file and listing it in that file's export (see README.md).
import { ACROSS_ROWS } from './topics/acrossRows';
import { ARITHMETIC } from './topics/arithmetic';
import { CLEANUP } from './topics/cleanup';
import { COMBINING } from './topics/combining';
import { DATES } from './topics/dates';
import { EXTRACTION } from './topics/extraction';
import { FORMATTING } from './topics/formatting';
import { LOGIC } from './topics/logic';
import { LOOKUPS } from './topics/lookups';
import { ROW_OPS } from './topics/rowOps';
import { STRUCTURE } from './topics/structure';
import { TOPICS, TOPIC_TITLES, type CatalogueType, type TopicId } from './types';

export { TOPICS, TOPIC_TITLES };

const ALL: CatalogueType[] = [...EXTRACTION, ...CLEANUP, ...FORMATTING, ...COMBINING, ...LOGIC, ...LOOKUPS, ...ARITHMETIC, ...DATES, ...ACROSS_ROWS, ...ROW_OPS, ...STRUCTURE];

function assertCatalogue(types: readonly CatalogueType[]): void {
  const seen = new Set<string>();
  for (const t of types) {
    if (!/^[a-zA-Z]+\.[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id)) throw new Error(`catalogue: bad type id "${t.id}" (expected <topic>.<kebab-name>)`);
    if (!t.id.startsWith(`${t.topic}.`)) throw new Error(`catalogue: "${t.id}" is in topic "${t.topic}" but its id says otherwise`);
    if (seen.has(t.id)) throw new Error(`catalogue: duplicate type id "${t.id}"`);
    seen.add(t.id);
    if (t.rule === null && !t.missing) throw new Error(`catalogue: "${t.id}" has no reference rule, so it must say what is missing`);
    if (t.rule !== null && t.missing) throw new Error(`catalogue: "${t.id}" has a reference rule and also says something is missing`);
  }
}
assertCatalogue(ALL);

/** Every type, in topic order, then definition order. */
export const CATALOGUE: readonly CatalogueType[] = [...ALL].sort((a, b) => TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic));

export function typesOfTopic(topic: TopicId): CatalogueType[] {
  return CATALOGUE.filter((t) => t.topic === topic);
}

/** `--types` selector: a full id ("text.left-n"), a topic ("extraction") or a prefix with a star ("extraction.*", "dates.add-*"). */
export function selectTypes(selectors: readonly string[]): CatalogueType[] {
  if (selectors.length === 0) return [...CATALOGUE];
  const out = new Set<CatalogueType>();
  for (const sel of selectors) {
    const matched = CATALOGUE.filter((t) => {
      if (sel === t.id || sel === t.topic) return true;
      if (sel.endsWith('*')) return t.id.startsWith(sel.slice(0, -1));
      return false;
    });
    if (matched.length === 0) throw new Error(`--types: nothing matches "${sel}" (use \`--list\` to see the ids)`);
    for (const t of matched) out.add(t);
  }
  return CATALOGUE.filter((t) => out.has(t));
}
