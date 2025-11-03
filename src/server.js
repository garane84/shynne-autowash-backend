import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pool, query } from './db.js';
import authRouter from './routes/auth.js';
import catalogRouter from './routes/catalog.js';
import washesRouter from './routes/washes.js';
import expensesRouter from './routes/expenses.js';
import reportsRouter from './routes/reports.js';
import servicesRouter from './routes/services.js';
import carTypesRouter from './routes/carTypes.js';
import servicePricesRouter from './routes/servicePrices.js';
import staffRoutes from './routes/staff.js'
import commissionRoutes from './routes/commissions.js'
import settingsRouter from './routes/settings.js';
import usersRouter from './routes/users.js';
import analyticsRouter from "./routes/analytics.js";
import featuredVehiclesRouter from "./routes/featuredVehicles.js";

const app = express();
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// initialize DB (run SQL file once)
import fs from 'fs';
import path from 'path';
const initSql = fs.readFileSync(path.join(process.cwd(), 'sql', '001_init.sql'), 'utf8');
(async () => {
  try {
    await pool.query(initSql);
    console.log("✅ Database initialized (or already up to date).");
  } catch (e) {
    console.error("DB init error", e);
  }
})();

app.use('/auth', authRouter);
app.use('/catalog', catalogRouter);
app.use('/washes', washesRouter);
app.use('/expenses', expensesRouter);
app.use('/reports', reportsRouter);
app.use('/services', servicesRouter);
app.use('/car-types', carTypesRouter);
app.use('/', servicePricesRouter); // price upsert route
app.use('/staff', staffRoutes)
app.use('/commissions', commissionRoutes)
app.use('/settings', settingsRouter);
app.use('/users', usersRouter);
app.use("/analytics", analyticsRouter);
app.use("/featured-vehicles", featuredVehiclesRouter);

// Dashboard Today vs Yesterday
app.get('/dashboard/today-vs-yesterday', async (req, res) => {
  try {
    const today = req.query.date ? new Date(req.query.date) : new Date();
    const tzToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const yesterday = new Date(tzToday.getTime() - 24*60*60*1000);

    const metricsSql = `
      SELECT
        COUNT(*)::int AS wash_count,
        COALESCE(SUM(unit_price),0)::numeric AS revenue,
        COALESCE(SUM(commission_amount),0)::numeric AS commission,
        COALESCE(SUM(profit_amount),0)::numeric AS profit
      FROM washes
      WHERE washed_at >= $1 AND washed_at < ($1 + interval '1 day')`;
    const expSql = `
      SELECT COALESCE(SUM(amount),0)::numeric AS expenses
      FROM expenses
      WHERE spent_at >= $1 AND spent_at < ($1 + interval '1 day')`;

    const [{ rows: [t] }, { rows: [te] }, { rows: [y] }, { rows: [ye] }] = await Promise.all([
      query(metricsSql, [tzToday]),
      query(expSql, [tzToday]),
      query(metricsSql, [yesterday]),
      query(expSql, [yesterday])
    ]);

    const todayNet = Number(t.profit) - Number(te.expenses);
    const yNet = Number(y.profit) - Number(ye.expenses);
    const pct = yNet === 0 ? null : ((todayNet - yNet) / Math.abs(yNet)) * 100;

    res.json({
      date: tzToday.toISOString().slice(0,10),
      today: { ...t, expenses: te.expenses, net_income: todayNet },
      yesterday: { ...y, expenses: ye.expenses, net_income: yNet },
      delta_pct: pct
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API running on :${port}`));
