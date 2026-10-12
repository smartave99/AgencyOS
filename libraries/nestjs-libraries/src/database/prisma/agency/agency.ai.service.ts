import { Injectable, Logger } from '@nestjs/common';
import {
  AiChatDto,
  AiProviderId,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.settings.dto';
import {
  GenerateAdCopyDto,
  ImproveTextDto,
  CopyTone,
  CopyChannel,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';
import {
  AgencyAiGatewayService,
  AiProviderError,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.gateway.service';

export interface GeneratedAdVariants {
  headlines: string[];
  bodyVariants: string[];
  callToActions: string[];
  providerUsed: AiProviderId | 'heuristic_engine';
  model?: string | null;
  /** Why the template engine answered instead of the chosen model. */
  fallbackReason?: string;
}

const COPY_SHAPE = {
  type: 'object',
  properties: {
    headlines: { type: 'array', items: { type: 'string' }, minItems: 3 },
    bodyVariants: { type: 'array', items: { type: 'string' }, minItems: 3 },
    callToActions: { type: 'array', items: { type: 'string' }, minItems: 3 },
  },
  required: ['headlines', 'bodyVariants', 'callToActions'],
};

const ASSISTANT_PERSONA = `You are the AgencyOS assistant, built into a desktop app that advertising agencies use to create ads for their clients, get client approval, deliver approved ads to the Telegram groups and channels the agency is authorized to post in, and report the results.
You can explain, draft and advise; you cannot click buttons or change data, so say which page to open instead. Pages: Dashboard, Clients, Campaigns, Approvals, Telegram, Connected accounts, Reports, Sales pipeline, Knowledge base, Invoices, Calendar, Media library, Settings (AI and Copilot, Appearance, Storage) and Guide.
Be brief and concrete. For how-to questions give numbered steps that name the exact pages.
AgencyOS only delivers to destinations the agency is authorized to post in. Decline help with spam, unsolicited bulk messaging, getting around Telegram limits or posting where the agency has no permission, and say why.`;

@Injectable()
export class AgencyAiService {
  private readonly logger = new Logger(AgencyAiService.name);

  constructor(private readonly gateway: AgencyAiGatewayService) {}

  async generateCopy(
    orgId: string,
    params: GenerateAdCopyDto
  ): Promise<GeneratedAdVariants> {
    const tone = params.tone || CopyTone.DIRECT_RESPONSE;
    const channel = params.channelType || CopyChannel.TELEGRAM;
    const client = params.clientName || 'our brand';
    const objective = params.objective || 'LEAD_GENERATION';

    let fallbackReason: string | undefined;
    try {
      // A small model now and then answers with the wrong shape; one more try is cheap.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = await this.gateway.complete(orgId, {
          system:
            'You are an expert direct-response copywriter for advertising agencies.',
          messages: [{ role: 'user', content: this.buildPrompt(params) }],
          json: COPY_SHAPE,
          // Ad copy does not need the model to reason first, and a small local model would
          // spend its whole time budget on it.
          thinkingWhenAuto: 'off',
        });
        const variants = this.toVariants(this.gateway.parseJson(result.text));
        if (variants) {
          return {
            ...variants,
            providerUsed: result.provider,
            model: result.model,
          };
        }
        this.logger.warn(
          `${result.provider} reply did not have the three lists (attempt ${attempt}): ${result.text.slice(
            0,
            300
          )}`
        );
        fallbackReason = 'The model answered, but not in the form needed.';
      }
    } catch (e: any) {
      fallbackReason =
        e instanceof AiProviderError ? e.message : 'The AI request failed.';
      this.logger.warn(`AI copy generation fell back to templates: ${e.message}`);
    }

    // High-quality heuristic copywriting engine (zero-dependency fallback)
    return {
      ...this.generateHeuristicCopy(params, tone, channel, client, objective),
      fallbackReason,
    };
  }

  async improveText(
    orgId: string,
    params: ImproveTextDto
  ): Promise<{ improvedText: string; providerUsed: string }> {
    const tone = params.targetTone || CopyTone.DIRECT_RESPONSE;
    try {
      const result = await this.gateway.complete(orgId, {
        system:
          'You edit advertising text for Telegram. Keep the meaning and the language of the original, keep any HTML tags valid, and reply with the improved text only.',
        messages: [
          {
            role: 'user',
            content: `Tone: ${tone}\n${
              params.instructions ? `Instructions: ${params.instructions}\n` : ''
            }Text:\n${params.text}`,
          },
        ],
        thinkingWhenAuto: 'off',
      });
      return { improvedText: result.text, providerUsed: result.provider };
    } catch (e: any) {
      this.logger.debug(`AI text improvement skipped: ${e.message}`);
      return {
        improvedText: this.enhanceTextLocally(
          params.text,
          tone,
          params.instructions
        ),
        providerUsed: 'heuristic_engine',
      };
    }
  }

  /** The Copilot panel: answers a conversation with the chosen provider. */
  async chat(orgId: string, dto: AiChatDto) {
    const messages = dto.messages
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: 'Please continue.' });
    }
    const result = await this.gateway.complete(orgId, {
      system: `${ASSISTANT_PERSONA}${
        dto.page ? `\nThe person is on this page: ${dto.page}.` : ''
      }`,
      messages,
      thinkingWhenAuto: 'off',
    });
    return {
      reply: result.text,
      provider: result.provider,
      model: result.model,
      ms: result.ms,
      notes: result.notes,
    };
  }

  // Small local models sometimes answer with one string or with {text: "..."} objects
  // instead of a plain list of strings; accept those, drop anything else.
  private toVariants(
    parsed: any
  ): Pick<
    GeneratedAdVariants,
    'headlines' | 'bodyVariants' | 'callToActions'
  > | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const headlines = this.toTextList(parsed.headlines);
    const bodyVariants = this.toTextList(parsed.bodyVariants);
    const callToActions = this.toTextList(parsed.callToActions);
    return headlines.length && bodyVariants.length && callToActions.length
      ? { headlines, bodyVariants, callToActions }
      : null;
  }

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
