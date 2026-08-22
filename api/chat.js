export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "POST only" });
    }

    if (!process.env.HF_TOKEN) {
        console.error("Missing HF_TOKEN environment variable.");
        return res.status(500).json({
            intent: "conversation",
            command: null,
            argument: null,
            userName: req.body?.userName || "Unknown User",
            reply: "Server Configuration Error: The API Token is missing from the environment variables."
        });
    }

    try {
        const { message, history, userName, telemetry } = req.body || {};

        if (!message) {
            return res.status(400).json({ error: "Missing message" });
        }

        const pastMessages = Array.isArray(history) ? history : [];
        const currentName = userName && userName.trim() !== "" ? userName : "Unknown User";

        // Sanitize telemetry objects safely with fallback defaults
        const liveData = {
            invertervolt: telemetry?.invertervolt ?? "N/A",
            battvol: telemetry?.battvol ?? "missing",
            solarvolt: telemetry?.solarvolt ?? "N/A",
            solarcur: telemetry?.solarcur ?? "N/A",
            cpu: telemetry?.cpu ?? "--",
            mem: telemetry?.mem ?? "--"
        };

        // CRITICAL FIX: Prompt rewritten with strict single quotes and string concatenation (+)
        // This completely eliminates literal syntax leaks to the model
        const systemMessage = {
            role: "system",
            content: 'You are the Solar Power Assistant AI for Jim\'s DIY solar power control system.\n\n' +
            'CRITICAL IDENTITY RULES:\n' +
            '- The current user name provided in context is: "' + currentName + '".\n' +
            '- If the name is "Unknown User", your absolute first priority is to politely ask the user for their name (e.g., "Hello! Before we begin, may I know your name?"). Do not mention anything about solar power or rules until you know their name.\n' +
            '- If the user just told you their name in the latest message, extract it, save it into the "userName" JSON field, and greet them by name.\n' +
            '- If you already know their name, address them by that name from time to time to maintain a friendly tone. Never call them Jim if their name is different.\n\n' +
            'System Specifications & Dynamic Features:\n' +
            '- Dedicated for home water supply. Backup mode when the grid is active.\n' +
            '- 12V 1000W Inverter, 100Ah 4-Cell LiFePO4 battery (3.6V per cell) with Active Balancer.\n' +
            '- Battery Voltage Monitor with Buzzer, 40 WP Mono Solar Panel, 1A MPPT Solar Charger.\n' +
            '- Automatic Transfer Switch (ATS) to failover from Main Grid to Solar Power automatically.\n\n' +
            'LIVE SYSTEM TELEMETRY (Use this data to answer status/voltage questions precisely):\n' +
            '- AC Inverter Voltage (Output to well pump): ' + liveData.invertervolt + ' V\n' +
            '- DC Battery Voltage (Aggregate of 4 LiFePO4 cells): ' + liveData.battvol + ' V\n' +
            '- DC Charging Voltage (Stepdown from MPPT Solar Charger): ' + liveData.solarvolt + ' V\n' +
            '- DC Charging Current (Max 1A target under perfect sunshine): ' + liveData.solarcur + ' A\n' +
            '- Controller Resource Metrics: CPU: ' + liveData.cpu + '%, Free Memory: ' + liveData.mem + 'B\n\n' +
            'CRITICAL CONFIRMATION LOGIC AND SYSTEM RULES:\n' +
            '1. When a user asks to turn the system/relay ON or OFF for the first time, you MUST explain the consequences and ask for confirmation. Output intent="conversation", command=null, argument=null.\n' +
            '2. CONSEQUENCE FOR POWER ON: Explain to the user that the solar power system will be activated, however the well pump will still use Source A (city power) as long as there is no blackout.\n' +
            '3. CONSEQUENCE FOR POWER OFF: Explain to the user that the solar power will stay off, but it will automatically power on when city power has a blackout and the water level in the tank is low.\n' +
            '4. CHAT HISTORY EVALUATION: Look closely at the provided chat history to evaluate what request they are confirming when they give a short answer like "y", "yes", "n", or "no".\n' +
            '5. If the user previously asked to turn the system OFF (or "power off"), and now answers "y" or "yes", you MUST output intent="control", command="relay", argument="off".\n' +
            '6. If the user previously asked to turn the system ON (or "power on"), and now answers "y" or "yes", you MUST output intent="control", command="relay", argument="on".\n\n' +
            'JSON Output Format (Strictly follow this exact JSON structure):\n' +
            '{\n' +
            '  "intent": "conversation" | "control" | "unknown",\n' +
            '  "command": "relay" | "status" | "battery" | "inverter" | "charging" | null,\n' +
            '  "argument": "on" | "off" | "battery" | "voltage" | "current" | "all" | null,\n' +
            '  "userName": "Extracted name if user just told you, otherwise repeat currentName",\n' +
            '  "reply": "Your response string here"\n' +
            '}\n\n' +
            'Rules:\n' +
            '1. Never output Markdown code blocks like ```json. Output ONLY raw JSON strings.\n' +
            '2. Never output explanations outside JSON.\n' +
            '3. Always include every field.'
        };

        const payloadMessages = [
            systemMessage,
            ...pastMessages,
            { role: "user", content: message }
        ];

        // Fetch execution query from the unified Hugging Face Router endpoint
        const response = await fetch(
		"https://router.huggingface.co/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.HF_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "meta-llama/Llama-3.1-8B-Instruct:novita",
                    temperature: 0,
                    stream: false,
                    messages: payloadMessages
                })
            }
        );

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return res.status(200).json({
                intent: "conversation",
                command: null,
                argument: null,
                userName: userName,
                reply: "Router Connection Failure: " + (errorData?.error?.message || "Unknown hardware endpoint error.")
            });
        }

        const data = await response.json();
        let content = (data?.choices?.[0]?.message?.content || "").trim();

        // Failsafe cleaning to strip out markdown wraps
        if (content.startsWith("```")) {
            content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        }

        try {
            const parsed = JSON.parse(content);

            return res.status(200).json({
                intent: parsed.intent ?? "conversation",
                command: parsed.command ?? null,
                argument: parsed.argument ?? null,
                userName: parsed.userName ?? userName,
                reply: parsed.reply ?? ""
            });

        } catch (err) {
            console.error("Invalid JSON from router model. Raw data string:", content);
            return res.status(200).json({
                intent: "conversation",
                command: null,
                argument: null,
                userName: userName,
                reply: content
            });
        }

    } catch (err) {
        console.error("Critical Handler Core Exception:", err);
        return res.status(200).json({
            intent: "conversation",
            command: null,
            argument: null,
            userName: req.body?.userName || "Unknown User",
            reply: "System Exception Occurred: " + err.message
        });
    }
}
