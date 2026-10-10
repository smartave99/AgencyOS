import { Test, TestingModule } from '@nestjs/testing';
import { AgencyPortalService } from './agency.portal.service';
import { AgencyRepository } from './agency.repository';
import { CampaignStatus } from '@prisma/client';

describe('AgencyPortalService', () => {
  let service: AgencyPortalService;
  let repo: jest.Mocked<AgencyRepository>;

  const mockRepo = {
    getClientById: jest.fn(),
    getCampaigns: jest.fn(),
    getCampaignById: jest.fn(),
    updateCampaign: jest.fn(),
    getApprovals: jest.fn(),
    reviewApprovalRequest: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyPortalService,
        {
          provide: AgencyRepository,
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AgencyPortalService>(AgencyPortalService);
    repo = module.get(AgencyRepository);
    jest.clearAllMocks();
  });

  describe('Client Portal Isolation', () => {
    it('should aggregate only client-specific campaigns, clicks, and leads', async () => {
      mockRepo.getClientById.mockResolvedValue({
        id: 'cust-10',
        name: 'Sarah Connor',
        companyName: 'Cyberdyne Systems',
        email: 'sarah@cyberdyne.com',
        phone: '+15550001',
        assignedSalesUser: { name: 'John Matrix', email: 'john@agency.com' },
      } as any);

      mockRepo.getCampaigns.mockResolvedValue([
        {
          id: 'camp-1',
          name: 'Cyberdyne Launch',
          objective: 'BRAND_AWARENESS',
          status: CampaignStatus.COMPLETED,
          contentTitle: 'New AI Breakthrough',
          contentBody: 'Explore our latest automation tools.',
          destinations: [{ id: 'd1' }],
          _count: { leads: 12, publishingEvents: 5 },
        },
      ] as any);

      mockRepo.getCampaignById.mockResolvedValue({
        id: 'camp-1',
        trackingLinks: [{ totalClicks: 140 }],
        leads: [{ id: 'l1' }],
        publishingEvents: [{ status: 'SUCCESS' }],
      } as any);

      const portal = await service.getClientPortalData('org-1', 'cust-10');

      expect(portal.client.companyName).toBe('Cyberdyne Systems');
      expect(portal.metrics.totalCampaigns).toBe(1);
      expect(portal.metrics.totalLinkClicks).toBe(140);
      expect(portal.campaigns[0].name).toBe('Cyberdyne Launch');
      expect(portal.campaigns[0].totalClicks).toBe(140);
    });

    it('should allow client to approve submitted campaign creative', async () => {
      mockRepo.getCampaignById.mockResolvedValue({
        id: 'camp-1',
        customerId: 'cust-10',
        createdById: 'user-sales',
        status: CampaignStatus.SUBMITTED,
      } as any);

      mockRepo.getApprovals.mockResolvedValue([
        { id: 'appr-1', campaignId: 'camp-1', status: 'PENDING' },
      ] as any);

      const result = await service.clientReviewCampaign(
        'org-1',
        'cust-10',
        'camp-1',
        'APPROVE',
        'Looks fantastic, ready to publish!'
      );

      expect(mockRepo.updateCampaign).toHaveBeenCalledWith(
        'org-1',
        'camp-1',
        { status: CampaignStatus.APPROVED }
      );
      expect(mockRepo.reviewApprovalRequest).toHaveBeenCalledWith(
        'appr-1',
        'user-sales',
        'APPROVED',
        '[Client Feedback] Looks fantastic, ready to publish!'
      );
      expect(result.status).toBe(CampaignStatus.APPROVED);
    });
  });
});
