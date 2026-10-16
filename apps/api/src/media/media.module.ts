import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';

@Module({ imports: [AuthModule], controllers: [MediaController], providers: [MediaService] })
export class MediaModule {}
