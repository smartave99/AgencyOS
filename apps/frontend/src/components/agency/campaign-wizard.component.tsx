'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import Link from 'next/link';

interface Client {
  id: string;
  name: string;
  companyName: string | null;
}

interface TelegramDestination {
  id: string;
  title: string;
  chatId: string;
  type: string;
  isAuthorized: boolean;
}

interface SocialIntegration {
  id: string;
  name: string;
  type: string;
  picture: string | null;
  disabled: boolean;
}

export const CampaignWizardComponent = () => {
  const fetch = useFetch();
  const router = useRouter();
  const toaster = useToaster();
  const searchParams = useSearchParams();
  const defaultClientId = searchParams.get('client') || '';

  const [step, setStep] = useState<number>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 1: Brief & Client
  const [customerId, setCustomerId] = useState(defaultClientId);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('BRAND_AWARENESS');
  const [budget, setBudget] = useState<string>('');

  // Step 2: Content Composer
  const [contentTitle, setContentTitle] = useState('');
  const [contentBody, setContentBody] = useState('');
  const [ctaLink, setCtaLink] = useState('');
  const [ctaText, setCtaText] = useState('Learn More');
  const [telegramChannelLink, setTelegramChannelLink] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Step 3: Destinations
  const [selectedTelegramDestinations, setSelectedTelegramDestinations] = useState<string[]>([]);
  const [selectedSocialIntegrations, setSelectedSocialIntegrations] = useState<string[]>([]);

  // Step 4: Schedule & Frequency
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [postingFrequency, setPostingFrequency] = useState('ONCE');

  // Step 2 AI Copilot State
  const [showAiCopilot, setShowAiCopilot] = useState(false);
  const [aiBrief, setAiBrief] = useState('');
  const [aiTone, setAiTone] = useState<'DIRECT_RESPONSE' | 'PROFESSIONAL' | 'CASUAL' | 'URGENT'>('DIRECT_RESPONSE');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiResults, setAiResults] = useState<{
    headlines: string[];
    bodyVariants: string[];
    callToActions: string[];
    providerUsed: string;
  } | null>(null);

  const handleGenerateAiCopy = async () => {
    if (!aiBrief.trim()) {
      toaster.show('Please enter a brief or product description', 'warning');
      return;
    }
    setIsGeneratingAi(true);
    try {
      const selectedClient = clients?.find((c) => c.id === customerId);
      const res = await fetch('/agency/ai/generate-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: aiBrief.trim(),
          clientName: selectedClient?.companyName || selectedClient?.name,
          objective,
          tone: aiTone,
          channelType: 'TELEGRAM',
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'AI generation failed');
      }
      const data = await res.json();
      setAiResults(data);
      toaster.show(`Copy variants generated via ${data.providerUsed}!`, 'success');
    } catch (err: any) {
      toaster.show(err.message || 'Failed to generate copy', 'warning');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  // Load Clients
  const { data: clients } = useSWR('wizard-clients', async () => {
    const res = await fetch('/agency/clients');
    if (!res.ok) return [];
    return (await res.json()) as Client[];
  });

  // Load Telegram Destinations
  const { data: telegramDests } = useSWR('wizard-telegram', async () => {
    const res = await fetch('/agency/telegram/destinations');
    if (!res.ok) return [];
    return (await res.json()) as TelegramDestination[];
  });

  // Load Social Integrations
  const { data: socialIntegrations } = useSWR('wizard-social', async () => {
    const res = await fetch('/integrations/list');
    if (!res.ok) return [];
    const json = await res.json();
    return (json.integrations || []) as SocialIntegration[];
  });

  const toggleTelegramDest = (id: string) => {
    setSelectedTelegramDestinations((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const toggleSocialDest = (id: string) => {
    setSelectedSocialIntegrations((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const handleSaveCampaign = async (submitForReview = false) => {
    if (!customerId) {
      toaster.show('Please select a client', 'warning');
      setStep(1);
      return;
    }
    if (!name.trim()) {
      toaster.show('Campaign name is required', 'warning');
      setStep(1);
      return;
    }
    if (!contentBody.trim()) {
      toaster.show('Promotional ad copy is required', 'warning');
      setStep(2);
      return;
    }

    const destinations = [
      ...selectedTelegramDestinations.map((id) => ({
        destinationType: 'TELEGRAM' as const,
        telegramDestinationId: id,
      })),
      ...selectedSocialIntegrations.map((id) => ({
        destinationType: 'SOCIAL' as const,
        integrationId: id,
      })),
    ];

    if (destinations.length === 0) {
      toaster.show('Please select at least one publishing destination', 'warning');
      setStep(3);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/agency/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          name: name.trim(),
          objective,
          budget: budget ? parseFloat(budget) : undefined,
          startDate: startDate ? new Date(startDate).toISOString() : undefined,
          endDate: endDate ? new Date(endDate).toISOString() : undefined,
          timezone,
          postingFrequency,
          contentTitle: contentTitle.trim() || undefined,
          contentBody: contentBody.trim(),
          ctaLink: ctaLink.trim() || undefined,
          ctaText: ctaText.trim() || undefined,
          telegramChannelLink: telegramChannelLink.trim() || undefined,
          internalNotes: internalNotes.trim() || undefined,
          destinations,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to create campaign');
      }

      const campaign = await res.json();

      if (submitForReview) {
        await fetch(`/agency/campaigns/${campaign.id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: 'Submitted via Campaign Wizard' }),
        });
        toaster.show('Campaign created and submitted for approval!', 'success');
      } else {
        toaster.show('Campaign draft saved successfully!', 'success');
      }

      router.push('/agency/campaigns');
    } catch (err: any) {
      toaster.show(err.message || 'Failed to save campaign', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

  const steps = [
    { num: 1, title: 'Brief & Client' },
    { num: 2, title: 'Content Composer' },
    { num: 3, title: 'Destinations' },
    { num: 4, title: 'Schedule' },
    { num: 5, title: 'Preview & Submit' },
  ];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-newBgLineColor pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/agency/campaigns" className="text-xs text-blue-400 hover:underline">
              ← Back to Campaigns
            </Link>
          </div>
          <h1 className="text-xl font-bold text-newTextColor mt-1">Advertisement Campaign Builder</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSaveCampaign(false)}
            disabled={isSubmitting}
            className="px-3.5 py-1.5 bg-newBgColor hover:bg-slate-800 text-newTextColor border border-newBgLineColor text-xs rounded-lg transition-colors"
          >
            Save Draft
          </button>
          <button
            onClick={() => handleSaveCampaign(true)}
            disabled={isSubmitting}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
          >
            Submit for Approval
          </button>
        </div>
      </div>

      {/* Stepper Header */}
      <div className="grid grid-cols-5 gap-2 bg-newBgColorInner border border-newBgLineColor rounded-xl p-2.5">
        {steps.map((s) => (
          <button
            key={s.num}
            onClick={() => setStep(s.num)}
            className={clsx(
              'flex items-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all text-left',
              step === s.num
                ? 'bg-blue-600 text-white shadow-sm'
                : step > s.num
                ? 'text-emerald-400 hover:bg-newBgColor'
                : 'text-textItemBlur hover:bg-newBgColor'
            )}
          >
            <span
              className={clsx(
                'w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold',
                step === s.num
                  ? 'bg-white text-blue-600'
                  : step > s.num
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-slate-800 text-slate-400'
              )}
            >
              {step > s.num ? '✓' : s.num}
            </span>
            <span className="truncate">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Main Wizard Form Body */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Form Area (7 cols) */}
        <div className="lg:col-span-7 bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 flex flex-col gap-5">
          {/* STEP 1: Brief & Client */}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-bold text-newTextColor border-b border-newBgLineColor pb-2">
                1. Campaign Brief & Client Assignment
              </h2>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Target Client *
                </label>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select onboarded client...</option>
                  {(clients || []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.companyName || c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Campaign Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Q4 Telegram Product Launch Announcement"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Campaign Objective
                  </label>
                  <select
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                  >
                    <option value="BRAND_AWARENESS">Brand Awareness</option>
                    <option value="COMMUNITY_GROWTH">Telegram Community Growth</option>
                    <option value="LEAD_GENERATION">Lead Generation</option>
                    <option value="WEBSITE_TRAFFIC">Website Traffic & Sales</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Planned Budget (USD)
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 500"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end pt-4 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  Next: Compose Content →
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Content Composer */}
          {step === 2 && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-newBgLineColor pb-2">
                <h2 className="text-base font-bold text-newTextColor">
                  2. Advertisement Content Composer
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAiCopilot(!showAiCopilot)}
                  className="px-3 py-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
                >
                  <span>✨ AI Copy Assistant</span>
                  <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                    {showAiCopilot ? 'Hide' : 'Open'}
                  </span>
                </button>
              </div>

              {/* AI Copilot Panel */}
              {showAiCopilot && (
                <div className="p-4 rounded-xl bg-gradient-to-b from-blue-950/30 to-indigo-950/20 border border-blue-500/30 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-blue-300 flex items-center gap-1.5">
                      <span>🤖</span> Marketing AI Copilot (Telegram & Social Optimized)
                    </span>
                    <span className="text-[10px] text-textItemBlur">
                      Powered by Ollama / Qwen & OpenAI Fallback
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div className="md:col-span-2">
                      <input
                        type="text"
                        placeholder="Brief: e.g. 50% discount on web design services for startups this week..."
                        value={aiBrief}
                        onChange={(e) => setAiBrief(e.target.value)}
                        className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={aiTone}
                        onChange={(e) => setAiTone(e.target.value as any)}
                        className="bg-newBgColor border border-newBgLineColor rounded-lg px-2.5 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500 flex-1"
                      >
                        <option value="DIRECT_RESPONSE">Direct Response</option>
                        <option value="URGENT">Urgent / Flash</option>
                        <option value="PROFESSIONAL">Professional</option>
                        <option value="CASUAL">Casual / Community</option>
                      </select>
                      <button
                        type="button"
                        disabled={isGeneratingAi}
                        onClick={handleGenerateAiCopy}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold rounded-lg shrink-0"
                      >
                        {isGeneratingAi ? 'Generating...' : 'Generate ✨'}
                      </button>
                    </div>
                  </div>

                  {/* AI Results */}
                  {aiResults && (
                    <div className="flex flex-col gap-3 pt-2 border-t border-blue-500/20 mt-1">
                      {/* Headlines */}
                      <div>
                        <span className="text-[10px] uppercase font-bold text-blue-300">
                          Recommended Headlines (Click to use):
                        </span>
                        <div className="flex flex-col gap-1.5 mt-1">
                          {aiResults.headlines.map((h, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                setContentTitle(h);
                                toaster.show('Headline applied!', 'success');
                              }}
                              className="text-left text-xs p-2 rounded-lg bg-newBgColor/80 hover:bg-blue-600/20 border border-newBgLineColor hover:border-blue-500 text-newTextColor transition-colors flex items-center justify-between"
                            >
                              <span>{h}</span>
                              <span className="text-[10px] text-blue-400 shrink-0 ml-2">Use →</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Body variants */}
                      <div>
                        <span className="text-[10px] uppercase font-bold text-blue-300">
                          Recommended Ad Copy Variants (Click to use):
                        </span>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-1">
                          {aiResults.bodyVariants.map((b, i) => (
                            <div
                              key={i}
                              className="p-2.5 rounded-lg bg-newBgColor/80 border border-newBgLineColor flex flex-col justify-between gap-2"
                            >
                              <div className="text-[11px] text-newTextColor line-clamp-4 whitespace-pre-line font-mono">
                                {b}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setContentBody(b);
                                  toaster.show('Ad copy applied!', 'success');
                                }}
                                className="w-full py-1 text-center bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white rounded text-[10px] font-semibold transition-colors"
                              >
                                Apply Variant #{i + 1}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* CTAs */}
                      <div>
                        <span className="text-[10px] uppercase font-bold text-blue-300">
                          Call-To-Action Suggestions (Click to use):
                        </span>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {aiResults.callToActions.map((cta, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                setCtaText(cta);
                                toaster.show('CTA applied!', 'success');
                              }}
                              className="px-2.5 py-1 rounded bg-newBgColor/80 hover:bg-blue-600/20 border border-newBgLineColor hover:border-blue-500 text-xs text-newTextColor"
                            >
                              {cta} <span className="text-blue-400 text-[10px] ml-1">+</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Headline / Title (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. 🚀 Introducing the Next Generation of AI Tools"
                  value={contentTitle}
                  onChange={(e) => setContentTitle(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-textItemBlur uppercase">
                    Promotional Ad Copy (HTML supported) *
                  </label>
                  <span className="text-[10px] text-textItemBlur">
                    {contentBody.length} / 4096 chars
                  </span>
                </div>
                <textarea
                  rows={6}
                  placeholder="Enter your ad copy here. Use <b>bold</b>, <i>italic</i>, and emojis..."
                  value={contentBody}
                  onChange={(e) => setContentBody(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500 resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Call To Action Button Text
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Join Community / Claim Discount"
                    value={ctaText}
                    onChange={(e) => setCtaText(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Landing Page / Destination URL
                  </label>
                  <input
                    type="url"
                    placeholder="https://clientwebsite.com/promo"
                    value={ctaLink}
                    onChange={(e) => setCtaLink(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Direct Telegram Channel / Community Link
                </label>
                <input
                  type="text"
                  placeholder="https://t.me/yourcommunity"
                  value={telegramChannelLink}
                  onChange={(e) => setTelegramChannelLink(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 border border-newBgLineColor text-xs text-textItemBlur rounded-lg hover:text-newTextColor"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  Next: Select Destinations →
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: Destinations */}
          {step === 3 && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-bold text-newTextColor border-b border-newBgLineColor pb-2">
                3. Authorized Publishing Destinations
              </h2>

              {/* Telegram Channels & Groups */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-newTextColor">
                    Telegram Channels & Supergroups
                  </span>
                  <Link href="/agency/telegram" className="text-[11px] text-blue-400 hover:underline">
                    + Onboard new chat
                  </Link>
                </div>

                {!telegramDests || telegramDests.length === 0 ? (
                  <div className="p-4 rounded-lg bg-newBgColor border border-newBgLineColor text-xs text-textItemBlur text-center">
                    No authorized Telegram destinations registered yet.{' '}
                    <Link href="/agency/telegram" className="text-blue-400 hover:underline">
                      Verify a group or channel now →
                    </Link>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {telegramDests.map((dest) => (
                      <label
                        key={dest.id}
                        className={clsx(
                          'p-3 rounded-lg border flex items-center justify-between cursor-pointer transition-all',
                          selectedTelegramDestinations.includes(dest.id)
                            ? 'bg-blue-600/10 border-blue-500/40 text-newTextColor'
                            : 'bg-newBgColor border-newBgLineColor text-textItemBlur hover:border-slate-700'
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={selectedTelegramDestinations.includes(dest.id)}
                            onChange={() => toggleTelegramDest(dest.id)}
                            className="rounded text-blue-600"
                          />
                          <div>
                            <div className="text-xs font-medium text-newTextColor">{dest.title}</div>
                            <div className="text-[10px] text-textItemBlur uppercase">{dest.type}</div>
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                          Authorized
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Social Media Accounts */}
              <div className="flex flex-col gap-2 mt-2">
                <span className="text-xs font-semibold text-newTextColor">
                  Connected Social Accounts (Postiz Sockets)
                </span>

                {!socialIntegrations || socialIntegrations.length === 0 ? (
                  <div className="p-4 rounded-lg bg-newBgColor border border-newBgLineColor text-xs text-textItemBlur text-center">
                    No social media accounts connected.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {socialIntegrations.map((soc) => (
                      <label
                        key={soc.id}
                        className={clsx(
                          'p-3 rounded-lg border flex items-center justify-between cursor-pointer transition-all',
                          selectedSocialIntegrations.includes(soc.id)
                            ? 'bg-blue-600/10 border-blue-500/40 text-newTextColor'
                            : 'bg-newBgColor border-newBgLineColor text-textItemBlur hover:border-slate-700'
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={selectedSocialIntegrations.includes(soc.id)}
                            onChange={() => toggleSocialDest(soc.id)}
                            className="rounded text-blue-600"
                          />
                          <div>
                            <div className="text-xs font-medium text-newTextColor">{soc.name}</div>
                            <div className="text-[10px] text-textItemBlur uppercase">{soc.type}</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-4 py-2 border border-newBgLineColor text-xs text-textItemBlur rounded-lg hover:text-newTextColor"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  Next: Schedule & Frequency →
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Schedule */}
          {step === 4 && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-bold text-newTextColor border-b border-newBgLineColor pb-2">
                4. Scheduling & Posting Windows
              </h2>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Start Date & Time
                  </label>
                  <input
                    type="datetime-local"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    End Date (Optional)
                  </label>
                  <input
                    type="datetime-local"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Posting Frequency
                  </label>
                  <select
                    value={postingFrequency}
                    onChange={(e) => setPostingFrequency(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                  >
                    <option value="ONCE">One-time Broadcast</option>
                    <option value="DAILY">Daily Posting</option>
                    <option value="WEEKLY">Weekly Cadence</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Timezone
                  </label>
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">Eastern Time (ET)</option>
                    <option value="America/Los_Angeles">Pacific Time (PT)</option>
                    <option value="Europe/London">London (GMT/BST)</option>
                    <option value="Asia/Dubai">Dubai (GST)</option>
                    <option value="Asia/Kolkata">India (IST)</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-4 py-2 border border-newBgLineColor text-xs text-textItemBlur rounded-lg hover:text-newTextColor"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(5)}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  Next: Review & Preview →
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: Review & Submit */}
          {step === 5 && (
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-bold text-newTextColor border-b border-newBgLineColor pb-2">
                5. Campaign Summary & Manager Submission
              </h2>

              <div className="flex flex-col gap-3 text-xs">
                <div className="flex justify-between py-2 border-b border-newBgLineColor/60">
                  <span className="text-textItemBlur">Campaign Name</span>
                  <span className="font-semibold text-newTextColor">{name || 'Untitled'}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-newBgLineColor/60">
                  <span className="text-textItemBlur">Client</span>
                  <span className="font-semibold text-newTextColor">
                    {clients?.find((c) => c.id === customerId)?.companyName || 'None selected'}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-newBgLineColor/60">
                  <span className="text-textItemBlur">Destinations</span>
                  <span className="font-semibold text-newTextColor">
                    {selectedTelegramDestinations.length} Telegram, {selectedSocialIntegrations.length} Social
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-newBgLineColor/60">
                  <span className="text-textItemBlur">Estimated Budget</span>
                  <span className="font-bold text-emerald-400">
                    {budget ? `$${budget}` : 'Not specified'}
                  </span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300">
                Submitting this campaign will route it to the <strong>Approval Inbox</strong>. Once approved by a Campaign Manager, the Temporal scheduler will execute the scheduled broadcasts.
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="px-4 py-2 border border-newBgLineColor text-xs text-textItemBlur rounded-lg hover:text-newTextColor"
                >
                  ← Back
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleSaveCampaign(false)}
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-newBgColor hover:bg-slate-800 text-newTextColor border border-newBgLineColor text-xs rounded-lg"
                  >
                    Save as Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveCampaign(true)}
                    disabled={isSubmitting}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                  >
                    Submit for Approval
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Preview Canvas (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-newBgLineColor pb-2.5">
              <span className="text-xs font-bold text-newTextColor uppercase tracking-wider flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
                </svg>
                Live Telegram Preview
              </span>
              <span className="text-[10px] text-textItemBlur">Real-time bubble render</span>
            </div>

            {/* Telegram Chat Simulation */}
            <div className="rounded-xl bg-[#0e1621] p-4 text-white flex flex-col gap-2 shadow-inner border border-slate-800 min-h-[300px]">
              {/* Message Bubble */}
              <div className="bg-[#182533] rounded-2xl rounded-tl-sm p-3.5 max-w-[95%] self-start shadow-md flex flex-col gap-2">
                {contentTitle && (
                  <div className="font-bold text-sm text-sky-400">
                    {contentTitle}
                  </div>
                )}

                <div className="text-xs text-slate-100 whitespace-pre-wrap leading-relaxed">
                  {contentBody || 'Your promotional ad copy will render here as you type...'}
                </div>

                {ctaLink && (
                  <div className="pt-2 border-t border-slate-700/60 mt-1">
                    <a
                      href={ctaLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-center py-2 px-3 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-xs font-semibold transition-colors"
                    >
                      {ctaText || 'Learn More'} ↗
                    </a>
                  </div>
                )}

                {telegramChannelLink && (
                  <div>
                    <a
                      href={telegramChannelLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-center py-1.5 px-3 bg-[#242f3d] hover:bg-[#2b394a] text-sky-400 rounded-lg text-xs font-medium border border-slate-700/50 transition-colors"
                    >
                      Join Telegram Community
                    </a>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 self-end mt-0.5">
                  12:00 PM • AgencyOS Bot
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
