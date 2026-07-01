/**
 * Unit tests for {@link AuthService.authenticate} (Requirement 18.1, 18.2,
 * 18.5) and its {@link AuthService.authorize} delegation.
 *
 * Tokens are signed with the real {@link JwtService} so verification exercises
 * genuine JWT semantics (signature + expiry) — no mocking of the crypto path.
 */
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, extractBearerToken } from './auth.service';
import { buildPermissionMap } from './route-permissions';

const SECRET = 'test-secret-value';
const jwt = new JwtService();

/** Builds a minimal Express-like request carrying the given Authorization header. */
function requestWith(authorization?: string): Request {
  return { headers: authorization === undefined ? {} : { authorization } } as Request;
}

/** Signs a token with the shared test secret and optional claim overrides. */
function sign(claims: Record<string, unknown>, options: Record<string, unknown> = {}): string {
  return jwt.sign(claims, { secret: SECRET, ...options });
}

describe('extractBearerToken', () => {
  it('returns the token from a well-formed bearer header', () => {
    expect(extractBearerToken(requestWith('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('returns undefined when the header is absent or not a bearer credential', () => {
    expect(extractBearerToken(requestWith())).toBeUndefined();
    expect(extractBearerToken(requestWith('Basic abc'))).toBeUndefined();
    expect(extractBearerToken(requestWith('Bearer '))).toBeUndefined();
  });
});

describe('AuthService.authenticate', () => {
  let service: AuthService;
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    service = new AuthService(jwt);
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it('extracts userId and role from a valid token (18.2)', () => {
    const token = sign({ sub: 'user-1', role: 'operator' });
    const ctx = service.authenticate(requestWith(`Bearer ${token}`));
    expect(ctx).toEqual({ userId: 'user-1', role: 'operator' });
  });

  it('accepts a userId claim as an alternative subject', () => {
    const token = sign({ userId: 'user-2', role: 'viewer' });
    expect(service.authenticate(requestWith(`Bearer ${token}`)).userId).toBe('user-2');
  });

  it('rejects a request with no token (18.1)', () => {
    expect(() => service.authenticate(requestWith())).toThrow(UnauthorizedException);
  });

  it('rejects an expired token (18.5)', () => {
    const expired = sign({ sub: 'u', role: 'viewer', exp: Math.floor(Date.now() / 1000) - 60 });
    expect(() => service.authenticate(requestWith(`Bearer ${expired}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong secret (18.5)', () => {
    const forged = jwt.sign({ sub: 'u', role: 'viewer' }, { secret: 'other-secret' });
    expect(() => service.authenticate(requestWith(`Bearer ${forged}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token carrying an unknown role', () => {
    const token = sign({ sub: 'u', role: 'wizard' });
    expect(() => service.authenticate(requestWith(`Bearer ${token}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token missing a subject', () => {
    const token = sign({ role: 'viewer' });
    expect(() => service.authenticate(requestWith(`Bearer ${token}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails fast when the server secret is not configured', () => {
    delete process.env.JWT_SECRET;
    const token = sign({ sub: 'u', role: 'viewer' });
    expect(() => service.authenticate(requestWith(`Bearer ${token}`))).toThrow(
      /JWT_SECRET is not configured/,
    );
  });
});

describe('AuthService.authorize', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it('delegates to the injected permission registry (default-deny)', () => {
    const permissions = buildPermissionMap([
      { method: 'GET', path: '/x', roles: ['analyst'] },
    ]);
    const service = new AuthService(jwt, permissions);
    expect(service.authorize({ userId: 'u', role: 'analyst' }, { method: 'GET', path: '/x' })).toBe(
      true,
    );
    expect(service.authorize({ userId: 'u', role: 'viewer' }, { method: 'GET', path: '/x' })).toBe(
      false,
    );
  });
});
