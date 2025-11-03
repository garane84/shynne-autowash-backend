// src/db.js
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ Missing DATABASE_URL environment variable. Check your .env file location.");
  process.exit(1);
}

// Automatically disable SSL for localhost, enable for production
const useSSL = !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1');

export const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

export async function query(text, params = []) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error("❌ Database query error:", err.message);
    throw err;
  }
}
