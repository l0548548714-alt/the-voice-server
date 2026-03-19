const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
console.log('🔍 MONGO_URI:', process.env.MONGO_URI?.substring(0, 60));
const mongoose = require('mongoose');

// --- 🔒 אבטחה: הגדרת פיירבייס בשרת ---
const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase Admin initialized');
    } catch (err) {
        console.error('❌ Firebase Admin initialization error:', err.message);
    }
}

// 🔒 פונקציית "השומר": בודקת את תעודת הזהות (Token)
const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'גישה נדחתה. חסרה תעודת זהות (Token).' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.userEmail = decodedToken.email; 
        next();
    } catch (error) {
        console.error('❌ שגיאת אימות טוקן:', error.message);
        return res.status(403).json({ error: 'תעודת זהות (Token) לא חוקית או פגה תוקף.' });
    }
};

const app = express();
const PORT = process.env.PORT || 3000;

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    apiKey: String,
    updatedAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

app.use(cors());
app.use(express.json({ limit: '50mb' })); 

// ----------------------------------------------------
// 🔒 שמירת מפתח API למשתמש
// ----------------------------------------------------
app.post('/api/save-user-key', verifyFirebaseToken, async (req, res) => {
    try {
        const secureEmail = req.userEmail; 
        const { apiKey } = req.body;
        
        if (!apiKey && apiKey !== '') return res.status(400).json({ error: 'חסר מפתח API' });
        
        await User.findOneAndUpdate(
            { email: secureEmail.toLowerCase() },
            { apiKey: apiKey, updatedAt: Date.now() },
            { upsert: true } 
        );
        res.json({ success: true });
    } catch (error) {
        console.error('❌ save-user-key error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ----------------------------------------------------
// 🔒 שליפת מפתח API למשתמש
// ----------------------------------------------------
app.get('/api/get-user-key', verifyFirebaseToken, async (req, res) => {
    try {
        const secureEmail = req.userEmail;
        const user = await User.findOne({ email: secureEmail.toLowerCase() });
        res.json({ apiKey: user ? user.apiKey : null });
    } catch (error) {
        console.error('❌ get-user-key error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// מנגנון הגנה נגד ספאם (Rate Limiting)
// ==========================================
const userRequests = new Map();

const rateLimiter = (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    const cooldownMs = 60 * 1000;

    if (userRequests.has(ip)) {
        const timePassed = now - userRequests.get(ip);
        
        if (timePassed < cooldownMs) {
            const timeLeft = Math.ceil((cooldownMs - timePassed) / 1000);
            console.warn(`🚨 חסימת ספאם: ה-IP ${ip} ניסה לשלוח מהר מדי. נותרו ${timeLeft} שניות.`);
            return res.status(429).json({ 
                error: `שליחה מהירה מדי! אנא המתן ${timeLeft} שניות לפני תמלול נוסף.` 
            });
        }
    }
    
    userRequests.set(ip, now);
    next();
};

// ==========================================
// 1. נתיב התמלול
// ==========================================
app.post('/api/transcribe', rateLimiter, async (req, res) => {
    req.setTimeout(300000); 

    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';
        
        const systemInstructionText = `תפקיד: אתה מומחה לתמלול אודיו, המתמחה בשפה העברית ובלשון הקודש, עם יכולת זיהוי פונטית גבוהה והמרה לכתיב תקני.
המשימה: תמלל במדויק את קובץ האודיו המצורף לשפה עברית תקנית ורצופה. מטרת העל היא להפיק תמלול מדויק פונטית-סמנטית — לשקף את המשמעות המילולית והכתיב התקני של המילים, גם אם ההגייה בפועל שונה מהנורמה.

## 1. הנחיות לשוניות וכללי תעתיק (עדיפות עליונה)

יש לגשר בין הגייה מסורתית (כגון אשכנזית) לבין כתיב עברי תקני.

### כללי ברזל לתיקון הגייה לכתיב תקני:

**עיצורים 'ת'/'ס':** אם 'ת' (ללא דגש) נשמעת כ'ס' — תמלל תמיד כ'ת'.
- "בראסיס" → בראשית | "שבס" → שבת

**עיצורים 'כ'/'ס'/'ש':** אם 'כ' (ללא דגש) נשמעת כ'ס' או 'ש' — תמלל כ'כ'.
- "כסיב" → כתיב

**תנועות (קמץ/חולם/צירה):** תמלל לפי האות המקורית בכתיב התקני, ללא קשר לשינוי ההגייה.
- "שולויים" → שלום | "סויד" → סוד | "חילק" → חלק

**מונחי לשון הקודש וארמית:** תמלל בכתיבן התקני המקובל בהקשר.
- 'שבס קוידש' → שבת קודש | 'חוכמו' → חכמה | 'עוילם' → עולם | 'להוי' → להיות
- **יוצא דופן:** מילות קישור ארמיות (כגון 'קא') — שמור בכתיב ארמי: קא.

## 2. כללי תמלול כלליים

1. תמלל אך ורק מה שנשמע בבירור. קטע לא מובן — חובה לכתוב: [לא ברור].
2. אל תשלים משפטים ואל תשנה את התחביר.
3. הוסף סימני פיסוק לפי האינטונציה.
4. מספרים — תמיד במילים ("שמונה עשרה" ולא 18).
5. כתובית אחת: עד 40 מילים, עד 30 שניות.
6. שמור על סדר כרונולוגי עולה ועקבי של חותמות הזמן לאורך כל התמלול, ללא קפיצות אחורה.
7. תמלל את הקובץ **במלואו**, מהשנייה הראשונה ועד האחרונה, מילה במילה. אסור לעצור, לדלג, לקצר או לסכם חלקים, גם אם הקובץ ארוך.
8. כתוב סיכום קצר (2–3 משפטים) של נושא השיעור.`;

        const requestParts = [
            { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
        ];
        
        if (promptCtx) {
            requestParts.push({ text: `הקשר לאודיו זה: ${promptCtx}` });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: [{ parts: requestParts }],
                generationConfig: { 
                    responseMimeType: "application/json",
                    maxOutputTokens: 65536,
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            summary: { type: "STRING" },
                            subtitles: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        start: { type: "STRING" },
                                        end: { type: "STRING" },
                                        text: { type: "STRING" }
                                    },
                                    required: ["start", "end", "text"]
                                }
                            }
                        },
                        required: ["summary", "subtitles"]
                    }
                }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: 'שגיאת API מגוגל', details: errText });
        }

        const geminiData = await response.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!rawText) {
             return res.status(500).json({ error: 'לא התקבל טקסט מגוגל' });
        }
        
        let cleanText = rawText.replace(/```json/gi, '').replace(/```/gi, '').trim();

        try {
            const parsedData = JSON.parse(cleanText);
            return res.json(parsedData);
        } catch (e) {
            console.error('JSON Parse Error in server:', e);
            return res.status(500).json({ error: 'תשובת גוגל לא תקינה (שגיאת פענוח)', details: cleanText });
        }

    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({ error: 'אירעה שגיאה בתהליך התמלול', details: error.message });
    }
});

// ==========================================
// 2. נתיב הצ'אט
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });
        
        const model = modelName || 'gemini-2.5-flash';

        const systemInstructionText = `
        You are a smart assistant for a transcription app.
        Use the following transcript JSON for grounding: ${JSON.stringify(contextSubs || [])}.
        Answer in Hebrew.
        Keep your answers short, concise, and to the point. Avoid long paragraphs unless specifically asked for a detailed explanation.
        `;

        const safeHistory = JSON.parse(JSON.stringify(historyForApi));
        
        const lastMessage = safeHistory[safeHistory.length - 1];
        if (msgPrompt && lastMessage.parts && lastMessage.parts[0]) {
             lastMessage.parts[0].text += `\n\nUser Question: "${msgPrompt}"`;
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: safeHistory,
                generationConfig: { 
                    maxOutputTokens: 65536 
                }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: 'שגיאת API מגוגל', details: errText });
        }
        
        res.json(await response.json());
        
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. נתיב השכמה (Ping)
// ==========================================
app.get('/api/wakeup', (req, res) => {
    res.json({ status: 'awake', message: 'בוקר טוב! השרת התעורר ומוכן לעבודה.' });
});

// ==========================================
// הפעלת השרת רק לאחר התחברות למונגו
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB Atlas');
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err.message);
        process.exit(1); 
    });
