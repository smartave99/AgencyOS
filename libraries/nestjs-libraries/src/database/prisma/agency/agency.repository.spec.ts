import { AgencyRepository } from './agency.repository';
import { PrismaService } from '../prisma.service';
import { CampaignStatus } from '@prisma/client';

describe('AgencyRepository - Data Access & Query Gating', () => {
  let repository: AgencyRepository;
  let mockPrisma: any;

  const mockOrgId = 'org-test-999';

  beforeEach(() => {
    mockPrisma = {
      customer: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      campaign: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      campaignDestination: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      approvalRequest: {
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      telegramDestination: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      publishingEvent: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        groupBy: jest.fn(),
      },
      integration: {
        count: jest.fn(),
      },
      leadCapture: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    repository = new AgencyRepository(mockPrisma as PrismaService);
  });

  describe('Campaign Queries', () => {
    it('should query campaigns scoped by orgId and exclude deleted rows', async () => {
      mockPrisma.campaign.findMany.mockResolvedValue([]);

      await repository.getCampaigns(mockOrgId, { status: CampaignStatus.APPROVED });

      expect(mockPrisma.campaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orgId: mockOrgId,
            deletedAt: null,
            status: CampaignStatus.APPROVED,
          }),
        })
      );
    });

    it('should fetch single campaign scoped by orgId and id', async () => {
      mockPrisma.campaign.findFirst.mockResolvedValue({ id: 'camp-1', orgId: mockOrgId });

      const res = await repository.getCampaignById(mockOrgId, 'camp-1');

      expect(mockPrisma.campaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-1', orgId: mockOrgId, deletedAt: null },
        })
      );
      expect(res?.id).toEqual('camp-1');
    });
  });

  describe('Publishing Event & Idempotency Key Access', () => {
    it('should query publishing event by deterministic idempotency key', async () => {
      const mockKey = 'camp_101_dest_202';
      mockPrisma.publishingEvent.findFirst.mockResolvedValue({
        id: 'evt-1',
        idempotencyKey: mockKey,
        status: 'SUCCESS',
      });

      const res = await repository.getPublishingEventByIdempotencyKey(mockKey);

      expect(mockPrisma.publishingEvent.findFirst).toHaveBeenCalledWith({
        where: { idempotencyKey: mockKey },
      });
      expect(res?.status).toEqual('SUCCESS');
    });

    it('should create publishing event receipt with timestamp and status', async () => {
      mockPrisma.publishingEvent.create.mockResolvedValue({
        id: 'evt-new',
        status: 'SUCCESS',
      });

      await repository.recordPublishingEvent({
        campaignId: 'camp-101',
        telegramDestinationId: 'tg-202',
        externalMessageId: '98765',
        status: 'SUCCESS',
        idempotencyKey: 'camp_101_dest_202',
      });

      expect(mockPrisma.publishingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          campaignId: 'camp-101',
          telegramDestinationId: 'tg-202',
          externalMessageId: '98765',
          status: 'SUCCESS',
          idempotencyKey: 'camp_101_dest_202',
        }),
      });
    });
  });

  describe('Dashboard Metrics Aggregation', () => {
    it('should aggregate active clients, campaigns, and delivery telemetry', async () => {
      mockPrisma.customer.count.mockResolvedValue(12);
      mockPrisma.campaign.count
        .mockResolvedValueOnce(5)  // active
        .mockResolvedValueOnce(20); // total
      mockPrisma.approvalRequest.count.mockResolvedValue(2);
      mockPrisma.telegramDestination.count.mockResolvedValue(8);
      mockPrisma.integration.count.mockResolvedValue(4);
      mockPrisma.publishingEvent.groupBy.mockResolvedValue([
        { status: 'SUCCESS', _count: { status: 150 } },
        { status: 'FAILED', _count: { status: 3 } },
      ]);
      mockPrisma.campaign.findMany.mockResolvedValue([]);
      mockPrisma.publishingEvent.findMany.mockResolvedValue([]);

      const metrics = await repository.getDashboardMetrics(mockOrgId);

      expect(metrics.activeClientsCount).toEqual(12);
      expect(metrics.activeCampaignsCount).toEqual(5);
      expect(metrics.totalCampaignsCount).toEqual(20);
      expect(metrics.pendingApprovalsCount).toEqual(2);
      expect(metrics.telegramDestinationsCount).toEqual(8);
      expect(metrics.connectedSocialCount).toEqual(4);
      expect(metrics.successfulPosts).toEqual(150);
      expect(metrics.failedPosts).toEqual(3);
      expect(metrics.deliveryRate).toBeGreaterThan(95);
    });
  });
});
