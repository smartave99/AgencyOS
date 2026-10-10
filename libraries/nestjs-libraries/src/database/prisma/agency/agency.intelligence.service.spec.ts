import { Test, TestingModule } from '@nestjs/testing';
import { AgencyIntelligenceService } from './agency.intelligence.service';
import { AgencyRepository } from './agency.repository';

describe('AgencyIntelligenceService', () => {
  let service: AgencyIntelligenceService;
  let repo: jest.Mocked<AgencyRepository>;

  const mockRepo = {
    createKnowledgeDocument: jest.fn(),
    getKnowledgeDocuments: jest.fn(),
    getKnowledgeDocumentById: jest.fn(),
    deleteKnowledgeDocument: jest.fn(),
    getAllKnowledgeDocumentsForSearch: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyIntelligenceService,
        {
          provide: AgencyRepository,
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AgencyIntelligenceService>(AgencyIntelligenceService);
    repo = module.get(AgencyRepository);
    jest.clearAllMocks();
  });

  describe('Vector Embeddings & Deterministic Fallback', () => {
    it('should generate a 128-dimensional unit normalized vector embedding', async () => {
      const vec = await service.generateEmbedding('Telegram crypto advertising and growth hacking strategies');
      expect(vec).toHaveLength(128);

      // Verify unit vector normalization: sum(v_i^2) ~= 1
      let sumSq = 0;
      for (const val of vec) sumSq += val * val;
      expect(Math.abs(sumSq - 1.0)).toBeLessThan(0.01);
    });

    it('should return higher cosine similarity for semantically related texts', async () => {
      const v1 = await service.generateEmbedding('Bitcoin investment trading community');
      const v2 = await service.generateEmbedding('Crypto token trading discussion');
      const v3 = await service.generateEmbedding('Organic gardening tomato plant cultivation');

      const simCrypto = service.computeCosineSimilarity(v1, v2);
      const simGardening = service.computeCosineSimilarity(v1, v3);

      expect(simCrypto).toBeGreaterThan(simGardening);
    });
  });

  describe('Sentiment Analysis', () => {
    it('should detect positive sentiment in supportive discussions', () => {
      const res = service.analyzeSentiment('The ad campaign generated amazing profits, solved our growth issue and had super high conversion!');
      expect(res.label).toBe('POSITIVE');
      expect(res.score).toBeGreaterThan(0.2);
    });

    it('should detect negative sentiment in customer complaints', () => {
      const res = service.analyzeSentiment('This is a terrible scam, worst experience ever with slow response and broken links');
      expect(res.label).toBe('NEGATIVE');
      expect(res.score).toBeLessThan(-0.2);
    });

    it('should classify balanced or informational messages as neutral', () => {
      const res = service.analyzeSentiment('The group meeting will take place on Tuesday at 4 PM in room 3.');
      expect(res.label).toBe('NEUTRAL');
      expect(res.score).toBe(0);
    });
  });

  describe('Ingest & Search', () => {
    it('should ingest documents with tags and sentiment into the repository', async () => {
      mockRepo.createKnowledgeDocument.mockResolvedValue({
        id: 'doc-1',
        orgId: 'org-1',
        title: 'Weekly Community Recap',
        content: 'Great discussions about web3 advertising this week.',
        category: 'DISCUSSION',
        sentimentScore: 0.5,
        tags: '["web3", "advertising"]',
        embedding: '[]',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.ingestDocument('org-1', {
        title: 'Weekly Community Recap',
        content: 'Great discussions about web3 advertising this week.',
        category: 'DISCUSSION',
      });

      expect(mockRepo.createKnowledgeDocument).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          title: 'Weekly Community Recap',
          category: 'DISCUSSION',
        })
      );
      expect(result.id).toBe('doc-1');
    });

    it('should score and rank search results above threshold', async () => {
      const vecCrypto = await service.generateEmbedding('crypto token launch marketing');
      mockRepo.getAllKnowledgeDocumentsForSearch.mockResolvedValue([
        {
          id: 'doc-1',
          title: 'Crypto Marketing Playbook',
          content: 'How to launch a crypto token with Telegram group ads',
          category: 'CAMPAIGN_BRIEF',
          sentimentScore: 0.4,
          tags: '["crypto", "token"]',
          embedding: JSON.stringify(vecCrypto),
          createdAt: new Date(),
        },
      ] as any);

      const results = await service.searchKnowledge('org-1', {
        query: 'crypto advertising token',
        threshold: 0.1,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Crypto Marketing Playbook');
      expect(results[0].similarity).toBeGreaterThan(0.1);
    });
  });
});
