import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;

    if (this.isClientAbortException(exception)) {
      status = HttpStatus.BAD_REQUEST;
      message = 'request aborted';
      this.logger.warn(`[HTTP] ${request.method} ${request.originalUrl || request.url} aborted by client`);

      if (request.aborted || request.destroyed || response.headersSent || response.writableEnded) {
        return;
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as any;
        message = resp.message || message;
        errors = resp.errors;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.message, exception.stack);
    }

    if (response.headersSent || response.writableEnded) {
      return;
    }

    response.status(status).json({
      code: status,
      message,
      errors,
    });
  }

  private isClientAbortException(exception: unknown): boolean {
    const candidate = exception as { code?: unknown; message?: unknown; type?: unknown };
    const message = String(candidate?.message || '').toLowerCase();
    const type = String(candidate?.type || '').toLowerCase();
    const code = String(candidate?.code || '').toUpperCase();

    return (
      type === 'request.aborted' ||
      code === 'ECONNABORTED' ||
      code === 'ECONNRESET' ||
      message.includes('request aborted') ||
      message.includes('aborted')
    );
  }
}
