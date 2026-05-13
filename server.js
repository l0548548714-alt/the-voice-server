const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const crypto = require('crypto');

// --- 🔒 אבטחה: הגדרות הצפנה מתקדמות (AES-256-GCM) ---
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY || Buffer.from(ENCRYPTION_KEY, 'hex').length !== 32) {
    console.error('❌ ENCRYPTION_KEY חסר או לא חוקי! חובה להגדיר מחרוזת HEX של 64 תווים ב-Render.');
    process.exit(1);
}

const IV_LENGTH = 12;

function encrypt(text) {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${encrypted}:${authTag}`;
    } catch (e) { console.error('Encryption error:', e); return text; }
}

function decrypt(text) {
    if (!text) return text;
    try {
        const parts = text.split(':');
        // אם המבנה אינו GCM (3 חלקים), מחזיר null
        if (parts.length !== 3) return null;
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = parts[1];
        const authTag = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { console.error('Decryption error:', e); return null; }
}

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

// --- הגדרת מודל למשימות תמלול ---
const jobSchema = new mongoose.Schema({
    jobId: { type: String, unique: true, required: true, index: true },
    status: { type: String, enum: ['processing', 'completed', 'error'], default: 'processing' },
    result: mongoose.Schema.Types.Mixed,
    error: String,
    details: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const Job = mongoose.model('Job', jobSchema);

app.use(cors());
app.use(express.json({ limit: '50mb' })); 

// ==========================================
// ניהול מפתחות API של המשתמש
// ==========================================
app.post('/api/save-user-key', verifyFirebaseToken, async (req, res) => {
    try {
        const secureEmail = req.userEmail; 
        const { apiKey } = req.body;
        
        if (!apiKey && apiKey !== '') return res.status(400).json({ error: 'חסר מפתח API' });
        
        const encryptedKey = encrypt(apiKey); // הצפנת המפתח

        await User.findOneAndUpdate(
            { email: secureEmail.toLowerCase() },
            { apiKey: encryptedKey, updatedAt: Date.now() },
            { upsert: true } 
        );
        res.json({ success: true });
    } catch (error) {
        console.error('❌ save-user-key error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/get-user-key', verifyFirebaseToken, async (req, res) => {
    try {
        const secureEmail = req.userEmail;
        const user = await User.findOne({ email: secureEmail.toLowerCase() });
        const decryptedKey = user && user.apiKey ? decrypt(user.apiKey) : null;
        res.json({ apiKey: decryptedKey });
    } catch (error) {
        console.error('❌ get-user-key error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// מנגנון הגנה נגד ספאם
// ==========================================
const userRequests = new Map();

// ניקוי זיכרון כל דקה
setInterval(() => {
    const now = Date.now();
    for (let [identifier, timestamp] of userRequests.entries()) {
        if (now - timestamp > 60000) userRequests.delete(identifier);
    }
}, 60000);

const rateLimiter = (req, res, next) => {
    const identifier = req.userEmail || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    const cooldownMs = 10 * 1000; // 10 שניות

    if (userRequests.has(identifier)) {
        const timePassed = now - userRequests.get(identifier);
        
        if (timePassed < cooldownMs) {
            return res.status(429).json({ 
                error: `שליחה מהירה מדי! נסה שוב בעוד מספר שניות.` 
            });
        }
    }
    
    userRequests.set(identifier, now);
    next();
};

// ==========================================
// 1. נתיב התמלול (מאובטח)
// ==========================================
app.post('/api/transcribe', verifyFirebaseToken, rateLimiter, async (req, res) => {
    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        // 🛡️ SSRF Validation קשוח
        try {
            const parsedUri = new URL(fileUri);
            if (parsedUri.hostname !== 'generativelanguage.googleapis.com') {
                return res.status(400).json({ error: 'URI לא מורשה (SSRF Protection).' });
            }
        } catch (e) {
            return res.status(400).json({ error: 'כתובת URI לא חוקית.' });
        }

        const model = modelName || 'gemini-2.5-flash';
        const jobId = uuidv4();

        // יצירת רשומה חדשה ב-MongoDB
        await Job.create({ jobId: jobId, status: 'processing' });
        res.status(202).json({ jobId: jobId, status: 'processing' });

        (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 דקות מקסימום

            try {
                // === הנחיית מערכת קשוחה מותאמת אישית לשיעורי תורה ===
                const systemInstructionText = `[1] תפקיד והקשר תורני
אתה מומחה תמלול מתקדם המתמחה בתוכן תורני של קהילות חרדיות אשכנזיות. התוכן הוא לימודי ולא שיח יומיומי (שיעורי תורה, דרשות, פלפול, קושיה ותירוץ).
משימתך: שחזור המשמעות האמיתית והמדויקת של הדובר — העדף תמיד פירושים תורניים, מושגים מהש"ס, פוסקים והקשרים ישיבתיים.

==================================================
[2] טיפול ברעשי רקע ודוברים
==================================================
- התעלם לחלוטין מרעשי רקע (שיעול, הזזת כיסאות, רשרושים) ושתיקות.
- אם יש יותר מדובר אחד, ציין זאת בקצרה: "הרב:", "שאלה:". תגובת קהל תירשם כ: (קהל: אמן).

==================================================
[3] עקרונות עבודה, דיוק לשוני ועקביות לאורך זמן
==================================================
1. תמלול מלא ואחיד: אין לקצר, אין לדלג על קטעים או חזרות. תמלל במלואו עד סוף האודיו ואל תעבור ל"מצב סיכום" בקבצים ארוכים!
2. דיוק לשוני אבסולוטי: אל תשפר את ניסוח הדובר, אל תהפוך משפטים ל"רשמיים", ושמור על טעויות דיבור טבעיות ומילות מעבר (נו, כלומר, ממילא, דהיינו).
3. אפס הזיות: אל תוסיף מילים שלא נאמרו. מילה חלקית נרשמת כ-[?]. קטע לא פוענח נרשם כ-[לא מובן].
4. נאמנות לשפה: אל תתרגם יידיש לעברית, כתוב בדיוק כפי שנשמע.
5. מספרים ותאריכים: כתוב בצורה תורנית קריאה (דף כ"ג, סימן רמ"ב).

==================================================
[4] זיכרון פנימי ושמירת עקביות
==================================================
שים לב לשמות, מושגים מרכזיים, ראשי תיבות וסגנון הדובר שמופיעים לאורך הקובץ, ושמור על איות זהה ועקביות מוחלטת שלהם מההתחלה ועד הסוף.

==================================================
[5] דוגמאות המרה וגלוסרי הגייה (אשכנזית -> כתיב תקני)
==================================================
חובה להמיר את ההגייה לכתיב המקורי:
- "שבּוס" -> שבת | "סוירה" / "סורה" -> תורה | "עוילם" -> עולם
- "יוים-טוב" -> יום טוב | "מיצוואס" -> מצוות | "קוידש" -> קודש | "דאַוונען" -> דאוונען

==================================================
[6] גלוסרי מושגים קלאסיים (לשמור כפי שנאמר)
==================================================
- ארמית: אמר רבא, אביי, תנא, אמורא, קא משמע לן, הוה אמינא, הכי קאמר, לשיטתו, דאורייתא, דרבנן, פשיטא, תיקו.
- הלכה וספרות: רש"י, תוספות, רמב"ן, שולחן ערוך, משנה ברורה, קשה, ויש לומר, לכתחילה, בדיעבד.

==================================================
[7] בדיקה עצמית לפני הפלט
==================================================
וודא עם עצמך: האם שמרתי על עקביות שמות? האם לא דילגתי על קטעים? האם לא הוספתי מילים שלא נאמרו?

==================================================
[8] פורמט הפלט (JSON בלבד!)
==================================================
חובה להחזיר את הפלט בדיוק לפי סכמת ה-JSON שהוגדרה לך:
1. את הכתוביות יש להכניס למערך "subtitles".
2. כל כתובית (text) צריכה להכיל בין 5 ל-35 מילים כדי שתהיה קריאה נוחה בנגן.
3. שמור על רצף זמנים (start, end) הגיוני ועולה.
4. את סיכום השיעור (3-5 נקודות קצרות של הנושאים המרכזיים) יש להכניס אך ורק לשדה ה-"summary", ולא בתוך הכתוביות.`;

                const requestParts = [
                    { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
                ];
                
                // --- מנגנון הזרקת הקשר חי (Context) ---
                if (promptCtx) {
                    requestParts.push({ text: `מושגים הקשורים להקלטה (אם הם אכן נאמרו, השתמש באיות זה): ${promptCtx}` });
                }

                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                
                let response;
                let fetchError;

                // 🔄 מנגנון Retry קשוח: מנסה 3 פעמים אם יש עומס בגוגל
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        response = await fetch(geminiUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            signal: controller.signal,
                            body: JSON.stringify({
                                systemInstruction: { parts: [{ text: systemInstructionText }] },
                                contents: [{ parts: requestParts }],
                                generationConfig: { 
                                    responseMimeType: "application/json",
                                    maxOutputTokens: 8192, // יציב יותר למניעת קריסות
                                    temperature: 0.1, // מניעת הזיות
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
                        if (response.ok) break; 
                        const errBody = await response.text();
                        fetchError = new Error(`Attempt ${attempt} failed: ${errBody.substring(0, 200)}`);
                    } catch (e) {
                        fetchError = e;
                    }
                    if (attempt < 3 && fetchError.name !== 'AbortError') await new Promise(r => setTimeout(r, 2000 * attempt));
                }

                clearTimeout(timeoutId);

                if (!response || !response.ok) {
                    const errorMsg = fetchError ? fetchError.message : 'שגיאת API מגוגל';
                    console.error(`❌ Gemini API Error for job ${jobId}:`, errorMsg);
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'שגיאת API מגוגל', details: errorMsg });
                    return;
                }

                const geminiData = await response.json();
                const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (!rawText) {
                    console.error(`❌ Empty response from Gemini for job ${jobId}`);
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'לא התקבל טקסט מגוגל' });
                    return;
                }
                
                // Regex משופר לחילוץ JSON (מונע קריסות פירמוט)
                let cleanText = rawText;
                const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
                if (jsonMatch) cleanText = jsonMatch[0];

                try {
                    const parsedData = JSON.parse(cleanText);
                    await Job.findOneAndUpdate({ jobId: jobId }, {
                        status: 'completed',
                        result: parsedData
                    });
                } catch (e) {
                    console.error(`❌ JSON Parse Error for job ${jobId}:`, e.message);
                    await Job.findOneAndUpdate({ jobId: jobId }, { 
                        status: 'error', 
                        error: `תשובת גוגל לא תקינה (שגיאת פענוח JSON).`,
                        details: cleanText.slice(-500) 
                    });
                }

            } catch (backgroundError) {
                clearTimeout(timeoutId);
                if (backgroundError.name === 'AbortError') {
                    console.error(`❌ Timeout Error for job ${jobId}`);
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'פג זמן ההמתנה. גוגל לא החזירו תשובה תוך 10 דקות (Timeout).' });
                } else {
                    console.error('Background task error:', backgroundError);
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'שגיאה כללית בתהליך הרקע', details: backgroundError.message });
                }
            }
        })();

    } catch (error) {
        console.error('Transcription Init Error:', error);
        res.status(500).json({ error: 'אירעה שגיאה באתחול התמלול' });
    }
});

// ==========================================
// 1b. נתיב בדיקת מצב משימה (Polling)
// ==========================================
app.get('/api/transcribe/status/:jobId', async (req, res) => {
    try {
        const jobId = req.params.jobId;
        const job = await Job.findOne({ jobId: jobId });

        if (!job) {
            return res.status(404).json({ error: 'משימה לא נמצאה' });
        }

        res.json(job);
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'שגיאה בבדיקת סטטוס המשימה' });
    }
});

// ==========================================
// 2. נתיב הצ'אט
// ==========================================
app.post('/api/chat', verifyFirebaseToken, rateLimiter, async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });
        
        const model = modelName || 'gemini-2.5-flash'; 

        // מניעת פיצוץ טוקנים בצ'אט
        const trimmedSubs = (contextSubs || []).slice(0, 150);

        const systemInstructionText = `
אתה עוזר בינה מלאכותית חכם באתר תמלול. 
התבסס אך ורק על ה-JSON הבא: ${JSON.stringify(trimmedSubs)}.
ענה בעברית ברורה ותקנית. השתדל לענות בתמציתיות ולעניין.
        `;

        const safeHistory = JSON.parse(JSON.stringify(historyForApi));
        
        const lastMessage = safeHistory[safeHistory.length - 1];
        if (msgPrompt && lastMessage.parts && lastMessage.parts[0]) {
             lastMessage.parts[0].text += `\n\nשאלת המשתמש: "${msgPrompt}"`;
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: safeHistory,
                generationConfig: { 
                    maxOutputTokens: 2048 
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
    
