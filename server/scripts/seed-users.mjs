import { db } from '../models/db.js';
import { usersTable } from '../models/users/schema.js';
import { adminsTable } from '../models/admins/schema.js';
import bcrypt from 'bcryptjs';

async function seed() {
  console.log('Seeding default dev users...');

  const passwordHash = await bcrypt.hash('password123', 10);

  // 1. Seed default user
  try {
    await db.insert(usersTable).values({
      email: 'user@salesmarketing.com',
      password: passwordHash,
      name: 'Dev User',
      role: 'user',
      isVerified: true,
      isSetupComplete: true,
      isApproved: true,
    });
    console.log('Inserted user@salesmarketing.com');
  } catch (err) {
    if (err.code === '23505') {
      console.log('user@salesmarketing.com already exists');
    } else {
      console.error('Failed to insert user', err);
    }
  }

  // 2. Seed default admin
  try {
    await db.insert(adminsTable).values({
      email: 'admin@salesmarketing.com',
      password: passwordHash,
      name: 'Dev Admin',
      role: 'admin',
      isVerified: true,
    });
    console.log('Inserted admin@salesmarketing.com');
  } catch (err) {
    if (err.code === '23505') {
      console.log('admin@salesmarketing.com already exists');
    } else {
      console.error('Failed to insert admin', err);
    }
  }

  console.log('Seeding complete.');
  process.exit(0);
}

seed();
