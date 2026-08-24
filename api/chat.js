import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_HISTORY_TURNS = 10;

function getAdminAuth() {
  if (!getApps().length) {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!rawServiceAccount) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    }
    initializeApp({ credential: cert(JSON.parse(rawServiceAccount)) });
  }
  return getAuth();
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) =>
      item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string"
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((item) => ({ role: item.role, content: item.content.slice(0, MAX_MESSAGE_LENGTH) }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  // Require a Firebase ID token issued to a currently signed-in user.
  const idToken = getBearerToken(req);
  if (!idToken) return res.status(401).json({ error: "Authentication required" });

  let decodedToken;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(idToken, true);
  } catch (error) {
    console.warn("Rejected /api/chat token:", error.code || error.message);
    return res.status(401).json({ error: "Invalid or expired authentication token" });
  }

  // Any currently authenticated Firebase user may use chat.

  if (!process.env.HF_TOKEN) {
    console.error("Missing HF_TOKEN environment variable.");
    return res.status(500).json({ error: "Server configuration error" });
  }

  try {
    const { message, history, telemetry } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "A message is required" });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(413).json({ error: "Message is too long" });
    }

    const pastMessages = sanitizeHistory(history);
    // Do not accept a caller-provided identity. The verified Firebase token is authoritative.
    const userName = decodedToken.name || decodedToken.email || "Unknown User";
    const liveData = {
      invertervolt: String(telemetry?.invertervolt ?? "N/A").slice(0, 40),
      battvol: String(telemetry?.battvol ?? "missing").slice(0, 40),
      solarvolt: String(telemetry?.solarvolt ?? "N/A").slice(0, 40),
      solarcur: String(telemetry?.solarcur ?? "N/A").slice(0, 40),
      cpu: String(telemetry?.cpu ?? "--").slice(0, 40),
      mem: String(telemetry?.mem ?? "--").slice(0, 40)
    };

    const systemMessage = {
      role: "system",
      content: `You are the Solar Power Assistant for a home solar system. The verified user is ${userName}.\n` +
        `Live telemetry: inverter ${liveData.invertervolt} V; battery ${liveData.battvol} V; solar ${liveData.solarvolt} V / ${liveData.solarcur} A; CPU ${liveData.cpu}%; memory ${liveData.mem} B.\n` +
        `Reply ONLY as JSON with intent (conversation|control|unknown), command (relay|null), argument (on|off|null), userName, and reply. A control intent is advisory only: it does not authorize or execute hardware control.`
    };

    const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta-llama/Llama-3.1-8B-Instruct:novita",
        temperature: 0,
        stream: false,
        messages: [systemMessage, ...pastMessages, { role: "user", content: message.trim() }]
      })
    });

    if (!response.ok) {
      console.error("Hugging Face Router error:", response.status);
      return res.status(502).json({ error: "AI service is temporarily unavailable" });
    }

    const data = await response.json();
    let content = (data?.choices?.[0]?.message?.content || "").trim();
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    try {
      const parsed = JSON.parse(content);
      const control = parsed.intent === "control" && parsed.command === "relay" &&
        (parsed.argument === "on" || parsed.argument === "off");
      return res.status(200).json({
        intent: control ? "control" : "conversation",
        command: control ? "relay" : null,
        argument: control ? parsed.argument : null,
        userName,
        reply: typeof parsed.reply === "string" ? parsed.reply.slice(0, 4_000) : ""
      });
    } catch {
      return res.status(200).json({ intent: "conversation", command: null, argument: null, userName, reply: content.slice(0, 4_000) });
    }
  } catch (error) {
    console.error("/api/chat failure:", error);
    return res.status(500).json({ error: "Server error" });
  }
}
