import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrderService } from './order.service';

// ponytail: in-process timer instead of a queue. Safe with several API instances (the cancel is
// guarded by the order status), just redundant. Move to BullMQ if more background jobs appear.
@Injectable()
export class OrderExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OrderExpiryService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly orders: OrderService) {}

  onModuleInit() {
    const minutes = Number(process.env.ORDER_EXPIRE_MINUTES ?? 30);
    const everySeconds = Number(process.env.ORDER_SWEEP_SECONDS ?? 60);
    if (!(minutes > 0) || !(everySeconds > 0)) return;
    this.timer = setInterval(() => {
      this.orders.expireUnpaid(minutes).then(
        (n) => n && this.log.log(`Cancelled ${n} unpaid VNPAY order(s)`),
        (e) => this.log.error(e),
      );
    }, everySeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
