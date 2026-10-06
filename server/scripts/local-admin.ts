import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

async function main() {
  const uid = process.env.BOOTSTRAP_ADMIN_UID || '';
  if (!uid) {
    console.error('BOOTSTRAP_ADMIN_UID is not set in .env');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { firebaseUid: uid } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'ADMIN', status: 'ACTIVE', approvedAt: existing.approvedAt ?? new Date() },
    });
    console.log(`Local admin activated: ${existing.email}`);
  } else {
    const user = await prisma.user.create({
      data: {
        firebaseUid: uid,
        email: `admin@local.${uid.slice(0, 8)}`,
        displayName: 'Local Admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        approvedAt: new Date(),
      },
    });
    console.log(`Local admin created: ${user.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());