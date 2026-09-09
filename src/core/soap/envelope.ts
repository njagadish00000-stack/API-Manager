/**
 * SOAP envelope construction & response parsing (§40).
 * SOAP 1.1 / 1.2, WS-Security (UsernameToken Text/Digest), WS-Addressing,
 * MTOM/multipart packaging.
 */
import type { SoapConfig } from '../../shared/types';
import { bytesToBase64 } from '../misc/codec';
import { escapeXml } from '../xmlx/xmlUtils';

export const NS = {
  soap11: 'http://schemas.xmlsoap.org/soap/envelope/',
  soap12: 'http://www.w3.org/2003/05/soap-envelope',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  xop: 'http://www.w3.org/2004/08/xop/include',
};

export interface EnvelopeOptions {
  config: SoapConfig;
  bodyXml: string;
  /** extra header xml elements */
  headerXml?: string;
  targetNamespace?: string;
  /** (nonceB64, created, password) => base64 digest — provided by Node side */
  digestProvider?: (nonceB64: string, created: string, password: string) => string;
}

export interface BuiltSoapMessage {
  body: string;            // full payload text (or multipart body text)
  contentType: string;
  soapAction?: string;     // value for SOAPAction header (1.1) or embedded (1.2)
  headers: { key: string; value: string }[];
  isMultipart?: boolean;
}

export function buildSoapMessage(opts: EnvelopeOptions): BuiltSoapMessage {
  const { config, bodyXml } = opts;
  const version = config.version ?? '1.1';
  const envNs = version === '1.2' ? NS.soap12 : NS.soap11;

  // ---- headers ----
  let headerContent = '';

  // WS-Addressing
  if (config.wsAddressing && (config.wsAddressing.action || config.wsAddressing.to || config.wsAddressing.messageId)) {
    const a = config.wsAddressing;
    headerContent += [
      a.to ? `<wsa:To>${escapeXml(a.to)}</wsa:To>` : '',
      `<wsa:Action>${escapeXml(a.action ?? config.action ?? '')}</wsa:Action>`,
      a.messageId ? `<wsa:MessageID>${escapeXml(a.messageId)}</wsa:MessageID>` : `<wsa:MessageID>urn:uuid:${cryptoRandom()}</wsa:MessageID>`,
      a.replyTo ? `<wsa:ReplyTo><wsa:Address>${escapeXml(a.replyTo)}</wsa:Address></wsa:ReplyTo>` : '',
    ].join('');
  }

  // WS-Security (UsernameToken)
  if (config.wsSecurity?.username) {
    const ws = config.wsSecurity;
    const created = new Date().toISOString();
    let token = '';
    if (ws.passwordType === 'PasswordDigest' && ws.password) {
      const nonceB64 = bytesToBase64(hexToBytes(randomHex(16)));
      const digest = opts.digestProvider
        ? opts.digestProvider(nonceB64, created, ws.password)
        : '';
      token = `<wsse:UsernameToken wsu:Id="UsernameToken-${cryptoRandom()}">
        <wsse:Username>${escapeXml(ws.username ?? '')}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>`;
    } else {
      token = `<wsse:UsernameToken wsu:Id="UsernameToken-${cryptoRandom()}">
        <wsse:Username>${escapeXml(ws.username ?? '')}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(ws.password ?? '')}</wsse:Password>
      </wsse:UsernameToken>`;
    }
    const ts = ws.addTimestamp
      ? `<wsu:Timestamp wsu:Id="TS-${cryptoRandom()}"><wsu:Created>${created}</wsu:Created><wsu:Expires>${new Date(Date.now() + 5 * 60000).toISOString()}</wsu:Expires></wsu:Timestamp>`
      : '';
    headerContent += `<wsse:Security ${ws.mustUnderstand !== false ? `soapenv:mustUnderstand="1"` : ''}>${ts}${token}</wsse:Security>`;
  }

  if (opts.headerXml) headerContent += opts.headerXml;

  const needsWsse = headerContent.includes('wsse:') || headerContent.includes('wsu:');
  const needsWsa = headerContent.includes('wsa:');
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<soapenv:Envelope xmlns:soapenv="${envNs}"` +
    (opts.targetNamespace ? ` xmlns:ser="${opts.targetNamespace}"` : '') +
    (needsWsse ? ` xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"` : '') +
    (needsWsa ? ` xmlns:wsa="${NS.wsa}"` : '') +
    `>\n<soapenv:Header>${headerContent}</soapenv:Header>\n<soapenv:Body>\n${bodyXml}\n</soapenv:Body>\n</soapenv:Envelope>`;

  const extraHeaders: { key: string; value: string }[] = [];
  let contentType: string;
  let soapAction: string | undefined = config.action;
  if (version === '1.2') {
    contentType = `application/soap+xml; charset=utf-8${config.action ? `; action="${config.action}"` : ''}`;
    soapAction = undefined;
  } else {
    contentType = 'text/xml; charset=utf-8';
  }

  // MTOM packaging
  if (config.mtom) {
    const boundary = `----=_Part_${cryptoRandom()}`;
    const bodyId = `<root.message@api-manager>`;
    const multipart =
      `--${boundary}\r\nContent-Type: application/xop+xml; charset=UTF-8; type="${version === '1.2' ? 'application/soap+xml' : 'text/xml'}"\r\nContent-Transfer-Encoding: 8bit\r\nContent-ID: ${bodyId}\r\n\r\n${envelope}\r\n--${boundary}--\r\n`;
    contentType = `multipart/related; type="application/xop+xml"; boundary="${boundary}"; start="${bodyId}"; start-info="${version === '1.2' ? 'application/soap+xml' : 'text/xml'}"`;
    return { body: multipart, contentType, soapAction, headers: extraHeaders, isMultipart: true };
  }

  return { body: envelope, contentType, soapAction, headers: extraHeaders };
}

// ---------------------------------------------------------------------------
// SOAP response helpers
// ---------------------------------------------------------------------------

export interface SoapFaultInfo {
  isFault: boolean;
  code?: string;
  reason?: string;
  detail?: string;
}

export function detectSoapFault(xml: string): SoapFaultInfo {
  const m = xml.match(/<(\w+:)?Fault[\s>]/);
  if (!m) return { isFault: false };
  const pick = (tag: string): string | undefined => {
    const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
    return re.exec(xml)?.[1]?.trim();
  };
  return {
    isFault: true,
    code: pick('faultcode') ?? pick('Code') ?? pick('Value'),
    reason: pick('faultstring') ?? pick('Reason') ?? pick('Text'),
    detail: pick('detail') ?? pick('Detail'),
  };
}

/** Extract the inner XML of soap:Body (or return original when absent). */
export function extractSoapBody(xml: string): string {
  const m = /<(?:\w+:)?Body[^>]*>([\s\S]*)<\/(?:\w+:)?Body>/.exec(xml);
  return m ? m[1].trim() : xml;
}

export function isSoapPayload(xml: string): boolean {
  return /<(?:\w+:)?Envelope[\s>]/.test(xml) && /soap|Envelope/.test(xml);
}

function cryptoRandom(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

function randomHex(len: number): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(len);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
