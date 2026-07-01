import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { InMemoryTemplateStore } from './in-memory-template-store';
import { TEMPLATE_STORE } from './template-store';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Assembles the mission template library feature (task 5.7): the REST
 * controller, the application service, and the built-in template registry bound
 * to the {@link TEMPLATE_STORE} port. Imports {@link MissionsModule} so an
 * instantiated template is validated and persisted through the canonical
 * mission authoring service.
 */
@Module({
  imports: [MissionsModule],
  controllers: [TemplatesController],
  providers: [
    TemplatesService,
    { provide: TEMPLATE_STORE, useFactory: () => new InMemoryTemplateStore() },
  ],
  exports: [TemplatesService],
})
export class TemplatesModule {}
