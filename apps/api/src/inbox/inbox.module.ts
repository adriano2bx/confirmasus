import { Logger, Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { prisma } from '@confirma/database';
import { QUEUES, createRedisConnection } from '@confirma/queue';
import { AuthModule } from '../auth/auth.module.js';
import { HUMAN_MESSAGE_QUEUE, INBOX_PRISMA } from './inbox.constants.js';
import { InboxController } from './inbox.controller.js';
import { InboxActionsService } from './inbox-actions.service.js';
import { InboxQueryService } from './inbox-query.service.js';
import { InboxStreamService } from './inbox-stream.service.js';
import { InboxTeamsService } from './inbox-teams.service.js';

@Module({
  imports: [AuthModule],
  controllers: [InboxController],
  providers: [
    InboxQueryService,
    InboxActionsService,
    InboxTeamsService,
    InboxStreamService,
    { provide: INBOX_PRISMA, useValue: prisma },
    {
      provide: HUMAN_MESSAGE_QUEUE,
      useFactory: () => {
        const queue = new Queue(QUEUES.humanMessages, { connection: createRedisConnection() });
        // Redis indisponível não derruba a API; o varredor do worker publica os QUEUED.
        queue.on('error', () =>
          Logger.warn('Fila de mensagens humanas indisponível', 'InboxModule'),
        );
        return queue;
      },
    },
  ],
})
export class InboxModule {}
