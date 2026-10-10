import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    REDIS_URL: z.url(),
    MONGO_URL: z.url(),
    ALLOWED_ORIGINS: z
      .string()
      .transform((str) =>
        str
          .split(",")
          .map((s) => s.trim())
          .filter((origin) => origin.length > 0),
      )
      .pipe(z.array(z.url()).min(1)),
    JWT_KEY: z.string().min(32),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
  })
  .transform((e) => ({
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    redisUrl: e.REDIS_URL,
    mongoUrl: e.MONGO_URL,
    allowedOrigins: e.ALLOWED_ORIGINS,
    jwt: {
      key: e.JWT_KEY,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
    },
  }));

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }

  return result.data;
}

export type Config = z.infer<typeof envSchema>;
