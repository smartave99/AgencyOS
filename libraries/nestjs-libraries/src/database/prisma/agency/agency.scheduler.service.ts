import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgencyService } from './agency.service';

@Injectable()
export class AgencySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgencySchedulerService.name);
  private intervalRef: NodeJS.Timeout | null = null;

  constructor(private readonly agencyService: AgencyService) {}

  onModuleInit() {
    this.logger.log('AgencySchedulerService initialized. Starting background campaign delivery monitor...');
    // Initial check on boot
    this.checkScheduledCampaigns();

    // Check every 60 seconds for scheduled campaigns ready to publish
    this.intervalRef = setInterval(() => {
      this.checkScheduledCampaigns();
    }, 60000);
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  async checkScheduledCampaigns() {
    try {
      const processedCount = await this.agencyService.processScheduledCampaigns();
      if (processedCount > 0) {
        this.logger.log(`Autonomous Scheduler: Successfully published ${processedCount} scheduled campaign(s).`);
      }
    } catch (err: any) {
      this.logger.error(`Error in autonomous campaign scheduler: ${err?.message}`);
    }
  }
}
