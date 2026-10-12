import { Injectable, Logger } from '@nestjs/common';
import {
  GenerateAdCopyDto,
  ImproveTextDto,
  CopyTone,
  CopyChannel,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';

export interface GeneratedAdVariants {
  headlines: string[];
  bodyVariants: string[];
  callToActions: string[];
  providerUsed: 'ollama' | 'openai' | 'heuristic_engine';
}

@Injectable()
export class AgencyAiService {
  private readonly logger = new Logger(AgencyAiService.name);
  // OLLAMA_HOST / AI_MODEL are the documented names (.env.agencyos.example); the
  // older OLLAMA_URL / OLLAMA_MODEL are still honoured.
  private readonly ollamaUrl =
    process.env.OLLAMA_HOST ||
    process.env.OLLAMA_URL ||
    'http://localhost:11434';
  private readonly ollamaModel =
    process.env.AI_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  private readonly openaiApiKey = process.env.OPENAI_API_KEY;

  async generateCopy(params: GenerateAdCopyDto): Promise<GeneratedAdVariants> {
    const tone = params.tone || CopyTone.DIRECT_RESPONSE;
    const channel = params.channelType || CopyChannel.TELEGRAM;
    const client = params.clientName || 'our brand';
    const objective = params.objective || 'LEAD_GENERATION';

    // 1. Try local Ollama if configured
    try {
      const ollamaResponse = await this.tryOllama(params);
      if (ollamaResponse) {
        return { ...ollamaResponse, providerUsed: 'ollama' };
      }
    } catch (e: any) {
      this.logger.debug(`Ollama generation skipped: ${e.message}`);
    }

    // 2. Try OpenAI if API key provided
    if (this.openaiApiKey) {
      try {
        const openAiResponse = await this.tryOpenAi(params);
        if (openAiResponse) {
          return { ...openAiResponse, providerUsed: 'openai' };
        }
      } catch (e: any) {
        this.logger.warn(`OpenAI generation skipped: ${e.message}`);
      }
    }

    // 3. High-quality Heuristic Copywriting Engine (zero-dependency fallback)
    return this.generateHeuristicCopy(params, tone, channel, client, objective);
  }

  async improveText(
    params: ImproveTextDto
  ): Promise<{ improvedText: string; providerUsed: string }> {
    const tone = params.targetTone || CopyTone.DIRECT_RESPONSE;

    // Check Ollama or fallback to tone-enhanced text
    return {
      improvedText: this.enhanceTextLocally(
        params.text,
        tone,
        params.instructions
      ),
      providerUsed: 'heuristic_engine',
    };
  }

  // ==========================================
  // OLLAMA PROVIDER
  // ==========================================
  private async tryOllama(
    params: GenerateAdCopyDto
  ): Promise<Omit<GeneratedAdVariants, 'providerUsed'> | null> {
    const controller = new AbortController();
    // A 3B model on a CPU-only machine needs tens of seconds (model load + generation);
    // a few seconds would make local AI always fall through to the template engine.
    const timeoutMs =
      Number.parseInt(process.env.AGENCY_AI_TIMEOUT_MS || '', 10) || 90000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const prompt = this.buildPrompt(params);

    try {
      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt,
          stream: false,
          format: 'json',
          // Models that can "think" first (Gemma 4, Qwen 3) would spend the time budget on
          // reasoning the ad copy does not need.
          think: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        this.logger.warn(
          `Ollama generate answered ${res.status}: ${(await res.text()).slice(
            0,
            200
          )}`
        );
        return null;
      }
      const data = await res.json();
      const parsed = JSON.parse(data.response);
      const headlines = this.toTextList(parsed.headlines);
      const bodyVariants = this.toTextList(parsed.bodyVariants);
      const callToActions = this.toTextList(parsed.callToActions);
      if (headlines.length && bodyVariants.length && callToActions.length) {
        return { headlines, bodyVariants, callToActions };
      }
      this.logger.warn(
        `Ollama reply did not have the three lists: ${String(
          data.response
        ).slice(0, 300)}`
      );
      return null;
    } catch (e: any) {
      clearTimeout(timeoutId);
      this.logger.warn(`Ollama generation failed: ${e.message}`);
      return null;
    }
  }

  // Small local models sometimes answer with one string or with {text: "..."} objects
  // instead of a plain list of strings; accept those, drop anything else.
  private toTextList(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items
      .map((x: any) =>
        typeof x === 'string'
          ? x
          : x && typeof x === 'object'
          ? x.text || x.headline || x.body || x.cta || x.content
          : ''
      )
      .filter((x: unknown): x is string => typeof x === 'string' && !!x.trim());
  }

  // ==========================================
  // OPENAI PROVIDER
  // ==========================================
  private async tryOpenAi(
    params: GenerateAdCopyDto
  ): Promise<Omit<GeneratedAdVariants, 'providerUsed'> | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const prompt = this.buildPrompt(params);

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert direct-response copywriter for advertising agencies. Return valid JSON only with keys: headlines (array of 3 strings), bodyVariants (array of 3 formatted strings), callToActions (array of 3 strings).',
            },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) return null;
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content);
      if (parsed.headlines && parsed.bodyVariants && parsed.callToActions) {
        return parsed;
      }
      return null;
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
  }

  // ==========================================
  // HEURISTIC COPYWRITING ENGINE
  // ==========================================
  private generateHeuristicCopy(
    params: GenerateAdCopyDto,
    tone: CopyTone,
    channel: CopyChannel,
    client: string,
    objective: string
  ): GeneratedAdVariants {
    const briefClean = params.brief.trim();

    if (tone === CopyTone.URGENT) {
      return {
        headlines: [
          `⚡ Limited Access: ${client} Unveils Special Offer`,
          `⏳ Final Window: Don't Miss Out on ${client}`,
          `🔥 Urgent Update: Exclusive Opportunity from ${client}`,
        ],
        bodyVariants: [
          `🚨 <b>TIME-SENSITIVE ANNOUNCEMENT</b>\n\n${briefClean}\n\n⚡ <i>Spots and allocations are strictly limited. Take action before registration closes!</i>\n\n📌 <b>What You Get:</b>\n• Immediate priority access\n• Dedicated support channel\n• Guaranteed member perks`,
          `⏰ <b>ACT FAST — CLOSING SOON</b>\n\nLooking for results? ${client} just announced: \n\n${briefClean}\n\n👉 Secure your spot now before the window closes.`,
          `🔥 <b>FLASH CAMPAIGN FOR OUR COMMUNITY</b>\n\nWe have partnered with ${client} to bring you this exclusive offer:\n\n${briefClean}\n\n⚠️ Only available for the next 48 hours. Don't wait!`,
        ],
        callToActions: [
          'Claim Your Spot Now ⚡',
          'Access Limited Offer Before It Ends ⏳',
          'Join Immediately 👉',
        ],
        providerUsed: 'heuristic_engine',
      };
    }

    if (tone === CopyTone.PROFESSIONAL) {
      return {
        headlines: [
          `Leading Solution: How ${client} Delivers Measurable Results`,
          `Strategic Advisory: The New Standard from ${client}`,
          `Industry Briefing: Verified Insights from ${client}`,
        ],
        bodyVariants: [
          `<b>EXECUTIVE BRIEFING</b>\n\n${briefClean}\n\n<b>Key Advantages:</b>\n• Enterprise-grade execution and reliability\n• Proven ROI across client engagements\n• Seamless integration with your current workflow\n\nDiscover how ${client} sets the standard for modern growth.`,
          `<b>INDUSTRY UPDATE</b>\n\nOrganizations trust ${client} to drive critical performance outcomes.\n\n${briefClean}\n\nSchedule a consultation with our team to evaluate strategic fit.`,
          `<b>VERIFIED SOLUTIONS</b>\n\nIn a competitive landscape, precision matters. ${client} delivers:\n\n${briefClean}\n\nExplore our client case studies and performance metrics.`,
        ],
        callToActions: [
          'Schedule an Executive Briefing 📊',
          'Learn More & View Case Studies 🔍',
          'Contact Our Advisory Team 🤝',
        ],
        providerUsed: 'heuristic_engine',
      };
    }

    if (tone === CopyTone.CASUAL) {
      return {
        headlines: [
          `Hey community! Check out what ${client} just launched 👇`,
          `Game-changer alert: ${client} is making waves 🌊`,
          `Have you seen this from ${client}? 👀`,
        ],
        bodyVariants: [
          `Hey everyone! 👋\n\nWe wanted to share something exciting that our friends at ${client} just dropped:\n\n${briefClean}\n\nDrop a comment or check out the link below to get all the details! 👇`,
          `Quick heads-up for the group! 💡\n\nIf you've been looking for an easier way forward, ${client} has you covered:\n\n${briefClean}\n\nSuper impressed by this — highly recommend checking it out!`,
          `Can we talk about this for a second? 🔥\n\n${client} just made things 10x easier:\n\n${briefClean}\n\nTap below to explore! 🚀`,
        ],
        callToActions: [
          'Check It Out Here! 🚀',
          'Tap Here to Learn More 👇',
          'Join the Discussion 💬',
        ],
        providerUsed: 'heuristic_engine',
      };
    }

    // Default: DIRECT_RESPONSE (High conversion)
    return {
      headlines: [
        `Unlock Rapid Results with ${client}: Proven & Guaranteed`,
        `The Fastest Way to Scale: How ${client} Solves Your Biggest Bottleneck`,
        `Special Announcement: Transform Your Growth with ${client}`,
      ],
      bodyVariants: [
        `🚀 <b>ATTENTION: SPECIAL ANNOUNCEMENT</b>\n\n${briefClean}\n\n✅ <b>Why it works:</b>\n• Proven direct response framework\n• Zero fluff, 100% focused on outcome\n• Backed by verified track record\n\n👉 Click below to claim your access today!`,
        `🎯 <b>STOP STRUGGLING WITH LOW CONVERSIONS</b>\n\nHere is how ${client} changes the equation:\n\n${briefClean}\n\nGet started now and see the difference within 24 hours.`,
        `💡 <b>PROVEN BLUEPRINT FOR SUCCESS</b>\n\nWe partnered with ${client} to bring you this game-changing offer:\n\n${briefClean}\n\n👇 Click the link below to unlock immediate access!`,
      ],
      callToActions: [
        'Get Instant Access Now 👉',
        'Claim Exclusive Offer 🎁',
        'Start Your Journey with Us 🚀',
      ],
      providerUsed: 'heuristic_engine',
    };
  }

  private enhanceTextLocally(
    text: string,
    tone: CopyTone,
    instructions?: string
  ): string {
    const clean = text.trim();
    if (tone === CopyTone.URGENT) {
      return `⚡ <b>TIME SENSITIVE:</b> ${clean}\n\n<i>Act quickly before this opportunity closes.</i>`;
    }
    if (tone === CopyTone.PROFESSIONAL) {
      return `<b>Executive Summary:</b> ${clean}\n\n<i>Contact our team for detailed documentation.</i>`;
    }
    return `🚀 <b>Featured Update:</b> ${clean}\n\n👉 <i>Tap below to learn more!</i>`;
  }

  private buildPrompt(params: GenerateAdCopyDto): string {
    return `You are an expert direct-response copywriter for advertising agencies.
Reply with JSON only, in exactly this shape: {"headlines": ["...", "...", "..."], "bodyVariants": ["...", "...", "..."], "callToActions": ["...", "...", "..."]}
Every list holds 3 plain strings. Generate 3 ad headlines, 3 ad body variants, and 3 call-to-actions based on this brief:
Brief: ${params.brief}
Client: ${params.clientName || 'General'}
Industry: ${params.industry || 'General'}
Objective: ${params.objective || 'Lead Generation'}
Tone: ${params.tone || 'Direct Response'}
Channel Format: ${
      params.channelType ||
      'Telegram (HTML formatting like <b>bold</b>, <i>italic</i>, and emojis)'
    }
Target Audience: ${params.targetAudience || 'General'}`;
  }
}
