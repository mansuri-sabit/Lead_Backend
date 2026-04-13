import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import dns from 'node:dns';

let dnsFixApplied = false;
function applyMongoDnsFix() {
    if (dnsFixApplied) return;
    dnsFixApplied = true;
    dns.setDefaultResultOrder('ipv4first');
    if (process.env.USE_PUBLIC_DNS === '1') {
        const servers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',').map((s: string) => s.trim()) : ['8.8.8.8', '1.1.1.1'];
        dns.setServers(servers);
    }
}

const adSchema = new Schema({
    userId: { type: String, index: true },
    advertiser_name: String,
    ad_description: String,
    scrape_date: { type: Date, default: Date.now },
    keyword: String,
    phone: String,
    address: String,
    image_url: String,
    landing_url: String,
    ad_id: String,
    source: { type: String, default: 'facebook' },
    advertiser_legal_name: String,
    based_in_country: String,
    ad_start_date: Date
});

// Mission schema for tracking scraping jobs
const missionSchema = new Schema({
    userId: { type: String, index: true },
    keyword: { type: String, required: true },
    status: { type: String, enum: ['running', 'completed', 'failed', 'stopped'], default: 'running' },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    adsFound: { type: Number, default: 0 },
    newAds: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    adsProcessed: { type: Number, default: 0 },
    maxAdsPerRequest: { type: Number, required: true },
    dailyLimit: { type: Number, required: true },
    country: { type: String, default: 'IN' },
    source: { type: String, default: 'facebook' },
    error: { type: String },
    executionId: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Scheduler configuration schema
const schedulerSchema = new Schema({
    userId: { type: String, index: true },
    keyword: { type: String, required: true },
    cronExpression: { type: String, required: true }, // e.g., '0 */6 * * *' for every 6 hours
    isActive: { type: Boolean, default: false },
    maxAdsPerRequest: { type: Number, default: 1000 },
    dailyLimit: { type: Number, default: 5000 },
    lastRun: { type: Date },
    nextRun: { type: Date },
    totalRuns: { type: Number, default: 0 },
    successfulRuns: { type: Number, default: 0 },
    failedRuns: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// User schema for authentication
const userSchema = new Schema({
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

// Compound index for fast dedup lookups (used by saveAd and saveAdsBulk)
adSchema.index({ advertiser_name: 1, ad_description: 1, userId: 1 }, { name: 'dedup_compound_idx' });

const Ad = mongoose.model('Ad', adSchema);
const Mission = mongoose.model('Mission', missionSchema);
const Scheduler = mongoose.model('Scheduler', schedulerSchema);
const User = mongoose.model('User', userSchema);

/** One Filter Bot extraction job per user (metadata only; rows in FilterBotCommenter). */
const filterBotRunSchema = new Schema({
    userId: { type: String, required: true, index: true },
    postUrl: { type: String, required: true },
    action: { type: String, enum: ['Like', 'Comment', 'Goal'], required: true },
    maxUsers: { type: Number },
    total: { type: Number, required: true },
    status: { type: String, enum: ['running', 'completed', 'failed'], required: true },
    errorMessage: { type: String },
    processingTimeMs: { type: Number },
    extractedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
filterBotRunSchema.index({ userId: 1, createdAt: -1 });

/** Agent 2: profile page + About scrape (phones, addresses, external social links). */
const filterBotProfileEnrichmentSchema = new Schema(
    {
        status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'] },
        enrichedAt: { type: Date },
        phones: [{ type: String }],
        addresses: [{ type: String }],
        socialLinks: [{ platform: { type: String }, url: { type: String } }],
        profileUrlUsed: { type: String },
        aboutUrlUsed: { type: String },
        error: { type: String }
    },
    { _id: false }
);

/** One document per extracted commenter (avoids 16MB doc limit on huge threads). */
const filterBotCommenterSchema = new Schema({
    runId: { type: Schema.Types.ObjectId, ref: 'FilterBotRun', required: true, index: true },
    userId: { type: String, required: true, index: true },
    rowIndex: { type: Number, required: true },
    externalId: { type: String },
    name: { type: String },
    username: { type: String },
    profileUrl: { type: String },
    anchorHref: { type: String }, // raw anchor href from a[href*="comment_id"]
    comment: { type: String },
    commentTime: { type: Date },
    extractedAt: { type: Date, default: Date.now },
    profileEnrichment: { type: filterBotProfileEnrichmentSchema }
});
filterBotCommenterSchema.index({ runId: 1, rowIndex: 1 }, { unique: true });
filterBotCommenterSchema.index({ userId: 1, runId: 1 });

const FilterBotRun = mongoose.model('FilterBotRun', filterBotRunSchema);
const FilterBotCommenter = mongoose.model('FilterBotCommenter', filterBotCommenterSchema);

export { Ad, Mission, Scheduler, User, FilterBotRun, FilterBotCommenter };

export async function connectDB() {
    if (mongoose.connection.readyState >= 1) return;
    applyMongoDnsFix();
    const uri = process.env.MONGODB_URI || process.env.MONGODB_URI_STANDARD;
    if (!uri) {
        throw new Error('MONGODB_URI (or MONGODB_URI_STANDARD) is not set in environment');
    }
    await mongoose.connect(uri);
}

/**
 * Saves an ad. userId is required for data isolation; ads are de-duplicated per user.
 */
export async function saveAd(
    advertiser: string,
    description: string,
    keyword: string,
    phone: string | null,
    address: string | null,
    startDate?: Date | null,
    userId?: string | null
): Promise<boolean> {
    try {
        await connectDB();

        const filter: Record<string, unknown> = {
            advertiser_name: advertiser,
            ad_description: description
        };
        if (userId != null) filter.userId = userId;

        const existing = await Ad.findOne(filter);
        if (existing) {
            console.log(`[Skip] Ad already exists: ${advertiser}`);
            return false;
        }

        const adData: Record<string, unknown> = {
            advertiser_name: advertiser,
            ad_description: description,
            keyword,
            phone,
            address,
            ad_start_date: startDate
        };
        if (userId != null) adData.userId = userId;

        const ad = new Ad(adData);
        await ad.save();
        console.log(`[Save] New ad stored: ${advertiser}`);
        return true;
    } catch (err) {
        console.error('Error saving to MongoDB:', err);
        return false;
    }
}

/**
 * Bulk-saves ads using MongoDB bulkWrite with upsert. One DB round-trip per batch
 * instead of 2N round-trips (findOne + save per ad). Returns which ads were new.
 */
export async function saveAdsBulk(
    ads: Array<{ advertiser: string; description: string; keyword: string; phone: string | null; address?: string | null; startDate?: Date | null }>,
    userId?: string | null
): Promise<{ saved: number; duplicates: number; newFlags: boolean[] }> {
    await connectDB();
    if (ads.length === 0) return { saved: 0, duplicates: 0, newFlags: [] };

    const userFilter = userId != null ? { userId } : {};
    const ops = ads.map(ad => ({
        updateOne: {
            filter: {
                advertiser_name: ad.advertiser,
                ad_description: ad.description,
                ...userFilter
            },
            update: {
                $setOnInsert: {
                    advertiser_name: ad.advertiser,
                    ad_description: ad.description,
                    keyword: ad.keyword,
                    phone: ad.phone,
                    address: ad.address || null,
                    ad_start_date: ad.startDate || null,
                    scrape_date: new Date(),
                    source: 'facebook',
                    ...userFilter
                }
            },
            upsert: true
        }
    }));

    const result: any = await Ad.bulkWrite(ops, { ordered: false });
    const upsertedMap = result.upsertedIds || {};
    const upsertedSet = new Set(Object.keys(upsertedMap).map(Number));
    const newFlags = ads.map((_, i) => upsertedSet.has(i));
    return { saved: result.upsertedCount, duplicates: ads.length - result.upsertedCount, newFlags };
}

/**
 * Returns mission by id; used by scraper to get userId for saveAd isolation.
 */
export async function getMissionById(missionId: string): Promise<{ userId?: string | null } | null> {
    try {
        await connectDB();
        const mission = await Mission.findById(missionId).lean();
        return mission ? { userId: mission.userId ?? null } : null;
    } catch (err) {
        console.error('Error fetching mission:', err);
        return null;
    }
}

export async function getStats(userId?: string | null) {
    await connectDB();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const filter: Record<string, unknown> = { scrape_date: { $gte: startOfDay } };
    if (userId != null) filter.userId = userId;
    return await Ad.countDocuments(filter);
}

export async function updateMission(missionId: string, updates: any) {
    try {
        await connectDB();
        await Mission.findByIdAndUpdate(missionId, {
            ...updates,
            updatedAt: new Date()
        });
    } catch (err) {
        console.error('Error updating mission in MongoDB:', err);
    }
}

const SALT_ROUNDS = 10;

/**
 * Registers a new user. Returns the created user doc or throws USERNAME_TAKEN.
 */
export async function registerUser(username: string, password: string): Promise<{ username: string }> {
    await connectDB();
    const normalizedUsername = username.trim().toLowerCase();
    const existing = await User.findOne({ username: normalizedUsername });
    if (existing) {
        throw new Error('USERNAME_TAKEN');
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = new User({ username: normalizedUsername, passwordHash });
    await user.save();
    return { username: user.username };
}

/**
 * Verifies credentials. Returns the username if valid, or null if invalid.
 */
export async function verifyUser(username: string, password: string): Promise<string | null> {
    await connectDB();
    const normalizedUsername = username.trim().toLowerCase();
    const user = await User.findOne({ username: normalizedUsername });
    if (!user) return null;
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    return isMatch ? user.username : null;
}

const FILTER_BOT_INSERT_CHUNK = 500;

function serializeFilterBotProfileEnrichment(
    raw: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const enrichedAt = e.enrichedAt;
    let enrichedAtStr: string | null = null;
    if (enrichedAt instanceof Date) enrichedAtStr = enrichedAt.toISOString();
    else if (typeof enrichedAt === 'string') enrichedAtStr = enrichedAt;
    return {
        ...e,
        enrichedAt: enrichedAtStr
    };
}

export type FilterBotPersistMeta = {
    postUrl: string;
    action: 'Like' | 'Comment' | 'Goal';
    maxUsers: number | null;
    total: number;
    processingTimeMs: number;
    status: 'completed' | 'failed';
    errorMessage?: string | null;
};

export type FilterBotRunStatus = 'running' | 'completed' | 'failed';

export async function createFilterBotRun(
    ownerUserId: string,
    meta: {
        postUrl: string;
        action: 'Like' | 'Comment' | 'Goal';
        maxUsers: number | null;
    }
): Promise<{ runId: string }> {
    await connectDB();
    const run = await FilterBotRun.create({
        userId: ownerUserId,
        postUrl: meta.postUrl,
        action: meta.action,
        maxUsers: meta.maxUsers ?? null,
        total: 0,
        status: 'running',
        extractedAt: new Date(),
        updatedAt: new Date()
    });
    return { runId: String(run._id) };
}

export async function saveFilterBotRunProgress(
    ownerUserId: string,
    runId: string,
    users: Array<Record<string, unknown>>
): Promise<void> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) return;
    const rid = runId as unknown as mongoose.Types.ObjectId;
    if (!users.length) return;
    const ops: any[] = users.map((u, rowIndex) => {
        const ct = u.commentTime;
        const extractedAt =
            u.extractedAt instanceof Date
                ? u.extractedAt
                : typeof u.extractedAt === 'string'
                  ? new Date(u.extractedAt)
                  : new Date();
        return {
            updateOne: {
                filter: { runId: rid, userId: ownerUserId, rowIndex },
                update: {
                    $set: {
                        runId: rid,
                        userId: ownerUserId,
                        rowIndex,
                        externalId: u.id != null ? String(u.id) : `row_${rowIndex}`,
                        name: u.name != null ? String(u.name) : '',
                        username: u.username != null ? String(u.username) : null,
                        profileUrl: u.profileUrl != null ? String(u.profileUrl) : null,
                        anchorHref: u.anchorHref != null ? String(u.anchorHref) : null,
                        comment: u.comment != null ? String(u.comment) : '',
                        commentTime: ct instanceof Date ? ct : typeof ct === 'string' ? new Date(ct) : null,
                        extractedAt
                    },
                    $setOnInsert: {
                        profileEnrichment: {
                            status: 'pending',
                            enrichedAt: null,
                            phones: [],
                            addresses: [],
                            socialLinks: []
                        }
                    }
                },
                upsert: true
            }
        };
    });
    await FilterBotCommenter.bulkWrite(ops, { ordered: false } as any);

    await FilterBotRun.updateOne(
        { _id: rid, userId: ownerUserId },
        { $set: { total: users.length, status: 'running', updatedAt: new Date() } }
    );
}

export async function finalizeFilterBotRun(
    ownerUserId: string,
    runId: string,
    payload: {
        status: Exclude<FilterBotRunStatus, 'running'>;
        total: number;
        processingTimeMs: number;
        errorMessage?: string | null;
    }
): Promise<void> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) return;
    const rid = runId as unknown as mongoose.Types.ObjectId;
    await FilterBotRun.updateOne(
        { _id: rid, userId: ownerUserId },
        {
            $set: {
                status: payload.status,
                total: payload.total,
                processingTimeMs: payload.processingTimeMs,
                errorMessage: payload.errorMessage ?? undefined,
                extractedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
}

/**
 * Persists a Filter Bot run and comment rows. Uses chunked insertMany for large result sets.
 * On partial failure, removes the run and inserted rows for consistency.
 */
export async function persistFilterBotExtraction(
    ownerUserId: string,
    meta: FilterBotPersistMeta,
    users: Array<Record<string, unknown>>
): Promise<{ runId: string }> {
    await connectDB();
    const run = await FilterBotRun.create({
        userId: ownerUserId,
        postUrl: meta.postUrl,
        action: meta.action,
        maxUsers: meta.maxUsers ?? undefined,
        total: meta.total,
        status: meta.status,
        errorMessage: meta.errorMessage || undefined,
        processingTimeMs: meta.processingTimeMs,
        extractedAt: new Date(),
        updatedAt: new Date()
    });

    if (meta.status !== 'completed' || users.length === 0) {
        return { runId: String(run._id) };
    }

    try {
        for (let i = 0; i < users.length; i += FILTER_BOT_INSERT_CHUNK) {
            const slice = users.slice(i, i + FILTER_BOT_INSERT_CHUNK);
            const docs = slice.map((u, j) => {
                const rowIndex = i + j;
                const ct = u.commentTime;
                return {
                    runId: run._id,
                    userId: ownerUserId,
                    rowIndex,
                    externalId: u.id != null ? String(u.id) : `row_${rowIndex}`,
                    name: u.name != null ? String(u.name) : '',
                    username: u.username != null ? String(u.username) : undefined,
                    profileUrl: u.profileUrl != null ? String(u.profileUrl) : undefined,
                    anchorHref: u.anchorHref != null ? String(u.anchorHref) : undefined,
                    comment: u.comment != null ? String(u.comment) : '',
                    commentTime: ct instanceof Date ? ct : typeof ct === 'string' ? new Date(ct) : undefined,
                    extractedAt: u.extractedAt instanceof Date ? u.extractedAt : typeof u.extractedAt === 'string' ? new Date(u.extractedAt) : new Date()
                };
            });
            await FilterBotCommenter.insertMany(docs, { ordered: true });
        }
    } catch (err) {
        await FilterBotCommenter.deleteMany({ runId: run._id });
        await FilterBotRun.deleteOne({ _id: run._id });
        throw err;
    }
    return { runId: String(run._id) };
}

/**
 * Latest successful run for the user + one page of commenters (sorted by rowIndex).
 */
export async function getLatestFilterBotRunWithComments(
    ownerUserId: string,
    page = 1,
    limit = 100
): Promise<{
    run: Record<string, unknown> | null;
    users: Array<{
        id: string;
        rowIndex: number;
        name: string;
        username: string | null;
        profileUrl: string | null;
        anchorHref?: string | null;
        comment: string;
        commentTime: string;
        extractedAt: string;
        profileEnrichment?: Record<string, unknown> | null;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}> {
    await connectDB();
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const safePage = Math.max(1, Math.floor(page));
    const run = await FilterBotRun.findOne({ userId: ownerUserId })
        .sort({ createdAt: -1 })
        .lean();
    if (!run) {
        return { run: null, users: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
    const runId = run._id as mongoose.Types.ObjectId;
    const total = await FilterBotCommenter.countDocuments({ runId, userId: ownerUserId });
    const skip = (safePage - 1) * safeLimit;
    const rows = await FilterBotCommenter.find({ runId, userId: ownerUserId })
        .sort({ rowIndex: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean();
    const users = rows.map(r => ({
        id: r.externalId || `row_${r.rowIndex}`,
        rowIndex: r.rowIndex,
        name: r.name || 'Unknown User',
        username: r.username ?? null,
        profileUrl: r.profileUrl ?? null,
        anchorHref: r.anchorHref ?? null,
        comment: r.comment || '',
        commentTime: (r.commentTime?.toISOString?.() ?? new Date().toISOString()) as string,
        extractedAt: (r.extractedAt?.toISOString?.() ?? new Date().toISOString()) as string,
        profileEnrichment: serializeFilterBotProfileEnrichment(
            r.profileEnrichment as Record<string, unknown> | undefined
        )
    }));
    const totalPages = total > 0 ? Math.ceil(total / safeLimit) : 0;
    return {
        run: run as unknown as Record<string, unknown>,
        users,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages
    };
}

/**
 * Paginated commenters for a specific run (ownership enforced).
 */
export async function getFilterBotRunComments(
    ownerUserId: string,
    runId: string,
    page = 1,
    limit = 100
): Promise<{
    run: Record<string, unknown> | null;
    users: Array<{
        id: string;
        rowIndex: number;
        name: string;
        username: string | null;
        profileUrl: string | null;
        anchorHref?: string | null;
        comment: string;
        commentTime: string;
        extractedAt: string;
        profileEnrichment?: Record<string, unknown> | null;
    }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) {
        return { run: null, users: [], total: 0, page: 1, limit: 100, totalPages: 0 };
    }
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const safePage = Math.max(1, Math.floor(page));
    const run = await FilterBotRun.findOne({ _id: runId, userId: ownerUserId }).lean();
    if (!run) {
        return { run: null, users: [], total: 0, page: safePage, limit: safeLimit, totalPages: 0 };
    }
    const rid = run._id as mongoose.Types.ObjectId;
    const total = await FilterBotCommenter.countDocuments({ runId: rid, userId: ownerUserId });
    const skip = (safePage - 1) * safeLimit;
    const rows = await FilterBotCommenter.find({ runId: rid, userId: ownerUserId })
        .sort({ rowIndex: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean();
    const users = rows.map(r => ({
        id: r.externalId || `row_${r.rowIndex}`,
        rowIndex: r.rowIndex,
        name: r.name || 'Unknown User',
        username: r.username ?? null,
        profileUrl: r.profileUrl ?? null,
        anchorHref: r.anchorHref ?? null,
        comment: r.comment || '',
        commentTime: (r.commentTime?.toISOString?.() ?? new Date().toISOString()) as string,
        extractedAt: (r.extractedAt?.toISOString?.() ?? new Date().toISOString()) as string,
        profileEnrichment: serializeFilterBotProfileEnrichment(
            r.profileEnrichment as Record<string, unknown> | undefined
        )
    }));
    const totalPages = total > 0 ? Math.ceil(total / safeLimit) : 0;
    return {
        run: run as unknown as Record<string, unknown>,
        users,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages
    };
}

export async function listFilterBotRuns(ownerUserId: string, limit = 20, skip = 0) {
    await connectDB();
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const safeSkip = Math.max(0, Math.floor(skip));
    return FilterBotRun.find({ userId: ownerUserId })
        .sort({ createdAt: -1 })
        .skip(safeSkip)
        .limit(safeLimit)
        .select('postUrl action maxUsers total status processingTimeMs extractedAt createdAt')
        .lean();
}

export type FilterBotCommenterRowRef = {
    rowIndex: number;
    profileUrl: string | null;
    anchorHref: string | null;
};

/**
 * Load commenter rows by row indices for profile enrichment (ownership enforced).
 */
export async function getFilterBotCommentersForRows(
    ownerUserId: string,
    runId: string,
    rowIndices: number[]
): Promise<FilterBotCommenterRowRef[]> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId) || rowIndices.length === 0) return [];
    const rid = runId as unknown as mongoose.Types.ObjectId;
    const unique = Array.from(
        new Set(rowIndices.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0))
    );
    if (unique.length === 0) return [];

    const rows = await FilterBotCommenter.find({
        runId: rid,
        userId: ownerUserId,
        rowIndex: { $in: unique }
    })
        .select('rowIndex profileUrl anchorHref')
        .lean();

    return rows.map((r) => ({
        rowIndex: r.rowIndex,
        profileUrl: r.profileUrl ?? null,
        anchorHref: r.anchorHref ?? null
    }));
}

export type ProfileEnrichmentPayload = {
    status: 'pending' | 'processing' | 'completed' | 'failed';
    enrichedAt?: Date;
    phones?: string[];
    addresses?: string[];
    socialLinks?: Array<{ platform: string; url: string }>;
    profileUrlUsed?: string | null;
    aboutUrlUsed?: string | null;
    error?: string | null;
};

/**
 * Persist Agent 2 (profile enrichment) result for one commenter row.
 */
export async function updateFilterBotCommenterEnrichment(
    ownerUserId: string,
    runId: string,
    rowIndex: number,
    enrichment: ProfileEnrichmentPayload
): Promise<{ modified: boolean }> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) return { modified: false };
    const rid = runId as unknown as mongoose.Types.ObjectId;
    const doc: Record<string, unknown> = {
        status: enrichment.status,
        enrichedAt: enrichment.enrichedAt ?? new Date(),
        phones: enrichment.phones ?? [],
        addresses: enrichment.addresses ?? [],
        socialLinks: enrichment.socialLinks ?? [],
        profileUrlUsed: enrichment.profileUrlUsed ?? undefined,
        aboutUrlUsed: enrichment.aboutUrlUsed ?? undefined,
        error: enrichment.error ?? undefined
    };
    const res = await FilterBotCommenter.updateOne(
        { runId: rid, userId: ownerUserId, rowIndex },
        { $set: { profileEnrichment: doc } }
    );
    return { modified: (res.modifiedCount ?? 0) > 0 };
}

export async function claimPendingFilterBotCommenters(
    ownerUserId: string,
    runId: string,
    limit = 5
): Promise<FilterBotCommenterRowRef[]> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) return [];
    const rid = runId as unknown as mongoose.Types.ObjectId;
    const safeLimit = Math.min(25, Math.max(1, Math.floor(limit)));

    const candidates = await FilterBotCommenter.find({
        runId: rid,
        userId: ownerUserId,
        $or: [
            { profileEnrichment: { $exists: false } },
            { 'profileEnrichment.status': { $exists: false } },
            { 'profileEnrichment.status': 'pending' }
        ]
    })
        .sort({ rowIndex: 1 })
        .limit(safeLimit * 3)
        .select('rowIndex profileUrl anchorHref profileEnrichment')
        .lean();

    const claimed: FilterBotCommenterRowRef[] = [];
    for (const c of candidates) {
        if (claimed.length >= safeLimit) break;
        const res = await FilterBotCommenter.updateOne(
            {
                runId: rid,
                userId: ownerUserId,
                rowIndex: c.rowIndex,
                $or: [
                    { profileEnrichment: { $exists: false } },
                    { 'profileEnrichment.status': { $exists: false } },
                    { 'profileEnrichment.status': 'pending' }
                ]
            },
            {
                $set: {
                    profileEnrichment: {
                        ...(c.profileEnrichment || {}),
                        status: 'processing',
                        enrichedAt: new Date()
                    }
                }
            }
        );
        if ((res.modifiedCount || 0) > 0) {
            claimed.push({
                rowIndex: c.rowIndex,
                profileUrl: c.profileUrl ?? null,
                anchorHref: c.anchorHref ?? null
            });
        }
    }
    return claimed;
}

export async function getFilterBotRunStatus(
    ownerUserId: string,
    runId: string
): Promise<'running' | 'completed' | 'failed' | null> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) return null;
    const rid = runId as unknown as mongoose.Types.ObjectId;
    const run = await FilterBotRun.findOne({ _id: rid, userId: ownerUserId }).select('status').lean();
    return (run?.status as 'running' | 'completed' | 'failed' | undefined) ?? null;
}

/**
 * Bulk delete commenter rows for a run (ownership enforced).
 */
export async function deleteFilterBotRunComments(
    ownerUserId: string,
    runId: string,
    rowIndices: number[]
): Promise<{ deletedCount: number }> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) {
        return { deletedCount: 0 };
    }
    const uniqueRows = Array.from(
        new Set(
            (rowIndices || [])
                .map((n) => Number(n))
                .filter((n) => Number.isFinite(n) && n >= 0)
        )
    );
    if (uniqueRows.length === 0) return { deletedCount: 0 };

    const rid = runId as unknown as mongoose.Types.ObjectId;
    const deleted = await FilterBotCommenter.deleteMany({
        runId: rid,
        userId: ownerUserId,
        rowIndex: { $in: uniqueRows }
    });
    return { deletedCount: deleted.deletedCount || 0 };
}

/**
 * Delete a whole run (and its commenter rows) (ownership enforced).
 */
export async function deleteFilterBotRun(ownerUserId: string, runId: string): Promise<{ deletedCount: number }> {
    await connectDB();
    if (!mongoose.isValidObjectId(runId)) {
        return { deletedCount: 0 };
    }
    const rid = runId as unknown as mongoose.Types.ObjectId;

    // Only delete if run belongs to owner
    const runExists = await FilterBotRun.exists({ _id: rid, userId: ownerUserId });
    if (!runExists) return { deletedCount: 0 };

    const deletedRows = await FilterBotCommenter.deleteMany({ runId: rid, userId: ownerUserId });
    await FilterBotRun.deleteOne({ _id: rid, userId: ownerUserId });
    return { deletedCount: deletedRows.deletedCount || 0 };
}
