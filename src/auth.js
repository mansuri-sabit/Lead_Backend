/**
 * JWT auth middleware for data isolation. Verifies Bearer token and sets req.userId.
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is required in production');
    process.exit(1);
}

// Fallback for local dev only — never used in production
const SECRET = JWT_SECRET || 'dev-only-insecure-key-' + Date.now();

/**
 * Issues a JWT for the given userId.
 * @param {string} userId
 * @returns {string} signed JWT
 */
export function signToken(userId) {
    return jwt.sign(
        { sub: userId, iat: Math.floor(Date.now() / 1000) },
        SECRET,
        { expiresIn: process.env.JWT_EXPIRY || '24h' }
    );
}

/**
 * Middleware: requires valid Authorization: Bearer <token>. Sets req.userId.
 */
export function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
        return res.status(401).json({ error: 'Invalid token', code: 'UNAUTHORIZED' });
    }
    try {
        const payload = jwt.verify(token, SECRET);
        const userId = payload.sub;
        if (!userId || typeof userId !== 'string') {
            return res.status(401).json({ error: 'Invalid token payload', code: 'UNAUTHORIZED' });
        }
        req.userId = userId;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired', code: 'UNAUTHORIZED' });
        }
        return res.status(401).json({ error: 'Invalid token', code: 'UNAUTHORIZED' });
    }
}
