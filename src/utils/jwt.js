import jwt from 'jsonwebtoken';

export function signToken(user) {
  const payload = { sub: user.id, role: user.role, name: user.name, email: user.email };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}
