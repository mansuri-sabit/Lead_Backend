// Quick check: how many LeadCaptureResult docs exist for the latest run?
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const runs = await db.collection('leadcaptureruns')
    .find({})
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  console.log('\n=== Recent Lead Capture Runs ===');
  for (const r of runs) {
    const count = await db.collection('leadcaptureresults').countDocuments({ runId: r._id });
    console.log({
      _id: r._id.toString(),
      status: r.status,
      totalCompanies: r.totalCompanies,
      processedCount: r.processedCount,
      createdAt: r.createdAt,
      actualResultDocsInDB: count,
    });

    // Sample 3 result docs
    const sample = await db.collection('leadcaptureresults')
      .find({ runId: r._id })
      .limit(3)
      .project({ companyName: 1, rowIndex: 1, agent1Status: 1, agent2Status: 1, agent3Status: 1, score: 1 })
      .toArray();
    console.log('  sample:', sample);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
