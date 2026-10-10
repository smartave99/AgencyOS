import { Injectable, NotFoundException } from '@nestjs/common';
import { AgencyRepository } from './agency.repository';

export interface PlatformCapability {
  identifier: string;
  name: string;
  description: string;
  maxTextLength: number;
  supportsImages: boolean;
  supportsVideos: boolean;
  maxVideoDurationSeconds?: number;
  supportsLinks: boolean;
  supportsFormatting: 'MARKDOWN_HTML' | 'PLAIN_TEXT' | 'LIMITED';
  destinationTypes: ('GROUP' | 'CHANNEL' | 'PAGE' | 'PROFILE' | 'COMMUNITY')[];
  supportsDirectMessage: boolean;
  schedulingSupported: boolean;
  rateLimitPerMinute: number;
  complianceNotes: string;
}

export interface AccountHealthSummary {
  id: string;
  name: string;
  provider: string;
  profile?: string;
  client?: { id: string; name: string; companyName?: string };
  healthStatus: 'HEALTHY' | 'NEEDS_REFRESH' | 'EXPIRED' | 'DISABLED';
  tokenExpiration?: Date;
  refreshNeeded: boolean;
  disabled: boolean;
  capabilities: PlatformCapability;
}

@Injectable()
export class AgencyPlatformsService {
  constructor(private readonly repository: AgencyRepository) {}

  /**
   * Official Capability Registry for all advertising and publishing destinations
   */
  private readonly platformRegistry: Record<string, PlatformCapability> = {
    telegram: {
      identifier: 'telegram',
      name: 'Telegram (Groups & Channels)',
      description: 'Authorized broadcast channels, supergroups, and sponsored community placements via Bot API.',
      maxTextLength: 4096,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 1800,
      supportsLinks: true,
      supportsFormatting: 'MARKDOWN_HTML',
      destinationTypes: ['CHANNEL', 'GROUP'],
      supportsDirectMessage: false, // Strict anti-spam: no unsolicited DMs
      schedulingSupported: true,
      rateLimitPerMinute: 20,
      complianceNotes: 'Requires explicit bot administrator permissions. No unsolicited member scraping or bulk DMs.',
    },
    x: {
      identifier: 'x',
      name: 'X (Twitter)',
      description: 'Public sponsored tweets, micro-threads, and branded announcements.',
      maxTextLength: 280,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 140,
      supportsLinks: true,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PROFILE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 15,
      complianceNotes: 'Subject to X v2 API tier rate limits. Media must adhere to 512MB video limits.',
    },
    linkedin: {
      identifier: 'linkedin',
      name: 'LinkedIn (Company Pages & Profiles)',
      description: 'B2B sponsored posts, thought leadership, and corporate agency campaigns.',
      maxTextLength: 3000,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 600,
      supportsLinks: true,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PAGE', 'PROFILE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 25,
      complianceNotes: 'Requires organization administrator rights for Company Pages.',
    },
    facebook: {
      identifier: 'facebook',
      name: 'Facebook Pages',
      description: 'Sponsored updates, community link cards, and visual carousels.',
      maxTextLength: 63206,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 14400,
      supportsLinks: true,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PAGE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 30,
      complianceNotes: 'Page management permission required. Meta review needed for advanced ads API.',
    },
    instagram: {
      identifier: 'instagram',
      name: 'Instagram (Business & Creator)',
      description: 'Visual feed posts, carousel ads, and Reels.',
      maxTextLength: 2200,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 900,
      supportsLinks: false, // In-caption links are non-clickable
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PROFILE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 20,
      complianceNotes: 'Requires Instagram Business account linked to a Facebook Page. In-caption links are not hyperlinks.',
    },
    youtube: {
      identifier: 'youtube',
      name: 'YouTube Community & Shorts',
      description: 'Video releases, Community Tab announcements, and Shorts.',
      maxTextLength: 5000,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 43200,
      supportsLinks: true,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['CHANNEL'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 10,
      complianceNotes: 'Subject to YouTube Data API v3 daily quota units.',
    },
    tiktok: {
      identifier: 'tiktok',
      name: 'TikTok Commercial',
      description: 'Short-form promotional video content and sponsored creator clips.',
      maxTextLength: 2200,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 600,
      supportsLinks: false,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PROFILE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 10,
      complianceNotes: 'Direct post API requires video asset upload and TikTok verification.',
    },
    pinterest: {
      identifier: 'pinterest',
      name: 'Pinterest Business',
      description: 'Product pins, promotional idea boards, and visual traffic drivers.',
      maxTextLength: 500,
      supportsImages: true,
      supportsVideos: true,
      maxVideoDurationSeconds: 900,
      supportsLinks: true,
      supportsFormatting: 'PLAIN_TEXT',
      destinationTypes: ['PAGE'],
      supportsDirectMessage: false,
      schedulingSupported: true,
      rateLimitPerMinute: 20,
      complianceNotes: 'Destination board and valid destination landing URL required.',
    },
  };

  /**
   * Return the complete list of supported platform capabilities
   */
  getPlatformCapabilities(): PlatformCapability[] {
    return Object.values(this.platformRegistry);
  }

  getCapability(platformId: string): PlatformCapability {
    const key = platformId.toLowerCase();
    return (
      this.platformRegistry[key] || {
        identifier: key,
        name: key.toUpperCase(),
        description: 'Standard social network channel.',
        maxTextLength: 1000,
        supportsImages: true,
        supportsVideos: false,
        supportsLinks: true,
        supportsFormatting: 'PLAIN_TEXT',
        destinationTypes: ['PROFILE'],
        supportsDirectMessage: false,
        schedulingSupported: true,
        rateLimitPerMinute: 10,
        complianceNotes: 'Standard API limits apply.',
      }
    );
  }

  /**
   * Return connected accounts with real-time health diagnostic
   */
  async getConnectedAccounts(orgId: string): Promise<AccountHealthSummary[]> {
    const integrations = await this.repository.getConnectedIntegrations(orgId);

    return integrations.map((it) => {
      let healthStatus: 'HEALTHY' | 'NEEDS_REFRESH' | 'EXPIRED' | 'DISABLED' = 'HEALTHY';

      if (it.disabled) {
        healthStatus = 'DISABLED';
      } else if (it.refreshNeeded) {
        healthStatus = 'NEEDS_REFRESH';
      } else if (it.tokenExpiration && new Date(it.tokenExpiration) < new Date()) {
        healthStatus = 'EXPIRED';
      }

      return {
        id: it.id,
        name: it.customName || it.name,
        provider: it.providerIdentifier,
        profile: it.profile || undefined,
        client: it.customer
          ? {
              id: it.customer.id,
              name: it.customer.name,
              companyName: it.customer.companyName || undefined,
            }
          : undefined,
        healthStatus,
        tokenExpiration: it.tokenExpiration || undefined,
        refreshNeeded: it.refreshNeeded,
        disabled: it.disabled,
        capabilities: this.getCapability(it.providerIdentifier),
      };
    });
  }

  /**
   * Associate a connected social channel to a specific agency client
   */
  async assignAccountClient(orgId: string, integrationId: string, customerId: string) {
    const existing = await this.repository.getIntegrationById(orgId, integrationId);
    if (!existing) {
      throw new NotFoundException(`Connected account ${integrationId} not found`);
    }

    return this.repository.updateIntegrationCustomer(orgId, integrationId, customerId);
  }

  /**
   * Diagnostic test on connected account
   */
  async testAccountConnection(orgId: string, integrationId: string) {
    const account = await this.repository.getIntegrationById(orgId, integrationId);
    if (!account) {
      throw new NotFoundException(`Connected account ${integrationId} not found`);
    }

    const isExpired = account.tokenExpiration && new Date(account.tokenExpiration) < new Date();
    const isHealthy = !account.disabled && !account.refreshNeeded && !isExpired;

    return {
      id: account.id,
      name: account.name,
      provider: account.providerIdentifier,
      healthy: isHealthy,
      message: isHealthy
        ? 'Account connection active and authorized for scheduled publishing.'
        : account.disabled
        ? 'Account has been explicitly disabled.'
        : isExpired
        ? 'OAuth token expired. Re-authentication required.'
        : 'Token refresh needed before publishing.',
      testedAt: new Date(),
    };
  }
}
