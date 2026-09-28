import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { RequestContext } from '../common/context/request-context';
import type { AuthenticatedRequest } from './auth.types';

/** Runs every authenticated handler inside the caller's tenant context. */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.auth) return next.handle();

    const data = { ...req.auth, requestId: randomUUID() };
    return new Observable((subscriber) => {
      const subscription = RequestContext.run(data, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
