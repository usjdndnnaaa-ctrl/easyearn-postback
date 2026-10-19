const PROJECT_ID = "gen-lang-client-0934700512";
const DATABASE_ID = "ai-studio-android-easyearn-5be24963-88b1-4ab2-af0e-61256e46abe6";
const API_KEY = "AIzaSyC-V5yMlrVNU2rzUyy8-TVdEV5anxuYVbk";
const SECRET_KEY = "EASYEARN_KEY_2026";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

// Rate: $1.00 USD = 10,000 Coins
const COINS_PER_USD = 10000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const userId = req.query.user_id || req.query.sub1 || req.query.ymid || req.body?.user_id;
    const payoutRaw = req.query.payout || req.query.amount || req.body?.payout;
    const transId = req.query.trans_id || req.query.transaction_id || req.body?.trans_id || `tr_${Date.now()}`;

    if (!userId) {
      return res.status(400).send("Error: Missing user_id parameter");
    }

    const payout = parseFloat(payoutRaw) || 0.0;
    const coinsToAdd = Math.max(1, Math.round(payout * COINS_PER_USD));

    // Duplicate Check
    if (transId) {
      const checkRes = await fetch(`${BASE_URL}/postback_queue/${transId}?key=${API_KEY}`);
      if (checkRes.status === 200) {
        return res.status(200).send("OK: Duplicate Transaction Ignored");
      }

      await fetch(`${BASE_URL}/postback_queue?documentId=${transId}&key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            userId: { stringValue: userId },
            coins: { integerValue: String(coinsToAdd) },
            payout: { doubleValue: payout },
            processedAt: { timestampValue: new Date().toISOString() }
          }
        })
      });
    }

    const docId = userId.includes("@") ? userId.replace(/\./g, "_") : userId;
    const userRes = await fetch(`${BASE_URL}/users/${docId}?key=${API_KEY}`);
    
    if (userRes.status === 200) {
      const userData = await userRes.json();
      const currentCoins = parseInt(userData.fields?.coins?.integerValue || userData.fields?.coins?.doubleValue || 0);
      const newCoins = currentCoins + coinsToAdd;

      await fetch(`${BASE_URL}/users/${docId}?updateMask.fieldPaths=coins&updateMask.fieldPaths=secretKey&key=${API_KEY}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            coins: { integerValue: String(newCoins) },
            secretKey: { stringValue: SECRET_KEY }
          }
        })
      });

      return res.status(200).send("OK");
    } else {
      return res.status(200).send("OK: Queued in postback_queue");
    }
  } catch (error) {
    return res.status(500).send("Internal Server Error: " + error.message);
  }
};
