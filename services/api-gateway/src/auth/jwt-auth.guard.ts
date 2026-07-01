/**
 * Guard that authenticates every request by verifying its JWT *before* the
 * request can reach an upstream service (Requirement 18.1, 18.5; property P45).
 *
 * On success it attaches the resolved {@link AuthContext} to the request so the
 * downstream {@link RbacGuard} (and proxy layer) can reuse it; on failure
 * {@link AuthService.authenticate} throws `401 Unauthorized`, short-circuiting
 * the request.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthedRequest } from './authed-request';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    // Throws UnauthorizedException (401) for missing/expired/invalid tokens.
    req.authContext = this.auth.authenticate(req);
    return true;
  }
}
