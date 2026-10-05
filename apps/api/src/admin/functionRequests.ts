// Function requests in the admin view (SPEC 8.10, 13, 14.2; issue #40). The collection already holds one document per name + signature (the
// `key`), counted per distinct HASHED owner, so a "group" is a document. Nothing here can show user data: a request was value-filtered
// before it was stored (`learn/notes.ts`) and holds a name, a purpose sentence, argument names and types - and the hashes of who asked
// (`ownerHashes`) never leave the server.
//
// DECISION: no GitHub token and no call to GitHub. When a group reaches the threshold the admin gets a link to GitHub's new-issue form with
// the title and body filled in; she reads it and submits it herself. The body is built here, from the request's own fields only.
import { limits, type AdminFunctionRequest } from '@formatai/shared';
import type { FunctionRequestDoc } from '../models.js';

type Request = Pick<FunctionRequestDoc, 'name' | 'purpose' | 'args' | 'returns' | 'topic' | 'count' | 'distinctOwners'>;

/** `name(a: text, b: number): text`. */
export function functionSignature(r: Pick<FunctionRequestDoc, 'name' | 'args' | 'returns'>): string {
  return `${r.name}(${r.args.map((a) => `${a.name}: ${a.type}`).join(', ')}): ${r.returns}`;
}

/** One line: a request's text is one sentence, but nothing here may break the markdown it is put in. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The issue's title and body: the request's name, purpose, signature, topic and how often it was asked - nothing else. */
export function issueText(r: Request): { title: string; body: string } {
  const signature = functionSignature(r);
  const title = `Function request: ${signature}`.slice(0, 120);
  const body = [
    '## Function request',
    '',
    `- **Name:** \`${oneLine(r.name)}\``,
    `- **Purpose:** ${oneLine(r.purpose)}`,
    `- **Signature:** \`${oneLine(signature)}\``,
    `- **Topic:** ${oneLine(r.topic)}`,
    `- **Asked:** ${r.count} ${r.count === 1 ? 'time' : 'times'}, by ${r.distinctOwners} different ${r.distinctOwners === 1 ? 'user' : 'users'}`,
    '',
    'Recorded by the formatAI function-request log. A request holds a name, a purpose and a signature only - never an example or any data.',
  ].join('\n');
  return { title, body };
}

/** GitHub's new-issue form with the title and body filled in (`limits.admin.githubNewIssueUrl`). */
export function issueUrl(r: Request): string {
  const { title, body } = issueText(r);
  return `${limits.admin.githubNewIssueUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** The request as the admin page shows it. The issue link only comes with a `new` request that has reached the threshold. */
export function presentFunctionRequest(doc: FunctionRequestDoc & { _id: NonNullable<FunctionRequestDoc['_id']> }): AdminFunctionRequest {
  const atThreshold = doc.distinctOwners >= limits.learn.functionRequests.issueThreshold;
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    purpose: doc.purpose,
    signature: functionSignature(doc),
    args: doc.args.map((a) => ({ name: a.name, type: a.type })),
    returns: doc.returns,
    topic: doc.topic,
    count: doc.count,
    distinctOwners: doc.distinctOwners,
    firstSeen: doc.firstSeen.toISOString(),
    lastSeen: doc.lastSeen.toISOString(),
    status: doc.status,
    atThreshold,
    ...(atThreshold && doc.status === 'new' ? { issueUrl: issueUrl(doc) } : {}),
  };
}
