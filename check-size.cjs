require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const docs = await db.collection('leadcaptureresults')
    .find({ runId: new mongoose.Types.ObjectId('69ddc968e220ad6f59becf59') })
    .toArray();
  const json = JSON.stringify(docs);
  console.log('Doc count:', docs.length);
  console.log('Total payload size (bytes):', json.length);
  console.log('Total payload size (MB):', (json.length / 1024 / 1024).toFixed(2));
  // Check largest doc
  const sizes = docs.map(d => ({ name: d.companyName, bytes: JSON.stringify(d).length, posts: d.linkedinPosts?.length || 0, ocr: (d.linkedinPosts || []).reduce((s, p) => s + (p.ocrTexts?.join('').length || 0), 0) }));
  sizes.sort((a, b) => b.bytes - a.bytes);
  console.log('Top 5 largest docs:');
  sizes.slice(0, 5).forEach(s => console.log(`  ${s.bytes.toString().padStart(8)} bytes | posts=${s.posts} | ocrChars=${s.ocr} | ${s.name?.slice(0, 50)}`));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
