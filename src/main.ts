import { ArgumentsHost, Catch, ConflictException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from './app.module';

// Unique-constraint races (slug, hostname...) become 409 instead of 500.
@Catch(Prisma.PrismaClientKnownRequestError)
class PrismaErrorFilter extends BaseExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    if (error.code === 'P2002') {
      return super.catch(new ConflictException('Already exists'), host);
    }
    if (error.code === 'P2025') {
      return super.catch(new NotFoundException('Not found'), host);
    }
    return super.catch(error, host);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalFilters(new PrismaErrorFilter(app.getHttpAdapter()));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
