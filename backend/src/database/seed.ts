import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import logger from '../utils/logger';

async function seed(): Promise<void> {
  logger.info('Seeding database...');

  try {
    // Create demo pharmacy
    const pharmacyId = uuidv4();
    const ownerId = uuidv4();
    const pharmacistId = uuidv4();
    const passwordHash = await bcrypt.hash('Demo@1234', 12);

    await db.query(
      `INSERT INTO pharmacies (id, name, license_number, location, region, district, gps_address, phone, email, owner_id, subscription_tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (license_number) DO NOTHING`,
      [pharmacyId, 'Demo Community Pharmacy', 'PH-DEMO-001', 'Osu, Accra', 'Greater Accra', 'Accra Metropolitan', 'GA-123-4567', '+233201234567', 'demo@pharmacy.com', ownerId, 'premium']
    );

    // Create pharmacy owner
    await db.query(
      `INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO NOTHING`,
      [ownerId, pharmacyId, 'pharmacy_owner', 'Kwame', 'Asante', 'demo@pharmacy.com', '+233201234567', passwordHash]
    );

    // Create pharmacist
    await db.query(
      `INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO NOTHING`,
      [pharmacistId, pharmacyId, 'pharmacist', 'Ama', 'Mensah', 'pharmacist@demo.com', '+233207654321', passwordHash]
    );

    // Create sample patients
    const patients = [
      { first: 'Kofi', last: 'Appiah', nhis: 'NHIS-001-234', phone: '+233241111111', conditions: ['hypertension', 'diabetes'] },
      { first: 'Akosua', last: 'Darko', nhis: 'NHIS-002-456', phone: '+233242222222', conditions: ['asthma'] },
      { first: 'Yaw', last: 'Boateng', nhis: 'NHIS-003-789', phone: '+233243333333', conditions: ['malaria'] },
      { first: 'Efua', last: 'Owusu', nhis: 'NHIS-004-012', phone: '+233244444444', conditions: ['hypertension'] },
      { first: 'Kwesi', last: 'Adu', nhis: 'NHIS-005-345', phone: '+233245555555', conditions: [] },
    ];

    for (const p of patients) {
      const id = uuidv4();
      await db.query(
        `INSERT INTO patients (id, pharmacy_id, nhis_number, first_name, last_name, date_of_birth, gender, phone, address, region, chronic_conditions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, pharmacyId, p.nhis, p.first, p.last, '1990-01-15', 'male', p.phone, 'Osu, Accra', 'Greater Accra', p.conditions]
      );
    }

    // Create sample inventory
    const inventoryItems = [
      { name: 'Paracetamol 500mg', code: 'PAR-500', category: 'Analgesics', qty: 500, price: 0.50, cost: 0.30, expiry: '2027-06-15' },
      { name: 'Amoxicillin 250mg', code: 'AMX-250', category: 'Antibiotics', qty: 200, price: 2.00, cost: 1.20, expiry: '2026-12-30' },
      { name: 'Metformin 500mg', code: 'MET-500', category: 'Antidiabetics', qty: 300, price: 1.50, cost: 0.80, expiry: '2027-03-20' },
      { name: 'Amlodipine 5mg', code: 'AML-5', category: 'Antihypertensives', qty: 150, price: 3.00, cost: 1.80, expiry: '2027-01-10' },
      { name: 'ORS Sachets', code: 'ORS-001', category: 'Rehydration', qty: 1000, price: 0.25, cost: 0.10, expiry: '2028-06-01' },
      { name: 'Chloroquine Tablets', code: 'CHL-250', category: 'Antimalarials', qty: 400, price: 1.00, cost: 0.60, expiry: '2027-08-15' },
      { name: 'Vitamin C 1000mg', code: 'VTC-1000', category: 'Supplements', qty: 250, price: 2.50, cost: 1.50, expiry: '2027-04-30' },
      { name: 'Cough Syrup (100ml)', code: 'CSY-100', category: 'Cough & Cold', qty: 8, price: 12.00, cost: 7.50, expiry: '2026-10-20' },
      { name: 'Insulin Pen (NovoRapid)', code: 'INS-NR', category: 'Antidiabetics', qty: 5, price: 85.00, cost: 60.00, expiry: '2026-09-15' },
      { name: 'Blood Glucose Strips', code: 'BGS-50', category: 'Diagnostics', qty: 50, price: 1.50, cost: 0.90, expiry: '2027-12-01' },
    ];

    for (const item of inventoryItems) {
      await db.query(
        `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, category, quantity, unit_price, cost_price, expiry_date, reorder_level, requires_prescription)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [uuidv4(), pharmacyId, item.name, item.code, item.category, item.qty, item.price, item.cost, item.expiry, 20, item.category === 'Antibiotics' || item.category === 'Antidiabetics']
      );
    }

    logger.info('Database seeded successfully');
    logger.info('Demo credentials: demo@pharmacy.com / Demo@1234');
  } catch (error) {
    logger.error('Seeding failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

seed();
