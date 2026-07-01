/**
 * Guard that enforces default-deny RBAC for an already-authenticated request
 * (Requirement 18.3, 18.4; properties P40/P41).
 *
 * It must run *after* {@link JwtAuthGuard}, which populates `req.authContext`.
 * When no principal is present it denies with `401`; when the principal's role
 * is not permitted for the resolved route it denies with `403 Forbidden`.
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { resolveRouteMeta, type AuthedRequest } from './authed-request';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const ctx = req.authContext;
    if (ctx === undefined) {
      // RBAC requires an authenticated principal; the JWT guard must run first.
      throw new UnauthorizedException('Request is not authenticated');
    }

    const route = resolveRouteMeta(req);
    if (!this.auth.authorize(ctx, route)) {
      throw new ForbiddenException('Role is not permitted for this route');
    }
    return true;
  }
}
