const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
console.log('🔍 MONGO_URI:', process.env.MONGO_URI?.substring(0, 60));
const mongoose = require('mongoose');

// --- 🔒 אבטחה: הגדרת פיירבייס בשרת ---
const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        // ✅ תיקון: שימוש במשתנה סביבה עם פרטי Service Account
         const serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Firebase Admin initialized');
    } catch (err) {
        console.error('❌ Firebase Admin initialization error:', err.message);
    }
}

// 🔒 פונקציית "השומר": בודקת את תעודת הזהות (Token) לפני שהיא נותנת להיכנס
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

// --- חיבור למסד הנתונים MongoDB Atlas ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

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
// 1. נתיב התמלול
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    req.setTimeout(300000); 

    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';
        
        const systemInstructionText = `תפקיד: מומחה תמלול וסנכרון כתוביות מקצועי.
המטרה: להפיק תמלול מדויק בפורמט JSON הכולל כתוביות (SRT style) וסיכום. האודיו כולל שיחה או הרצאה בעברית שמשולבים בה מילים וביטויים רבים מ"לשון הקודש" עם הגייה מסורתית.

חוקי שפה ותרגום (קריטי):
1. אין לתרגם שפות! אם הדובר עובר לאנגלית (או שפה זרה אחרת), תמלל את המילים בשפת המקור (באותיות לטיניות). אל תתרגם לעברית.
2. התיקון היחיד המותר הוא "נורמליזציה" של הגיית לשון הקודש לכתיב עברי תקני כמפורט בהמשך.

חוקי איכות התמלול והסנכרון (קריטי לנגן ולחוויית קריאה):
1. תמלול נקי (Clean Verbatim): התעלם לחלוטין ממילות מילוי ('אה', 'אממ', 'אהה'), גמגומים וחזרות מיותרות. אל תכתוב אותן. ספק טקסט רציף וקריא.
2. מניעת הזיות (Hallucinations): בשתיקות ארוכות, רעשי רקע או מוזיקה - אל תמציא טקסט! התעלם לחלוטין משקט. אם הדיבור אינו מובן כלל, השתמש בתגית [לא ברור].
3. אסתטיקת כתוביות: לעולם אל תסיים כתובית באות יחס (כמו 'ו', 'ב', 'ל', 'מ', 'ש') או בפסיק (,). נקודה (.) בסוף משפט תמיד תסיים את הכתובית הנוכחית.
4. מקטעים קצרים: כל כתובית צריכה להכיל בין 3 ל-7 מילים, או להימשך מקסימום 5 שניות.
5. דיוק זמנים: זמני ה-start וה-end חייבים להיות מדויקים פונטית לדיבור. פורמט: HH:MM:SS,mmm.

עקרון מפתח: נורמליזציה לכתיב תקני של לשון הקודש:
יש ליישם תיקון אוטומטי של הגיית לשון הקודש חזרה לכתיב התקני העברי הסטנדרטי:
- עיצורים: 'כסיב'/'שבס' -> כתיב/שבת. 'בראסיס' -> בראשית. 'מיתרה' -> מטרה.
- תנועות: 'שולויים'/'קוֹדוֹיש' -> שלום/קדוש. 'סויד'/'חוכמו' -> סוד/חכמה. 'חילק'/'אימת' -> חלק/אמת.
- מונחי מפתח: 'שבס קוידש' -> שבת קודש. 'עוילם' -> עולם. 'עיון' -> עיון. 'קא' נשאר קא. 'להוי' -> להיות.

כללי פלט JSON (Strict):
הפלט חייב להיות אובייקט JSON תקין בלבד, ללא שום טקסט נוסף או עיצוב (ללא סימון \`\`\`json).
קריטי: אסור להשתמש במרכאות כפולות (") בתוך ערכי הטקסט (summary או text). השתמש בגרש יחיד (') בלבד. אל תרד שורות בתוך הטקסט.
* שים לב: הדוגמה הבאה נועדה להמחשת המבנה, חיתוך הזמנים וניקוי הרעשים בלבד. התוכן, כמובן, יהיה שונה בהתאם לאודיו שתקבל.
דוגמת ביצוע (Few-Shot Example):
דוגמה לאודיו בו הדובר אומר: "אז... אהה... אנחנו לומדים היום על... שבס קוידש. ו... זה כמובן מאוד חשוב."
פלט מצופה:
{
  "summary": "הדובר פותח את השיעור ומציין שהיום נלמד על חשיבותה של שבת קודש.",
  "subtitles": [
    {"start":"00:00:01,000","end":"00:00:03,500","text":"אז אנחנו לומדים היום על"},
    {"start":"00:00:03,500","end":"00:00:05,200","text":"שבת קודש."},
    {"start":"00:00:06,000","end":"00:00:08,000","text":"וזה כמובן מאוד חשוב."}
  ]
}`;

        const requestParts = [
            { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
        ];
        
        if (promptCtx) {
            requestParts.push({ text: `הקשר לאודיו זה שיעזור לך בתמלול: ${promptCtx}` });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: [{ parts: requestParts }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Google API Error:', errText);
            return res.status(response.status).json({ error: 'שגיאת API מגוגל', details: errText });
        }

        res.json(await response.json());

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
        if (!historyForApi || !Array.isArray(historyForApi) || historyForApi.length === 0) {
            return res.status(400).json({ error: 'היסטוריית הצ\'אט חסרה או לא תקינה במבנה המצופה' });
        }

        const model = modelName || 'gemini-2.5-flash';

        const systemInstructionText = `
        You are a smart assistant for a transcription app.
        Use the following transcript JSON for grounding: ${JSON.stringify(contextSubs || [])}.
        
        Instructions:
        1. Answer in Hebrew based ONLY on the transcript.
        2. If the answer is found in specific segments, citation is MANDATORY.
        3. Citation format: Append [[id:mm:ss]] to the relevant sentence. 
        4. Format lists using simple bullet points.
        5. DO NOT REPEAT THE TRANSCRIPT. Summarize and answer concisely.
        6. If the text contains [דובר] or [שואל], prefix your response with that tag to indicate who is speaking.
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
                contents: safeHistory 
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Google Chat API Error:', errText);
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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
