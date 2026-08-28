/**
 * Centralised configuration module.
 *
 * All environment variable access in the backend MUST go through this module.
 * The schema is validated once at startup; missing required variables cause an
 * immediate process exit with a clear error message.  The resulting config
 * object is frozen so it cannot be mutated at runtime.
 *
 * Usage:
 *   import { config } from './config';
 *   console.log(config.horizonUrl);
 */

import { z } from 'zod';

const csvArray = z
  .string()
  .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean));

const booleanString = z
  .string()
  .transform((val) => ['true', '1', 'yes'].includes(val.toLowerCase()));

const configSchema = z.object({
  port: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),

  nodeEnv: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  horizonUrl: z.string().url(),
  networkPassphrase: z.string().min(1),
  vestingContractId: z.string().min(1),
  databaseUrl: z.string().url(),

  dbPoolMax: z
    .string()
    .default('10')
    .transform(Number)
    .pipe(z.number().int().positive()),

  redisUrl: z.string().url(),

  redisTtlSeconds: z
    .string()
    .default('300')
    .transform(Number)
    .pipe(z.number().int().positive()),

  webhookSecret: z.string().min(16),

  webhookAllowedUrls: z
    .string()
    .default('')
    .pipe(csvArray),

  otlpEndpoint: z.string().default(''),
  otelServiceName: z.string().default('vesting-backend'),
  otelServiceVersion: z.string().default('0.0.0'),

  otelSampleRate: z
    .string()
    .default('0.1')
    .transform(Number)
    .pipe(z.number().min(0).max(1)),

  jwtSecret: z.string().min(32),
  jwtExpiresIn: z.string().default('1h'),
  corsAllOrigins: booleanString.default('false'),

  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  /** Maximum nested selection-set depth for GraphQL operations. @default 5 */
  graphqlMaxDepth: z
    .string()
    .default('5')
    .transform(Number)
    .pipe(z.number().int().positive()),

  /**
   * Maximum GraphQL query complexity. Each field costs 1; list fields cost n
   * (the requested page size) and multiply nested field costs by n.
   * @default 100
   */
  graphqlMaxComplexity: z
    .string()
    .default('100')
    .transform(Number)
    .pipe(z.number().int().positive()),
});

export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse({
    port:                 env.PORT,
    nodeEnv:              env.NODE_ENV,
    horizonUrl:           env.HORIZON_URL,
    networkPassphrase:    env.NETWORK_PASSPHRASE,
    vestingContractId:    env.VESTING_CONTRACT_ID,
    databaseUrl:          env.DATABASE_URL,
    dbPoolMax:            env.DB_POOL_MAX,
    redisUrl:             env.REDIS_URL,
    redisTtlSeconds:      env.REDIS_TTL_SECONDS,
    webhookSecret:        env.WEBHOOK_SECRET,
    webhookAllowedUrls:   env.WEBHOOK_ALLOWED_URLS,
    otlpEndpoint:         env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName:      env.OTEL_SERVICE_NAME,
    otelServiceVersion:   env.OTEL_SERVICE_VERSION,
    otelSampleRate:       env.OTEL_SAMPLE_RATE,
    jwtSecret:            env.JWT_SECRET,
    jwtExpiresIn:         env.JWT_EXPIRES_IN,
    corsAllOrigins:       env.CORS_ALL_ORIGINS,
    logLevel:             env.LOG_LEVEL,
    graphqlMaxDepth:      env.GRAPHQL_MAX_DEPTH,
    graphqlMaxComplexity: env.GRAPHQL_MAX_COMPLEXITY,
  });

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    process.stderr.write(
      `\n[config] Invalid environment configuration:\n${messages}\n\n`,
    );
    process.exit(1);
  }

  return Object.freeze(result.data);
}

export const config = parseConfig();

export type Config = z.infer<typeof configSchema>;
