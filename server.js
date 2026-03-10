const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- הגדרות אבטחה (CORS) ---
const allowedOrigins = [
    'https://akol-catuv.web.app',
    'https://purim-4c32f.web.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

// מאפשר קבלת קבצי JSON גדולים (עד 50MB)
app.use(express.json({ limit: '50mb' }));

// ==========================================
// 1. נתיב התמלול (Transcribe)
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        if (!apiKey || !fileUri) return res.status(400).json({ error: 'חסר מפתח או קובץ' });

        const model = modelName || 'gemini-2.5-flash';
        const systemPrompt = `תפקיד: מומחה תמלול.
הוראה: תמלל את האודיו לעברית תקנית.
כללים:
1. תקן שגיאות הגייה ודקדוק.
2. הפלט חייב להיות אובייקט JSON תקין בלבד, במבנה הבא בדיוק:
{
  "summary": "כתוב סיכום של התוכן בשפה העברית בלבד (עד 25 מילים).",
  "subtitles": [{"start":"HH:MM:SS,mmm","end":"HH:MM:SS,mmm","text":"..."}]
}
3. קריטי: אסור להשתמש במרכאות כפולות (") בתוך ערכי הטקסט. השתמש בגרש יחיד (') בלבד.
${promptCtx ? 'הקשר: ' + promptCtx : ''}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt }, { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!response.ok) throw new Error(await response.text());
        res.json(await response.json());
    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 2. נתיב הצ'אט (Chat)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });

        const model = modelName || 'gemini-2.5-flash';
        const systemPrompt = `
        You are a smart assistant for a transcription app.
        Use the following transcript JSON for grounding: ${JSON.stringify(contextSubs)}.
        User Question: "${msgPrompt}"
        Instructions:
        1. Answer in Hebrew based ONLY on the transcript.
        2. Citation format: Append [[id:mm:ss]] to the relevant sentence.
        3. Format lists using simple bullet points.
        4. If the text contains [דובר] or [שואל], prefix your response with that tag.
        `;

        const lastUserMessage = historyForApi[historyForApi.length - 1];
        lastUserMessage.parts[0].text = systemPrompt;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: historyForApi })
        });

        if (!response.ok) throw new Error(await response.text());
        res.json(await response.json());
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
