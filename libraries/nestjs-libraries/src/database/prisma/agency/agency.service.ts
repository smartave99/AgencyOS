import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgencyRepository,
  CreateCampaignParams,
  CreateClientParams,
  CreateTelegramDestinationParams,
  UpdateCampaignParams,
  UpdateClientParams,
} from './agency.repository';
import { CampaignStatus } from '@prisma/client';
import TelegramBot from 'node-telegram-bot-api';

@Injectable()
export class AgencyService {
  private telegramBot: TelegramBot | null = null;

  constructor(private agencyRepo: AgencyRepository) {
    if (process.env.TELEGRAM_TOKEN) {
      try {
        this.telegramBot = new TelegramBot(process.env.TELEGRAM_TOKEN);
      } catch (e) {
        console.warn('AgencyService: Telegram bot initialized without token');
      }
    }
  }

  // ==========================================
  // CLIENTS
  // ==========================================
  async getClients(orgId: string, search?: string) {
    return this.agencyRepo.getClients(orgId, search);
  }

  async getClientById(orgId: string, id: string) {
    const client = await this.agencyRepo.getClientById(orgId, id);
    if (!client) {
      throw new NotFoundException(`Client with ID ${id} not found`);
    }
    return client;
  }

  async createClient(orgId: string, params: CreateClientParams) {
    if (!params.name || params.name.trim().length === 0) {
      throw new BadRequestException('Client name is required');
    }
    return this.agencyRepo.createClient(orgId, params);
  }

  async updateClient(orgId: string, id: string, params: UpdateClientParams) {
    await this.getClientById(orgId, id);
    return this.agencyRepo.updateClient(orgId, id, params);
  }

  async deleteClient(orgId: string, id: string) {
    await this.getClientById(orgId, id);
    return this.agencyRepo.deleteClient(orgId, id);
  }

  // ==========================================
  // CAMPAIGNS
  // ==========================================
  async getCampaigns(
    orgId: string,
    filters?: { status?: CampaignStatus; customerId?: string; search?: string }
  ) {
    return this.agencyRepo.getCampaigns(orgId, filters);
  }

  async getCampaignById(orgId: string, id: string) {
    const campaign = await this.agencyRepo.getCampaignById(orgId, id);
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    }
    return campaign;
  }

  async createCampaign(orgId: string, userId: string, params: Omit<CreateCampaignParams, 'createdById'>) {
    if (!params.name || params.name.trim().length === 0) {
      throw new BadRequestException('Campaign name is required');
    }
    if (!params.customerId) {
      throw new BadRequestException('Customer / Client ID is required');
    }
    if (!params.contentBody || params.contentBody.trim().length === 0) {
      throw new BadRequestException('Campaign promotional content is required');
    }

    // Verify client belongs to org
    await this.getClientById(orgId, params.customerId);

    return this.agencyRepo.createCampaign(orgId, {
      ...params,
      createdById: userId,
    });
  }

  async updateCampaign(orgId: string, id: string, params: UpdateCampaignParams) {
    const campaign = await this.getCampaignById(orgId, id);

    // Business rule: Completed or cancelled campaigns cannot be modified without reopening
    if (campaign.status === CampaignStatus.COMPLETED || campaign.status === CampaignStatus.CANCELLED) {
      throw new BadRequestException(`Cannot edit campaign in ${campaign.status} status`);
    }

    return this.agencyRepo.updateCampaign(orgId, id, params);
  }

  async updateCampaignDestinations(
    orgId: string,
    campaignId: string,
    destinations: Array<{
      destinationType: 'TELEGRAM' | 'SOCIAL';
      telegramDestinationId?: string;
      integrationId?: string;
      customSettings?: string;
    }>
  ) {
    await this.getCampaignById(orgId, campaignId);
    return this.agencyRepo.updateCampaignDestinations(campaignId, destinations);
  }

  async deleteCampaign(orgId: string, id: string) {
    await this.getCampaignById(orgId, id);
    return this.agencyRepo.deleteCampaign(orgId, id);
  }

  // ==========================================
  // WORKFLOW & APPROVALS
  // ==========================================
  async submitForApproval(orgId: string, campaignId: string, userId: string, notes?: string) {
    const campaign = await this.getCampaignById(orgId, campaignId);

    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.CHANGES_REQUESTED) {
      throw new BadRequestException(
        `Only campaigns in DRAFT or CHANGES_REQUESTED status can be submitted (Current: ${campaign.status})`
      );
    }

    if (!campaign.destinations || campaign.destinations.length === 0) {
      throw new BadRequestException('Campaign must have at least one target destination before submission');
    }

    // Update campaign status to SUBMITTED
    await this.agencyRepo.updateCampaign(orgId, campaignId, {
      status: CampaignStatus.SUBMITTED,
    });

    // Create Approval record
    return this.agencyRepo.createApprovalRequest(campaignId, userId, notes);
  }

  async getApprovals(orgId: string, status?: string) {
    return this.agencyRepo.getApprovals(orgId, status);
  }

  async reviewCampaign(
    orgId: string,
    approvalId: string,
    reviewerUserId: string,
    decision: 'APPROVE' | 'REJECT',
    notes?: string
  ) {
    const approvals = await this.agencyRepo.getApprovals(orgId);
    const approval = approvals.find((a) => a.id === approvalId);

    if (!approval) {
      throw new NotFoundException(`Approval request ${approvalId} not found`);
    }

    if (approval.status !== 'PENDING') {
      throw new BadRequestException(`Approval request is already resolved (${approval.status})`);
    }

    const newApprovalStatus = decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
    const newCampaignStatus = decision === 'APPROVE' ? CampaignStatus.APPROVED : CampaignStatus.CHANGES_REQUESTED;

    await this.agencyRepo.updateCampaign(orgId, approval.campaignId, {
      status: newCampaignStatus,
    });

    return this.agencyRepo.reviewApprovalRequest(approvalId, reviewerUserId, newApprovalStatus, notes);
  }

  async scheduleCampaign(orgId: string, campaignId: string) {
    const campaign = await this.getCampaignById(orgId, campaignId);

    if (campaign.status !== CampaignStatus.APPROVED) {
      throw new BadRequestException(
        `Only APPROVED campaigns can be scheduled for publishing. Current status: ${campaign.status}`
      );
    }

    if (!campaign.startDate) {
      throw new BadRequestException('Campaign start date is required to schedule');
    }

    // Transition status to SCHEDULED
    return this.agencyRepo.updateCampaign(orgId, campaignId, {
      status: CampaignStatus.SCHEDULED,
    });
  }

  async publishCampaignNow(orgId: string, campaignId: string) {
    const campaign = await this.getCampaignById(orgId, campaignId);

    // Workflow Gate: Only APPROVED, SCHEDULED, or PUBLISHING campaigns can be published
    if (
      campaign.status !== CampaignStatus.APPROVED &&
      campaign.status !== CampaignStatus.SCHEDULED &&
      campaign.status !== CampaignStatus.PUBLISHING
    ) {
      throw new BadRequestException(
        `Only APPROVED or SCHEDULED campaigns can be published. Current status: ${campaign.status}`
      );
    }

    if (!campaign.destinations || campaign.destinations.length === 0) {
      throw new BadRequestException('Campaign has no target destinations configured');
    }

    // Set campaign status to PUBLISHING
    await this.agencyRepo.updateCampaign(orgId, campaignId, {
      status: CampaignStatus.PUBLISHING,
    });

    let successCount = 0;
    let failureCount = 0;

    for (const dest of campaign.destinations) {
      if (dest.destinationType === 'TELEGRAM' && dest.telegramDestination) {
        const tgDest = dest.telegramDestination;

        // Verify active posting authorization
        if (!tgDest.isAuthorized || !tgDest.canPostMessages) {
          await this.agencyRepo.recordPublishingEvent({
            campaignId,
            telegramDestinationId: tgDest.id,
            status: 'FAILED',
            errorMessage: 'Destination bot lacks active posting authorization',
          });
          failureCount++;
          continue;
        }

        // Idempotency check: deterministic key per campaign + destination
        const idempotencyKey = `camp_${campaign.id}_dest_${dest.id}`;
        const existingEvent = await this.agencyRepo.getPublishingEventByIdempotencyKey(idempotencyKey);
        if (existingEvent && existingEvent.status === 'SUCCESS') {
          // Already successfully published, skip
          successCount++;
          continue;
        }

        // Format message
        let text = '';
        if (campaign.contentTitle) {
          text += `<b>${campaign.contentTitle}</b>\n\n`;
        }
        text += campaign.contentBody;
        if (campaign.ctaText && campaign.ctaLink) {
          text += `\n\n👉 <a href="${campaign.ctaLink}">${campaign.ctaText}</a>`;
        } else if (campaign.ctaLink) {
          text += `\n\n🔗 ${campaign.ctaLink}`;
        } else if (campaign.telegramChannelLink) {
          text += `\n\n📢 ${campaign.telegramChannelLink}`;
        }

        try {
          let messageId: string | undefined;

          if (this.telegramBot) {
            let mediaList: string[] = [];
            try {
              mediaList = campaign.contentMedia ? JSON.parse(campaign.contentMedia) : [];
            } catch {
              mediaList = campaign.contentMedia ? [campaign.contentMedia] : [];
            }

            if (mediaList.length > 0) {
              const res = await this.telegramBot.sendPhoto(tgDest.chatId, mediaList[0], {
                caption: text,
                parse_mode: 'HTML',
              });
              messageId = String(res.message_id);
            } else {
              const res = await this.telegramBot.sendMessage(tgDest.chatId, text, {
                parse_mode: 'HTML',
              });
              messageId = String(res.message_id);
            }
          } else {
            // Local dev without live Telegram token
            messageId = `simulated_${Date.now()}`;
          }

          await this.agencyRepo.recordPublishingEvent({
            campaignId,
            telegramDestinationId: tgDest.id,
            externalMessageId: messageId,
            status: 'SUCCESS',
            idempotencyKey,
          });

          await this.agencyRepo.updateTelegramDestination(orgId, tgDest.id, {
            lastError: undefined,
          });

          successCount++;
        } catch (publishErr: any) {
          const errMsg = publishErr?.message || 'Telegram API transmission error';
          await this.agencyRepo.recordPublishingEvent({
            campaignId,
            telegramDestinationId: tgDest.id,
            status: 'FAILED',
            errorMessage: errMsg,
            idempotencyKey,
          });

          await this.agencyRepo.updateTelegramDestination(orgId, tgDest.id, {
            lastError: errMsg,
          });

          failureCount++;
        }
      }
    }

    const finalStatus =
      failureCount > 0 && successCount === 0
        ? CampaignStatus.FAILED
        : CampaignStatus.COMPLETED;

    return this.agencyRepo.updateCampaign(orgId, campaignId, {
      status: finalStatus,
    });
  }

  // ==========================================
  // TELEGRAM DESTINATIONS & VERIFICATION
  // ==========================================
  async getTelegramDestinations(orgId: string) {
    return this.agencyRepo.getTelegramDestinations(orgId);
  }

  async verifyTelegramChat(chatId: string): Promise<{
    valid: boolean;
    title: string;
    type: string;
    botIsAdmin: boolean;
    canPostMessages: boolean;
    canDeleteMessages: boolean;
    canInviteUsers: boolean;
    error?: string;
  }> {
    if (!this.telegramBot) {
      return {
        valid: false,
        title: '',
        type: '',
        botIsAdmin: false,
        canPostMessages: false,
        canDeleteMessages: false,
        canInviteUsers: false,
        error: 'TELEGRAM_TOKEN environment variable is not configured',
      };
    }

    try {
      const chat = await this.telegramBot.getChat(chatId);
      const botMe = await this.telegramBot.getMe();
      const chatMember = await this.telegramBot.getChatMember(chat.id, botMe.id);

      const isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
      const canPost = isAdmin
        ? chatMember.status === 'creator' || !!chatMember.can_post_messages || chat.type === 'group' || chat.type === 'supergroup'
        : false;
      const canDelete = isAdmin ? chatMember.status === 'creator' || !!chatMember.can_delete_messages : false;
      const canInvite = isAdmin ? chatMember.status === 'creator' || !!chatMember.can_invite_users : false;

      return {
        valid: true,
        title: chat.title || chat.username || String(chat.id),
        type: chat.type,
        botIsAdmin: isAdmin,
        canPostMessages: canPost,
        canDeleteMessages: canDelete,
        canInviteUsers: canInvite,
      };
    } catch (error: any) {
      return {
        valid: false,
        title: '',
        type: '',
        botIsAdmin: false,
        canPostMessages: false,
        canDeleteMessages: false,
        canInviteUsers: false,
        error: error?.message || 'Failed to verify Telegram chat',
      };
    }
  }

  async registerTelegramDestination(orgId: string, params: CreateTelegramDestinationParams) {
    // If bot is active, verify beforehand
    const verification = await this.verifyTelegramChat(params.chatId);
    if (!verification.valid && this.telegramBot) {
      throw new BadRequestException(`Could not verify Telegram destination: ${verification.error}`);
    }

    return this.agencyRepo.createTelegramDestination(orgId, {
      ...params,
      title: verification.valid && verification.title ? verification.title : params.title,
      type: verification.valid && verification.type ? verification.type : params.type,
      canPostMessages: verification.canPostMessages,
      canDeleteMessages: verification.canDeleteMessages,
      canInviteUsers: verification.canInviteUsers,
    });
  }

  async deleteTelegramDestination(orgId: string, id: string) {
    const dest = await this.agencyRepo.getTelegramDestinationById(orgId, id);
    if (!dest) {
      throw new NotFoundException(`Destination ${id} not found`);
    }
    return this.agencyRepo.deleteTelegramDestination(orgId, id);
  }

  // ==========================================
  // EXECUTIVE DASHBOARD
  // ==========================================
  async getDashboard(orgId: string) {
    return this.agencyRepo.getDashboardMetrics(orgId);
  }

  // ==========================================
  // PUBLISHING EVENTS & LOGS
  // ==========================================
  async getPublishingEvents(orgId: string, campaignId?: string) {
    return this.agencyRepo.getPublishingEvents(orgId, campaignId);
  }
}
