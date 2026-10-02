import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.BASTION_DATABASE_URL ?? 'postgresql://bastion:bastion@localhost:5432/bastion',
  },
});
