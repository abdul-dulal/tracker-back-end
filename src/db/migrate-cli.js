import { initDb, closeDb } from '../lib/db.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

await initDb();
await migrate();
await seed();
await closeDb();
console.log('Migrations and seed applied.');
