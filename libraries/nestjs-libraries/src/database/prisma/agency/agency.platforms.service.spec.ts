import { Test, TestingModule } from '@nestjs/testing';
import { AgencyPlatformsService } from './agency.platforms.service';
import { AgencyRepository } from './agency.repository';

describe('AgencyPlatformsService', () => {
  let service: AgencyPlatformsService;
  let repo: jest.Mocked<AgencyRepository>;

  const mockRepo = {
    getConnectedIntegrations: jest.fn(),
    getIntegrationById: jest.fn(),
    updateIntegrationCustomer: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyPlatformsService,
        {
          provide: AgencyRepository,
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AgencyPlatformsService>(AgencyPlatformsService);
    repo = module.get(AgencyRepository);
    jest.clearAllMocks();
  });

  describe('Capability Registry', () => {
    it('should return complete official capability specifications for all networks', () => {
      const capabilities = service.getPlatformCapabilities();
      expect(capabilities.length).toBeGreaterThanOrEqual(8);

      const telegram = capabilities.find((c) => c.identifier === 'telegram');
      expect(telegram).toBeDefined();
      expect(telegram?.supportsFormatting).toBe('MARKDOWN_HTML');
      expect(telegram?.destinationTypes).toContain('CHANNEL');
      expect(telegram?.destinationTypes).toContain('GROUP');
      expect(telegram?.supportsDirectMessage).toBe(false); // anti-spam verification

      const x = capabilities.find((c) => c.identifier === 'x');
      expect(x?.maxTextLength).toBe(280);

      const linkedin = capabilities.find((c) => c.identifier === 'linkedin');
      expect(linkedin?.destinationTypes).toContain('PAGE');
    });
  });

  describe('Account Health Diagnostics', () => {
    it('should mark active connections as HEALTHY', async () => {
      mockRepo.getConnectedIntegrations.mockResolvedValue([
        {
          id: 'int-1',
          name: 'Agency Telegram Bot',
          customName: 'Main Agency Bot',
          providerIdentifier: 'telegram',
          disabled: false,
          refreshNeeded: false,
          tokenExpiration: new Date(Date.now() + 864000000),
          customer: { id: 'cust-1', name: 'Acme Corp', companyName: 'Acme' },
        },
      ] as any);

      const accounts = await service.getConnectedAccounts('org-1');
      expect(accounts[0].healthStatus).toBe('HEALTHY');
      expect(accounts[0].name).toBe('Main Agency Bot');
      expect(accounts[0].capabilities.identifier).toBe('telegram');
    });

    it('should flag expired tokens as EXPIRED', async () => {
      mockRepo.getConnectedIntegrations.mockResolvedValue([
        {
          id: 'int-2',
          name: 'Old Twitter OAuth',
          providerIdentifier: 'x',
          disabled: false,
          refreshNeeded: false,
          tokenExpiration: new Date(Date.now() - 10000), // in the past
          customer: null,
        },
      ] as any);

      const accounts = await service.getConnectedAccounts('org-1');
      expect(accounts[0].healthStatus).toBe('EXPIRED');
    });
  });
});
