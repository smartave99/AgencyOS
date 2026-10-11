import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelegramGateway, TelegramGatewayError } from './telegram.gateway';

const telegramError = (code: number, description: string, extra: any = {}) =>
  Object.assign(new Error(description), { code: 'ETELEGRAM', response: { body: { error_code: code, description, ...extra } } });

function gatewayWith(bot: Record<string, any>) {
  process.env.AGENCY_TELEGRAM_BOT_TOKEN = '123:test';
  const gateway = new TelegramGateway();
  (gateway as any).bot = bot;
  return gateway;
}

describe('TelegramGateway', () => {
  afterEach(() => {
    delete process.env.AGENCY_TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.UPLOAD_DIRECTORY;
    delete process.env.FRONTEND_URL;
  });

  describe('message rendering', () => {
    const gateway = new TelegramGateway();

    it('escapes HTML in every user-supplied field', () => {
      const html = gateway.renderAdHtml({ title: '<i>Sale</i> & more', body: 'Use <script>alert(1)</script> a < b', ctaText: '<b>Go</b>', ctaLink: 'https://example.com/?a=1&b="2"' });
      expect(html).toContain('<b>&lt;i&gt;Sale&lt;/i&gt; &amp; more</b>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('a &lt; b');
      expect(html).toContain('<a href="https://example.com/?a=1&amp;b=%222%22">&lt;b&gt;Go&lt;/b&gt;</a>');
    });

    it('keeps a strict allowlist of attribute-less formatting tags and maps strong/em', () => {
      const html = gateway.renderAdHtml({ body: '<strong>Bold</strong> <em>it</em> <u>u</u> <code>x</code> <a href="javascript:x">no</a> <img src=x>' });
      expect(html).toContain('<b>Bold</b> <i>it</i> <u>u</u> <code>x</code>');
      expect(html).toContain('&lt;a href=&quot;javascript:x&quot;&gt;'.replace('&quot;', '"').replace('&quot;', '"'));
      expect(html).not.toMatch(/<a |<img/);
    });

    it('falls back to fully escaped text when tags are unbalanced, rather than sending something Telegram rejects', () => {
      const html = gateway.renderAdHtml({ body: '<b>never closed' });
      expect(html).toBe('&lt;b&gt;never closed');
      expect(gateway.renderAdHtml({ body: '<b>x</i>' })).toBe('&lt;b&gt;x&lt;/i&gt;');
    });

    it('drops non-http(s) links and falls back to the channel link', () => {
      expect(gateway.renderAdHtml({ body: 'hi', ctaLink: 'javascript:alert(1)', ctaText: 'Click' })).toBe('hi');
      expect(gateway.renderAdHtml({ body: 'hi', ctaLink: 'data:text/html,x', channelLink: 'https://t.me/shop' })).toContain('📢 <a href="https://t.me/shop">');
    });
  });

  describe('validation against Telegram limits', () => {
    const gateway = new TelegramGateway();
    it('rejects empty, oversized, over-attached and mixed-type posts with a clear reason', () => {
      expect(() => gateway.validateAd({ body: '  ' })).toThrow(/empty/);
      expect(() => gateway.validateAd({ body: 'x'.repeat(4097) })).toThrow(/4096/);
      expect(() => gateway.validateAd({ body: 'ok', media: Array(11).fill('https://x.test/a.jpg') })).toThrow(/at most 10/);
      expect(() => gateway.validateAd({ body: 'ok', media: ['https://x.test/a.jpg', 'https://x.test/b.pdf'] })).toThrow(/Only images and videos/);
      expect(() => gateway.validateAd({ body: 'ok', media: ['file:///etc/passwd'] })).toThrow(/uploaded file or an http/);
      expect(() => gateway.validateAd({ body: 'ok', media: ['https://x.test/a.jpg'] })).not.toThrow();
    });
    it('counts visible characters, not markup, against the limit', () => {
      expect(() => gateway.validateAd({ body: `<b>${'x'.repeat(4090)}</b>` })).not.toThrow();
    });
  });

  describe('sending', () => {
    const base = () => ({
      getChat: jest.fn().mockResolvedValue({ id: -1001, type: 'channel', username: 'fruitshop' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 11 }),
      sendPhoto: jest.fn().mockResolvedValue({ message_id: 21 }),
      sendVideo: jest.fn().mockResolvedValue({ message_id: 22 }),
      sendMediaGroup: jest.fn().mockResolvedValue([{ message_id: 31 }, { message_id: 32 }]),
    });

    it('text only → one message, with a public link for a public channel', async () => {
      const bot = base();
      const res = await gatewayWith(bot).sendAd('-1001', { body: 'hello' });
      expect(bot.sendMessage).toHaveBeenCalledWith('-1001', 'hello', { parse_mode: 'HTML' });
      expect(res).toEqual({ primaryMessageId: '11', messageIds: ['11'], releaseUrl: 'https://t.me/fruitshop/11' });
    });

    it('builds a t.me/c link for a private supergroup and none for a basic group', async () => {
      const bot = base();
      bot.getChat.mockResolvedValue({ id: -1002, type: 'supergroup' }); // no public username
      expect((await gatewayWith(bot).sendAd('-12345', { body: 'x' })).releaseUrl).toBeUndefined(); // basic group: no link exists
      expect((await gatewayWith(bot).sendAd('-100234567', { body: 'x' })).releaseUrl).toBe('https://t.me/c/234567/11');
    });

    it('one image with a short text → a single captioned photo', async () => {
      const bot = base();
      const res = await gatewayWith(bot).sendAd('-1001', { body: 'short', media: ['https://x.test/a.jpg'] });
      expect(bot.sendPhoto).toHaveBeenCalledWith('-1001', 'https://x.test/a.jpg', { caption: 'short', parse_mode: 'HTML' });
      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(res.messageIds).toEqual(['21']);
    });

    it('one image with text beyond the 1024-character caption limit → photo, then the text as a reply', async () => {
      const bot = base();
      const res = await gatewayWith(bot).sendAd('-1001', { body: 'y'.repeat(2000), media: ['https://x.test/a.png'] });
      expect(bot.sendPhoto).toHaveBeenCalledWith('-1001', 'https://x.test/a.png', undefined);
      expect(bot.sendMessage).toHaveBeenCalledWith('-1001', 'y'.repeat(2000), { parse_mode: 'HTML', reply_to_message_id: 21 });
      expect(res.messageIds).toEqual(['21', '11']);
    });

    it('video and gif use their own send methods', async () => {
      const bot = { ...base(), sendAnimation: jest.fn().mockResolvedValue({ message_id: 41 }) };
      await gatewayWith(bot).sendAd('-1001', { body: 'v', media: ['https://x.test/a.mp4'] });
      expect(bot.sendVideo).toHaveBeenCalled();
      await gatewayWith(bot).sendAd('-1001', { body: 'g', media: ['https://x.test/a.gif'] });
      expect(bot.sendAnimation).toHaveBeenCalled();
    });

    it('several images → one album with the caption on the first item only', async () => {
      const bot = base();
      await gatewayWith(bot).sendAd('-1001', { body: 'album', media: ['https://x.test/1.jpg', 'https://x.test/2.jpg'] });
      const group = bot.sendMediaGroup.mock.calls[0][1];
      expect(group[0]).toMatchObject({ type: 'photo', caption: 'album', parse_mode: 'HTML' });
      expect(group[1].caption).toBeUndefined();
    });

    it('if the follow-up text fails after the media is already live, the error carries the live message ids', async () => {
      const bot = base();
      bot.sendMessage.mockRejectedValue(telegramError(429, 'Too Many Requests: retry later', { parameters: { retry_after: 7 } }));
      const err: TelegramGatewayError = await gatewayWith(bot).sendAd('-1001', { body: 'z'.repeat(1500), media: ['https://x.test/a.jpg'] }).catch((e) => e);
      expect(err).toBeInstanceOf(TelegramGatewayError);
      expect(err.partialMessageIds).toEqual(['21']);
      expect(err.kind).toBe('RATE_LIMITED');
    });

    it('is UNCONFIGURED, not silently successful, without a token', async () => {
      const err = await new TelegramGateway().sendAd('-1001', { body: 'x' }).catch((e) => e);
      expect(err).toMatchObject({ name: 'TelegramGatewayError', kind: 'UNCONFIGURED' });
    });
  });

  describe('error classification', () => {
    const classify = (e: unknown) => new TelegramGateway().classify(e);
    it('maps Telegram responses to actionable kinds', () => {
      expect(classify(telegramError(429, 'Too Many Requests', { parameters: { retry_after: 33 } }))).toMatchObject({ kind: 'RATE_LIMITED', retryAfterSeconds: 33 });
      expect(classify(telegramError(403, 'Forbidden: bot was kicked from the channel chat')).kind).toBe('FORBIDDEN');
      expect(classify(telegramError(400, 'Bad Request: chat not found')).kind).toBe('CHAT_NOT_FOUND');
      expect(classify(telegramError(400, 'Bad Request: not enough rights to send text messages')).kind).toBe('FORBIDDEN');
      expect(classify(telegramError(400, 'Bad Request: group chat was upgraded to a supergroup chat', { parameters: { migrate_to_chat_id: -1009 } })).kind).toBe('CHAT_MIGRATED');
      expect(classify(telegramError(400, "Bad Request: can't parse entities")).kind).toBe('BAD_REQUEST');
      expect(classify(telegramError(401, 'Unauthorized')).kind).toBe('UNCONFIGURED');
      expect(classify(telegramError(502, 'Bad Gateway')).kind).toBe('NETWORK');
      expect(classify(Object.assign(new Error('ECONNRESET'), { code: 'EFATAL' })).kind).toBe('NETWORK');
      expect(classify(new Error('something odd')).kind).toBe('UNKNOWN');
    });
  });

  describe('bot permissions', () => {
    const bot = (status: string, chatType: string, member: any = {}) => ({
      getMe: jest.fn().mockResolvedValue({ id: 1 }),
      getChat: jest.fn().mockResolvedValue({ id: -1, type: chatType }),
      getChatMember: jest.fn().mockResolvedValue({ status, ...member }),
    });
    it('a channel needs the explicit right to post; a group administrator can post', async () => {
      expect(await gatewayWith(bot('administrator', 'channel', { can_post_messages: false })).getBotPermissions('-1')).toMatchObject({ isAdmin: true, canPostMessages: false });
      expect(await gatewayWith(bot('administrator', 'channel', { can_post_messages: true })).getBotPermissions('-1')).toMatchObject({ canPostMessages: true });
      expect(await gatewayWith(bot('administrator', 'supergroup')).getBotPermissions('-1')).toMatchObject({ isAdmin: true, canPostMessages: true });
      expect(await gatewayWith(bot('creator', 'channel')).getBotPermissions('-1')).toMatchObject({ canPostMessages: true });
    });
    it('a plain member or a removed bot is not an administrator and cannot be used', async () => {
      expect(await gatewayWith(bot('member', 'supergroup')).getBotPermissions('-1')).toMatchObject({ isAdmin: false, canPostMessages: false });
      expect(await gatewayWith(bot('left', 'channel')).getBotPermissions('-1')).toMatchObject({ isAdmin: false, canPostMessages: false });
    });
  });

  describe('uploaded media', () => {
    it('is streamed from UPLOAD_DIRECTORY, and a path that climbs out of it is refused', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agencyos-uploads-'));
      mkdirSync(join(dir, '2026'));
      writeFileSync(join(dir, '2026', 'ad.jpg'), 'jpegbytes');
      writeFileSync(join(dir, '..', 'secret.jpg'), 'secret');
      process.env.UPLOAD_DIRECTORY = dir;
      process.env.FRONTEND_URL = 'http://localhost:5000';
      const sendPhoto = jest.fn().mockResolvedValue({ message_id: 5 });
      const sendDocument = jest.fn().mockResolvedValue({ message_id: 6 });
      const bot = { sendPhoto, sendDocument, getChat: jest.fn().mockResolvedValue({ id: -1, type: 'channel' }) };
      const gateway = gatewayWith(bot);

      await gateway.sendAd('-1001', { body: 'x', media: ['http://localhost:5000/uploads/2026/ad.jpg'] });
      expect(typeof sendPhoto.mock.calls[0][1]).toBe('object'); // a stream, not a URL Telegram can't reach

      // Direct attempts to climb out of the upload directory are refused outright.
      for (const evil of ['/uploads/../secret.jpg', '/uploads/%2e%2e/secret.jpg']) {
        await expect(gateway.sendAd('-1001', { body: 'x', media: [evil] })).rejects.toMatchObject({ kind: 'BAD_REQUEST' });
      }
      // A traversal URL is normalised into an ordinary remote URL: handed to Telegram as a
      // link, never opened from this machine's disk.
      await gateway.sendAd('-1001', { body: 'x', media: ['http://localhost:5000/uploads/../../etc/passwd'] });
      expect(sendDocument.mock.calls[0][1]).toBe('http://localhost:5000/etc/passwd');
      expect(sendPhoto).toHaveBeenCalledTimes(1);
    });
  });
});
