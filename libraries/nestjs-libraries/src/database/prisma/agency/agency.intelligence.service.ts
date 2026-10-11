import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  IngestDocumentDto,
  SearchIntelligenceDto,
} from '../../../dtos/agency/intelligence.dto';

export const LEXICAL_MODEL = 'lexical-hash-128';

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

export interface SearchResponse {
  results: SearchResult[];
  /** The model every score in `results` came from. */
  method: string;
  /** False when only keyword hashing was available: scores reflect shared words, not meaning. */
  semantic: boolean;
  documentsSearched: number;
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
  /** Sentiment is a word-list score, not a trained model. */
  sentimentMethod: 'keyword-lexicon';
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

/** model name → unit vector. Every document always carries the lexical vector. */
type EmbeddingSet = Record<string, number[]>;

@Injectable()
export class AgencyIntelligenceService {
  private readonly logger = new Logger(AgencyIntelligenceService.name);
  private readonly ollamaHost =
    process.env.OLLAMA_HOST || 'http://localhost:11434';
  private readonly embeddingModel =
    process.env.EMBEDDING_MODEL || 'embeddinggemma';

  constructor(
    private readonly repository: AgencyRepository,
    private readonly access: AgencyAccessService
  ) {}

  /** Discussion text only leaves this server for a third party if the operator says so. */
  private get externalAiAllowed() {
    return (
      process.env.AGENCY_ALLOW_EXTERNAL_AI === 'true' &&
      !!process.env.OPENAI_API_KEY
    );
  }

  /**
   * Always returns the deterministic lexical vector (cheap, offline, works for every
   * document), plus a real embedding when a model is reachable:
   *   1. local Ollama   2. OpenAI, only with AGENCY_ALLOW_EXTERNAL_AI=true
   * Vectors from different models are never compared with each other.
   */
  async embed(text: string): Promise<EmbeddingSet> {
    const clean = text.trim().substring(0, 2000);
    const set: EmbeddingSet = {
      [LEXICAL_MODEL]: this.generateDeterministicVector(clean, 128),
    };
    if (!clean) return set;

    const ollama = await this.tryOllamaEmbedding(clean);
    if (ollama) {
      set[`ollama:${this.embeddingModel}`] = ollama;
    } else if (this.externalAiAllowed) {
      const openai = await this.tryOpenAiEmbedding(clean);
      if (openai) set['openai:text-embedding-3-small'] = openai;
    }
    return set;
  }

  private async tryOllamaEmbedding(text: string): Promise<number[] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number.parseInt(process.env.AGENCY_EMBED_TIMEOUT_MS || '', 10) || 30000
    );
    try {
      const res = await fetch(`${this.ollamaHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: text }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { embeddings?: number[][] };
      const vec = data.embeddings?.[0];
      return Array.isArray(vec) && vec.length > 0
        ? this.normalizeVector(vec)
        : null;
    } catch {
      return null; // Ollama not running: lexical search still works.
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tryOpenAiEmbedding(text: string): Promise<number[] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: [{ embedding: number[] }] };
      const vec = data.data?.[0]?.embedding;
      return vec ? this.normalizeVector(vec) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseStoredEmbeddings(raw: string | null): EmbeddingSet {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Legacy format: a bare vector. Only the 128-d ones are known to be lexical.
        return parsed.length === 128 ? { [LEXICAL_MODEL]: parsed } : {};
      }
      return parsed?.v2 && typeof parsed.v2 === 'object' ? parsed.v2 : {};
    } catch {
      return {};
    }
  }

  /**
   * Deterministic hashed bag-of-words (+ bigrams) vector. Matches shared wording, not meaning.
   */
  private generateDeterministicVector(
    text: string,
    dimensions = 128
  ): number[] {
    const vector = new Array(dimensions).fill(0);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

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
  analyzeSentiment(text: string): {
    score: number;
    label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  } {
    const lower = text.toLowerCase();
    const positiveWords = [
      'love',
      'great',
      'awesome',
      'excellent',
      'good',
      'best',
      'super',
      'impressive',
      'helpful',
      'profit',
      'growth',
      'effective',
      'high',
      'solved',
      'recommend',
      'success',
      'convert',
      'boost',
      'excited',
      'interested',
      'buy',
      'win',
    ];
    const negativeWords = [
      'bad',
      'poor',
      'terrible',
      'worst',
      'issue',
      'problem',
      'bug',
      'error',
      'fail',
      'scam',
      'hate',
      'slow',
      'lost',
      'cancel',
      'expensive',
      'useless',
      'waste',
      'broken',
      'complaint',
      'difficult',
      'frustrated',
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
    const label =
      score > 0.15 ? 'POSITIVE' : score < -0.15 ? 'NEGATIVE' : 'NEUTRAL';
    return { score, label };
  }

  /**
   * Topic and Keyword Extractor
   */
  extractTopicTags(text: string): string[] {
    const commonStops = new Set([
      'the',
      'and',
      'for',
      'with',
      'that',
      'this',
      'have',
      'from',
      'they',
      'will',
      'what',
      'when',
      'make',
      'about',
      'your',
      'which',
      'their',
      'there',
      'could',
      'should',
      'would',
      'other',
      'these',
      'where',
      'after',
      'first',
      'into',
      'just',
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
   * Stores one document. Discussion content may only be added by someone who attests
   * that the group administrator authorized collection and participants were told;
   * the attestation is recorded in the audit trail.
   */
  async ingestDocument(actor: AgencyActor, dto: IngestDocumentDto) {
    this.access.assert(actor, 'intelligence:manage');
    if (!dto.authorizationConfirmed) {
      throw new BadRequestException(
        'Confirm that this content comes from a source you are authorized to analyze (group administrator consent and participant notice).'
      );
    }
    if (dto.telegramDestId) {
      const dest = await this.repository.getTelegramDestinationById(
        actor.orgId,
        dto.telegramDestId
      );
      if (!dest) throw new NotFoundException('Destination not found');
    }
    const embeddings = await this.embed(`${dto.title}\n${dto.content}`);
    const sentiment = this.analyzeSentiment(dto.content);
    const tags =
      dto.tags && dto.tags.length > 0
        ? dto.tags
        : this.extractTopicTags(`${dto.title} ${dto.content}`);

    const doc = await this.repository.createKnowledgeDocument(actor.orgId, {
      title: dto.title,
      content: dto.content,
      category: dto.category || 'DISCUSSION',
      source: dto.source || 'Authorized source',
      telegramDestId: dto.telegramDestId,
      sentimentScore: sentiment.score,
      tags: JSON.stringify(tags),
      embedding: JSON.stringify({ v2: embeddings }),
    });
    await this.access.audit(actor, {
      action: 'intelligence.ingested',
      entityType: 'AgencyKnowledgeDocument',
      entityId: doc.id,
      summary: `${doc.category} document added with authorization attested`,
    });
    return doc;
  }

  /**
   * Cosine search. All scores in one response come from a single model: the real
   * embedding model when every document has one, otherwise keyword hashing for all.
   */
  async searchKnowledge(
    actor: AgencyActor,
    dto: SearchIntelligenceDto
  ): Promise<SearchResponse> {
    this.access.assert(actor, 'intelligence:read');
    const query = await this.embed(dto.query);
    const documents = await this.repository.getAllKnowledgeDocumentsForSearch(
      actor.orgId,
      dto.category
    );
    const stored = documents.map((d) => ({
      doc: d,
      vectors: this.parseStoredEmbeddings(d.embedding),
    }));

    const semanticModel = Object.keys(query).find((m) => m !== LEXICAL_MODEL);
    const useSemantic =
      !!semanticModel &&
      stored.length > 0 &&
      stored.every((s) => s.vectors[semanticModel]);
    const model = useSemantic ? semanticModel! : LEXICAL_MODEL;

    const threshold = dto.threshold ?? (useSemantic ? 0.3 : 0.15);
    const limit = Math.min(dto.limit ?? 10, 50);
    const results: SearchResult[] = [];

    for (const { doc, vectors } of stored) {
      const docVec =
        vectors[model] ??
        (model === LEXICAL_MODEL
          ? this.generateDeterministicVector(
              `${doc.title}\n${doc.content}`,
              128
            )
          : []);
      const similarity = this.computeCosineSimilarity(query[model], docVec);
      if (similarity < threshold) continue;

      let tags: string[] = [];
      try {
        if (doc.tags) tags = JSON.parse(doc.tags);
      } catch {
        tags = [];
      }
      results.push({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        category: doc.category,
        source: doc.source || undefined,
        sentimentScore: doc.sentimentScore ?? 0.0,
        tags,
        similarity: Number(similarity.toFixed(4)),
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return {
      results: results.slice(0, limit),
      method: model,
      semantic: useSemantic,
      documentsSearched: stored.length,
    };
  }

  /** Backfills real embeddings for documents stored while no model was reachable. */
  async reindex(actor: AgencyActor, batch = 50) {
    this.access.assert(actor, 'intelligence:manage');
    const documents = await this.repository.getAllKnowledgeDocumentsForSearch(
      actor.orgId
    );
    let updated = 0;
    let unavailable = false;
    for (const doc of documents) {
      if (updated >= batch) break;
      const stored = this.parseStoredEmbeddings(doc.embedding);
      const next = await this.embed(`${doc.title}\n${doc.content}`);
      const semantic = Object.keys(next).find((m) => m !== LEXICAL_MODEL);
      if (!semantic) {
        unavailable = true;
        break;
      }
      if (stored[semantic]) continue;
      await this.repository.updateKnowledgeEmbedding(
        actor.orgId,
        doc.id,
        JSON.stringify({ v2: { ...stored, ...next } })
      );
      updated++;
    }
    if (unavailable && updated === 0) {
      throw new BadRequestException(
        'No embedding model is reachable. Start Ollama (see docs) and try again.'
      );
    }
    return { updated, remaining: Math.max(0, documents.length - updated) };
  }

  /**
   * Analytics and topic clustering over stored intelligence
   */
  async getIntelligenceAnalytics(
    actor: AgencyActor
  ): Promise<IntelligenceAnalyticsSummary> {
    this.access.assert(actor, 'intelligence:read');
    const documents = await this.repository.getKnowledgeDocuments(
      actor.orgId,
      undefined,
      200
    );

    const categoryBreakdown: Record<string, number> = {};
    const topicMap: Record<
      string,
      { count: number; sentimentSum: number; sampleTitles: string[] }
    > = {};
    let totalSentiment = 0;

    for (const doc of documents) {
      categoryBreakdown[doc.category] =
        (categoryBreakdown[doc.category] || 0) + 1;
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
        if (
          topicMap[t].sampleTitles.length < 3 &&
          !topicMap[t].sampleTitles.includes(doc.title)
        ) {
          topicMap[t].sampleTitles.push(doc.title);
        }
      }
    }

    const totalDocs = documents.length;
    const avgSentiment =
      totalDocs > 0 ? Number((totalSentiment / totalDocs).toFixed(2)) : 0;
    const sentimentLabel =
      avgSentiment > 0.15
        ? 'Positive'
        : avgSentiment < -0.15
        ? 'Negative'
        : 'Neutral';

    const trendingTopics: TopicInsight[] = Object.entries(topicMap)
      .map(([topic, data]) => {
        const topicAvg = data.count > 0 ? data.sentimentSum / data.count : 0;
        const sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' =
          topicAvg > 0.15
            ? 'POSITIVE'
            : topicAvg < -0.15
            ? 'NEGATIVE'
            : 'NEUTRAL';
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
      sentimentMethod: 'keyword-lexicon',
      categoryBreakdown,
      trendingTopics,
      recentInsights,
    };
  }

  async deleteDocument(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'intelligence:manage');
    const res = await this.repository.deleteKnowledgeDocument(actor.orgId, id);
    if (res.count === 0) throw new NotFoundException('Document not found');
    await this.access.audit(actor, {
      action: 'intelligence.deleted',
      entityType: 'AgencyKnowledgeDocument',
      entityId: id,
    });
    return { deleted: res.count };
  }

  /** Retention control: remove a whole dataset, or everything older than N days. */
  async purge(
    actor: AgencyActor,
    filters: { category?: string; olderThanDays?: number }
  ) {
    this.access.assert(actor, 'intelligence:manage');
    if (!filters.category && !filters.olderThanDays) {
      throw new BadRequestException('Choose a category and/or an age to purge');
    }
    const before = filters.olderThanDays
      ? new Date(Date.now() - filters.olderThanDays * 24 * 3600 * 1000)
      : undefined;
    const res = await this.repository.purgeKnowledge(
      actor.orgId,
      filters.category,
      before
    );
    await this.access.audit(actor, {
      action: 'intelligence.purged',
      entityType: 'AgencyKnowledgeDocument',
      summary: `Removed ${res.count} document(s)`,
      metadata: {
        category: filters.category ?? null,
        olderThanDays: filters.olderThanDays ?? null,
      },
    });
    return { deleted: res.count };
  }
}
