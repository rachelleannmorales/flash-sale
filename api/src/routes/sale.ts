import type { Express, NextFunction, Request, Response } from 'express';
import rateLimit, { type Store } from 'express-rate-limit';
import { z } from 'zod';
import type { SaleService } from '../services/saleService.js';
import { normalizeUserId } from '../utils/userId.js';

export interface RoutesDeps {
  sale: SaleService;
  rateLimit: {
    windowMs: number;
    max: number;
    store: Store;
  };
}

const CONFLICT_STATUSES = new Set([
  'already_purchased',
  'sold_out',
  'ended',
  'not_started',
]);

const UserIdString = z.string().min(1).max(128);

const UserIdParamSchema = z.object({
  userId: UserIdString,
});

const PurchaseBodySchema = z
  .object({
    userId: UserIdString,
  })
  .strict();

type Where = 'body' | 'params' | 'query';
function validate<T extends z.ZodTypeAny>(where: Where, schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[where]);
    if (!result.success) {
      return res.status(400).json({ error: 'invalid_request', where, details: result.error.flatten() });
    }
    (req as unknown as Record<Where, unknown>)[where] = result.data;
    next();
  };
}

export function registerRoutes(app: Express, deps: RoutesDeps) {
  const { sale } = deps;

  const livez = (_req: Request, res: Response) => res.status(200).json({ ok: true });
  app.get('/livez', livez);

  app.get('/readyz', async (_req, res) => {
    const ok = await sale.ping();
    res.status(ok ? 200 : 503).json({ ok });
  });

  app.get('/api/sale/status', async (_req, res) => {
    res.json(await sale.getStatus());
  });

  app.get(
    '/api/sale/purchase/:userId',
    validate('params', UserIdParamSchema),
    async (req, res) => {
      const userId = normalizeUserId(req.params.userId);
      if (!userId) return res.status(400).json({ error: 'invalid_user_id' });
      const purchased = await sale.hasPurchased(userId);
      res.json({ userId, purchased });
    },
  );


  const purchaseLimiter = rateLimit({
    windowMs: deps.rateLimit.windowMs,
    limit: deps.rateLimit.max,
    store: deps.rateLimit.store,
    passOnStoreError: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const userId = (req.body as { userId: string }).userId;
      return `u:${userId.toLowerCase()}`;
    },
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limited' });
    },
  });

  app.post(
    '/api/sale/purchase',
    validate('body', PurchaseBodySchema),
    purchaseLimiter,
    async (req, res) => {
      const body = req.body as z.infer<typeof PurchaseBodySchema>;
      const userId = normalizeUserId(body.userId);
      if (!userId) return res.status(400).json({ error: 'invalid_user_id' });

      const result = await sale.attemptPurchase(userId);

      if (result.status === 'ok') {
        return res.status(201).json({
          status: 'ok',
          userId,
          remaining: result.remaining,
        });
      }

      if (CONFLICT_STATUSES.has(result.status)) {
        return res.status(409).json({ status: result.status, userId });
      }

      return res.status(500).json({ status: 'unknown', error: 'unexpected_outcome' });
    },
  );
}
