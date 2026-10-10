'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface TopicInsight {
  topic: string;
  count: number;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  sampleTitles: string[];
}

interface IntelligenceAnalyticsSummary {
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
    createdAt: string;
  }[];
}

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  source?: string;
  sentimentScore: number;
  tags: string[];
  similarity: number;
}

export const AgencyIntelligenceComponent: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();

  const [loading, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState<IntelligenceAnalyticsSummary | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCategory, setSearchCategory] = useState<string>('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  // Ingest modal
  const [showIngestModal, setShowIngestModal] = useState(false);
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestCategory, setIngestCategory] = useState('DISCUSSION');
  const [ingestSource, setIngestSource] = useState('');
  const [ingestTags, setIngestTags] = useState('');
  const [ingestContent, setIngestContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const res = await (await fetch('/agency/intelligence')).json();
      setAnalytics(res);
    } catch {
      toast.show('Failed to load discussion intelligence', 'warning');
    } finally {
      setLoading(false);
    }
  }, [fetch, toast]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    try {
      setSearching(true);
      const res = await (
        await fetch('/agency/intelligence/search', {
          method: 'POST',
          body: JSON.stringify({
            query: searchQuery,
            category: searchCategory || undefined,
            threshold: 0.1,
          }),
        })
      ).json();
      setSearchResults(Array.isArray(res) ? res : []);
    } catch {
      toast.show('Semantic vector search failed', 'warning');
    } finally {
      setSearching(false);
    }
  };

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestTitle.trim() || !ingestContent.trim()) {
      toast.show('Title and content are required', 'warning');
      return;
    }

    try {
      setSubmitting(true);
      const tagList = ingestTags
        ? ingestTags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

      await fetch('/agency/intelligence/ingest', {
        method: 'POST',
        body: JSON.stringify({
          title: ingestTitle,
          category: ingestCategory,
          source: ingestSource || undefined,
          tags: tagList,
          content: ingestContent,
        }),
      });

      toast.show('Document ingested & vector embedded successfully', 'success');
      setShowIngestModal(false);
      setIngestTitle('');
      setIngestContent('');
      setIngestTags('');
      setIngestSource('');
      await loadAnalytics();
    } catch {
      toast.show('Failed to ingest knowledge document', 'warning');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this document from vector memory?')) return;
    try {
      await fetch(`/agency/intelligence/${id}`, { method: 'DELETE' });
      toast.show('Document removed from vector memory', 'success');
      await loadAnalytics();
      if (searchResults) {
        setSearchResults((prev) => (prev ? prev.filter((d) => d.id !== id) : null));
      }
    } catch {
      toast.show('Failed to delete document', 'warning');
    }
  };

  if (loading && !analytics) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6 text-white max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">Discussion Analytics & Semantic AI</h1>
            <span className="rounded-full bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-400 border border-purple-500/30">
              Module E — Neural Knowledge
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Vector embeddings, aggregate sentiment analysis, and semantic discovery across authorized Telegram groups and campaign knowledge.
          </p>
        </div>
        <button
          onClick={() => setShowIngestModal(true)}
          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-primary/90 transition-all flex items-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          + Ingest Dataset / Document
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-400">Total Indexed Documents</span>
            <span className="rounded-full bg-blue-500/10 p-2 text-blue-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
          </div>
          <p className="mt-3 text-2xl font-bold text-white">{analytics?.totalDocuments || 0}</p>
          <p className="mt-1 text-xs text-gray-500">Vector memory embeddings</p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-400">Discussion Sentiment</span>
            <span className={`rounded-full p-2 text-xs font-bold ${
              (analytics?.averageSentiment || 0) > 0.15 ? 'bg-emerald-500/10 text-emerald-400' :
              (analytics?.averageSentiment || 0) < -0.15 ? 'bg-rose-500/10 text-rose-400' : 'bg-gray-500/10 text-gray-400'
            }`}>
              {analytics?.sentimentLabel || 'Neutral'}
            </span>
          </div>
          <p className="mt-3 text-2xl font-bold text-white">
            {((analytics?.averageSentiment || 0) * 100).toFixed(0)}% Index
          </p>
          <p className="mt-1 text-xs text-gray-500">Aggregate audience sentiment</p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-400">Topic Clusters</span>
            <span className="rounded-full bg-purple-500/10 p-2 text-purple-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
            </span>
          </div>
          <p className="mt-3 text-2xl font-bold text-white">{analytics?.trendingTopics?.length || 0}</p>
          <p className="mt-1 text-xs text-gray-500">Extracted theme clusters</p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-400">Embedding Engine</span>
            <span className="rounded-full bg-amber-500/10 p-2 text-amber-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/></svg>
            </span>
          </div>
          <p className="mt-3 text-2xl font-bold text-white">Dense 128D</p>
          <p className="mt-1 text-xs text-gray-500">Cosine similarity vector space</p>
        </div>
      </div>

      {/* Semantic Vector Search Section */}
      <div className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">Semantic Knowledge & Discussion Search</h2>
            <p className="text-xs text-gray-400">Ask natural language questions or search topics to find mathematically matching discussion documents.</p>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="e.g. 'What are members saying about crypto token prices?' or 'Client brand tone rules'..."
              className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-primary focus:outline-none"
            />
          </div>
          <select
            value={searchCategory}
            onChange={(e) => setSearchCategory(e.target.value)}
            className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2.5 text-sm text-gray-300 focus:border-primary focus:outline-none"
          >
            <option value="">All Categories</option>
            <option value="DISCUSSION">Group Discussions</option>
            <option value="CAMPAIGN_BRIEF">Campaign Briefs</option>
            <option value="FAQ">Client FAQs</option>
            <option value="SOP">Agency SOPs</option>
            <option value="MARKET_RESEARCH">Market Research</option>
          </select>
          <button
            type="submit"
            disabled={searching}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary/90 transition-all flex items-center justify-center gap-2"
          >
            {searching ? 'Computing Vectors...' : 'Semantic Search'}
          </button>
        </form>

        {/* Search Results Display */}
        {searchResults !== null && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2">
              <span className="text-xs font-semibold text-gray-400">
                Found {searchResults.length} relevant documents (ranked by cosine similarity)
              </span>
              <button
                onClick={() => setSearchResults(null)}
                className="text-xs text-primary hover:underline"
              >
                Clear Search
              </button>
            </div>

            {searchResults.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">No documents matched your semantic threshold. Try ingesting more content or broadening terms.</p>
            ) : (
              searchResults.map((res) => (
                <div key={res.id} className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 hover:border-gray-700 transition-all">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary">
                        {(res.similarity * 100).toFixed(1)}% Match
                      </span>
                      <h3 className="font-semibold text-white">{res.title}</h3>
                    </div>
                    <span className="text-xs rounded bg-gray-800 px-2 py-0.5 text-gray-300">
                      {res.category}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{res.content}</p>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center gap-2">
                      {res.source && <span>Source: {res.source}</span>}
                      {res.tags && res.tags.length > 0 && (
                        <div className="flex gap-1">
                          {res.tags.map((t, idx) => (
                            <span key={idx} className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-400">
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(res.id)}
                      className="text-rose-400 hover:text-rose-300 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Trending Topics & Discussion Clusters */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm">
          <h2 className="text-lg font-bold text-white mb-1">Trending Discussion Topics</h2>
          <p className="text-xs text-gray-400 mb-4">Extracted keywords from authorized community discussions with audience sentiment.</p>

          <div className="space-y-3">
            {(!analytics?.trendingTopics || analytics.trendingTopics.length === 0) ? (
              <p className="text-sm text-gray-500 py-6 text-center">No discussion topics detected yet. Ingest chat feeds to see clusters.</p>
            ) : (
              analytics.trendingTopics.map((topic, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/30 p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white capitalize">#{topic.topic}</span>
                      <span className="text-xs text-gray-500">({topic.count} mentions)</span>
                    </div>
                    {topic.sampleTitles.length > 0 && (
                      <p className="text-xs text-gray-400 mt-1 truncate max-w-sm">
                        Mentioned in: {topic.sampleTitles.join(', ')}
                      </p>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    topic.sentiment === 'POSITIVE' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                    topic.sentiment === 'NEGATIVE' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                    'bg-gray-500/10 text-gray-400 border border-gray-500/20'
                  }`}>
                    {topic.sentiment}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recently Ingested Documents */}
        <div className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm">
          <h2 className="text-lg font-bold text-white mb-1">Recent Knowledge Documents</h2>
          <p className="text-xs text-gray-400 mb-4">Knowledge items stored in your agency vector memory.</p>

          <div className="space-y-3">
            {(!analytics?.recentInsights || analytics.recentInsights.length === 0) ? (
              <p className="text-sm text-gray-500 py-6 text-center">Vector memory is empty. Click '+ Ingest Dataset' above.</p>
            ) : (
              analytics.recentInsights.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/30 p-3">
                  <div>
                    <h4 className="font-semibold text-white text-sm">{doc.title}</h4>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-400">{doc.category}</span>
                      {doc.source && <span>• {doc.source}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(doc.id)}
                    className="text-xs text-rose-400 hover:text-rose-300"
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Ingest Modal */}
      {showIngestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-[#1a1b22] p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 pb-4">
              <h3 className="text-lg font-bold text-white">Ingest Dataset / Knowledge Document</h3>
              <button
                onClick={() => setShowIngestModal(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleIngest} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">Document Title *</label>
                <input
                  type="text"
                  required
                  value={ingestTitle}
                  onChange={(e) => setIngestTitle(e.target.value)}
                  placeholder="e.g. Q4 Telegram Chat Summary or Client Guidelines"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">Category</label>
                  <select
                    value={ingestCategory}
                    onChange={(e) => setIngestCategory(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                  >
                    <option value="DISCUSSION">Group Discussion</option>
                    <option value="CAMPAIGN_BRIEF">Campaign Brief</option>
                    <option value="FAQ">Client FAQ</option>
                    <option value="SOP">Agency SOP</option>
                    <option value="MARKET_RESEARCH">Market Research</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1">Source (Optional)</label>
                  <input
                    type="text"
                    value={ingestSource}
                    onChange={(e) => setIngestSource(e.target.value)}
                    placeholder="e.g. Telegram Supergroup"
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">Topic Tags (comma-separated)</label>
                <input
                  type="text"
                  value={ingestTags}
                  onChange={(e) => setIngestTags(e.target.value)}
                  placeholder="e.g. crypto, fees, pricing, growth"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">Content / Discussion Text *</label>
                <textarea
                  required
                  rows={5}
                  value={ingestContent}
                  onChange={(e) => setIngestContent(e.target.value)}
                  placeholder="Paste authorized discussion transcripts, customer questions, or marketing knowledge..."
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none font-sans"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowIngestModal(false)}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
                >
                  {submitting ? 'Generating Vectors...' : 'Embed & Ingest'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
