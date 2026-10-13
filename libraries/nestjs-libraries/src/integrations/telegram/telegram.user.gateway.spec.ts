import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelegramGateway } from './telegram.gateway';
import {
  TelegramUserGateway,
  TelegramUserGatewayError,
} from './telegram.user.gateway';

/** The client against a real loopback HTTP server that speaks the worker contract. */
describe('TelegramUserGateway (loopback HTTP, no Telegram)', () => {
  let server: Server;
  let seen: Array<{
    url: string;
    headers: IncomingMessage['headers'];
    body: any;
  }>;
  let reply: (req: IncomingMessage, res: ServerResponse, body: any) => void;
  const account = {
    apiId: 1,
    apiHash: 'a1'.repeat(16),
    session: 'secret-session',
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        seen.push({ url: req.url!, headers: req.headers, body });
        reply(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.AGENCYOS_TELEGRAM_WORKER_URL = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }`;
    process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN = 'token-for-test';
  });
  afterAll(async () => {
    delete process.env.AGENCYOS_TELEGRAM_WORKER_URL;
    delete process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN;
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    seen = [];
    reply = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, results: [] }));
    };
  });

  const gw = () => new TelegramUserGateway();
  const json = (res: ServerResponse, status: number, payload: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  };

  it('sends the token and a correlation id, posts JSON to the contract path, and returns the answer', async () => {
    await gw().searchCommunities(account, 'bakery', 20);
    expect(seen[0].url).toBe('/v1/communities/search');
    expect(seen[0].headers['x-agencyos-worker-token']).toBe('token-for-test');
    expect(String(seen[0].headers['x-correlation-id'])).toMatch(
      /^[0-9a-f]{16}$/
    );
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].body).toEqual({ account, query: 'bakery', limit: 20 });
  });

  it('turns the worker’s error envelope into a typed error with its code and wait', async () => {
    reply = (_r, res) =>
      json(res, 200, {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'FloodWait',
          retryAfterSeconds: 42,
        },
      });
    await expect(gw().resolveCommunity(account, '@x')).rejects.toMatchObject({
      name: 'TelegramUserGatewayError',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
    });
    reply = (_r, res) =>
      json(res, 200, {
        ok: false,
        error: { code: 'ACCOUNT_RESTRICTED', message: 'PeerFlood' },
      });
    await expect(gw().joinCommunity(account, '@x')).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
  });

  it('tells a worker problem from a Telegram refusal: no token accepted, unreadable answer, not running', async () => {
    reply = (_r, res) =>
      json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED' } });
    await expect(gw().accountStatus(account)).rejects.toMatchObject({
      code: 'WORKER_AUTH',
    });
    reply = (_r, res) => {
      res.statusCode = 500;
      res.end('<html>oops</html>');
    };
    await expect(gw().accountStatus(account)).rejects.toMatchObject({
      code: 'WORKER_PROTOCOL',
    });
    reply = (_r, res) => json(res, 200, { nothing: 'we know' });
    await expect(gw().accountStatus(account)).rejects.toMatchObject({
      code: 'WORKER_PROTOCOL',
    });

    const saved = process.env.AGENCYOS_TELEGRAM_WORKER_URL;
    process.env.AGENCYOS_TELEGRAM_WORKER_URL = 'http://127.0.0.1:1';
    await expect(gw().accountStatus(account)).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE',
    });
    expect(await gw().health()).toEqual({ ok: false });
    process.env.AGENCYOS_TELEGRAM_WORKER_URL = saved;
  });

  it('is off, and says so, when no worker is configured', async () => {
    const saved = process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN;
    delete process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN;
    expect(gw().isConfigured()).toBe(false);
    await expect(
      gw().loginStart({ apiId: 1, apiHash: 'x', phone: '+1' })
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    expect(seen).toHaveLength(0);
    process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN = saved;
  });

  it('does not treat a send that never got an answer as a failure: the post may be live', async () => {
    class Slow extends TelegramUserGateway {
      // The worker never replies within the allowed time.
      protected override async post<T>(
        path: string,
        body: Record<string, unknown>,
        options = {}
      ) {
        return super.post<T>(path, body, { ...options, timeoutMs: 50 });
      }
    }
    reply = () => undefined; // never answers
    await expect(
      new Slow().sendMessage(account, '@x', { html: 'hi', media: [] })
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(
      new Slow().searchCommunities(account, 'bakery', 5)
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('exposes no call that lists people or adds them: only the endpoints of the contract exist', () => {
    const names = Object.getOwnPropertyNames(
      TelegramUserGateway.prototype
    ).filter((n) => n !== 'constructor');
    for (const n of names) {
      expect(n).not.toMatch(
        /participant|member|addUser|inviteUser|contacts|phone/i
      );
    }
  });

  describe('building the ad for a user account', () => {
    let dir: string;
    const bot = new TelegramGateway();
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agencyos-media-'));
      process.env.UPLOAD_DIRECTORY = dir;
      process.env.FRONTEND_URL = 'http://localhost:4200';
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.UPLOAD_DIRECTORY;
    });

    it('uses the same text as the bot and the files AgencyOS holds', () => {
      writeFileSync(join(dir, 'pic.jpg'), 'x');
      writeFileSync(join(dir, 'clip.mp4'), 'x');
      const ad = gw().buildWorkerAd(
        {
          title: 'Offer',
          body: 'Fresh <b>bread</b>',
          ctaLink: 'https://x.test',
          ctaText: 'Order',
          media: ['/uploads/pic.jpg', 'http://localhost:4200/uploads/clip.mp4'],
        },
        bot
      );
      expect(ad.html).toBe(
        bot.renderAdHtml({
          title: 'Offer',
          body: 'Fresh <b>bread</b>',
          ctaLink: 'https://x.test',
          ctaText: 'Order',
        })
      );
      expect(ad.media).toEqual([
        { path: join(dir, 'pic.jpg'), kind: 'photo' },
        { path: join(dir, 'clip.mp4'), kind: 'video' },
      ]);
    });

    it('refuses web addresses and unsupported file types instead of sending something else', () => {
      writeFileSync(join(dir, 'doc.pdf'), 'x');
      expect(() =>
        gw().buildWorkerAd(
          { body: 'x', media: ['https://example.com/a.jpg'] },
          bot
        )
      ).toThrow(/uploaded to AgencyOS/);
      expect(() =>
        gw().buildWorkerAd({ body: 'x', media: ['/uploads/doc.pdf'] }, bot)
      ).toThrow(TelegramUserGatewayError);
      expect(() => gw().buildWorkerAd({ body: '   ' }, bot)).toThrow(/empty/);
    });
  });
});
