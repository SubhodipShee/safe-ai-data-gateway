// Diagnoses the Atlas connection without ever printing the password.
// Usage: npm run check-db
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DB_NAME, explainDbError, useDnsServers } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });

const uri = (process.env.MONGODB_URI || '').trim();
useDnsServers((process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean));
const parts = uri.match(/^(mongodb(?:\+srv)?):\/\/([^:@/]+):(.*)@([^/?]+)\/?([^?]*)/);

if (!parts) {
  console.log('URI shape : NOT RECOGNISED. Expected mongodb+srv://user:password@host/database');
} else {
  const [, scheme, user, pass, host, db] = parts;
  console.log('scheme    :', scheme);
  console.log('user      :', user);
  console.log(
    'password  :',
    `${pass.length} chars,`,
    /[@:/?#%[\]\s<>]/.test(pass) ? 'HAS SPECIAL CHARACTERS that break the URI' : 'no problem characters',
  );
  console.log('host      :', host);
  console.log('database  :', db || `(none in URI — the gateway uses "${DB_NAME}" anyway)`);
}

try {
  await mongoose.connect(uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 10_000 });
  console.log(`RESULT    : connected OK (database: ${mongoose.connection.name})`);
} catch (err) {
  console.log('RESULT    :', explainDbError(err));
  console.log('raw error :', String(err.message).split(uri).join('[uri]').slice(0, 300));
} finally {
  await mongoose.disconnect();
}
