import { Injectable } from '@nestjs/common';

/**
 * Where the WhatsApp Business Cloud API would plug in. NOTHING here talks to a network: this is a
 * contract and a default that refuses, so that a later version has one place to implement and the
 * rest of AgencyOS never needs to know.
 *
 * What switching it on would need, none of which exists in this version:
 *  - a Meta business account with a verified WhatsApp Business phone number, and a permanent
 *    access token for it, stored sealed (like Telegram bot tokens) and never returned by any API;
 *  - message templates approved by Meta (a business may start a conversation only with one), and
 *    the 24-hour customer-service window for free-form replies;
 *  - a public HTTPS webhook with a verification token and signature check, to hear about replies
 *    and about delivery and read receipts. Only then could AgencyOS say a message was delivered;
 *  - the same consent rules as the manual workspace: only opted-in contacts, the unsubscribe
 *    ledger checked before every send, and every send recorded in the audit trail;
 *  - queueing, retries with backoff, a dead-letter state and rate limits per phone number.
 *
 * Until then every call fails with {@link WhatsappBusinessNotEnabledError}, and messages are sent
 * by a person in WhatsApp.
 */
export const WHATSAPP_BUSINESS_PROVIDER = 'WHATSAPP_BUSINESS_PROVIDER';

export interface WhatsappBusinessTemplateMessage {
  /** The recipient in E.164 form, e.g. +4915112345678. Must be an opted-in contact. */
  to: string;
  /** The name of a template Meta has approved. */
  templateName: string;
  /** The template's language, e.g. en_US. */
  languageCode: string;
  /** Values for the template's numbered placeholders, in order. */
  parameters: string[];
}

export interface WhatsappBusinessTextMessage {
  to: string;
  /** Free text; WhatsApp only accepts it inside the 24-hour window after the person wrote. */
  body: string;
}

/** What the provider acknowledged. Accepted for sending is not delivered. */
export interface WhatsappBusinessSendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

export interface WhatsappBusinessApprovedTemplate {
  name: string;
  languageCode: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
}

export interface WhatsappBusinessProvider {
  /** Whether sending through it is turned on and configured. */
  isEnabled(): boolean;
  sendTemplate(
    orgId: string,
    message: WhatsappBusinessTemplateMessage
  ): Promise<WhatsappBusinessSendResult>;
  sendText(
    orgId: string,
    message: WhatsappBusinessTextMessage
  ): Promise<WhatsappBusinessSendResult>;
  listApprovedTemplates(
    orgId: string
  ): Promise<WhatsappBusinessApprovedTemplate[]>;
}

export class WhatsappBusinessNotEnabledError extends Error {
  constructor() {
    super(
      'The WhatsApp Business API is not enabled in this version of AgencyOS. Messages are sent by a person in WhatsApp.'
    );
    this.name = 'WhatsappBusinessNotEnabledError';
  }
}

/** The default, and for now the only, provider: it never sends and says why. */
@Injectable()
export class DisabledWhatsappBusinessProvider
  implements WhatsappBusinessProvider
{
  isEnabled() {
    return false;
  }

  async sendTemplate(): Promise<WhatsappBusinessSendResult> {
    throw new WhatsappBusinessNotEnabledError();
  }

  async sendText(): Promise<WhatsappBusinessSendResult> {
    throw new WhatsappBusinessNotEnabledError();
  }

  async listApprovedTemplates(): Promise<WhatsappBusinessApprovedTemplate[]> {
    throw new WhatsappBusinessNotEnabledError();
  }
}
