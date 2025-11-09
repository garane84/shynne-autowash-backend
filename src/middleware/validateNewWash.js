// backend/src/middleware/validateNewWash.js
// Minimal, dependency-free validation only for "create wash".
// Normalizes plate to UPPERCASE and strips spaces/hyphens.

const KENYA_PLATE_RE = /^K[A-Z]{2}\d{3}[A-Z]$/; // e.g., KDP547Z

module.exports = function validateNewWash(req, res, next) {
  const errors = [];

  // Accept either vehicle_reg or vehicleReg from the client; normalize to vehicle_reg
  const raw = (req.body.vehicle_reg ?? req.body.vehicleReg ?? '').toString();
  const normalizedPlate = raw.toUpperCase().replace(/[\s-]/g, '');

  if (!normalizedPlate) {
    errors.push('vehicle_reg is required.');
  } else if (!KENYA_PLATE_RE.test(normalizedPlate)) {
    errors.push('vehicle_reg must match Kenyan format e.g. KDP547Z.');
  }

  // Require these IDs (keep names exactly as your API uses)
  if (!req.body.service_id) errors.push('service_id is required.');
  if (!req.body.staff_id) errors.push('staff_id is required.');
  if (!req.body.car_type && !req.body.carType) errors.push('car_type is required.');

  if (errors.length) {
    return res.status(400).json({
      error: 'VALIDATION_FAILED',
      details: errors
    });
  }

  // Normalize fields (don’t alter other body props)
  req.body.vehicle_reg = normalizedPlate;
  if (req.body.carType && !req.body.car_type) {
    req.body.car_type = req.body.carType; // keep backward compatibility
  }

  return next();
};
