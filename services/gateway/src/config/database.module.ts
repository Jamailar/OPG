import { Module, Global, Logger, Injectable, Inject, OnApplicationShutdown } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import configuration from './configuration';

export const PRISMA_CLIENT = 'PRISMA_CLIENT';
const MIGRATION_LOCK_KEY = 498673210;

interface SqlMigration {
  version: string;
  name: string;
  path: string;
  checksum: string;
  statements: string[];
}

@Injectable()
class PrismaLifecycleService implements OnApplicationShutdown {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown() {
    await this.prisma.$disconnect();
    Logger.log('Prisma disconnected from database', 'DatabaseModule');
  }
}

function isAutoMigrationEnabled() {
  const raw = String(process.env.DB_AUTO_MIGRATE ?? process.env.DATABASE_AUTO_MIGRATE ?? 'true')
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function resolveMigrationsDir() {
  const candidates = [
    resolve(process.cwd(), 'prisma/migrations'),
    resolve(process.cwd(), 'services/gateway/prisma/migrations'),
    resolve(__dirname, '../../prisma/migrations'),
    resolve(__dirname, '../../../prisma/migrations'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function readSqlMigrations(): SqlMigration[] {
  const migrationsDir = resolveMigrationsDir();
  if (!migrationsDir) {
    Logger.warn('No prisma/migrations directory found; skip database migrations', 'DatabaseModule');
    return [];
  }

  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const migrationPath = join(migrationsDir, entry.name, 'migration.sql');
      if (!existsSync(migrationPath)) {
        return null;
      }
      const sql = readFileSync(migrationPath, 'utf8');
      return {
        version: entry.name,
        name: basename(entry.name),
        path: migrationPath,
        checksum: createHash('sha256').update(sql).digest('hex'),
        statements: splitSqlStatements(sql).filter((statement) => {
          const normalized = statement.trim().replace(/;$/, '').trim().toUpperCase();
          return normalized !== 'BEGIN' && normalized !== 'COMMIT';
        }),
      };
    })
    .filter((migration): migration is SqlMigration => !!migration)
    .sort((left, right) => left.version.localeCompare(right.version));
}

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || '';

    if (lineComment) {
      current += char;
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      current += char;
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '$') {
      const rest = sql.slice(index);
      const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (singleQuoted && char === "'" && next === "'") {
      current += char + next;
      index += 1;
      continue;
    }

    if (!doubleQuoted && char === "'" && sql[index - 1] !== '\\') {
      singleQuoted = !singleQuoted;
      current += char;
      continue;
    }

    if (doubleQuoted && char === '"' && next === '"') {
      current += char + next;
      index += 1;
      continue;
    }

    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      current += char;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === ';') {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }
  return statements;
}

async function ensureMigrationRegistry(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
      version varchar(128) PRIMARY KEY,
      name varchar(255) NOT NULL,
      checksum varchar(64) NOT NULL,
      execution_ms integer NOT NULL DEFAULT 0,
      executed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function runStartupMigrations(prisma: PrismaClient) {
  if (!isAutoMigrationEnabled()) {
    Logger.warn('Database auto migration disabled by DB_AUTO_MIGRATE', 'DatabaseModule');
    return;
  }

  const migrations = readSqlMigrations();
  if (migrations.length === 0) {
    return;
  }

  await ensureMigrationRegistry(prisma);
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
      const appliedRows = await (tx.$queryRawUnsafe(
        `SELECT version, checksum FROM gateway_schema_migrations`,
      ) as Promise<Array<{ version: string; checksum: string }>>);
      const applied = new Map(appliedRows.map((row) => [row.version, row.checksum]));
      const prismaMigrationsTable = await (tx.$queryRawUnsafe(
        `SELECT to_regclass('public._prisma_migrations')::text AS table_name`,
      ) as Promise<Array<{ table_name: string | null }>>);
      const prismaAppliedRows = prismaMigrationsTable[0]?.table_name
        ? await (tx.$queryRawUnsafe(
          `SELECT migration_name
             FROM _prisma_migrations
            WHERE finished_at IS NOT NULL
              AND rolled_back_at IS NULL`,
        ) as Promise<Array<{ migration_name: string }>>)
        : [];
      const prismaApplied = new Set(prismaAppliedRows.map((row) => row.migration_name));
      let appliedCount = 0;

      for (const migration of migrations) {
        const existingChecksum = applied.get(migration.version);
        if (existingChecksum) {
          if (existingChecksum !== migration.checksum) {
            if (!prismaApplied.has(migration.version)) {
              throw new Error(`Database migration checksum mismatch: ${migration.version}`);
            }
            Logger.warn(
              `Gateway migration checksum changed after Prisma applied it; synchronizing registry: ${migration.version}`,
              'DatabaseModule',
            );
            await tx.$executeRawUnsafe(
              `UPDATE gateway_schema_migrations
                  SET checksum = $2,
                      executed_at = now()
                WHERE version = $1`,
              migration.version,
              migration.checksum,
            );
          }
          continue;
        }

        if (prismaApplied.has(migration.version)) {
          await tx.$executeRawUnsafe(
            `INSERT INTO gateway_schema_migrations (version, name, checksum, execution_ms, executed_at)
             VALUES ($1, $2, $3, 0, now())`,
            migration.version,
            migration.name,
            migration.checksum,
          );
          continue;
        }

        const startedAt = Date.now();
        Logger.log(`Applying database migration ${migration.version}`, 'DatabaseModule');
        for (const statement of migration.statements) {
          await tx.$executeRawUnsafe(statement);
        }
        const executionMs = Date.now() - startedAt;
        await tx.$executeRawUnsafe(
          `INSERT INTO gateway_schema_migrations (version, name, checksum, execution_ms, executed_at)
           VALUES ($1, $2, $3, $4, now())`,
          migration.version,
          migration.name,
          migration.checksum,
          executionMs,
        );
        appliedCount += 1;
      }

      const latest = migrations[migrations.length - 1]?.version || 'none';
      Logger.log(`Database schema version checked: latest=${latest}, applied=${appliedCount}`, 'DatabaseModule');
    },
    { maxWait: 30000, timeout: 600000 },
  );
}

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [configuration.KEY],
      useFactory: async (config: ConfigType<typeof configuration>) => {
        const logLevels: ('query' | 'error' | 'warn')[] = config.database.queryLogEnabled
          ? ['query', 'error', 'warn']
          : config.env === 'development'
            ? ['error', 'warn']
            : ['error'];
        const prisma = new PrismaClient({
          datasources: {
            db: {
              url: config.database.url,
            },
          },
          log: logLevels,
        });

        // 连接测试
        try {
          await prisma.$connect();
          Logger.log('Prisma connected to database', 'DatabaseModule');
          await runStartupMigrations(prisma);
        } catch (error) {
          Logger.error('Failed to connect to database', error, 'DatabaseModule');
          throw error;
        }

        return prisma;
      },
    },
    PrismaLifecycleService,
  ],
  exports: [PRISMA_CLIENT],
})
export class DatabaseModule {}
