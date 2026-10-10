import { Injectable, Logger } from '@nestjs/common';
import { AgencyRepository } from './agency.repository';
import { IngestDocumentDto, SearchIntelligenceDto } from '../../../dtos/agency/intelligence.dto';

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  source?: string;
  sentimentScore: number;
  tags: string[];
  similarity: number;
}

export interface TopicInsight {
  topic: string;
  count: number;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  sampleTitles: string[];
}

export interface IntelligenceAnalyticsSummary {
  totalDocuments: number;
  averageSentiment: number;
  sentimentLabel: string;
  categoryBreakdown: Record<string, number>;
  trendingTopics: TopicInsight[];
  recentInsights: {
    id: string;
    title: string;
    category: string;
    source?: string;
    sentimentScore: number;
    createdAt: Date;
  }[];
}

@Injectable()
export class AgencyIntelligenceService {
  private readonly logger = new Logger(AgencyIntelligenceService.name);
  private readonly ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  private readonly embeddingModel = process.env.EMBEDDING_MODEL || 'embeddinggemma';

  constructor(private readonly repository: AgencyRepository) {}

  /**
   * Generates a 128-dimensional dense vector embedding.
   * Priority:
   * 1. Local Ollama (embeddinggemma / nomic-embed-text)
   * 2. OpenAI text-embedding-3-small (if OPENAI_API_KEY is present)
   * 3. Deterministic Hashed Dense Vector (Zero dependency, 100% offline fallback)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const cleanText = text.trim();
    if (!cleanText) {
      return new Array(128).fill(0);
    }

    // Try Local Ollama Embedding
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.ollamaHost}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: cleanText.substring(0, 2000),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { embedding: number[] };
        if (Array.isArray(data.embedding) && data.embedding.length > 0) {
          return this.normalizeVector(data.embedding);
        }
      }
    } catch {
      // Ollama not responding, move to fallback
    }

    // Try OpenAI Embedding
    if (process.env.OPENAI_API_KEY) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: cleanText.substring(0, 2000),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = (await res.json()) as { data: [{ embedding: number[] }] };
          if (data.data?.[0]?.embedding) {
            return this.normalizeVector(data.data[0].embedding);
          }
        }
      } catch {
        // OpenAI failed, move to fallback
      }
    }

    // High-performance deterministic hashed dense vector fallback
    return this.generateDeterministicVector(cleanText, 128);
  }

  /**
   * Deterministic semantic feature extraction into normalized float vector
   */
  private generateDeterministicVector(text: string, dimensions = 128): number[] {
    const vector = new Array(dimensions).fill(0);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      let hash = 0;
      for (let j = 0; j < word.length; j++) {
        hash = (hash * 31 + word.charCodeAt(j)) | 0;
      }
      const index = Math.abs(hash) % dimensions;
      const weight = 1.0 + (word.length > 5 ? 0.5 : 0.0);
      vector[index] += weight;

      // Word pairs (bigrams) for contextual semantic depth
      if (i > 0) {
        const bigram = words[i - 1] + '_' + word;
        let bigramHash = 0;
        for (let j = 0; j < bigram.length; j++) {
          bigramHash = (bigramHash * 37 + bigram.charCodeAt(j)) | 0;
        }
        const bIndex = Math.abs(bigramHash) % dimensions;
        vector[bIndex] += 1.5;
      }
    }

    return this.normalizeVector(vector);
  }

  private normalizeVector(vec: number[]): number[] {
    let sumSquares = 0;
    for (const val of vec) {
      sumSquares += val * val;
    }
    const mag = Math.sqrt(sumSquares);
    if (mag === 0) return vec;
    return vec.map((v) => Number((v / mag).toFixed(6)));
  }

  /**
   * Cosine similarity calculation between two unit vectors: dot(A, B)
   */
  computeCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
    const len = Math.min(vecA.length, vecB.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += vecA[i] * vecB[i];
    }
    return Math.max(0, Math.min(1, dot));
  }

  /**
   * Aggregate Sentiment Analyzer (-1.0 to +1.0)
   */
  analyzeSentiment(text: string): { score: number; label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' } {
    const lower = text.toLowerCase();
    const positiveWords = [
      'love', 'great', 'awesome', 'excellent', 'good', 'best', 'super', 'impressive',
      'helpful', 'profit', 'growth', 'effective', 'high', 'solved', 'recommend',
      'success', 'convert', 'boost', 'excited', 'interested', 'buy', 'win'
    ];
    const negativeWords = [
      'bad', 'poor', 'terrible', 'worst', 'issue', 'problem', 'bug', 'error',
      'fail', 'scam', 'hate', 'slow', 'lost', 'cancel', 'expensive', 'useless',
      'waste', 'broken', 'complaint', 'difficult', 'frustrated'
    ];

    let pos = 0;
    let neg = 0;

    for (const w of positiveWords) {
      const matches = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
      if (matches) pos += matches.length;
    }
    for (const w of negativeWords) {
      const matches = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
      if (matches) neg += matches.length;
    }

    const total = pos + neg;
    if (total === 0) {
      return { score: 0.0, label: 'NEUTRAL' };
    }

    const score = Number(((pos - neg) / total).toFixed(2));
    const label = score > 0.15 ? 'POSITIVE' : score < -0.15 ? 'NEGATIVE' : 'NEUTRAL';
    return { score, label };
  }

  /**
   * Topic and Keyword Extractor
   */
  extractTopicTags(text: string): string[] {
    const commonStops = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from', 'they', 'will',
      'what', 'when', 'make', 'about', 'your', 'which', 'their', 'there', 'could',
      'should', 'would', 'other', 'these', 'where', 'after', 'first', 'into', 'just'
    ]);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !commonStops.has(w));

    const freq: Record<string, number> = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Ingest a discussion or document with vector embeddings and sentiment
   */
  async ingestDocument(orgId: string, dto: IngestDocumentDto) {
    const embedding = await this.generateEmbedding(`${dto.title}\n${dto.content}`);
    const sentiment = this.analyzeSentiment(dto.content);
    const tags = dto.tags && dto.tags.length > 0 ? dto.tags : this.extractTopicTags(`${dto.title} ${dto.content}`);

    return this.repository.createKnowledgeDocument(orgId, {
      title: dto.title,
      content: dto.content,
      category: dto.category || 'DISCUSSION',
      source: dto.source || 'Authorized Group Feed',
      telegramDestId: dto.telegramDestId,
      sentimentScore: sentiment.score,
      tags: JSON.stringify(tags),
      embedding: JSON.stringify(embedding),
    });
  }

  /**
   * Perform semantic vector search over knowledge documents and authorized discussions
   */
  async searchKnowledge(orgId: string, dto: SearchIntelligenceDto): Promise<SearchResult[]> {
    const queryEmbedding = await this.generateEmbedding(dto.query);
    const documents = await this.repository.getAllKnowledgeDocumentsForSearch(orgId, dto.category);

    const threshold = dto.threshold ?? 0.15;
    const limit = dto.limit ?? 10;

    const scored: SearchResult[] = [];

    for (const doc of documents) {
      let docEmbedding: number[] = [];
      try {
        if (doc.embedding) {
          docEmbedding = JSON.parse(doc.embedding);
        }
      } catch {
        docEmbedding = [];
      }

      if (docEmbedding.length === 0) {
        docEmbedding = await this.generateEmbedding(`${doc.title}\n${doc.content}`);
      }

      const similarity = this.computeCosineSimilarity(queryEmbedding, docEmbedding);

      let parsedTags: string[] = [];
      try {
        if (doc.tags) parsedTags = JSON.parse(doc.tags);
      } catch {
        parsedTags = [];
      }

      if (similarity >= threshold) {
        scored.push({
          id: doc.id,
          title: doc.title,
          content: doc.content,
          category: doc.category,
          source: doc.source || undefined,
          sentimentScore: doc.sentimentScore ?? 0.0,
          tags: parsedTags,
          similarity: Number(similarity.toFixed(4)),
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /**
   * Analytics and topic clustering over stored intelligence
   */
  async getIntelligenceAnalytics(orgId: string): Promise<IntelligenceAnalyticsSummary> {
    const documents = await this.repository.getKnowledgeDocuments(orgId, undefined, 200);

    const categoryBreakdown: Record<string, number> = {};
    const topicMap: Record<string, { count: number; sentimentSum: number; sampleTitles: string[] }> = {};
    let totalSentiment = 0;

    for (const doc of documents) {
      categoryBreakdown[doc.category] = (categoryBreakdown[doc.category] || 0) + 1;
      totalSentiment += doc.sentimentScore ?? 0.0;

      let tags: string[] = [];
      try {
        if (doc.tags) tags = JSON.parse(doc.tags);
      } catch {
        tags = [];
      }

      for (const t of tags) {
        if (!topicMap[t]) {
          topicMap[t] = { count: 0, sentimentSum: 0, sampleTitles: [] };
        }
        topicMap[t].count += 1;
        topicMap[t].sentimentSum += doc.sentimentScore ?? 0.0;
        if (topicMap[t].sampleTitles.length < 3 && !topicMap[t].sampleTitles.includes(doc.title)) {
          topicMap[t].sampleTitles.push(doc.title);
        }
      }
    }

    const totalDocs = documents.length;
    const avgSentiment = totalDocs > 0 ? Number((totalSentiment / totalDocs).toFixed(2)) : 0;
    const sentimentLabel = avgSentiment > 0.15 ? 'Positive' : avgSentiment < -0.15 ? 'Negative' : 'Neutral';

    const trendingTopics: TopicInsight[] = Object.entries(topicMap)
      .map(([topic, data]) => {
        const topicAvg = data.count > 0 ? data.sentimentSum / data.count : 0;
        const sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' =
          topicAvg > 0.15 ? 'POSITIVE' : topicAvg < -0.15 ? 'NEGATIVE' : 'NEUTRAL';
        return {
          topic,
          count: data.count,
          sentiment,
          sampleTitles: data.sampleTitles,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const recentInsights = documents.slice(0, 10).map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      source: d.source || undefined,
      sentimentScore: d.sentimentScore ?? 0.0,
      createdAt: d.createdAt,
    }));

    return {
      totalDocuments: totalDocs,
      averageSentiment: avgSentiment,
      sentimentLabel,
      categoryBreakdown,
      trendingTopics,
      recentInsights,
    };
  }

  async deleteDocument(orgId: string, id: string) {
    return this.repository.deleteKnowledgeDocument(orgId, id);
  }
}
