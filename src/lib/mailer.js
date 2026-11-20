import nodemailer from 'nodemailer';
import { env, isTest } from '../config/env.js';
import { logger } from './logger.js';

/** Captured emails in test mode (assert in tests). */
export const outbox = [];

let transport;
function getTransport() {
  if (transport) return transport;
  transport = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return transport;
}

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Simple branded HTML layout. */
export function layout({ title, body, actionUrl, actionLabel }) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f5f7;padding:24px">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:8px;padding:24px">
  <h2 style="margin-top:0;color:#111">${escape(title)}</h2>
  <div style="color:#333;line-height:1.5">${body}</div>
  ${actionUrl ? `<p><a href="${escape(actionUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escape(actionLabel ?? 'Open')}</a></p>` : ''}
  <p style="color:#888;font-size:12px">Tracker — Time Tracking & Productivity</p></div></body></html>`;
}

/**
 * Send an email. attachments: [{ filename, content: Buffer, contentType }]
 */
export async function sendMail({ to, subject, html, text, attachments }) {
  const message = { from: env.MAIL_FROM, to, subject, html, text, attachments };
  if (isTest) {
    outbox.push(message);
    return { messageId: `test-${outbox.length}` };
  }
  try {
    const info = await getTransport().sendMail(message);
    if (!env.SMTP_HOST) logger.info({ to, subject }, 'email (no SMTP configured, logged only)');
    return info;
  } catch (err) {
    logger.error({ err, to, subject }, 'email send failed');
    throw err;
  }
}

export { escape as escapeHtml };
