import { AgencyAiService } from './agency.ai.service';
import {
  CopyTone,
  CopyChannel,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';

describe('AgencyAiService - Marketing Copy Copilot', () => {
  let service: AgencyAiService;

  beforeEach(() => {
    service = new AgencyAiService();
  });

  describe('Copy Generation with Heuristic Engine Fallback', () => {
    it('should generate 3 headlines, 3 body variants, and 3 CTAs with DIRECT_RESPONSE tone', async () => {
      const result = await service.generateCopy({
        brief:
          'Promote our SaaS analytics tool for crypto traders with 50% discount for early adopters',
        clientName: 'CoinTrack Pro',
        tone: CopyTone.DIRECT_RESPONSE,
        channelType: CopyChannel.TELEGRAM,
      });

      expect(result.headlines).toHaveLength(3);
      expect(result.bodyVariants).toHaveLength(3);
      expect(result.callToActions).toHaveLength(3);
      expect(result.headlines[0]).toContain('CoinTrack Pro');
      expect(result.bodyVariants[0]).toContain('<b>');
      expect(result.callToActions[0]).toBeDefined();
    });

    it('should generate urgency-focused copy when tone is URGENT', async () => {
      const result = await service.generateCopy({
        brief: 'Enrollment closing tonight for the masterclass',
        clientName: 'Academy Alpha',
        tone: CopyTone.URGENT,
      });

      expect(result.headlines[0]).toMatch(/⚡|⏳|🔥/);
      expect(result.bodyVariants[0]).toContain('TIME-SENSITIVE');
      expect(result.callToActions[0]).toMatch(/Now|Immediately|⚡/);
    });

    it('should generate enterprise-style copy when tone is PROFESSIONAL', async () => {
      const result = await service.generateCopy({
        brief: 'Enterprise supply chain consulting and logistics risk analysis',
        clientName: 'Nexus Global',
        tone: CopyTone.PROFESSIONAL,
      });

      expect(result.headlines[0]).toContain('Nexus Global');
      expect(result.bodyVariants[0]).toContain('EXECUTIVE BRIEFING');
      expect(result.callToActions[0]).toMatch(/Executive|Learn More|Advisory/);
    });

    it('should generate friendly conversational copy when tone is CASUAL', async () => {
      const result = await service.generateCopy({
        brief: 'New mobile app launch with gaming rewards',
        clientName: 'PlayPulse',
        tone: CopyTone.CASUAL,
      });

      expect(result.headlines[0]).toMatch(/Hey|Game-changer|seen this/);
      expect(result.bodyVariants[0]).toContain('👋');
    });
  });

  describe('Local model (Ollama) replies', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });
    const reply = (obj: unknown) =>
      ({
        ok: true,
        json: async () => ({ response: JSON.stringify(obj) }),
      } as any);
    const brief = { brief: 'Spring sale at a bakery', clientName: 'Bakery' };

    it('uses the local model and asks for a JSON schema with the three lists', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          reply({ headlines: ['a'], bodyVariants: ['b'], callToActions: ['c'] })
        );
      global.fetch = fetchMock as any;
      const result = await service.generateCopy(brief);
      expect(result.providerUsed).toBe('ollama');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.format.required).toEqual([
        'headlines',
        'bodyVariants',
        'callToActions',
      ]);
    });

    it('accepts a single string or {text} items, as small models produce', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          reply({
            headlines: 'one',
            bodyVariants: [{ text: 'two' }],
            callToActions: ['three'],
          })
        ) as any;
      const result = await service.generateCopy(brief);
      expect(result.providerUsed).toBe('ollama');
      expect(result.headlines).toEqual(['one']);
      expect(result.bodyVariants).toEqual(['two']);
    });

    it('tries once more when the first reply has the wrong shape, then falls back to templates', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(reply({ title: 'wrong' }))
        .mockResolvedValueOnce(
          reply({ headlines: ['a'], bodyVariants: ['b'], callToActions: ['c'] })
        );
      global.fetch = fetchMock as any;
      expect((await service.generateCopy(brief)).providerUsed).toBe('ollama');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      global.fetch = jest
        .fn()
        .mockResolvedValue(reply({ title: 'wrong' })) as any;
      expect((await service.generateCopy(brief)).providerUsed).toBe(
        'heuristic_engine'
      );
    });
  });

  describe('Text Improvement', () => {
    it('should improve draft text locally with tone enhancements', async () => {
      const result = await service.improveText({
        text: 'Join our special trading channel right now for signals.',
        targetTone: CopyTone.URGENT,
      });

      expect(result.improvedText).toContain('TIME SENSITIVE');
      expect(result.improvedText).toContain('Join our special trading channel');
    });
  });
});
