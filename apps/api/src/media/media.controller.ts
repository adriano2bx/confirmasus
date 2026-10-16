import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { MediaService } from './media.service.js';

@Controller('inbox/media')
@UseGuards(AuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':assetId')
  async download(
    @Param('assetId') assetId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!request.user) throw new UnauthorizedException('Autenticação obrigatória');
    const file = await this.media.open(request.user, assetId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.size,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }
}
