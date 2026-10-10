import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgencyService } from './agency.service';
import { AgencyRepository } from './agency.repository';
import { CampaignStatus } from '@prisma/client';

describe('AgencyService - Core Business Logic & Workflow Gating', () => {
  let service: AgencyService;
  let mockRepo: Partial<jest.Mocked<AgencyRepository>>;

  const mockOrgId = 'org-agency-101';
  const mockUserId = 'user-sales-202';
  const mockCustomerId = 'cust-client-303';
  const mockCampaignId = 'camp-promo-404';

  beforeEach(() => {
    mockRepo = {
      getClientById: jest.fn(),
      getCampaignById: jest.fn(),
      createCampaign: jest.fn(),
      updateCampaign: jest.fn(),
      updateCampaignDestinations: jest.fn(),
      createApprovalRequest: jest.fn(),
      getApprovals: jest.fn(),
      reviewApprovalRequest: jest.fn(),
      getTelegramDestinationById: jest.fn(),
      recordPublishingEvent: jest.fn(),
      getPublishingEventByIdempotencyKey: jest.fn(),
      updateTelegramDestination: jest.fn(),
    };

    service = new AgencyService(mockRepo as AgencyRepository);
  });

  describe('1. Campaign Creation & Input Validation', () => {
    it('should throw BadRequestException if campaign name is missing or empty', async () => {
      await expect(
        service.createCampaign(mockOrgId, mockUserId, {
          name: '   ',
          customerId: mockCustomerId,
          contentBody: 'Promotional announcement text',
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if customer ID is missing', async () => {
      await expect(
        service.createCampaign(mockOrgId, mockUserId, {
          name: 'Summer Flash Sale',
          customerId: '',
          contentBody: 'Promotional announcement text',
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if content body is missing', async () => {
      await expect(
        service.createCampaign(mockOrgId, mockUserId, {
          name: 'Summer Flash Sale',
          customerId: mockCustomerId,
          contentBody: '   ',
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if client does not belong to organization', async () => {
      (mockRepo.getClientById as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createCampaign(mockOrgId, mockUserId, {
          name: 'Summer Flash Sale',
          customerId: mockCustomerId,
          contentBody: 'Special promo deal!',
        })
      ).rejects.toThrow(NotFoundException);
    });

    it('should create campaign in DRAFT status when parameters are valid', async () => {
      const mockClient = { id: mockCustomerId, name: 'Apex Logistics', orgId: mockOrgId };
      (mockRepo.getClientById as jest.Mock).mockResolvedValue(mockClient as any);

      const createdMock = {
        id: mockCampaignId,
        orgId: mockOrgId,
        name: 'Summer Flash Sale',
        customerId: mockCustomerId,
        status: CampaignStatus.DRAFT,
        contentBody: 'Special 50% discount offer',
      };
      (mockRepo.createCampaign as jest.Mock).mockResolvedValue(createdMock as any);

      const result = await service.createCampaign(mockOrgId, mockUserId, {
        name: 'Summer Flash Sale',
        customerId: mockCustomerId,
        contentBody: 'Special 50% discount offer',
      });

      expect(result.status).toEqual(CampaignStatus.DRAFT);
      expect(mockRepo.createCampaign).toHaveBeenCalledWith(
        mockOrgId,
        expect.objectContaining({
          name: 'Summer Flash Sale',
          createdById: mockUserId,
        })
      );
    });
  });

  describe('2. Approval Workflow Gating', () => {
    it('should reject submitting a campaign that has no target destinations', async () => {
      const draftCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.DRAFT,
        destinations: [],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(draftCampaign as any);

      await expect(
        service.submitForApproval(mockOrgId, mockCampaignId, mockUserId, 'Review required')
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject submitting a campaign that is already SUBMITTED or APPROVED', async () => {
      const approvedCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.APPROVED,
        destinations: [{ id: 'dest-1' }],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(approvedCampaign as any);

      await expect(
        service.submitForApproval(mockOrgId, mockCampaignId, mockUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it('should successfully submit DRAFT campaign and transition status to SUBMITTED', async () => {
      const draftCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.DRAFT,
        destinations: [{ id: 'dest-1', destinationType: 'TELEGRAM' }],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(draftCampaign as any);
      (mockRepo.updateCampaign as jest.Mock).mockResolvedValue({
        ...draftCampaign,
        status: CampaignStatus.SUBMITTED,
      } as any);
      (mockRepo.createApprovalRequest as jest.Mock).mockResolvedValue({
        id: 'appr-505',
        campaignId: mockCampaignId,
        status: 'PENDING',
      } as any);

      const result = await service.submitForApproval(mockOrgId, mockCampaignId, mockUserId, 'Ready for manager');

      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        mockOrgId,
        mockCampaignId,
        { status: CampaignStatus.SUBMITTED }
      );
      expect(mockRepo.createApprovalRequest).toHaveBeenCalledWith(
        mockCampaignId,
        mockUserId,
        'Ready for manager'
      );
      expect(result.status).toEqual('PENDING');
    });

    it('manager review: should transition campaign to APPROVED when manager approves', async () => {
      const pendingApproval = {
        id: 'appr-505',
        campaignId: mockCampaignId,
        status: 'PENDING',
      };
      (mockRepo.getApprovals as jest.Mock).mockResolvedValue([pendingApproval] as any);
      (mockRepo.updateCampaign as jest.Mock).mockResolvedValue({
        id: mockCampaignId,
        status: CampaignStatus.APPROVED,
      } as any);
      (mockRepo.reviewApprovalRequest as jest.Mock).mockResolvedValue({
        ...pendingApproval,
        status: 'APPROVED',
      } as any);

      const result = await service.reviewCampaign(
        mockOrgId,
        'appr-505',
        'user-manager-888',
        'APPROVE',
        'Looks excellent, approved!'
      );

      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        mockOrgId,
        mockCampaignId,
        { status: CampaignStatus.APPROVED }
      );
      expect(mockRepo.reviewApprovalRequest).toHaveBeenCalledWith(
        'appr-505',
        'user-manager-888',
        'APPROVED',
        'Looks excellent, approved!'
      );
    });

    it('manager review: should transition campaign to CHANGES_REQUESTED when rejected', async () => {
      const pendingApproval = {
        id: 'appr-505',
        campaignId: mockCampaignId,
        status: 'PENDING',
      };
      (mockRepo.getApprovals as jest.Mock).mockResolvedValue([pendingApproval] as any);

      await service.reviewCampaign(
        mockOrgId,
        'appr-505',
        'user-manager-888',
        'REJECT',
        'Please adjust promotional pricing'
      );

      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        mockOrgId,
        mockCampaignId,
        { status: CampaignStatus.CHANGES_REQUESTED }
      );
    });
  });

  describe('3. Scheduling & Publishing Execution Gates', () => {
    it('should reject scheduling if campaign is not in APPROVED status', async () => {
      const draftCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.DRAFT,
        startDate: new Date(),
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(draftCampaign as any);

      await expect(
        service.scheduleCampaign(mockOrgId, mockCampaignId)
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject scheduling if campaign has no start date', async () => {
      const approvedCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.APPROVED,
        startDate: null,
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(approvedCampaign as any);

      await expect(
        service.scheduleCampaign(mockOrgId, mockCampaignId)
      ).rejects.toThrow(BadRequestException);
    });

    it('should transition approved campaign to SCHEDULED status', async () => {
      const approvedCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.APPROVED,
        startDate: new Date(),
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(approvedCampaign as any);
      (mockRepo.updateCampaign as jest.Mock).mockResolvedValue({
        ...approvedCampaign,
        status: CampaignStatus.SCHEDULED,
      } as any);

      const res = await service.scheduleCampaign(mockOrgId, mockCampaignId);
      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        mockOrgId,
        mockCampaignId,
        { status: CampaignStatus.SCHEDULED }
      );
    });

    it('publish execution: should reject publishing an unapproved campaign (DRAFT)', async () => {
      const draftCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        status: CampaignStatus.DRAFT,
        destinations: [{ id: 'dest-1' }],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(draftCampaign as any);

      await expect(
        service.publishCampaignNow(mockOrgId, mockCampaignId)
      ).rejects.toThrow(BadRequestException);
    });

    it('publish execution: should reject unauthorized Telegram destination', async () => {
      const approvedCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        version: 1,
        status: CampaignStatus.APPROVED,
        contentBody: 'Live test message',
        destinations: [
          {
            id: 'dest-1',
            destinationType: 'TELEGRAM',
            telegramDestination: {
              id: 'tg-dest-99',
              isAuthorized: false, // Unauthorized!
              canPostMessages: false,
            },
          },
        ],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(approvedCampaign as any);
      (mockRepo.updateCampaign as jest.Mock).mockResolvedValue({} as any);
      (mockRepo.recordPublishingEvent as jest.Mock).mockResolvedValue({} as any);

      await service.publishCampaignNow(mockOrgId, mockCampaignId);

      expect(mockRepo.recordPublishingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: mockCampaignId,
          telegramDestinationId: 'tg-dest-99',
          status: 'FAILED',
          errorMessage: expect.stringContaining('lacks active posting authorization'),
        })
      );
    });

    it('publish execution: should enforce idempotency and skip duplicate delivery', async () => {
      const approvedCampaign = {
        id: mockCampaignId,
        orgId: mockOrgId,
        version: 1,
        status: CampaignStatus.APPROVED,
        contentBody: 'Live test message',
        destinations: [
          {
            id: 'dest-1',
            destinationType: 'TELEGRAM',
            telegramDestination: {
              id: 'tg-dest-99',
              chatId: '-1001234567890',
              isAuthorized: true,
              canPostMessages: true,
            },
          },
        ],
      };
      (mockRepo.getCampaignById as jest.Mock).mockResolvedValue(approvedCampaign as any);
      (mockRepo.updateCampaign as jest.Mock).mockResolvedValue({} as any);

      // Existing success event with matching deterministic idempotency key
      const expectedKey = `camp_${mockCampaignId}_dest_dest-1_v1`;
      (mockRepo.getPublishingEventByIdempotencyKey as jest.Mock).mockResolvedValue({
        id: 'event-already-sent',
        idempotencyKey: expectedKey,
        status: 'SUCCESS',
      } as any);

      await service.publishCampaignNow(mockOrgId, mockCampaignId);

      // Verify that NO new publishing event or duplicate send was recorded
      expect(mockRepo.recordPublishingEvent).not.toHaveBeenCalled();
      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        mockOrgId,
        mockCampaignId,
        { status: CampaignStatus.COMPLETED }
      );
    });
  });
});
