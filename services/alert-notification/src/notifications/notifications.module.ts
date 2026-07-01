/**
 * Hosts the real-time notification transports and the multi-channel dispatcher.
 *
 * As of task 11.5 this module wires all three channel transports behind the
 * common `ChannelTransport` interface — in-app WebSocket ({@link AlertsGateway}),
 * email (Nodemailer) and WhatsApp (OpenWA REST) — plus the {@link DispatchService}
 * that fans alerts out across exactly the configured channels with retry,
 * backoff and in-app fallback (Requirement 15). Transport dependencies
 * (Nodemailer transporter, OpenWA axios client), the retry policy and the
 * backoff sleep are provided via factories so they are configurable in
 * production and mockable in tests.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import { createTransport, type Transporter } from 'nodemailer';
import { AlertsGateway } from './alerts.gateway';
import {
  EMAIL_TRANSPORT,
  IN_APP_TRANSPORT,
  MAIL_TRANSPORTER,
  OPENWA_HTTP,
  WHATSAPP_TRANSPORT,
} from './transports/channel-transport';
import { EmailTransport } from './transports/email.transport';
import { InAppTransport } from './transports/in-app.transport';
import { WhatsAppTransport } from './transports/whatsapp.transport';
import {
  DISPATCH_DELAY,
  DISPATCH_RETRY_POLICY,
  DispatchService,
  type DelayFn,
} from './dispatch/dispatch.service';
import { resolveRetryPolicy, type RetryPolicy } from './dispatch/dispatch.logic';

/** Builds the Nodemailer transporter from SMTP_* config. */
const mailTransporterProvider: Provider = {
  provide: MAIL_TRANSPORTER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const host = config.get<string>('SMTP_HOST');
    if (!host) {
      // No SMTP configured (local/dev/test): use the built-in JSON test
      // transport so sends succeed without contacting a real mail server.
      return createTransport({ jsonTransport: true });
    }
    return createTransport({
      host,
      port: config.get<number>('SMTP_PORT', 587),
      secure: config.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: config.get<string>('SMTP_USER')
        ? {
            user: config.get<string>('SMTP_USER', ''),
            pass: config.get<string>('SMTP_PASSWORD', ''),
          }
        : undefined,
    });
  },
};

/** Builds the OpenWA axios client from OPENWA_* config. */
const openwaHttpProvider: Provider = {
  provide: OPENWA_HTTP,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AxiosInstance => {
    const apiKey = config.get<string>('OPENWA_API_KEY');
    return axios.create({
      baseURL: config.get<string>('OPENWA_URL', 'http://localhost:8002'),
      timeout: config.get<number>('OPENWA_TIMEOUT_MS', 5_000),
      headers: apiKey ? { 'api-key': apiKey } : {},
    });
  },
};

const emailTransportProvider: Provider = {
  provide: EMAIL_TRANSPORT,
  inject: [MAIL_TRANSPORTER, ConfigService],
  useFactory: (transporter: Transporter, config: ConfigService) =>
    new EmailTransport(transporter, config.get<string>('ALERT_EMAIL_FROM', 'alerts@pawaac.local')),
};

const whatsappTransportProvider: Provider = {
  provide: WHATSAPP_TRANSPORT,
  inject: [OPENWA_HTTP],
  useFactory: (http: AxiosInstance) => new WhatsAppTransport(http),
};

const inAppTransportProvider: Provider = {
  provide: IN_APP_TRANSPORT,
  inject: [AlertsGateway],
  useFactory: (gateway: AlertsGateway) => new InAppTransport(gateway),
};

/** Per-channel retry/backoff policy assembled from ALERT_DISPATCH_* config. */
const retryPolicyProvider: Provider = {
  provide: DISPATCH_RETRY_POLICY,
  inject: [ConfigService],
  useFactory: (config: ConfigService): RetryPolicy =>
    resolveRetryPolicy({
      maxAttempts: config.get<number>('ALERT_DISPATCH_MAX_ATTEMPTS', 3),
      baseDelayMs: config.get<number>('ALERT_DISPATCH_BASE_DELAY_MS', 100),
      backoffFactor: config.get<number>('ALERT_DISPATCH_BACKOFF_FACTOR', 2),
      maxDelayMs: config.get<number>('ALERT_DISPATCH_MAX_DELAY_MS', 5_000),
    }),
};

/** Real backoff sleep used in production wiring. */
const delayProvider: Provider = {
  provide: DISPATCH_DELAY,
  useValue: ((ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    })) satisfies DelayFn,
};

@Module({
  imports: [ConfigModule],
  providers: [
    AlertsGateway,
    mailTransporterProvider,
    openwaHttpProvider,
    inAppTransportProvider,
    emailTransportProvider,
    whatsappTransportProvider,
    retryPolicyProvider,
    delayProvider,
    DispatchService,
  ],
  exports: [AlertsGateway, DispatchService],
})
export class NotificationsModule {}
