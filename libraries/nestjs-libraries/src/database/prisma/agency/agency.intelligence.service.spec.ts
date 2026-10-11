import {
  AgencyIntelligenceService,
  LEXICAL_MODEL,
} from './agency.intelligence.service';

// Pure-logic checks; storage, tenancy and permissions are covered by the integration specs.
describe('AgencyIntelligenceService (pure logic)', () => {
  let service: AgencyIntelligenceService;
  let realFetch: typeof fetch;

  beforeEach(() => {
    service = new AgencyIntelligenceService({} as any, {} as any);
    realFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('no model server')) as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('keyword vectors (the offline fallback)', () => {
    it('are always available, 128-d and unit length', async () => {
      const set = await service.embed(
        'Telegram advertising and growth strategies'
      );
      expect(Object.keys(set)).toEqual([LEXICAL_MODEL]);
      expect(set[LEXICAL_MODEL]).toHaveLength(128);
      const sumSq = set[LEXICAL_MODEL].reduce((a, v) => a + v * v, 0);
      expect(Math.abs(sumSq - 1)).toBeLessThan(0.01);
    });

    it('score shared wording, which is what they measure: text with common words ranks above unrelated text', async () => {
      const a = (await service.embed('Bitcoin trading community discussion'))[
        LEXICAL_MODEL
      ];
      const b = (await service.embed('Crypto trading discussion group'))[
        LEXICAL_MODEL
      ];
      const c = (await service.embed('Organic tomato gardening tips'))[
        LEXICAL_MODEL
      ];
      expect(service.computeCosineSimilarity(a, b)).toBeGreaterThan(
        service.computeCosineSimilarity(a, c)
      );
      // ...and they do NOT understand synonyms, which is why the UI must not call this semantic search.
      const synonyms = (await service.embed('car'))[LEXICAL_MODEL];
      const automobile = (await service.embed('automobile'))[LEXICAL_MODEL];
      expect(
        service.computeCosineSimilarity(synonyms, automobile)
      ).toBeLessThan(0.2);
    });

    it('an empty text yields a zero vector rather than an error', async () => {
      const set = await service.embed('   ');
      expect(set[LEXICAL_MODEL].every((v) => v === 0)).toBe(true);
    });
  });

  describe('sentiment (word-list scoring, not a trained model)', () => {
    it('detects positive, negative and mixed text', () => {
      expect(
        service.analyzeSentiment(
          'Amazing results, excellent growth, super helpful'
        ).label
      ).toBe('POSITIVE');
      expect(
        service.analyzeSentiment(
          'Terrible slow service, broken and useless, I want to cancel'
        ).label
      ).toBe('NEGATIVE');
      expect(
        service.analyzeSentiment('The meeting is on Tuesday at noon').label
      ).toBe('NEUTRAL');
    });
  });

  describe('topic tags', () => {
    it('returns the most frequent meaningful words', () => {
      const tags = service.extractTopicTags(
        'delivery delivery delivery pricing pricing question about the shipping'
      );
      expect(tags[0]).toBe('delivery');
      expect(tags).toContain('pricing');
      expect(tags).not.toContain('the');
    });
  });
});
