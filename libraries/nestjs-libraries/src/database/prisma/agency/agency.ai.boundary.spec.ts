import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What Telegram publishes about communities, and what the user accounts see, never reaches an AI model
 * (the local one or any other): Telegram's terms forbid using its content that way. The two sides share no
 * code, so nothing in the AI services can read a community, and nothing that reads Telegram can call a model.
 */
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
const imports = (source: string) =>
  [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

const AI_SIDE = [
  'agency.ai.service.ts',
  'agency.ai.gateway.service.ts',
  'agency.ai.tools.service.ts',
  'agency.ai.agent.service.ts',
  'agency.ai.discovery.service.ts',
  'agency.intelligence.service.ts',
];
const TELEGRAM_SIDE = [
  'agency.communities.service.ts',
  'agency.communities.repository.ts',
  'agency.telegram.users.service.ts',
  'agency.telegram.users.repository.ts',
  '../../../integrations/telegram/telegram.user.gateway.ts',
];

describe('Telegram content and AI models stay apart', () => {
  it.each(AI_SIDE)(
    '%s imports nothing that reads Telegram communities or user accounts',
    (file) => {
      const bad = imports(read(file)).filter((i) =>
        /agency\.communities|agency\.telegram\.users|telegram\.user\.gateway/.test(
          i
        )
      );
      expect(bad).toEqual([]);
    }
  );

  it.each(TELEGRAM_SIDE)('%s imports no AI service', (file) => {
    const bad = imports(read(file)).filter((i) =>
      /agency\.ai\.|agency\.intelligence|\/openai\//.test(i)
    );
    expect(bad).toEqual([]);
  });
});
