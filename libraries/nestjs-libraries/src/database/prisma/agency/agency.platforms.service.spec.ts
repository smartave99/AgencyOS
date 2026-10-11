import { AgencyPlatformsService } from './agency.platforms.service';

// Registry content only; account listing, ownership checks and tenancy are covered by the integration specs.
describe('AgencyPlatformsService capability registry', () => {
  const service = new AgencyPlatformsService({} as any, {} as any);

  it('documents Telegram accurately: HTML formatting, channels and groups, and no direct messages', () => {
    const telegram = service
      .getPlatformCapabilities()
      .find((c) => c.identifier === 'telegram');
    expect(telegram).toMatchObject({
      catalogued: true,
      maxTextLength: 4096,
      supportsFormatting: 'MARKDOWN_HTML',
      supportsDirectMessage: false,
    });
    expect(telegram!.destinationTypes).toEqual(
      expect.arrayContaining(['CHANNEL', 'GROUP'])
    );
  });

  it('covers the networks the product lists', () => {
    const ids = service.getPlatformCapabilities().map((c) => c.identifier);
    expect(ids).toEqual(
      expect.arrayContaining([
        'telegram',
        'x',
        'linkedin',
        'facebook',
        'instagram',
        'youtube',
        'tiktok',
      ])
    );
  });

  it('never advertises direct messaging for any network', () => {
    expect(
      service.getPlatformCapabilities().some((c) => c.supportsDirectMessage)
    ).toBe(false);
  });

  it('only quotes a rate limit where it has a documented figure', () => {
    const quoted = service
      .getPlatformCapabilities()
      .filter((c) => c.rateLimitPerMinute !== undefined);
    expect(quoted.map((c) => c.identifier)).toEqual(['telegram']);
  });

  it('treats an unknown network as unknown, not as a generic capable one', () => {
    expect(service.getCapability('mastodon-custom')).toMatchObject({
      catalogued: false,
      schedulingSupported: false,
      supportsImages: false,
      supportsVideos: false,
      destinationTypes: [],
    });
  });
});
