import { describe, expect, it } from 'vitest';
import { cliChildEnv } from '../../src/llm/providers/claudeCli';

describe('claude-cli child environment', () => {
  it('never passes API credentials, so the CLI uses the subscription login', () => {
    const env = cliChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 't', OTHER: 'x' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.OTHER).toBe('x');
  });
});
