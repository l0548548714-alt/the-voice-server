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
// 1. נתיב התמלול (מעודכן עם Structured Outputs)
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    req.setTimeout(300000); 

    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';
        
        // הנחיה נקייה לחלוטין! בלי אזהרות JSON או מרכאות.
        const systemInstructionText = `תפקיד: מומחה תמלול שמע לתוכן תורני (Strict Verbatim).

כללים:
1. תמלל אך ורק מה שנשמע בבירור. קטע לא מובן - חובה לכתוב: [לא ברור].
2. אל תשלים משפטים ואל תשנה את התחביר.
3. שמור על שפת המקור במדויק (עברית, ארמית), כולל ציטוטים.
4. הוסף סימני פיסוק לפי האינטונציה.
5. מספרים - תמיד במילים ("שמונה עשרה" ולא 18).
6. כתובית אחת: עד 40 מילים, עד 30 שניות.
7. כתוב סיכום קצר ולעניין (2-3 משפטים) של נושא השיעור.`;

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
                    // 🔥 סכמת הנתונים שמכריחה את המודל להחזיר JSON תקני:
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

if (rawText) {
    try {
        const parsed = JSON.parse(rawText);
        return res.json(parsed);
    } catch(e) {
        return res.status(500).json({ error: 'תשובת גוגל לא תקינה', details: rawText });
    }
}
        return res.json(geminiData);

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

        // הוספנו הנחיה ברורה לענות בצורה קצרה וקולעת
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
                    maxOutputTokens: 8192 // גם כאן הבטחנו טווח רחב לתשובה
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
        
        // רק כעת השרת מתחיל להאזין לבקשות
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err.message);
        process.exit(1); 
    });
