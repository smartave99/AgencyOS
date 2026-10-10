import { AgencyAiService } from './agency.ai.service';
import { CopyTone, CopyChannel } from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';

describe('AgencyAiService - Marketing Copy Copilot', () => {
  let service: AgencyAiService;

  beforeEach(() => {
    service = new AgencyAiService();
  });

  describe('Copy Generation with Heuristic Engine Fallback', () => {
    it('should generate 3 headlines, 3 body variants, and 3 CTAs with DIRECT_RESPONSE tone', async () => {
      const result = await service.generateCopy({
        brief: 'Promote our SaaS analytics tool for crypto traders with 50% discount for early adopters',
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
