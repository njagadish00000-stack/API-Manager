import { describe, it, expect } from 'vitest';
import {
  buildSoapMessage, detectSoapFault, extractSoapBody, isSoapPayload,
} from '../../src/core/soap/envelope';
import type { SoapConfig } from '../../src/shared/types';

const cfg = (overrides: Partial<SoapConfig> = {}): SoapConfig => ({
  version: '1.1',
  action: 'http://example.com/GetUser',
  ...overrides,
});

describe('SOAP envelope builder (§25)', () => {
  it('builds a SOAP 1.1 envelope with text/xml content type and SOAPAction', () => {
    const out = buildSoapMessage({ config: cfg(), bodyXml: '<GetUser><id>7</id></GetUser>' });
    expect(out.body).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(out.body).toContain('<GetUser><id>7</id></GetUser>');
    expect(out.contentType).toBe('text/xml; charset=utf-8');
    expect(out.soapAction).toBe('http://example.com/GetUser');
    expect(out.isMultipart).toBeUndefined();
  });

  it('builds SOAP 1.2 with application/soap+xml and embedded action, no SOAPAction header', () => {
    const out = buildSoapMessage({ config: cfg({ version: '1.2' }), bodyXml: '<GetUser/>' });
    expect(out.body).toContain('http://www.w3.org/2003/05/soap-envelope');
    expect(out.contentType).toContain('application/soap+xml');
    expect(out.contentType).toContain('action="http://example.com/GetUser"');
    expect(out.soapAction).toBeUndefined();
  });

  it('adds WS-Security PasswordText username token with wsse namespaces', () => {
    const out = buildSoapMessage({
      config: cfg({ wsSecurity: { username: 'alice', password: 's3cret', passwordType: 'PasswordText' } }),
      bodyXml: '<GetUser/>',
    });
    expect(out.body).toContain('xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"');
    expect(out.body).toContain('<wsse:Username>alice</wsse:Username>');
    expect(out.body).toContain('#PasswordText');
    expect(out.body).toContain('s3cret');
    expect(out.body).toContain('soapenv:mustUnderstand="1"');
  });

  it('adds WS-Security PasswordDigest token and invokes the digest provider', () => {
    const out = buildSoapMessage({
      config: cfg({
        wsSecurity: { username: 'bob', password: 'pw', passwordType: 'PasswordDigest', addTimestamp: true },
      }),
      bodyXml: '<Ping/>',
      digestProvider: () => 'BASE64DIGEST==',
    });
    expect(out.body).toContain('#PasswordDigest');
    expect(out.body).toContain('BASE64DIGEST==');
    expect(out.body).toContain('<wsse:Nonce');
    expect(out.body).toContain('<wsu:Created>');
    expect(out.body).toContain('<wsu:Timestamp');
    expect(out.body).toContain('<wsu:Expires>');
  });

  it('adds WS-Addressing headers', () => {
    const out = buildSoapMessage({
      config: cfg({ wsAddressing: { action: 'http://example.com/Act', to: 'http://svc.example/ep', replyTo: 'http://www.w3.org/2005/08/addressing/anonymous' } }),
      bodyXml: '<Op/>',
    });
    expect(out.body).toContain('xmlns:wsa="http://www.w3.org/2005/08/addressing"');
    expect(out.body).toContain('<wsa:To>http://svc.example/ep</wsa:To>');
    expect(out.body).toContain('<wsa:Action>http://example.com/Act</wsa:Action>');
    expect(out.body).toContain('wsa:MessageID');
    expect(out.body).toContain('addressing/anonymous');
  });

  it('produces a multipart/related MTOM package when enabled', () => {
    const out = buildSoapMessage({ config: cfg({ mtom: true }), bodyXml: '<Bin/>' });
    expect(out.isMultipart).toBe(true);
    expect(out.contentType.startsWith('multipart/related; type="application/xop+xml"')).toBe(true);
    expect(out.contentType).toContain('boundary="----=_Part_');
    expect(out.body).toContain('Content-ID: <root.message@api-manager>');
    expect(out.body).toContain('Content-Transfer-Encoding: 8bit');
    // the closing MIME boundary is present
    expect(/------=_Part_[^\r\n]+--\r\n$/.test(out.body)).toBe(true);
  });

  it('includes the target namespace prefix declaration', () => {
    const out = buildSoapMessage({
      config: cfg(), bodyXml: '<ser:GetUser/>', targetNamespace: 'http://example.com/svc',
    });
    expect(out.body).toContain('xmlns:ser="http://example.com/svc"');
  });
});

describe('SOAP response helpers', () => {
  it('detects SOAP 1.1 faults with code, string, and detail', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
      <soap:Fault><faultcode>soap:Client</faultcode><faultstring>Bad request</faultstring>
      <detail><err>missing id</err></detail></soap:Fault></soap:Body></soap:Envelope>`;
    const f = detectSoapFault(xml);
    expect(f.isFault).toBe(true);
    expect(f.code).toBe('soap:Client');
    expect(f.reason).toBe('Bad request');
    expect(f.detail).toContain('missing id');
  });

  it('detects SOAP 1.2 Fault/Code/Value/Reason/Text', () => {
    const xml = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>
      <env:Fault><env:Code><env:Value>env:Sender</env:Value></env:Code>
      <env:Reason><env:Text>nope</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>`;
    const f = detectSoapFault(xml);
    expect(f.isFault).toBe(true);
    expect(f.code).toBe('env:Sender');
    expect(f.reason).toBe('nope');
  });

  it('returns isFault false for normal envelopes', () => {
    const xml = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetUserResponse/></soap:Body></soap:Envelope>';
    expect(detectSoapFault(xml).isFault).toBe(false);
  });

  it('extracts inner body and recognizes SOAP payloads', () => {
    const xml = '<soap:Envelope xmlns:soap="x"><soap:Header/><soap:Body>\n  <Hello>world</Hello>\n</soap:Body></soap:Envelope>';
    expect(extractSoapBody(xml)).toBe('<Hello>world</Hello>');
    expect(isSoapPayload(xml)).toBe(true);
    expect(isSoapPayload('<html><body>not soap</body></html>')).toBe(false);
  });
});
