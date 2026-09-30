import { ObjectId } from 'mongodb';

const HEX_24 = /^[0-9a-f]{24}$/i;

/** A MongoDB id from its 24-hex string, or undefined. `ObjectId.isValid` also accepts any 12-character string,
 * which is not an id anyone here ever hands out - so it is not used. */
export function objectIdOf(value: unknown): ObjectId | undefined {
  return typeof value === 'string' && HEX_24.test(value) ? new ObjectId(value) : undefined;
}
