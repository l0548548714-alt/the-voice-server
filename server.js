const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const { v4: uuidv4 } = require('uuid');
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
// --- הגדרת מודל למשימות תמלול ---
const jobSchema = new mongoose.Schema({
    jobId: { type: String, unique: true, required: true },
    status: { type: String, enum: ['processing', 'completed', 'error'], default: 'processing' },
    result: mongoose.Schema.Types.Mixed,
    error: String,
    details: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const Job = mongoose.model('Job', jobSchema);

app.use(cors());
app.use(express.json({ limit: '50mb' })); 

// שומר את הסטטוס והתוצאות של משימות התמלול  

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
// מנגנון הגנה נגד ספאם — משמש רק לנתיבים שאינם תמלול
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
// 1. נתיב התמלול — ללא rate limiter כדי לאפשר עיבוד קבצים ארוכים בקטעים
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';

        const jobId = uuidv4();

        // יצירת רשומה חדשה ב-MongoDB
        await Job.create({ jobId: jobId, status: 'processing' });

        res.status(202).json({ jobId: jobId, status: 'processing' });

        (async () => {
            try {
                // === הנחיית מערכת קשוחה מותאמת אישית לשיעורי תורה ===
                const systemInstructionText = `תפקיד: אתה "מניח" (מתמלל) מומחה של שיעורי תורה, ברמה של תלמיד חכם מובהק. אתה שולט בשפה העברית, לשון הקודש, ארמית תלמודית, יידיש, וסלנג מודרני/ישיבתי.
המשימה: תמלול מדויק של דברי הרב לפי חוקים נוקשים של אפס הזיות (ZERO HALLUCINATIONS) והתאמה לספרות התורנית.

[חוקי ברזל לטקסט]
1. השענות אקוסטית בלבד: אל תמציא, תנחש או תשלים מילים. טקסט שלא נשמע בבירור יסומן מיד כ-[לא ברור].

[1. ניקוי גמגומים]
נקה את התמלול מגמגומים, מילות הרהור ("אה", "אממ") וחזרות מיותרות על אותה מילה. התמלול חייב להיות נקי וקריא, אך עליך לשמור על כל מילה בעלת משמעות או תוכן.

[2. שילוב שפות (יידיש / אנגלית / סלנג)]
חובה לתמלל מילים משפות אחרות או סלנג בדיוק מוחלט כפי שנאמרו, באותיות עבריות (או במקור אם זה באנגלית מובהקת), ללא שום ניסיון לתרגם לעברית תקנית! (לדוגמה: "א גוטע סברא", "טאקע", "ממילא", "למעשה", "אקשלי").

[3. ראשי תיבות]
כתוב את המילים כפי שנאמרו. אל תפתח ואל תסגור ראשי תיבות על דעת עצמך, *אלא אם כן* מדובר במושג מובהק שתמיד נכתב בראשי תיבות בספרות התורנית הקלאסית (לדוגמה: אם נאמר "רבי משה בן מימון" כתוב כפי שנאמר. אם נאמר "רמב"ם" כתוב רמב"ם ולא במילים. אם ההקשר מצדיק, אפשר לכתוב ע"ז, ק"ש, וכד').

[4. מראי מקומות וציונים (חובה לקצר)]
כאשר הרב מציין מקור, חובה לכתוב זאת בקיצור התורני המקובל.
* דוגמה לגמרא: "בבא קמא דף ל עמוד א" ייכתב כ- ב"ק ל ע"א (או בבא קמא ל ע"א).
* דוגמה להלכה: "אורח חיים סימן ש"י סעיף קטן ב" ייכתב כ- או"ח ש"י סק"ב.

[כללי המרה: הגייה ישיבתית לכתיב תקני]
עליך להאזין לצליל ולהמירו לכתיב המקורי:
* ס' בסוף/אמצע מילה שנשמע כמו ת' רפה -> יתומלל כ-ת' (לדוגמה: "מסכתס" -> מסכתות, "שבס" -> שבת, "טויספויס" -> תוספות).
* תנועות אשכנזיות -> יתומללו בכתיב תקני (לדוגמה: "תוירה" -> תורה, "מעיישה" -> מעשה).
* ארמית -> לשמור על הכתיב הארמי המקורי (לדוגמה: "מאי קא משמע לן", "סברא").

[חוקי עיצוב הפלט (SRT / JSON)]
1. כל כתובית תכיל בין 5 ל-30 מילים (קריאה נוחה).
2. שמור על רצף כרונולוגי עולה ועקבי של חותמות הזמן.
3. בסיום, הוסף סיכום (summary) של 2-3 משפטים המתמצת את תורף הסוגיה.`;
                const requestParts = [
                    { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
                ];
                
                // --- מנגנון הזרקת הקשר חי (Context) ---
                if (promptCtx) {
                    requestParts.push({ text: `חובה להצמד למושגים הבאים המופיעים באודיו: ${promptCtx}` });
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
                            temperature: 0.1, // <--- הקסם נגד הזיות: טמפרטורה נמוכה גורמת למודל להיות מדויק ורובוטי
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
                    console.error(`❌ Gemini API Error for job ${jobId}:`, errText.substring(0, 500));
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'שגיאת API מגוגל', details: errText });
                    return;
                }

                const geminiData = await response.json();
                const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (!rawText) {
                    console.error(`❌ Empty response from Gemini for job ${jobId}`);
                    await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'לא התקבל טקסט מגוגל' });
                    return;
                }
                
                let cleanText = rawText.replace(/```json/gi, '').replace(/```/gi, '').trim();

                try {
                    const parsedData = JSON.parse(cleanText);
                    await Job.findOneAndUpdate({ jobId: jobId }, {
                        status: 'completed',
                        result: parsedData
                    });
                } catch (e) {
                    console.error(`❌ JSON Parse Error for job ${jobId}:`, e.message);
                    console.error('Response length:', cleanText.length);
                    console.error('Last 300 chars:', cleanText.slice(-300));
                    await Job.findOneAndUpdate({ jobId: jobId }, { 
                        status: 'error', 
                        error: `תשובת גוגל לא תקינה (שגיאת פענוח JSON). אורך תשובה: ${cleanText.length} תווים`,
                        details: cleanText.slice(-500) 
                    });
                }

            } catch (backgroundError) {
                console.error('Background task error:', backgroundError);
                await Job.findOneAndUpdate({ jobId: jobId }, { status: 'error', error: 'שגיאה כללית בתהליך הרקע', details: backgroundError.message });
            }
        })();

    } catch (error) {
        console.error('Transcription Init Error:', error);
        res.status(500).json({ error: 'אירעה שגיאה באתחול התמלול' });
    }
});

// ==========================================
// 1b. נתיב בדיקת מצב משימה (Polling) - מעודכן ל-MongoDB
// ==========================================
app.get('/api/transcribe/status/:jobId', async (req, res) => {
    try {
        const jobId = req.params.jobId;
        // מחפשים את המשימה ב-MongoDB במקום בזיכרון השרת
        const job = await Job.findOne({ jobId: jobId });

        if (!job) {
            return res.status(404).json({ error: 'משימה לא נמצאה' });
        }

        // מחזירים את האובייקט המלא (סטטוס, תוצאה או שגיאה)
        res.json(job);
        
        // אין צורך למחוק ידנית - הגדרנו ב-Schema שהרשומה נמחקת לבד אחרי 24 שעות
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'שגיאה בבדיקת סטטוס המשימה' });
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
